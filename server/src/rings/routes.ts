/**
 * The Rings explorer's routes. Read-only, public, and answered from what the
 * indexer has already stored: a visitor's request never becomes a burst of RPC
 * calls. The one live read, whether a wallet is registered, is cached and
 * rate limited per visitor.
 */

import express, { type Request, type Response, type Router } from 'express';
import { isAddress } from '@solana/kit';

import {
  RING_ASSET_SORTS,
  RING_KINDS,
  RING_PAGE_SIZE,
  type RingAddressView,
  type RingAssetPage,
  type RingAssetSort,
  type CustomRingsView,
  type RingAssetView,
  type RingFeed,
  type RingKind,
  type RingLabels,
  type RingOverview,
  type RingRow,
} from '../../../shared/src/rings-api.js';
import { type RateLimiter, asyncRoute, clientIp, sendError } from '../http.js';
import type { RingIndexer } from './indexer.js';
import { type RingStore, cursorOf, readCursor } from './store.js';

const FEED_PAGE = 50;
const REGISTERED_TTL_MS = 10 * 60_000;

export const RINGS_OFF_OVERVIEW: RingOverview = Object.freeze({
  enabled: false,
  since: null,
  through: null,
  complete: false,
  tokens: 0,
  wallets: null,
  tx24h: 0,
  txAll: 0,
  active24h: 0,
  shields24h: 0,
  unshields24h: 0,
  transfers24h: 0,
  solShielded: '0',
  solFlow24h: '0',
});

export const RINGS_OFF_CUSTOM: CustomRingsView = Object.freeze({ enabled: false, readAt: null, activation: null, rings: [] });

export interface RingsRoutesInput {
  /** Undefined when this server does not follow Rings. */
  readonly rings: { readonly indexer: RingIndexer; readonly store: RingStore; readonly isRegistered: (owner: string) => Promise<boolean> } | undefined;
  readonly limiter: RateLimiter;
}

function one(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Tickers and decimals for the tokens these rows name, so a page can write their amounts. */
function labelsFor(indexer: RingIndexer, rows: readonly RingRow[]): RingLabels {
  const labels: Record<string, { symbol: string; decimals: number; listed: boolean }> = {};
  for (const row of rows) {
    for (const leg of row.legs) {
      if (labels[leg.mint]) continue;
      const asset = indexer.asset(leg.mint);
      if (asset) labels[leg.mint] = { symbol: asset.symbol, decimals: asset.decimals, listed: asset.listed };
    }
  }
  return labels;
}

export function ringsRouter(input: RingsRoutesInput): Router {
  const router = express.Router();
  const registered = new Map<string, { at: number; value: boolean }>();

  const guard = (request: Request, response: Response): NonNullable<RingsRoutesInput['rings']> | null => {
    if (!input.rings) {
      sendError(response, 503, 'RINGS_OFF', 'This site does not follow Rings activity.');
      return null;
    }
    if (!input.limiter.take(`rings:${clientIp(request)}`, 120, 60_000)) {
      sendError(response, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
      return null;
    }
    return input.rings;
  };

  router.get('/overview', (_request, response) => {
    response.setHeader('cache-control', 'public, max-age=10');
    response.json(input.rings ? input.rings.indexer.overview() : RINGS_OFF_OVERVIEW);
  });

  // The public register of custom rings. Served from what the follower last read: no call to the chain from here.
  router.get('/custom', (_request, response) => {
    response.setHeader('cache-control', 'public, max-age=30');
    response.json(input.rings ? input.rings.indexer.customRings() : RINGS_OFF_CUSTOM);
  });

  router.get('/tokens', (request, response) => {
    const rings = guard(request, response);
    if (!rings) return;
    const sortText = one(request.query.sort) || 'share';
    if (!(RING_ASSET_SORTS as readonly string[]).includes(sortText)) return sendError(response, 400, 'BAD_REQUEST', `sort must be one of: ${RING_ASSET_SORTS.join(', ')}.`);
    const pageNumber = Number(one(request.query.page) || '1');
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 100_000) return sendError(response, 400, 'BAD_REQUEST', 'page must be a whole number from 1.');
    const held = one(request.query.held);
    const result = rings.indexer.assetPage({
      sort: sortText as RingAssetSort,
      page: pageNumber,
      size: RING_PAGE_SIZE,
      query: one(request.query.q),
      held: held === '1',
    });
    const pages = Math.max(1, Math.ceil(result.total / RING_PAGE_SIZE));
    const body: RingAssetPage = { assets: result.assets, total: result.total, page: Math.min(pageNumber, pages), pages, size: RING_PAGE_SIZE };
    response.setHeader('cache-control', 'public, max-age=10');
    response.json(body);
  });

  router.get('/feed', (request, response) => {
    const rings = guard(request, response);
    if (!rings) return;
    const kindText = one(request.query.kind);
    if (kindText && !(RING_KINDS as readonly string[]).includes(kindText)) return sendError(response, 400, 'BAD_REQUEST', 'kind is not one this site knows.');
    const mint = one(request.query.mint);
    if (mint && !isAddress(mint)) return sendError(response, 400, 'BAD_REQUEST', 'mint must be a token address.');
    const beforeText = one(request.query.before);
    const before = beforeText ? readCursor(beforeText) : null;
    if (beforeText && !before) return sendError(response, 400, 'BAD_REQUEST', 'before is not a position this site gave out.');
    const rows = rings.store.feed({ limit: FEED_PAGE + 1, before, ...(kindText ? { kind: kindText as RingKind } : {}), ...(mint ? { mint } : {}) });
    const shown = rows.slice(0, FEED_PAGE);
    const last = shown[shown.length - 1];
    const body: RingFeed = { rows: shown, labels: labelsFor(rings.indexer, shown), next: rows.length > FEED_PAGE && last ? cursorOf(last) : null };
    response.setHeader('cache-control', 'public, max-age=5');
    response.json(body);
  });

  router.get(
    '/address/:address',
    asyncRoute(async (request: Request, response: Response) => {
      const rings = guard(request, response);
      if (!rings) return;
      const owner = one(request.params.address);
      if (!isAddress(owner)) return sendError(response, 400, 'BAD_REQUEST', 'That is not a wallet address.');
      const beforeText = one(request.query.before);
      const before = beforeText ? readCursor(beforeText) : null;
      if (beforeText && !before) return sendError(response, 400, 'BAD_REQUEST', 'before is not a position this site gave out.');

      // Whether the wallet is registered is the one thing read from chain for a visitor: kept for
      // ten minutes, and only so many a minute from one address.
      const now = Date.now();
      let known: boolean | null = null;
      const cached = registered.get(owner);
      if (cached && now - cached.at < REGISTERED_TTL_MS) known = cached.value;
      else if (input.limiter.take(`rings-registered:${clientIp(request)}`, 20, 60_000)) {
        try {
          known = await rings.isRegistered(owner);
          if (registered.size >= 5_000) registered.clear();
          registered.set(owner, { at: now, value: known });
        } catch {
          known = null;
        }
      }

      const rows = rings.store.addressRows(owner, FEED_PAGE + 1, before);
      const shown = rows.slice(0, FEED_PAGE);
      const last = shown[shown.length - 1];
      const summary = rings.store.addressSummary(owner);
      const overview = rings.indexer.overview();
      const body: RingAddressView = {
        address: owner,
        registered: known,
        first: summary.first,
        last: summary.last,
        counts: summary.counts,
        counterparties: summary.counterparties,
        rows: shown,
        labels: labelsFor(rings.indexer, shown),
        next: rows.length > FEED_PAGE && last ? cursorOf(last) : null,
        since: overview.since,
        complete: overview.complete,
      };
      response.setHeader('cache-control', 'public, max-age=10');
      response.json(body);
    }),
  );

  router.get('/token/:mint', (request, response) => {
    const rings = guard(request, response);
    if (!rings) return;
    const mint = one(request.params.mint);
    if (!isAddress(mint)) return sendError(response, 400, 'BAD_REQUEST', 'That is not a token address.');
    const asset = rings.indexer.asset(mint);
    if (!asset) return sendError(response, 404, 'NOT_REGISTERED', 'This token is not registered with Rings, so nobody can hold it privately.');
    const rows = rings.store.feed({ limit: 30, mint });
    const body: RingAssetView = { asset, rows, labels: labelsFor(rings.indexer, rows), ...rings.store.movers(mint) };
    response.setHeader('cache-control', 'public, max-age=10');
    response.json(body);
  });

  return router;
}
