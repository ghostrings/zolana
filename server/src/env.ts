/**
 * Environment parsing. Every value is validated once, here, and the rest of
 * the server works with the typed result. Secrets are never logged.
 */

import { PublicKey } from '@solana/web3.js';

import { HELIUS_RPC, NETWORK, type Network } from '../../shared/src/constants.js';
import { isCid } from '../../shared/src/ipfs.js';
import { PAIR_TOKENS, type PairToken, configEnvKey, curveEnvKeys, pairSymbol } from '../../shared/src/quotes.js';
import { type CurveSize, DEFAULT_ECONOMICS, FEE_TIERS, type LaunchEconomics, checkCurveSize, checkEconomics, solCurveSize } from '../../shared/src/tiers.js';

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

function text(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = text(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function flag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = text(env, key);
  if (raw === undefined) return false;
  if (raw === 'YES') return true;
  if (raw === 'NO') return false;
  throw new EnvError(`${key} must be exactly YES or NO.`);
}

/** A request header name, lower-cased. Only ordinary header characters are accepted. */
function headerName(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = text(env, key);
  if (raw === undefined) return undefined;
  const name = raw.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new EnvError(`${key} must be a header name, such as cf-connecting-ip.`);
  return name;
}

function publicKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = text(env, key);
  if (raw === undefined) return undefined;
  try {
    const parsed = new PublicKey(raw);
    if (parsed.toBase58() !== raw || parsed.equals(PublicKey.default)) throw new Error('non-canonical');
    return raw;
  } catch {
    throw new EnvError(`${key} must be a Solana address.`);
  }
}

function publicKeyList(env: NodeJS.ProcessEnv, key: string, max: number): string[] {
  const raw = text(env, key);
  if (raw === undefined) return [];
  const items = raw.split(/[\s,]+/).filter(Boolean);
  if (items.length > max) throw new EnvError(`${key} lists more than ${max} addresses.`);
  for (const item of items) {
    try {
      if (new PublicKey(item).toBase58() !== item) throw new Error('non-canonical');
    } catch {
      throw new EnvError(`${key} must be a comma-separated list of Solana addresses.`);
    }
  }
  return [...new Set(items)];
}

/** A short plain-text line shown to visitors. */
function notice(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = text(env, key);
  if (raw === undefined) return undefined;
  if (raw.length > 200 || /[<>\r\n]/.test(raw)) throw new EnvError(`${key} must be one line of plain text, at most 200 characters.`);
  return raw;
}

function lamports(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = text(env, key);
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]{0,18})$/.test(raw)) throw new EnvError(`${key} must be a whole number of lamports.`);
  return BigInt(raw);
}

export interface DeskEnv {
  readonly enabled: boolean;
  /** Base58 or JSON-array secret key of the desk wallet. Server only. */
  readonly secretKey: string | undefined;
  readonly spreadBps: number;
  readonly maxOrderLamports: bigint;
  readonly quoteTtlMs: number;
  /**
   * SOL value of inventory the desk keeps in each token listed in
   * `stockMints`, and half of the most it will ever hold of any one token.
   */
  readonly targetInventoryLamports: bigint;
  /** Seconds between restocking passes; each pass is jittered by up to half of this. */
  readonly rebalanceSeconds: number;
  readonly maxSlippageBps: number;
  /**
   * The largest price impact, in basis points, an order may have on the pool
   * and still be filled by the desk. The desk quotes at the pool's price
   * without moving the pool, so it only takes orders that are small next to
   * the pool's depth.
   */
  readonly maxImpactBps: number;
  /**
   * Mints the operator has chosen to keep stocked, so buys can be filled.
   * For every other token the desk holds nothing of its own accord: what it
   * receives from sellers it sells on within a few passes.
   */
  readonly stockMints: readonly string[];
  /**
   * Whether the desk merges a balance of its own that has split across more
   * notes than one fill can spend. Off until the operator has seen one
   * consolidation work on mainnet.
   */
  readonly autoConsolidate: boolean;
  /**
   * Wallets the desk does not trade with, by the operator's choice. It only
   * decides who the desk itself deals with: such a wallet can still use Rings
   * and trade on the pools, which nobody here can or does stop.
   */
  readonly blockedWallets: ReadonlySet<string>;
}

/** The Rings explorer: a read-only follower of the Rings program. On unless switched off. */
export interface RingsEnv {
  readonly enabled: boolean;
  /** Seconds between two reads of the program's new transactions. */
  readonly pollSeconds: number;
  /** How many days of history are read back, once, the first time it runs. */
  readonly backfillDays: number;
}

/** One pair token as the operator has set it up. */
export interface PairEnv {
  readonly token: PairToken;
  /**
   * The size of this pair's curves, in whole pair tokens. Undefined while the
   * operator has not chosen it, which is how a pair stays switched off. SOL
   * always has one.
   */
  readonly size: CurveSize | undefined;
  /** This pair's config address per fee tier, by fee in basis points. */
  readonly configs: Readonly<Record<number, string | undefined>>;
}

export interface AppEnv {
  /** Always mainnet. Kept as a field so every consumer names the network it runs on. */
  readonly network: Network;
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly publicOrigin: string | undefined;
  /** True when `publicOrigin` is this machine itself (http://localhost or 127.0.0.1). */
  readonly localOrigin: boolean;
  /**
   * Every address this site answers at: `publicOrigin` first, then the ones in
   * EXTRA_ORIGINS. Requests that change something are accepted only from
   * pages opened at one of these. Empty when PUBLIC_ORIGIN is not set.
   */
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: number;
  /**
   * A request header the hosting platform's edge sets to the visitor's
   * address, overwriting anything the visitor sent. Lower case. When set it
   * is used for rate limits instead of counting proxies.
   */
  readonly clientIpHeader: string | undefined;
  /** Full Helius RPC URL with the API key. Never sent to a browser. */
  readonly heliusRpcUrl: string | undefined;
  /** `…/v1/spr` on the same host, with the same key. */
  readonly heliusSprUrl: string | undefined;
  /** The SOL pair's config addresses, by fee in basis points. The same record is `pairs[0].configs`. */
  readonly configs: Readonly<Record<number, string | undefined>>;
  /**
   * Every pair token this build knows, SOL first, with what the operator has
   * set for it. A pair with no curve size and no config is simply not in use.
   */
  readonly pairs: readonly PairEnv[];
  /**
   * Configs kept from earlier sets (`DBC_CONFIGS_PREVIOUS`). A config can
   * never be edited, so changing the fee split means creating new configs;
   * the old ones go here so that every token launched on them stays listed,
   * tradable and claimable. Nothing new is launched on them.
   */
  readonly previousConfigs: readonly string[];
  readonly partnerWallet: string | undefined;
  /** The fee split new configs are created with, and the SOL curve's size. */
  readonly economics: LaunchEconomics;
  /**
   * Percent of the pool fees the platform's locked position collects that
   * `npm run fees:claim` sends on to each token's creator. A policy of this
   * deployment, not a term of any config: it is not on chain and can change.
   */
  readonly creatorPoolPayoutPct: number;
  /** False when CREATOR_POOL_PAYOUT_PCT is unset and the figure above was taken from CREATOR_FEE_SHARE_PCT. */
  readonly creatorPoolPayoutExplicit: boolean;
  readonly maxSlippageBps: number;
  readonly defaultSlippageBps: number;
  readonly pinataJwt: string | undefined;
  /**
   * The IPFS gateway written into token metadata, ending in `/ipfs`: a pinned
   * file's permanent address is this, a slash and its identifier. It may be
   * this site's own `<main address>/ipfs`, which this server answers itself.
   */
  readonly pinataGateway: string;
  /** Disk space this server's own copies of pinned artwork may take, in bytes. */
  readonly artworkCacheBytes: number;
  /** IPFS identifiers the operator has taken down: never stored, served or fetched here. */
  readonly artworkBlocklist: readonly string[];
  readonly uploadDailyLimit: number;
  /**
   * Each proof a browser requests is billed to this server's Helius key. These
   * bound that spend: per address per minute, and for the whole site per day.
   */
  readonly proofsPerMinutePerIp: number;
  readonly proofsDailyLimit: number;
  /**
   * Priority fee, as a price per compute unit in micro-lamports. The server
   * follows Helius's live estimate between these two bounds and falls back to
   * the lower one when no estimate is available.
   */
  readonly priorityMinMicroLamports: number;
  readonly priorityMaxMicroLamports: number;
  /**
   * Minutes between full scans for pools created under the platform's
   * configs. The scan walks Meteora's whole program, which is large on
   * mainnet, so it is a rare safety net: tokens launched through the site are
   * listed at once without it. 0 turns it off.
   */
  readonly discoveryMinutes: number;
  /**
   * Operator controls for a platform that is live with real funds.
   *
   * `maxTradeLamports` caps a single trade or first buy made through the site
   * (0 means no cap). It is a SOL amount; for a token priced in another pair
   * token it applies at the rate that pair's curve was sized at. The two pause
   * flags stop new launches or new trades from
   * the site while something is looked into. None of them touches the wallet
   * page: deposits, withdrawals and private transfers always stay available,
   * so nobody's funds are ever held by a pause.
   */
  readonly maxTradeLamports: bigint;
  readonly pauseLaunches: boolean;
  readonly pauseTrading: boolean;
  readonly pauseMessage: string | undefined;
  /**
   * Converting through Jupiter, so a token can be paid for in SOL or USDC
   * whatever it is priced in. On when a key is set (`JUPITER_API_KEY`, from
   * developers.jup.ag/portal). The key never leaves this server: pages ask
   * this server, and this server asks Jupiter.
   */
  readonly jupiterApiKey: string | undefined;
  /** Requests a second the key's plan allows (`JUPITER_RPS`). A free key allows 1. */
  readonly jupiterRps: number;
  /**
   * Whether a token that was not launched here can be bought and sold through
   * the site, on the swap page, through Jupiter. It needs the Jupiter key, and
   * is on whenever there is one: `SWAP_ANY_TOKEN=NO` switches it off and
   * leaves converting for tokens launched here as it was.
   */
  readonly swapAnyToken: boolean;
  readonly desk: DeskEnv;
  readonly modules: ModulesEnv;
  readonly rings: RingsEnv;
}

/**
 * Fee modules: what the server does with a token's creator fees when its
 * creator has handed that role to the platform (buy back and burn, pay wallet
 * shares). Off by default. Turning it on puts a secret on this server from
 * which one wallet per token is derived, and also needs MODULES_MAINNET_ACK=YES.
 */
export interface ModulesEnv {
  readonly enabled: boolean;
  /** Base58 of 32 random bytes (`npm run modules:new`). Every module wallet follows from it. Server only. */
  readonly seed: string | undefined;
  /**
   * The address of the wallet that pays the modules' network fees, which
   * `npm run modules:new` prints next to the seed. It is not a secret. The
   * server works the same address out from the seed and refuses to run
   * modules if the two differ: a seed pasted wrong, or replaced, would
   * otherwise lock every module's fees away without a word.
   */
  readonly gasTank: string | undefined;
  /** Minutes between passes over the module tokens. */
  readonly everyMinutes: number;
  /**
   * The least a pass acts on, in SOL terms (lamports): creator fees below it
   * stay where they are and keep accruing. For a token priced in another pair
   * token it applies at that pair's rate.
   */
  readonly minLamports: bigint;
  /** The most one buyback spends, in SOL terms. The rest waits for the next pass. */
  readonly maxBuyLamports: bigint;
  readonly slippageBps: number;
  /** Work everything out and log it, send nothing. */
  readonly dryRun: boolean;
}

/**
 * A third party's API key: sent as a header, so it must be one line of
 * printable characters. Anything else is a paste gone wrong and is said so
 * here, without the value being printed.
 */
function serviceKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = text(env, key);
  if (raw === undefined) return undefined;
  if (!/^[\x21-\x7e]{8,200}$/.test(raw)) throw new EnvError(`${key} does not look like an API key: it must be one line with no spaces. Paste it again.`);
  return raw;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * A bare origin (`https://privacycash.fun`). It is written into token metadata
 * addresses on mainnet, so it is checked strictly: https, with plain http
 * accepted only for this machine itself.
 */
function origin(env: NodeJS.ProcessEnv, key: string): { origin: string; local: boolean } | undefined {
  const raw = text(env, key);
  return raw === undefined ? undefined : parseOrigin(raw, key);
}

function parseOrigin(raw: string, key: string): { origin: string; local: boolean } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvError(`${key} must be a full origin such as https://privacycash.fun.`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new EnvError(`${key} must be an origin only: no path, query or credentials.`);
  }
  const local = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new EnvError(`${key} must use https. Plain http is accepted only for http://localhost or http://127.0.0.1.`);
  }
  return { origin: url.origin, local };
}

/** Pinata's shared public gateway. It works without an account and is throttled for everyone. */
export const PUBLIC_PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs';

/**
 * The gateway base written into token metadata. Those addresses are permanent,
 * so a value that would produce addresses nothing answers is refused here
 * instead of being discovered after a launch.
 */
function gatewayBase(env: NodeJS.ProcessEnv, key: string): string {
  const raw = text(env, key);
  if (raw === undefined) return PUBLIC_PINATA_GATEWAY;
  const example = 'https://your-gateway.mypinata.cloud/ipfs';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvError(`${key} must be a full address such as ${example}.`);
  }
  if (url.search || url.hash || url.username || url.password) throw new EnvError(`${key} must be an address only: no query or credentials.`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new EnvError(`${key} must use https.`);
  }
  if (url.pathname.replace(/\/+$/, '') !== '/ipfs') {
    throw new EnvError(`${key} must end in /ipfs, as in ${example}. A file's address is written as this, a slash and the file's identifier.`);
  }
  return `${url.origin}/ipfs`;
}

/** IPFS identifiers, separated by commas or spaces. */
function cidList(env: NodeJS.ProcessEnv, key: string, max: number): string[] {
  const raw = text(env, key);
  if (raw === undefined) return [];
  const items = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  if (items.length > max) throw new EnvError(`${key} lists more than ${max} identifiers.`);
  for (const item of items) {
    if (!isCid(item)) throw new EnvError(`${key} must list IPFS identifiers (the last part of an artwork address), separated by commas. "${item.slice(0, 80)}" is not one.`);
  }
  return items;
}

const MAX_EXTRA_ORIGINS = 8;

/**
 * Other addresses the same site is reachable at (EXTRA_ORIGINS), for instance
 * the hosting platform's own address next to a custom domain. Separated by
 * commas or spaces, and checked exactly like PUBLIC_ORIGIN.
 */
function extraOrigins(env: NodeJS.ProcessEnv, key: string, main: string | undefined): string[] {
  const raw = text(env, key);
  if (raw === undefined) return [];
  if (main === undefined) throw new EnvError(`${key} needs PUBLIC_ORIGIN: the site's main address goes there, and ${key} lists the others.`);
  const items = raw.split(/[\s,]+/).filter(Boolean);
  if (items.length > MAX_EXTRA_ORIGINS) throw new EnvError(`${key} lists more than ${MAX_EXTRA_ORIGINS} addresses.`);
  const seen = new Set<string>([main]);
  const extras: string[] = [];
  for (const item of items) {
    const parsed = parseOrigin(item, key).origin;
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    extras.push(parsed);
  }
  return extras;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  // Mainnet only. The variable is not needed; it is read so that a leftover
  // setting for another network stops the process instead of being ignored.
  const networkRaw = text(env, 'SOLANA_NETWORK');
  if (networkRaw !== undefined && networkRaw !== 'mainnet') {
    throw new EnvError(`SOLANA_NETWORK is set to "${networkRaw}". This build runs on Solana mainnet only: remove the variable or set it to mainnet.`);
  }
  const network: Network = NETWORK;

  const apiKey = text(env, 'HELIUS_API_KEY');
  const rpcOverride = text(env, 'SOLANA_RPC_URL');
  const sprOverride = text(env, 'SPR_URL');
  if (apiKey !== undefined && !/^[A-Za-z0-9-]{8,80}$/.test(apiKey)) throw new EnvError('HELIUS_API_KEY has an unexpected format.');
  for (const [key, value] of [['SOLANA_RPC_URL', rpcOverride], ['SPR_URL', sprOverride]] as const) {
    if (value !== undefined && /devnet|testnet/i.test(value)) {
      throw new EnvError(`${key} points at a test network. This build runs on Solana mainnet only.`);
    }
  }
  const heliusRpcUrl = rpcOverride ?? (apiKey ? `${HELIUS_RPC}/?api-key=${apiKey}` : undefined);
  const heliusSprUrl = sprOverride ?? (apiKey ? `${HELIUS_RPC}/v1/spr?api-key=${apiKey}` : undefined);

  const economics = checkEconomics({
    initialMarketCapSol: Number(text(env, 'CURVE_INITIAL_MARKET_CAP_SOL') ?? DEFAULT_ECONOMICS.initialMarketCapSol),
    migrationMarketCapSol: Number(text(env, 'CURVE_MIGRATION_MARKET_CAP_SOL') ?? DEFAULT_ECONOMICS.migrationMarketCapSol),
    creatorFeeSharePct: integer(env, 'CREATOR_FEE_SHARE_PCT', DEFAULT_ECONOMICS.creatorFeeSharePct, 0, 100),
    migrationFeePct: integer(env, 'MIGRATION_FEE_PCT', DEFAULT_ECONOMICS.migrationFeePct, 0, 99),
    creatorMigrationFeeSharePct: integer(env, 'CREATOR_MIGRATION_FEE_SHARE_PCT', DEFAULT_ECONOMICS.creatorMigrationFeeSharePct, 0, 100),
  });

  const configs: Record<number, string | undefined> = {};
  for (const tier of FEE_TIERS) configs[tier.feeBps] = publicKey(env, tier.envKey);
  const pairs = readPairs(env, economics, Object.freeze({ ...configs }));

  const deskEnabled = flag(env, 'GHOST_DESK_ENABLED');
  const deskSecret = text(env, 'DESK_SECRET_KEY');
  if (deskEnabled && deskSecret === undefined) throw new EnvError('GHOST_DESK_ENABLED=YES needs DESK_SECRET_KEY.');
  if (deskEnabled && !flag(env, 'GHOST_DESK_MAINNET_ACK')) {
    throw new EnvError(
      'The Ghost desk trades with real funds from a hot wallet on this server. It also needs GHOST_DESK_MAINNET_ACK=YES. Set it once you have read Part E of docs/MAINNET_RUNBOOK.md, and fund the desk only with what you can afford to lose.',
    );
  }

  // Configs kept from an earlier set. An address that is also a current config would be two things at once.
  const previousConfigs = publicKeyList(env, 'DBC_CONFIGS_PREVIOUS', 300);
  for (const pair of pairs) {
    for (const tier of FEE_TIERS) {
      const address = pair.configs[tier.feeBps];
      if (address && previousConfigs.includes(address)) {
        throw new EnvError(
          `${configEnvKey(tier, pair.token.id)} and DBC_CONFIGS_PREVIOUS both hold ${address}. A config is either the one new launches use or one kept from before, never both.`,
        );
      }
    }
  }

  const modulesEnabled = flag(env, 'MODULES_ENABLED');
  const modulesSeed = text(env, 'MODULES_SEED');
  if (modulesEnabled && modulesSeed === undefined) throw new EnvError('MODULES_ENABLED=YES needs MODULES_SEED. `npm run modules:new` makes one.');
  if (modulesSeed !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(modulesSeed)) {
    throw new EnvError('MODULES_SEED does not look like the value `npm run modules:new` prints: one line of base58. Paste it again.');
  }
  if (modulesEnabled && !flag(env, 'MODULES_MAINNET_ACK')) {
    throw new EnvError(
      'Fee modules move real funds from wallets this server controls. They also need MODULES_MAINNET_ACK=YES. Set it once you have read Part J of docs/MAINNET_RUNBOOK.md.',
    );
  }
  const modulesGasTank = publicKey(env, 'MODULES_GAS_TANK');
  if (modulesEnabled && modulesGasTank === undefined) {
    throw new EnvError(
      'MODULES_ENABLED=YES needs MODULES_GAS_TANK: the address `npm run modules:new` printed with the seed. It lets this server check that MODULES_SEED is the seed you made, whole and unchanged.',
    );
  }

  const maxSlippageBps = integer(env, 'MAX_SLIPPAGE_BPS', 1000, 1, 5000);
  const publicOrigin = origin(env, 'PUBLIC_ORIGIN');
  const priorityMinMicroLamports = integer(env, 'PRIORITY_FEE_MIN_MICROLAMPORTS', 20_000, 0, 50_000_000);
  const priorityMaxMicroLamports = integer(env, 'PRIORITY_FEE_MAX_MICROLAMPORTS', 2_000_000, 0, 50_000_000);
  if (priorityMaxMicroLamports < priorityMinMicroLamports) {
    throw new EnvError('PRIORITY_FEE_MAX_MICROLAMPORTS must not be lower than PRIORITY_FEE_MIN_MICROLAMPORTS.');
  }

  return Object.freeze({
    network,
    port: integer(env, 'PORT', 8080, 1, 65_535),
    host: text(env, 'HOST') ?? '0.0.0.0',
    dataDir: text(env, 'DATA_DIR') ?? './data',
    publicOrigin: publicOrigin?.origin,
    localOrigin: publicOrigin?.local ?? false,
    allowedOrigins: Object.freeze(publicOrigin ? [publicOrigin.origin, ...extraOrigins(env, 'EXTRA_ORIGINS', publicOrigin.origin)] : extraOrigins(env, 'EXTRA_ORIGINS', undefined)),
    trustProxy: integer(env, 'TRUST_PROXY', 0, 0, 5),
    clientIpHeader: headerName(env, 'CLIENT_IP_HEADER'),
    heliusRpcUrl,
    heliusSprUrl,
    configs: Object.freeze(configs),
    pairs,
    previousConfigs: Object.freeze(previousConfigs),
    partnerWallet: publicKey(env, 'PARTNER_WALLET'),
    economics,
    creatorPoolPayoutPct: integer(env, 'CREATOR_POOL_PAYOUT_PCT', economics.creatorFeeSharePct, 0, 100),
    creatorPoolPayoutExplicit: text(env, 'CREATOR_POOL_PAYOUT_PCT') !== undefined,
    maxSlippageBps,
    defaultSlippageBps: Math.min(integer(env, 'DEFAULT_SLIPPAGE_BPS', 100, 1, 5000), maxSlippageBps),
    pinataJwt: text(env, 'PINATA_JWT'),
    pinataGateway: gatewayBase(env, 'PINATA_GATEWAY_URL'),
    artworkCacheBytes: integer(env, 'ARTWORK_CACHE_MB', 500, 16, 1_000_000) * 1024 * 1024,
    artworkBlocklist: Object.freeze(cidList(env, 'ARTWORK_BLOCKLIST', 2000)),
    uploadDailyLimit: integer(env, 'UPLOAD_DAILY_LIMIT', 1000, 1, 1_000_000),
    proofsPerMinutePerIp: integer(env, 'PROOFS_PER_MINUTE_PER_IP', 12, 1, 600),
    proofsDailyLimit: integer(env, 'PROOFS_DAILY_LIMIT', 5000, 1, 10_000_000),
    priorityMinMicroLamports,
    priorityMaxMicroLamports,
    discoveryMinutes: integer(env, 'DISCOVERY_MINUTES', 10, 0, 1440),
    maxTradeLamports: lamports(env, 'MAX_TRADE_LAMPORTS', 0n),
    pauseLaunches: flag(env, 'PAUSE_LAUNCHES'),
    pauseTrading: flag(env, 'PAUSE_TRADING'),
    pauseMessage: notice(env, 'PAUSE_MESSAGE'),
    jupiterApiKey: serviceKey(env, 'JUPITER_API_KEY'),
    jupiterRps: integer(env, 'JUPITER_RPS', 1, 1, 150),
    // On by default: it asks nothing of the server but the relay it already runs. SWAP_ANY_TOKEN=NO switches it off.
    swapAnyToken: text(env, 'SWAP_ANY_TOKEN') === undefined ? true : flag(env, 'SWAP_ANY_TOKEN'),
    desk: Object.freeze({
      enabled: deskEnabled,
      secretKey: deskSecret,
      spreadBps: integer(env, 'DESK_SPREAD_BPS', 50, 0, 1000),
      maxOrderLamports: lamports(env, 'DESK_MAX_ORDER_LAMPORTS', 2_000_000_000n),
      quoteTtlMs: integer(env, 'DESK_QUOTE_TTL_MS', 20_000, 5_000, 60_000),
      targetInventoryLamports: lamports(env, 'DESK_TARGET_INVENTORY_LAMPORTS', 1_000_000_000n),
      rebalanceSeconds: integer(env, 'DESK_REBALANCE_SECONDS', 90, 15, 3600),
      maxSlippageBps: integer(env, 'DESK_MAX_SLIPPAGE_BPS', 150, 1, 2000),
      maxImpactBps: integer(env, 'DESK_MAX_IMPACT_BPS', 150, 10, 2000),
      stockMints: Object.freeze(publicKeyList(env, 'DESK_STOCK_MINTS', 50)),
      autoConsolidate: flag(env, 'DESK_AUTO_CONSOLIDATE'),
      // A mistyped address fails the start, loudly: a blocklist that silently drops an entry is worse than none.
      blockedWallets: new Set(publicKeyList(env, 'DESK_BLOCKED_WALLETS', 2_000)),
    }),
    rings: Object.freeze({
      // On by default: it only reads. RINGS_EXPLORER=NO switches it off.
      enabled: text(env, 'RINGS_EXPLORER') === undefined ? true : flag(env, 'RINGS_EXPLORER'),
      pollSeconds: integer(env, 'RINGS_POLL_SECONDS', 45, 15, 3600),
      backfillDays: integer(env, 'RINGS_BACKFILL_DAYS', 30, 0, 365),
    }),
    modules: Object.freeze({
      enabled: modulesEnabled,
      seed: modulesSeed,
      gasTank: modulesGasTank,
      everyMinutes: integer(env, 'MODULES_EVERY_MINUTES', 15, 5, 1440),
      minLamports: lamports(env, 'MODULES_MIN_LAMPORTS', 20_000_000n),
      maxBuyLamports: lamports(env, 'MODULES_MAX_BUY_LAMPORTS', 1_000_000_000n),
      slippageBps: integer(env, 'MODULES_SLIPPAGE_BPS', 100, 10, 1000),
      dryRun: flag(env, 'MODULES_DRY_RUN'),
    }),
  });
}

/**
 * What the operator has set for each pair token. SOL uses the settings it has
 * always used. Every other pair is switched on by two things: the size of its
 * curve (`CURVE_INITIAL_MARKET_CAP_<ID>`, `CURVE_MIGRATION_MARKET_CAP_<ID>`,
 * in whole pair tokens) and its config addresses (`DBC_CONFIG_<bps>_<ID>`).
 * A half-set pair stops the process here, with the name of what is missing.
 */
function readPairs(env: NodeJS.ProcessEnv, economics: LaunchEconomics, solConfigs: Readonly<Record<number, string | undefined>>): readonly PairEnv[] {
  const pairs: PairEnv[] = [];
  for (const token of PAIR_TOKENS) {
    if (token.native) {
      pairs.push(Object.freeze({ token, size: solCurveSize(economics), configs: solConfigs }));
      continue;
    }
    const ticker = pairSymbol(token);
    const keys = curveEnvKeys(token.id);
    const initial = text(env, keys.initial);
    const migration = text(env, keys.migration);
    const pairConfigs: Record<number, string | undefined> = {};
    let firstConfigKey: string | undefined;
    for (const tier of FEE_TIERS) {
      const key = configEnvKey(tier, token.id);
      pairConfigs[tier.feeBps] = publicKey(env, key);
      if (pairConfigs[tier.feeBps] && firstConfigKey === undefined) firstConfigKey = key;
    }
    if ((initial === undefined) !== (migration === undefined)) {
      throw new EnvError(`${keys.initial} and ${keys.migration} go together: set both, or neither to leave the ${ticker} pair off.`);
    }
    let size: CurveSize | undefined;
    if (initial !== undefined && migration !== undefined) {
      const plain = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
      if (!plain.test(initial) || !plain.test(migration)) {
        throw new EnvError(`${keys.initial} and ${keys.migration} must be plain numbers of ${ticker}, such as 2500 and 35000.`);
      }
      try {
        size = checkCurveSize({ initialMarketCap: Number(initial), migrationMarketCap: Number(migration) }, `${ticker} pair`);
      } catch (error) {
        throw new EnvError(`${keys.initial} / ${keys.migration}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (firstConfigKey !== undefined && size === undefined) {
      throw new EnvError(
        `${firstConfigKey} is set, so ${keys.initial} and ${keys.migration} are needed too: the curve size that config was created with. It is in the config's record file in ops/records.`,
      );
    }
    pairs.push(Object.freeze({ token, size, configs: Object.freeze(pairConfigs) }));
  }
  // A config is priced in one pair token and charges one fee: the same address cannot be two of them.
  const seen = new Map<string, string>();
  for (const pair of pairs) {
    for (const tier of FEE_TIERS) {
      const address = pair.configs[tier.feeBps];
      if (!address) continue;
      const key = configEnvKey(tier, pair.token.id);
      const earlier = seen.get(address);
      if (earlier !== undefined) throw new EnvError(`${key} and ${earlier} hold the same address. Every tier of every pair has its own config.`);
      seen.set(address, key);
    }
  }
  return Object.freeze(pairs);
}

/** Parses a secret key given as base58 or as a JSON array of 64 (or 32) bytes. */
export function parseSecretKey(raw: string, base58Decode: (text: string) => Uint8Array): Uint8Array {
  const trimmed = raw.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new EnvError('The secret key is not valid JSON.');
    }
    if (!Array.isArray(parsed) || parsed.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
      throw new EnvError('The secret key JSON must be an array of bytes.');
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    try {
      bytes = base58Decode(trimmed);
    } catch {
      throw new EnvError('The secret key is not valid base58.');
    }
  }
  if (bytes.length !== 64 && bytes.length !== 32) throw new EnvError('The secret key must be 64 bytes (or a 32-byte seed).');
  return bytes;
}

export function requireRpc(env: AppEnv): { rpcUrl: string; sprUrl: string } {
  if (!env.heliusRpcUrl || !env.heliusSprUrl) {
    throw new EnvError('Set HELIUS_API_KEY (or SOLANA_RPC_URL and SPR_URL) first.');
  }
  return { rpcUrl: env.heliusRpcUrl, sprUrl: env.heliusSprUrl };
}

/** Every config address the operator has set, across all pairs. */
export function configuredTiers(env: AppEnv): Array<{ feeBps: number; address: string; pairId: string }> {
  return env.pairs.flatMap((pair) =>
    FEE_TIERS.flatMap((tier) => {
      const address = pair.configs[tier.feeBps];
      return address ? [{ feeBps: tier.feeBps, address, pairId: pair.token.id }] : [];
    }),
  );
}
