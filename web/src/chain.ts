/**
 * Browser-side chain access. Every request goes through this site's own relay
 * (`/api/helius`), so no RPC key is ever in the page.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../shared/src/constants.js';
import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { SprClient } from '@heliuslabs/spr/client';

import {
  type AllowedConfig,
  type Market,
  MarketError,
  type QuoteRequest,
  type TradeQuote,
  allowedConfigMap,
  assertGraduatedFee,
  createDbc,
  graduatedFeeTerms,
  loadGraduatedPool,
  loadMarket,
  mintAuthorityOf,
  mintDecimals,
  mintSupply,
  quoteCurve,
  quoteCurveClose,
  quoteGraduated,
} from '../../shared/src/meteora.js';
import { createRingsClient } from '../../shared/src/privacy.js';
import type { TradingPair } from '../../shared/src/quotes.js';
import type { MarketEnv } from '../../shared/src/routes.js';
import { api } from './api.js';
import { tradingPairOf } from './pairs.js';

const RPC_URL = `${location.origin}/api/helius`;
const SPR_URL = `${location.origin}/api/helius/v1/spr`;
const TEE_RELAY = `${location.origin}/api/tee-policy`;

let connectionInstance: Connection | undefined;
let dbcInstance: DynamicBondingCurveClient | undefined;
let ringsPromise: Promise<SprClient> | undefined;
let configsPromise: Promise<Map<string, AllowedConfig>> | undefined;

export function connection(): Connection {
  connectionInstance ??= new Connection(RPC_URL, 'confirmed');
  return connectionInstance;
}

export function dbc(): DynamicBondingCurveClient {
  dbcInstance ??= createDbc(connection());
  return dbcInstance;
}

/* ---------------- priority fee ---------------- */

let priorityPrice = 0;
let priorityTimer: number | undefined;

async function refreshPriority(): Promise<void> {
  try {
    const status = await api.status();
    if (Number.isFinite(status.priorityMicroLamports) && status.priorityMicroLamports >= 0) priorityPrice = status.priorityMicroLamports;
  } catch {
    // Keep the last price; the next tick asks again.
  }
}

/**
 * The priority price to attach right now, in micro-lamports per compute unit.
 * The server follows the network's live estimate; this page re-reads it once a
 * minute while it is visible, so a tab left open still pays a current price.
 */
export function priorityMicroLamports(): number {
  if (priorityTimer === undefined) {
    priorityTimer = window.setInterval(() => {
      if (!document.hidden) void refreshPriority();
    }, 60_000);
  }
  return priorityPrice;
}

/**
 * The Rings SDK reports a failed request as a bare code and drops what the
 * server answered. This site's relay says why it refused, so the reason is
 * kept here for the moment an error has to be explained to somebody.
 */
let lastRefusal: { code: string; message: string; at: number } | undefined;

/** Why this site's relay last refused a wallet request, if that was a moment ago. */
export function recentRefusal(withinMs = 20_000): { code: string; message: string } | undefined {
  return lastRefusal && Date.now() - lastRefusal.at <= withinMs ? { code: lastRefusal.code, message: lastRefusal.message } : undefined;
}

const watchedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    try {
      const body = (await response.clone().json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.code === 'string') {
        lastRefusal = { code: body.error.code, message: typeof body.error.message === 'string' ? body.error.message : '', at: Date.now() };
      }
    } catch {
      // Not an answer in this site's own format: nothing to remember.
    }
  }
  return response;
};

export function ringsClient(): Promise<SprClient> {
  ringsPromise ??= refreshPriority()
    .then(() => {
      priorityMicroLamports(); // starts the once-a-minute refresh
      return createRingsClient({ rpcUrl: RPC_URL, sprUrl: SPR_URL, teePolicyRelay: TEE_RELAY, priorityMicroLamports: priorityPrice, fetch: watchedFetch });
    })
    .catch((error) => {
      ringsPromise = undefined;
      throw error;
    });
  return ringsPromise;
}

/**
 * The platform's configs, by address, with the fee tier and the pair token of
 * each. Only pairs the server has confirmed on chain are included, so a token
 * priced in anything else is not found, and cannot be traded, here.
 */
export function allowedConfigs(): Promise<Map<string, AllowedConfig>> {
  configsPromise ??= api
    .status()
    .then((status) => {
      const usable = status.pairs.filter((pair) => pair.problem === null);
      return allowedConfigMap([
        ...usable.flatMap((pair) => pair.tiers.map((tier) => ({ address: tier.config, feeBps: tier.feeBps, pair: tradingPairOf(pair) }))),
        // Configs kept from an earlier set: their tokens are found and traded exactly as before.
        ...(status.previousConfigs ?? []).flatMap((kept) => {
          const pair = usable.find((candidate) => candidate.id === kept.pairId);
          return pair ? [{ address: kept.address, feeBps: kept.feeBps, pair: tradingPairOf(pair), previous: true }] : [];
        }),
      ]);
    })
    .catch((error) => {
      configsPromise = undefined;
      throw error;
    });
  return configsPromise;
}

const checkedPairs = new Map<string, Promise<void>>();

/**
 * Reads a pair token's mint from chain and compares it with what the server
 * said about it. Every amount of a pair token typed into this page is turned
 * into base units with the mint's decimals, so the page checks that number
 * itself, once, before it prices or builds anything.
 */
export function assertPairMint(pair: TradingPair): Promise<void> {
  if (pair.native) return Promise.resolve();
  let check = checkedPairs.get(pair.mint);
  if (!check) {
    check = connection()
      .getAccountInfo(new PublicKey(pair.mint), 'confirmed')
      .then((info) => {
        const decimals = mintDecimals(info);
        if (decimals === null) {
          throw new MarketError('BAD_PAIR', `${pair.symbol} is not an ordinary SPL Token mint on chain, so nothing can be traded against it here.`);
        }
        if (decimals !== pair.decimals) {
          throw new MarketError('BAD_PAIR', `${pair.symbol} has ${decimals} decimals on chain, and this site was told ${pair.decimals}. Nothing is traded against it until that is put right.`);
        }
      });
    checkedPairs.set(pair.mint, check);
    check.catch(() => checkedPairs.delete(pair.mint));
  }
  return check;
}

/** Live pool state for a mint, read from chain and checked against the platform's fee tiers and pair tokens. */
export async function loadMarketEnv(mint: string): Promise<MarketEnv> {
  const market: Market = await loadMarket(dbc(), new PublicKey(mint), await allowedConfigs());
  await assertPairMint(market.pair);
  if (market.stage !== 'graduated') return { connection: connection(), dbc: dbc(), market };
  const graduated = await loadGraduatedPool(connection(), market);
  assertGraduatedFee(graduatedFeeTerms(graduated.state), market.tier);
  return { connection: connection(), dbc: dbc(), market, graduated };
}

export function quote(env: MarketEnv, request: QuoteRequest): Promise<TradeQuote> {
  if (env.market.stage === 'curve') return quoteCurve(env.dbc, env.connection, env.market, request);
  if (env.market.stage === 'graduated' && env.graduated) {
    return quoteGraduated(env.connection, env.market, env.graduated, request);
  }
  return Promise.reject(new Error('This curve is complete and is migrating to its pool. Trading resumes in a moment.'));
}

/** The buy that takes everything a curve has left, when `maxQuoteIn` of the pair token covers it; otherwise null. */
export function quoteClose(env: MarketEnv, maxQuoteIn: bigint, slippageBps: number): Promise<TradeQuote | null> {
  if (env.market.stage !== 'curve') return Promise.resolve(null);
  return quoteCurveClose(env.dbc, env.connection, env.market, maxQuoteIn, slippageBps);
}

export async function publicLamports(owner: string): Promise<bigint> {
  return BigInt(await connection().getBalance(new PublicKey(owner), 'confirmed'));
}

/**
 * Base units of `mint` in `owner`'s ordinary (public) token account. Zero when
 * that account does not exist. `program` is the mint's token program, which
 * decides where that account is; it is the SPL Token program unless said.
 */
export async function publicTokenUnits(owner: string, mint: string, program: string = TOKEN_PROGRAM_ID): Promise<bigint> {
  const account = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, new PublicKey(program));
  const info = await connection().getAccountInfo(account, 'confirmed');
  if (!info || info.data.length < AccountLayout.span) return 0n;
  return AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount;
}

const mintPrograms = new Map<string, string>();

/** Notes a mint's token program when something else on the page has already read it from chain. */
export function rememberTokenProgram(mint: string, program: string): void {
  if (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) mintPrograms.set(mint, program);
}

/**
 * The token program a mint belongs to, read from the mint's own account: the
 * SPL Token program or Token-2022. A token's accounts live under its mint's
 * program, so a move built for the wrong one would point at accounts that do
 * not exist. A mint never changes program, so each is read once a page.
 */
export async function tokenProgramOf(mint: string): Promise<string> {
  const known = mintPrograms.get(mint);
  if (known) return known;
  const info = await connection().getAccountInfo(new PublicKey(mint), 'confirmed');
  if (!info) throw new MarketError('NO_TOKEN', 'There is no token at that address on chain.');
  const owner = info.owner.toBase58();
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) throw new MarketError('NO_TOKEN', 'That address is not a token.');
  mintPrograms.set(mint, owner);
  return owner;
}

export interface MintState {
  /** The supply on chain right now, in base units. This is the number a burn lowers. */
  readonly supply: bigint;
  /** The address that can create more of the token, or null when nobody can. */
  readonly mintAuthority: string | null;
}

/** A token's mint account as it is on chain now. Null when it is not an SPL Token mint. */
export async function readMintState(mint: string): Promise<MintState | null> {
  const info = await connection().getAccountInfo(new PublicKey(mint), 'confirmed');
  const supply = mintSupply(info);
  const authority = mintAuthorityOf(info);
  if (supply === null || authority === undefined) return null;
  return { supply, mintAuthority: authority ? authority.toBase58() : null };
}
