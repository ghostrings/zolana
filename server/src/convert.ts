/**
 * The relay between this site's pages and Jupiter's Swap API.
 *
 * A page that wants to pay for a token in SOL or USDC asks here for the
 * conversion into the token's pair token. This server asks Jupiter with the
 * operator's key and hands the answer back. The page checks that answer
 * itself before a wallet signs anything (`shared/src/jupiter.ts`); this file
 * only decides what may be asked, and how often.
 *
 * What may be asked: one endpoint (`/build`), version 1 instructions, between
 * SOL or USDC on one side and SOL, USDC or a pair token in use on the other.
 * Where the operator lets people buy tokens that were not launched here
 * (`anyToken`), the other side may be any token at all, and the operator's
 * limit on a single trade is applied to the SOL or USDC side here as well as
 * on the page. Nothing else about the request is the page's to choose: no fee
 * account, no other payer, no other destination.
 *
 * What Jupiter learns from each request: the wallet address, the two tokens
 * and the amount. It sees this server's address, not the visitor's.
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import { isAddress } from '@solana/kit';

import type { PairRef, PairStatus } from '../../shared/src/api.js';
import { SOL_DECIMALS, WSOL_MINT } from '../../shared/src/constants.js';
import { type BuildRequest, JUPITER_BUILD_URL, MAX_ACCOUNTS_RANGE, buildQuery } from '../../shared/src/jupiter.js';
import { PAIR_TOKENS, fromSolLamports, pairSymbol, pairTokenById } from '../../shared/src/quotes.js';
import { type RateLimiter, asyncRoute, clientIp, sendError } from './http.js';

const USDC = pairTokenById('USDC');
if (!USDC || USDC.expectedDecimals === undefined) throw new Error('The pair list has no USDC entry.');

/** What can be paid with, or received, in place of a token's pair token. */
export const CONVERT_ASSETS: readonly PairRef[] = Object.freeze([
  Object.freeze({ id: 'SOL', symbol: 'SOL', mint: WSOL_MINT, decimals: SOL_DECIMALS }),
  Object.freeze({ id: USDC.id, symbol: pairSymbol(USDC), mint: USDC.mint, decimals: USDC.expectedDecimals }),
]);

const BASE_MINTS: ReadonlySet<string> = new Set(CONVERT_ASSETS.map((asset) => asset.mint));

/** Every mint this build could ever convert to or from: the list a request is checked against when no pair is confirmed yet. */
export const KNOWN_PAIR_MINTS: ReadonlySet<string> = new Set(PAIR_TOKENS.map((token) => token.mint));

/**
 * The operator's limit on a single trade, in base units of SOL or of USDC.
 * The limit is set in SOL. For USDC it applies at the USDC pair's rate, as it
 * does on the pages; when that pair has no rate the limit cannot be expressed
 * in USDC, and nothing is let through. 0n when there is no limit.
 */
export function baseCap(mint: string, maxTradeLamports: bigint, pairs: ReadonlyArray<Pick<PairStatus, 'mint' | 'decimals' | 'unitsPerSol'>>): bigint {
  if (maxTradeLamports <= 0n) return 0n;
  if (mint === WSOL_MINT) return maxTradeLamports;
  const pair = pairs.find((candidate) => candidate.mint === mint);
  const rate = pair?.unitsPerSol ?? 0;
  return pair && rate > 0 && Number.isFinite(rate) ? fromSolLamports(maxTradeLamports, { decimals: pair.decimals, native: false }, rate) : 1n;
}

/** True when a request names a token that is neither SOL, USDC nor a pair token in use: one that was not launched against anything here. */
export function isOutside(request: Pick<BuildRequest, 'inputMint' | 'outputMint'>, mints: ReadonlySet<string>): boolean {
  return !mints.has(request.inputMint) || !mints.has(request.outputMint);
}

/**
 * Reads a conversion request from a query string. Returns the request, or a
 * sentence saying what is wrong with it. `mints` is what may be converted
 * right now: SOL, USDC and the pair tokens in use. With `anyToken`, the side
 * that is not SOL or USDC may be any token.
 */
export function readConvertRequest(query: Record<string, unknown>, mints: ReadonlySet<string>, maxSlippageBps: number, anyToken = false): BuildRequest | string {
  const one = (key: string): string => (typeof query[key] === 'string' ? (query[key] as string).trim() : '');
  const inputMint = one('inputMint');
  const outputMint = one('outputMint');
  if (!isAddress(inputMint) || !isAddress(outputMint)) return 'inputMint and outputMint must be token addresses.';
  if (inputMint === outputMint) return 'There is nothing to convert between a token and itself.';
  if (!anyToken && isOutside({ inputMint, outputMint }, mints)) return 'This site converts only between SOL, USDC and the pair tokens it has in use.';
  if (!BASE_MINTS.has(inputMint) && !BASE_MINTS.has(outputMint)) return anyToken ? 'One side of a trade must be SOL or USDC.' : 'One side of a conversion must be SOL or USDC.';
  const amount = one('amount');
  if (!/^[1-9][0-9]{0,18}$/.test(amount)) return 'amount must be a whole number of base units, greater than zero.';
  const taker = one('taker');
  if (!isAddress(taker)) return 'taker must be a wallet address.';
  const slippageBps = Number(one('slippageBps'));
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > maxSlippageBps) return `slippageBps must be a whole number from 1 to ${maxSlippageBps}.`;
  const maxAccounts = Number(one('maxAccounts'));
  if (!Number.isInteger(maxAccounts) || maxAccounts < MAX_ACCOUNTS_RANGE.min || maxAccounts > MAX_ACCOUNTS_RANGE.max) {
    return `maxAccounts must be a whole number from ${MAX_ACCOUNTS_RANGE.min} to ${MAX_ACCOUNTS_RANGE.max}.`;
  }
  return { inputMint, outputMint, amount: BigInt(amount), taker, slippageBps, maxAccounts };
}

/**
 * Spaces requests out so the key's allowance is never exceeded, whoever is
 * asking. A request waits its turn for a short while; when the queue is
 * longer than that, it is told so at once instead of being held.
 */
export class Spacer {
  readonly #everyMs: number;
  readonly #longestWaitMs: number;
  readonly #now: () => number;
  #next = 0;

  constructor(requestsPerSecond: number, longestWaitMs = 2_500, now: () => number = Date.now) {
    this.#everyMs = 1000 / requestsPerSecond;
    this.#longestWaitMs = longestWaitMs;
    this.#now = now;
  }

  /** Milliseconds to wait before sending, or null when the queue is too long. */
  reserve(): number | null {
    const now = this.#now();
    const wait = Math.max(0, this.#next - now);
    if (wait > this.#longestWaitMs) return null;
    this.#next = Math.max(now, this.#next) + this.#everyMs;
    return wait;
  }
}

export interface ConvertRelayOptions {
  readonly apiKey: string;
  readonly requestsPerSecond: number;
  readonly maxSlippageBps: number;
  /** What may be converted right now. */
  mints(): ReadonlySet<string>;
  /** Whether a token that was not launched here may be bought and sold through this relay. */
  readonly anyToken?: boolean;
  /**
   * The operator's limit on a single trade, in base units of SOL or of USDC
   * (`mint` is one of the two). 0n when there is none. It is applied to trades
   * in tokens that were not launched here; a trade in a token launched here is
   * held to its own limit by its page.
   */
  cap?(mint: string): bigint;
  /** A sentence when trading through the site is paused, else null. */
  paused(): string | null;
  /** Whether the RPC has been confirmed as mainnet. Nothing is built for a network that has not. */
  ready?(): Promise<void>;
  log?(message: string): void;
  /** For the tests. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const UPSTREAM_TIMEOUT_MS = 12_000;
const CACHE_MS = 2_000;
const CACHE_ENTRIES = 200;
const LARGEST_ANSWER_BYTES = 256 * 1024;

/** Text from another server, cut down to something safe to put in a sentence. */
function plain(value: unknown, max = 140): string {
  return typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function convertRouter(options: ConvertRelayOptions, limiter: RateLimiter): Router {
  const router = express.Router();
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spacer = new Spacer(options.requestsPerSecond, 2_500, now);
  const cache = new Map<string, { at: number; body: string }>();
  let keyRefusedLoggedAt = 0;

  router.get(
    '/build',
    asyncRoute(async (request: Request, response: Response) => {
      response.setHeader('cache-control', 'no-store');
      // A browser says where a request comes from. One made by another website's page is refused:
      // the key's allowance is for this site's own visitors.
      const site = request.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        return sendError(response, 403, 'CROSS_ORIGIN', 'Cross-site requests are not accepted.');
      }
      const pause = options.paused();
      if (pause) return sendError(response, 503, 'TRADING_PAUSED', pause);
      if (!limiter.take(`convert:${clientIp(request)}`, 40, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many quotes. Wait a moment.');
      const mints = options.mints();
      const asked = readConvertRequest(request.query as Record<string, unknown>, mints, options.maxSlippageBps, options.anyToken === true);
      if (typeof asked === 'string') return sendError(response, 400, 'BAD_REQUEST', asked);
      // A token that was not launched here has no page of its own to hold it to the operator's limit, so this does.
      const outside = isOutside(asked, mints);
      const capOf = (mint: string): bigint => (outside && options.cap && BASE_MINTS.has(mint) ? options.cap(mint) : 0n);
      const OVER = 'This is more than a single trade through this site may be for now. Enter less.';
      const payCap = capOf(asked.inputMint);
      if (payCap > 0n && asked.amount > payCap) return sendError(response, 422, 'OVER_LIMIT', OVER);
      // What the other route would be told to do when this one has no answer.
      const otherwise = outside ? '' : ', or pay with the pair token';
      if (options.ready) {
        try {
          await options.ready();
        } catch {
          return sendError(response, 503, 'NETWORK_UNCONFIRMED', 'This server has not confirmed that its RPC is Solana mainnet, so it is not converting.');
        }
      }

      const query = buildQuery(asked).toString();
      /** A sale is limited by what it pays out, which only the answer says. */
      const overReceiveCap = (parsed: unknown): boolean => {
        const receiveCap = capOf(asked.outputMint);
        if (receiveCap <= 0n) return false;
        const out = (parsed as { outAmount?: unknown } | null)?.outAmount;
        // An answer that does not say what it pays is refused by the page anyway; here it is simply not let past the limit.
        return typeof out !== 'string' || !/^[0-9]{1,20}$/.test(out) || BigInt(out) > receiveCap;
      };
      const cached = cache.get(query);
      if (cached && now() - cached.at <= CACHE_MS) {
        if (overReceiveCap(JSON.parse(cached.body))) return sendError(response, 422, 'OVER_LIMIT', OVER);
        response.type('application/json').send(cached.body);
        return;
      }
      const wait = spacer.reserve();
      if (wait === null) return sendError(response, 429, 'CONVERTER_BUSY', 'The converter is busy. Try again in a few seconds.');
      if (wait > 0) await sleep(wait);

      let upstream: globalThis.Response;
      let text: string;
      try {
        upstream = await fetcher(`${JUPITER_BUILD_URL}?${query}`, {
          method: 'GET',
          headers: { accept: 'application/json', 'x-api-key': options.apiKey },
          redirect: 'error',
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        text = await upstream.text();
      } catch {
        return sendError(response, 502, 'CONVERTER_DOWN', `Jupiter did not answer. Try again${otherwise}.`);
      }
      if (upstream.status === 429) return sendError(response, 429, 'CONVERTER_BUSY', 'The converter is busy. Try again in a few seconds.');
      if (upstream.status === 401 || upstream.status === 403) {
        if (now() - keyRefusedLoggedAt > 60_000) {
          keyRefusedLoggedAt = now();
          options.log?.(`convert: Jupiter refused this server's API key (HTTP ${upstream.status}). Check JUPITER_API_KEY.`);
        }
        return sendError(response, 502, 'CONVERTER_DOWN', outside ? 'Trading through Jupiter is not available right now.' : 'Converting is not available right now. Pay with the pair token.');
      }
      if (upstream.status === 400 || upstream.status === 404 || upstream.status === 422) {
        let reason = '';
        try {
          reason = plain((JSON.parse(text) as { error?: unknown }).error);
        } catch {
          reason = '';
        }
        return sendError(
          response,
          422,
          'NO_ROUTE',
          outside
            ? `Jupiter has no route for this token at this size${reason ? ` (${reason})` : ''}. It may not be traded anywhere Jupiter reaches, or not in this amount. Try another amount.`
            : `Jupiter has no route for this conversion at this size${reason ? ` (${reason})` : ''}. Try another amount, or pay with the pair token.`,
        );
      }
      if (!upstream.ok || text.length > LARGEST_ANSWER_BYTES) {
        return sendError(response, 502, 'CONVERTER_DOWN', `Jupiter answered with an error. Try again${otherwise}.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return sendError(response, 502, 'CONVERTER_DOWN', 'Jupiter answered with something this server could not read.');
      }
      if (cache.size >= CACHE_ENTRIES) {
        const cutoff = now() - CACHE_MS;
        for (const [key, entry] of cache) if (entry.at < cutoff) cache.delete(key);
        if (cache.size >= CACHE_ENTRIES) cache.clear();
      }
      cache.set(query, { at: now(), body: text });
      if (overReceiveCap(parsed)) return sendError(response, 422, 'OVER_LIMIT', OVER);
      response.type('application/json').send(text);
    }),
  );

  return router;
}
