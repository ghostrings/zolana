/**
 * privacycash.fun server.
 *
 * It serves the web client, relays RPC so the API key stays private, keeps
 * the public listing, stores token artwork, and (when enabled) runs the Ghost
 * desk. It never sees a user's key, viewing key, private balance, or the
 * contents of a private transfer.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { isAddress } from '@solana/kit';

import type { PairRef, PlatformStats, StatusResponse, TokenDetail, TokenSummary } from '../../shared/src/api.js';
import { RELEASE, WSOL_MINT } from '../../shared/src/constants.js';
import { GhostError } from '../../shared/src/ghost.js';
import { cidOfUrl, isCid } from '../../shared/src/ipfs.js';
import { MarketError, burnedUnits } from '../../shared/src/meteora.js';
import { SOL_PAIR } from '../../shared/src/quotes.js';
import { FEE_TIERS } from '../../shared/src/tiers.js';
import { Artwork, displayImage, gatewaysFor } from './artwork.js';
import { CONVERT_ASSETS, baseCap, convertRouter } from './convert.js';
import { type Chain, type Indexer, WrongNetworkError, createChain, startIndexer } from './chain.js';
import { type TokenRow, Store } from './db.js';
import { Desk, DeskError } from './desk.js';
import { Modules, ModulesError, moduleSummary, moduleView, modulesOff } from './modules.js';
import { EnvError, PUBLIC_PINATA_GATEWAY, configuredTiers, readEnv, requireRpc } from './env.js';
import { createRingChain } from './rings/chain.js';
import { RingIndexer } from './rings/indexer.js';
import { ringsRouter } from './rings/routes.js';
import { customRingsRouter } from './custom-rings/routes.js';
import { RingStore } from './rings/store.js';
import { lifetimeVolume, readPageRequest, tokenPage } from './listing.js';
import { describePair } from './pairs.js';
import { CLIENT_IP_HEADER_SETTING, HTTPS_ORIGIN_SETTING, RateLimiter, asyncRoute, clientIp, isHashedAsset, sameOrigin, securityHeaders, sendError } from './http.js';
import { type PriorityOracle, fixedPriority, startPriorityOracle } from './priority.js';
import { proxyRouter } from './proxy.js';
import { redact } from './redact.js';
import { Trends } from './trend.js';
import { MAX_IMAGE_BYTES, UploadError, Uploads, metadataBytes, metadataJson } from './uploads.js';

const log = (message: string): void => console.log(`${new Date().toISOString()} ${redact(message)}`);

const SOL_REF: PairRef = Object.freeze({ id: SOL_PAIR.id, symbol: SOL_PAIR.symbol, mint: SOL_PAIR.mint, decimals: SOL_PAIR.decimals });

/** A stored token as the pages receive it. `pair` is the pair token its amounts are in. */
function summary(row: TokenRow, pair: PairRef): TokenSummary {
  return {
    mint: row.mint,
    pool: row.pool,
    feeBps: row.fee_bps,
    creator: row.creator,
    modules: null,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    image: row.image,
    website: row.website,
    twitter: row.twitter,
    stage: row.stage as TokenSummary['stage'],
    pair,
    price: row.price_sol,
    marketCap: row.market_cap_sol,
    progress: row.progress,
    reserve: row.reserve_lamports,
    threshold: row.threshold_lamports,
    fees: row.fee_lamports,
    volume: lifetimeVolume(row),
    volume24h: row.volume_24h_lamports,
    supply: row.supply,
    burned: burnedUnits(row.supply ? BigInt(row.supply) : null).toString(),
    createdAt: row.created_at,
  };
}

async function main(): Promise<void> {
  const env = readEnv();
  if (env.heliusRpcUrl && !env.publicOrigin) {
    // Token metadata addresses are written on mainnet. They must not depend on a request header.
    throw new EnvError('Set PUBLIC_ORIGIN (for example https://privacycash.fun) before connecting this server to mainnet.');
  }
  let store: Store;
  try {
    store = new Store(env.dataDir);
  } catch (error) {
    // The usual cause on a hosting platform: DATA_DIR names a path where no disk is mounted.
    throw new EnvError(
      `DATA_DIR (${env.dataDir}) cannot be created or written: ${error instanceof Error ? error.message : String(error)}. On a hosting platform, attach a persistent disk mounted at exactly that path.`,
    );
  }
  // Only tokens under the configured tiers are listed, whatever else the database holds
  // (an earlier set of configs, for instance the one used for the first run). The SOL pair's
  // are listed from the start; another pair's join once its token has been confirmed on chain.
  store.setListedConfigs(configuredTiers(env).filter((tier) => tier.pairId === SOL_PAIR.id).map((tier) => tier.address));
  const limiter = new RateLimiter();
  // This server's own copy of every file it pins, served at /ipfs/<cid>. Pages load artwork from
  // here, so a logo does not depend on the visitor being able to reach an IPFS gateway.
  const blockedArtwork: ReadonlySet<string> = new Set(env.artworkBlocklist);
  const artworkGateways = gatewaysFor(env.pinataGateway, env.allowedOrigins);
  let artwork: Artwork;
  try {
    artwork = new Artwork({
      dir: resolve(env.dataDir, 'ipfs'),
      budgetBytes: env.artworkCacheBytes,
      gateways: artworkGateways,
      blocked: blockedArtwork,
      log,
    });
  } catch (error) {
    throw new EnvError(`DATA_DIR (${env.dataDir}) cannot hold the artwork copies: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const uploads = new Uploads(env, store, artwork, log);
  let chain: Chain | undefined;
  let modules: Modules | undefined;
  /** A token as the pages receive it: its artwork is addressed on this site, its amounts labelled with its pair token. */
  const listed = (row: TokenRow): TokenSummary => {
    // The config a token was launched under says what it is priced in. Only tokens under a config
    // whose pair token has been confirmed on chain are served, so this always finds one; with no
    // RPC at all, only the SOL pair's tokens are served.
    const pair = chain?.allowedConfigs.get(row.config)?.pair;
    const ref: PairRef = pair ? { id: pair.id, symbol: pair.symbol, mint: pair.mint, decimals: pair.decimals } : SOL_REF;
    // With modules switched off on this server, a token that has them still says so: they are on chain.
    const feeModules = modules ? modules.summary(row.mint) : moduleSummary(store, row.mint);
    return { ...summary(row, ref), modules: feeModules, image: displayImage(row.image, env.allowedOrigins, blockedArtwork) };
  };
  // The market's cards also carry each token's last day: a small chart and the change over it.
  const trends = new Trends(store);
  const listedWithTrend = (row: TokenRow): TokenSummary => ({ ...listed(row), ...trends.of(row) });

  let desk: Desk | undefined;
  let indexer: Indexer | undefined;
  let rings: { indexer: RingIndexer; store: RingStore; isRegistered: (owner: string) => Promise<boolean> } | undefined;
  let priority: PriorityOracle = fixedPriority(env.priorityMinMicroLamports);
  if (env.heliusRpcUrl) {
    const active = createChain(env, log, (addresses) => {
      // A pair's token was confirmed on chain: its tokens are listed from now on, and looked for.
      store.setListedConfigs(addresses);
      indexer?.discover();
    });
    chain = active;
    // Mainnet or nothing. An RPC on any other network stops the process; an RPC that is merely
    // unreachable does not, and every chain path re-checks before it is used.
    try {
      await active.assertNetwork();
      log('network: the RPC is Solana mainnet');
    } catch (error) {
      if (error instanceof WrongNetworkError) throw new EnvError(error.message);
      log(`network: the RPC did not answer (${error instanceof Error ? error.message : String(error)}). Nothing on chain is served until it confirms it is mainnet.`);
    }
    priority = startPriorityOracle(env, env.heliusRpcUrl, log);
    if (configuredTiers(env).length > 0) {
      indexer = startIndexer(active, store, env, log);
      const verify = (): void => {
        active.verifyTiers().catch((error: unknown) => {
          if (error instanceof WrongNetworkError) return;
          log(`tiers: could not be checked yet (${error instanceof Error ? error.message : String(error)}); retrying`);
          setTimeout(verify, 30_000).unref();
        });
      };
      verify();
    } else {
      log('No fee tier config is set yet. Run `npm run configs:plan`, then `npm run configs:apply yes mainnet`.');
    }
    desk = new Desk(env, active, store, log, priority);
    desk.start().catch((error) => log(`desk: failed to start: ${error instanceof Error ? error.message : String(error)}`));
    if (env.modules.enabled) {
      // A seed that does not match MODULES_GAS_TANK stops the process here, before anything is run with it.
      modules = new Modules(env, active, store, log, priority);
      modules.start();
    } else {
      log('modules: off. Set MODULES_ENABLED=YES (with MODULES_SEED, MODULES_GAS_TANK and MODULES_MAINNET_ACK) to let creators run buyback-and-burn and fee sharing from their fees.');
    }
    if (env.rings.enabled) {
      // The explorer follows the Rings program and only ever reads. It has a database of its own,
      // so nothing it stores sits next to the listing or the desk's ledger.
      const ringStore = new RingStore(env.dataDir);
      if (ringStore.startOver()) log('rings: the rows on disk were read by an earlier release, which read them differently. They were dropped and history is being read again.');
      const ringChain = createRingChain({ ...requireRpc(env), connection: active.connection });
      const wellKnown = new Map<string, { symbol: string; name: string }>([
        [WSOL_MINT, { symbol: 'SOL', name: 'Solana' }],
        ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', { symbol: 'USDT', name: 'Tether USD' }],
        ...env.pairs.map((pair): [string, { symbol: string; name: string }] => [pair.token.mint, { symbol: pair.token.symbol ?? pair.token.id, name: pair.token.name }]),
      ]);
      const ringIndexer = new RingIndexer(ringChain, ringStore, {
        pollSeconds: env.rings.pollSeconds,
        backfillDays: env.rings.backfillDays,
        wellKnown,
        listed(mints) {
          const found = new Map<string, { symbol: string; name: string; image: string }>();
          for (let start = 0; start < mints.length; start += 400) {
            for (const row of store.tokensByMints(mints.slice(start, start + 400))) {
              found.set(row.mint, { symbol: row.symbol, name: row.name, image: displayImage(row.image, env.allowedOrigins, blockedArtwork) });
            }
          }
          return found;
        },
        log,
      });
      ringIndexer.start();
      rings = { indexer: ringIndexer, store: ringStore, isRegistered: (owner) => ringChain.isRegistered(owner) };
    } else {
      log('rings: the explorer is off (RINGS_EXPLORER=NO). The Rings page says so.');
    }
    log(
      env.jupiterApiKey
        ? `convert: on. Tokens can be paid for in SOL or USDC whatever they are priced in, through Jupiter, at up to ${env.jupiterRps} request${env.jupiterRps === 1 ? '' : 's'} a second (JUPITER_RPS).`
        : 'convert: off. Set JUPITER_API_KEY to let people pay with SOL or USDC for a token priced in something else.',
    );
    if (env.jupiterApiKey) {
      log(
        env.swapAnyToken
          ? 'swap: on. A token that was not launched here can be bought and sold on the swap page, through Jupiter. SWAP_ANY_TOKEN=NO switches that off.'
          : 'swap: off (SWAP_ANY_TOKEN=NO). Only tokens launched here are traded; the swap page says so.',
      );
    }
  } else {
    log('HELIUS_API_KEY is not set. The site runs, but nothing on chain is reachable.');
  }

  const app = express();
  app.disable('x-powered-by');
  if (env.trustProxy > 0) app.set('trust proxy', env.trustProxy);
  if (env.clientIpHeader) app.set(CLIENT_IP_HEADER_SETTING, env.clientIpHeader);
  if (env.publicOrigin?.startsWith('https://')) app.set(HTTPS_ORIGIN_SETTING, true);
  app.use(securityHeaders);
  app.get('/healthz', (_request, response) => void response.json({ ok: true }));

  // A request from a page opened at an address this server was not told about is refused. The
  // usual cause is the operator's own second address (the hosting platform's next to a custom
  // domain), so the log says what to set. The value comes from a request header: it is cut to
  // printable characters, and each address is reported at most once a minute.
  const unlistedSeen = new Map<string, number>();
  const reportUnlisted = (origin: string): void => {
    const shown = origin.replace(/[^\x21-\x7e]/g, '?').slice(0, 120);
    const now = Date.now();
    if (now - (unlistedSeen.get(shown) ?? 0) < 60_000) return;
    if (unlistedSeen.size >= 100) unlistedSeen.clear();
    unlistedSeen.set(shown, now);
    log(`origin: refused a request from a page at ${shown}. This server answers ${env.allowedOrigins.join(' and ')}. If that is another address of this site, add it to EXTRA_ORIGINS and deploy again.`);
  };

  const api = express.Router();
  api.use(sameOrigin(env.allowedOrigins, reportUnlisted));
  api.use(proxyRouter(env, limiter, chain ? () => (chain as Chain).assertNetwork() : undefined));

  const originOf = (request: Request): string => env.publicOrigin ?? `${request.protocol}://${request.get('host') ?? 'localhost'}`;

  api.get('/status', (_request, response) => {
    const pairs = chain
      ? chain.pairs()
      : env.pairs.map((entry) => describePair(entry, env.economics, undefined, () => ({ live: false, problem: 'The RPC is not configured.' }), false));
    const body: StatusResponse = {
      release: RELEASE,
      network: env.network,
      ready: Boolean(chain && pairs.some((pair) => pair.live)),
      rpcConfigured: Boolean(env.heliusRpcUrl),
      tiers: FEE_TIERS.map((tier) => {
        const state = chain ? chain.tier(tier.feeBps) : { live: false, problem: env.configs[tier.feeBps] ? 'The RPC is not configured.' : 'Not created yet.' };
        return {
          id: tier.id,
          feeBps: tier.feeBps,
          label: tier.label,
          blurb: tier.blurb,
          config: env.configs[tier.feeBps] ?? null,
          live: state.live,
          problem: state.problem,
        };
      }),
      pairs,
      previousConfigs: chain ? chain.previousConfigs() : [],
      economics: env.economics,
      creatorPoolPayoutPct: env.creatorPoolPayoutPct,
      origins: env.allowedOrigins,
      priorityMicroLamports: priority.current(),
      slippage: { defaultBps: env.defaultSlippageBps, maxBps: env.maxSlippageBps },
      desk: desk ? desk.info() : { enabled: false, address: null, spreadBps: env.desk.spreadBps, maxOrderLamports: env.desk.maxOrderLamports.toString() },
      uploads: { pinned: Boolean(env.pinataJwt), maxImageBytes: MAX_IMAGE_BYTES },
      convert: { enabled: Boolean(chain && env.jupiterApiKey), assets: CONVERT_ASSETS, anyToken: Boolean(chain && env.jupiterApiKey && env.swapAnyToken) },
      modules: modules ? modules.info() : modulesOff(env),
      limits: {
        maxTradeLamports: env.maxTradeLamports.toString(),
        launchesPaused: env.pauseLaunches,
        tradingPaused: env.pauseTrading,
        notice: env.pauseMessage ?? null,
      },
    };
    response.setHeader('cache-control', 'no-store');
    response.json(body);
  });

  // The market's list, a page at a time, or one of two lookups a wallet makes:
  //   ?mints=a,b,c   the listed tokens among those mints (to name what a wallet holds)
  //   ?creator=x     the listed tokens that wallet launched (for its rewards)
  api.get('/tokens', (request, response) => {
    response.setHeader('cache-control', 'public, max-age=5');
    const one = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const mints = one(request.query.mints);
    if (mints) {
      const list = [...new Set(mints.split(',').map((mint) => mint.trim()).filter(Boolean))];
      if (list.length > 100 || list.some((mint) => !isAddress(mint))) return sendError(response, 400, 'BAD_REQUEST', 'mints must be at most 100 token addresses, separated by commas.');
      return void response.json({ tokens: store.tokensByMints(list).map(listed) });
    }
    const creator = one(request.query.creator);
    if (creator) {
      if (!isAddress(creator)) return sendError(response, 400, 'BAD_REQUEST', 'creator must be a wallet address.');
      return void response.json({ tokens: store.tokensByCreator(creator).map(listed) });
    }
    response.json(tokenPage(store, readPageRequest(request.query), listedWithTrend));
  });

  // The address this server takes a visitor to have. Per-visitor limits are only as good as this:
  // open it after deploying and compare with your own address (see CLIENT_IP_HEADER and TRUST_PROXY).
  api.get('/ip', (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.json({ ip: clientIp(request) });
  });

  api.get('/stats', (_request, response) => {
    const body: PlatformStats = store.totals();
    response.setHeader('cache-control', 'public, max-age=5');
    response.json(body);
  });

  api.get(
    '/tokens/:mint',
    asyncRoute(async (request, response) => {
      const mint = String(request.params.mint);
      if (!isAddress(mint)) return sendError(response, 400, 'BAD_MINT', 'That is not a token address.');
      let row = store.token(mint);
      if (!row) return sendError(response, 404, 'NOT_LISTED', 'This token was not launched here.');
      // A token whose modules were switched on before the listing first read it is noticed here, not a pass later.
      if (modules?.offered(mint, row.creator)) {
        await modules.adopt(mint).catch(() => undefined);
        row = store.token(mint) ?? row;
      }
      const history = store.snapshots(mint, Date.now() - 7 * 86_400_000).map((point) => ({ at: point.at, price: point.price_sol }));
      const body: TokenDetail = { ...listed(row), change24h: trends.of(row).change24h, history, module: moduleView(store, mint) };
      response.setHeader('cache-control', 'public, max-age=3');
      response.json(body);
    }),
  );

  // After a launch confirms, the client asks the server to read the new pool from chain. The same
  // call is how a token's fee modules are noticed at once: the page may send the settings memo it
  // has just put on chain, which counts only if the chain agrees with it.
  api.post(
    '/tokens/:mint/refresh',
    express.json({ limit: '4kb' }),
    asyncRoute(async (request, response) => {
      const mint = String(request.params.mint);
      if (!isAddress(mint)) return sendError(response, 400, 'BAD_MINT', 'That is not a token address.');
      if (!chain) return sendError(response, 503, 'NOT_CONFIGURED', 'The RPC is not configured on this server.');
      if (!limiter.take(`refresh:${clientIp(request)}`, 20, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests.');
      if (!indexer) return sendError(response, 503, 'NOT_CONFIGURED', 'No fee tier is configured on this server.');
      let row = await indexer.index(mint);
      if (row && modules) {
        const memo = (request.body as { memo?: unknown } | undefined)?.memo;
        const adopted = await modules.adopt(mint, typeof memo === 'string' ? memo : undefined).catch(() => undefined);
        if (adopted) row = store.token(mint);
      }
      response.json(row ? listed(row) : null);
    }),
  );

  /* ---------------- fee modules ---------------- */

  // Settings looked over before a launch is started: the shares, and what each wallet is on chain.
  api.post(
    '/modules/check',
    express.json({ limit: '4kb' }),
    asyncRoute(async (request, response) => {
      if (!modules) return sendError(response, 503, 'MODULES_OFF', 'Fee modules are not available on this server.');
      if (!limiter.take(`modules:${clientIp(request)}`, 20, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
      response.setHeader('cache-control', 'no-store');
      response.json(await modules.check(request.body ?? {}));
    }),
  );

  // A creator asks where the creator role must go for a set of module settings to apply.
  api.post(
    '/modules/prepare',
    express.json({ limit: '4kb' }),
    asyncRoute(async (request, response) => {
      if (!modules) return sendError(response, 503, 'MODULES_OFF', 'Fee modules are not available on this server.');
      if (!limiter.take(`modules:${clientIp(request)}`, 20, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
      response.setHeader('cache-control', 'no-store');
      response.json(await modules.prepare(request.body ?? {}));
    }),
  );

  // Every module and the gas tank, as anyone could read them from chain. `npm run modules:status` prints this.
  api.get(
    '/modules',
    asyncRoute(async (request, response) => {
      if (!limiter.take(`modules-list:${clientIp(request)}`, 30, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests.');
      response.setHeader('cache-control', 'no-store');
      response.json(modules ? await modules.overview() : { enabled: false, dryRun: false, everyMinutes: env.modules.everyMinutes, gasTank: { address: env.modules.gasTank ?? '', lamports: null }, modules: [] });
    }),
  );

  /* ---------------- uploads ---------------- */

  api.post(
    '/uploads/image',
    express.raw({ limit: MAX_IMAGE_BYTES + 1024, type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'] }),
    asyncRoute(async (request, response) => {
      if (env.pauseLaunches) return sendError(response, 503, 'LAUNCHES_PAUSED', env.pauseMessage ?? 'New launches are paused for now.');
      if (!Buffer.isBuffer(request.body)) return sendError(response, 415, 'BAD_IMAGE', 'Send the image bytes as the request body.');
      const url = await uploads.image(new Uint8Array(request.body), clientIp(request), originOf(request));
      response.json({ url });
    }),
  );

  api.post(
    '/uploads/metadata',
    express.json({ limit: '16kb' }),
    asyncRoute(async (request, response) => {
      if (env.pauseLaunches) return sendError(response, 503, 'LAUNCHES_PAUSED', env.pauseMessage ?? 'New launches are paused for now.');
      const result = await uploads.metadata(request.body ?? {}, clientIp(request), originOf(request));
      response.json({ uri: result.uri });
    }),
  );

  api.get('/metadata/:file', (request, response) => {
    const match = /^([a-f0-9]{32})\.json$/.exec(String(request.params.file));
    const row = match ? store.metadata(match[1] as string) : undefined;
    if (!row) return sendError(response, 404, 'NOT_FOUND', 'No such metadata.');
    response.setHeader('cache-control', 'public, max-age=31536000, immutable');
    response.setHeader('access-control-allow-origin', '*');
    response.json(metadataJson(row));
  });

  /* ---------------- Rings explorer ---------------- */

  api.use('/rings', ringsRouter({ rings, limiter }));
  api.use('/custom-rings', customRingsRouter());

  /* ---------------- desk ---------------- */

  const deskRoute = (work: (active: Desk, request: Request) => Promise<unknown>, limit: number) =>
    [
      express.json({ limit: '64kb' }),
      asyncRoute(async (request: Request, response: Response) => {
        if (!desk) return sendError(response, 503, 'DESK_OFF', 'Ghost fill is not available on this server.');
        if (env.pauseTrading) return sendError(response, 503, 'TRADING_PAUSED', env.pauseMessage ?? 'Trading through the site is paused for now.');
        if (!limiter.take(`desk:${clientIp(request)}`, limit, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
        response.setHeader('cache-control', 'no-store');
        response.json(await work(desk, request));
      }),
    ] as const;

  api.post('/desk/quote', ...deskRoute((active, request) => active.quote(request.body ?? {}), 60));
  api.post('/desk/prepare', ...deskRoute((active, request) => active.prepare(request.body ?? {}), 12));
  api.post('/desk/submit', ...deskRoute((active, request) => active.submit(request.body ?? {}), 12));

  /* ---------------- converting through Jupiter ---------------- */

  if (chain && env.jupiterApiKey) {
    const active = chain;
    api.use(
      '/convert',
      convertRouter(
        {
          apiKey: env.jupiterApiKey,
          requestsPerSecond: env.jupiterRps,
          maxSlippageBps: env.maxSlippageBps,
          // SOL and USDC, and every pair token the chain has confirmed. Nothing else is ever asked of Jupiter.
          mints: () => new Set([...CONVERT_ASSETS.map((asset) => asset.mint), ...active.pairs().filter((pair) => pair.problem === null).map((pair) => pair.mint)]),
          paused: () => (env.pauseTrading ? (env.pauseMessage ?? 'Trading through the site is paused for now.') : null),
          ready: () => active.assertNetwork(),
          // A token that was not launched here: any address on the side that is not SOL or USDC, held to the operator's limit.
          anyToken: env.swapAnyToken,
          cap: (mint) => baseCap(mint, env.maxTradeLamports, active.pairs()),
          log,
        },
        limiter,
      ),
    );
  }

  api.use((_request, response) => sendError(response, 404, 'NOT_FOUND', 'No such endpoint.'));
  app.use('/api', api);

  /* ---------------- static ---------------- */

  app.use('/u', express.static(uploads.directory, { immutable: true, maxAge: '365d', index: false, dotfiles: 'deny' }));

  // Artwork and metadata this server pinned, by IPFS identifier, at the path a gateway uses.
  // A file comes from disk. One that is missing is restored only if this server recorded it:
  // metadata is written out again from the database, artwork is fetched back from IPFS.
  const recordedMetadata = (cid: string) => store.metadataMentioning(cid).find((row) => cidOfUrl(row.uri) === cid);
  const recordedImage = (cid: string): string | undefined => store.imagesMentioning(cid).find((image) => cidOfUrl(image) === cid);
  const gatewayOrigins = new Set(artworkGateways.map((base) => new URL(base).origin));
  app.get(
    '/ipfs/:cid',
    asyncRoute(async (request, response) => {
      const cid = String(request.params.cid);
      const notFound = (): void => void response.status(404).type('text/plain').send('Not found');
      if (!isCid(cid) || artwork.isBlocked(cid)) return notFound();
      let file = artwork.file(cid);
      let source: string | undefined;
      if (!file) {
        // A file that is not on disk costs a database lookup and perhaps a fetch, so one visitor
        // gets only so many of those a minute. Files on disk are never limited.
        const tooMany = (): void => void response.status(429).type('text/plain').send('Too many requests');
        const visitor = clientIp(request);
        if (!limiter.take(`artwork-lookup:${visitor}`, 120, 60_000)) return tooMany();
        const metadata = recordedMetadata(cid);
        if (metadata) {
          file = artwork.put(cid, metadataBytes(metadata), 'json');
        } else {
          source = recordedImage(cid);
          if (source === undefined) return notFound();
          if (!limiter.take(`artwork-fetch:${visitor}`, 30, 60_000)) return tooMany();
          file = await artwork.pull(cid);
        }
      }
      if (!file) {
        // No copy here and no gateway answered this server. The visitor's own browser may still
        // reach the gateway the token names, so it is sent there. Only to a known gateway: an
        // address somebody typed into an upload is never a redirect target.
        try {
          if (source !== undefined && gatewayOrigins.has(new URL(source).origin)) {
            response.setHeader('cache-control', 'no-store');
            return void response.redirect(302, source);
          }
        } catch {
          // Not an address: fall through.
        }
        return notFound();
      }
      response.setHeader('content-type', file.mime);
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('cross-origin-resource-policy', 'cross-origin');
      // Stricter than the site's own policy: this is a file, never a page that runs anything.
      response.setHeader('content-security-policy', "default-src 'none'; sandbox");
      // Sent by name from the copies' own folder, so nothing about the path to DATA_DIR matters.
      response.sendFile(`${file.cid}.${file.kind}`, { root: artwork.directory, maxAge: '365d', immutable: true }, (error) => {
        if (error && !response.headersSent) notFound();
      });
    }),
  );

  const webRoot = [resolve(import.meta.dirname, '../../../web/dist'), resolve(import.meta.dirname, '../../web/dist')].find((path) => existsSync(path));
  if (webRoot) {
    // The docs are one page that draws each of its own, so every address under /docs is that page.
    app.get(/^\/docs\/[a-z0-9-]{1,64}\/?$/, (_request, response) => {
      response.sendFile('docs.html', { root: webRoot, maxAge: '5m' }, (error) => {
        if (error && !response.headersSent) response.status(404).type('text/plain').send('Not found');
      });
    });
    app.use(
      express.static(webRoot, {
        extensions: ['html'],
        maxAge: '5m',
        index: 'index.html',
        // Scripts, styles and fonts the build named after their contents are kept by the browser for good;
        // pages and plainly named files keep the five minutes above.
        setHeaders(response, path) {
          if (isHashedAsset(path)) response.setHeader('cache-control', 'public, max-age=31536000, immutable');
        },
      }),
    );
  } else {
    log('web/dist was not found. Run `npm run build:web` to build the client.');
  }
  app.use((_request, response) => void response.status(404).type('text/plain').send('Not found'));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof DeskError) return sendError(response, error.status, error.code, error.message);
    if (error instanceof ModulesError) return sendError(response, error.status, error.code, error.message);
    if (error instanceof UploadError) return sendError(response, error.status, 'UPLOAD', error.message);
    if (error instanceof GhostError) return sendError(response, 400, error.code, error.message);
    if (error instanceof MarketError) return sendError(response, error.code === 'NOT_LISTED' ? 404 : 409, error.code, error.message);
    const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
    if (status === 413) return sendError(response, 413, 'TOO_LARGE', 'The request is too large.');
    if (status === 400) return sendError(response, 400, 'BAD_REQUEST', 'The request body could not be read.');
    log(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    sendError(response, 500, 'INTERNAL', 'Something went wrong on the server.');
  });

  const server = app.listen(env.port, env.host, () => {
    log(`privacycash.fun ${RELEASE} listening on ${env.host}:${env.port} (Solana mainnet)`);
    if (env.allowedOrigins.length > 0) log(`origin: answering pages opened at ${env.allowedOrigins.join(' and ')}`);
    // Unset, the payout follows the curve share. After a change of split that is rarely what was meant.
    if (!env.creatorPoolPayoutExplicit && env.creatorPoolPayoutPct !== 30) {
      log(
        `fees: CREATOR_POOL_PAYOUT_PCT is not set, so it follows CREATOR_FEE_SHARE_PCT: the site tells creators they are paid ${env.creatorPoolPayoutPct}% of the pool fees after graduation. Set CREATOR_POOL_PAYOUT_PCT to what you pay.`,
      );
    }
    log(`artwork: ${artwork.count} file(s) on this server's disk, ${(artwork.totalBytes / 1_048_576).toFixed(1)} MB of ${Math.round(env.artworkCacheBytes / 1_048_576)} MB. Pages load token artwork from /ipfs on this site.`);
    if (env.pinataJwt) {
      const own = env.allowedOrigins.some((origin) => env.pinataGateway === `${origin}/ipfs`);
      log(
        `artwork: new tokens carry addresses under ${env.pinataGateway}${
          own
            ? ', which is this site'
            : env.pinataGateway === PUBLIC_PINATA_GATEWAY
              ? ". That is Pinata's shared public gateway, which Pinata throttles; wallets and explorers load logos from it. See PINATA_GATEWAY_URL in .env.example."
              : ''
        }`,
      );
    }
    // Copies this server does not hold yet: tokens launched before it kept copies, or a new disk.
    setTimeout(() => {
      void (async () => {
        const wanted = new Set<string>();
        for (const row of store.allTokens()) {
          const cid = cidOfUrl(row.image);
          if (cid && !artwork.file(cid) && !artwork.isBlocked(cid)) wanted.add(cid);
        }
        if (wanted.size === 0) return;
        let copied = 0;
        for (const cid of wanted) if (await artwork.pull(cid)) copied += 1;
        log(`artwork: ${copied} of ${wanted.size} missing file(s) copied from IPFS to this server's disk`);
      })().catch((error) => log(`artwork: copying missing files failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 1_500).unref();
  });
  const shutdown = (): void => {
    desk?.stop();
    modules?.stop();
    indexer?.stop();
    rings?.indexer.stop();
    priority.stop();
    server.close(() => {
      rings?.store.close();
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  if (error instanceof EnvError) console.error(`Configuration error: ${redact(error.message)}`);
  else console.error(redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exit(1);
});
