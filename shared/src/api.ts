/** Shapes the web client and the server exchange. Amounts are strings of base units. */

import type { Network } from './constants.js';
import type { LaunchEconomics, TierId } from './tiers.js';

export interface TierStatus {
  readonly id: TierId;
  readonly feeBps: number;
  readonly label: string;
  readonly blurb: string;
  /** On-chain config address, or null while the tier has not been created. Tokens on it can be traded. */
  readonly config: string | null;
  /**
   * True when new tokens can be launched on this tier: the config exists and
   * the server has confirmed, against the chain, that its own launch settings
   * are the ones the config was created with.
   */
  readonly live: boolean;
  /** Why the tier is not live, in a sentence. Null when it is. */
  readonly problem: string | null;
}

/** A pair token as a listed token carries it: enough to label and format every amount priced in it. */
export interface PairRef {
  /** `SOL`, `USDC`, ... */
  readonly id: string;
  /** The ticker as the token writes it: `hSOL`, not `HSOL`. */
  readonly symbol: string;
  readonly mint: string;
  readonly decimals: number;
}

/** One pair token a launch can be priced in, and whether it is switched on. */
export interface PairStatus extends PairRef {
  readonly name: string;
  /** SOL itself. Every other pair token is an SPL token held in a token account. */
  readonly native: boolean;
  /** What the asset is and whose promise it rests on. */
  readonly note: string;
  /**
   * The size of this pair's curves, in whole pair tokens: where the market cap
   * starts and where the curve graduates. Null while the operator has not set them.
   */
  readonly curve: { readonly initialMarketCap: number; readonly migrationMarketCap: number } | null;
  /**
   * How many whole pair tokens count as one SOL when tokens on different pairs
   * are ordered, added up or held to the per-trade limit. It comes from how the
   * curves were sized and is not a price. 1 for SOL, 0 while `curve` is null.
   */
  readonly unitsPerSol: number;
  /** This pair's three fee tiers. A tier's `config` is null until the operator has created it. */
  readonly tiers: readonly TierStatus[];
  /** True when at least one of its tiers can take new launches. */
  readonly live: boolean;
  /** Why no token can be launched or traded against this pair, in a sentence. Null when it can. */
  readonly problem: string | null;
  /**
   * Whether Meteora's keeper graduates this pair's completed curves by itself:
   * true, false, or null when that depends on things only Meteora and Jupiter decide.
   */
  readonly keeperGraduates: boolean | null;
  /** That rule in a sentence. Empty while `curve` is null. */
  readonly keeperNote: string;
  /** What a holder should know about who controls the pair token, read from its mint. */
  readonly holderNotes: readonly string[];
}

/** A config kept from an earlier set: its tokens trade and earn as before, and nothing new is launched on it. */
export interface PreviousConfigStatus {
  readonly address: string;
  /** The id of the pair token it is priced in. */
  readonly pairId: string;
  readonly feeBps: number;
  /** The creator's share (0-100) of each curve fee left after Meteora's cut, as this config was created. */
  readonly creatorFeeSharePct: number;
}

/**
 * Fee modules on this server: buyback and burn, and sharing fees between
 * wallets, run from a token's creator fees. See `shared/src/modules.ts`.
 */
export interface ModulesStatus {
  /** True when this server runs fee modules and a creator can switch them on. */
  readonly enabled: boolean;
  /** Minutes between two passes over the tokens that have modules. */
  readonly everyMinutes: number;
  /** The least a pass acts on, in lamports. For another pair token it applies at that pair's `unitsPerSol`. */
  readonly minLamports: string;
  /** The most one buyback spends, in lamports, on the same terms. */
  readonly maxBuyLamports: string;
  readonly maxWallets: number;
  readonly minShareBps: number;
}

/**
 * Fee module settings to be looked over before a token exists: the shares, and
 * what each wallet is on chain. Nothing is switched on and nothing is kept.
 */
export interface ModuleCheckRequest {
  readonly burnBps: number;
  readonly wallets: ReadonlyArray<{ readonly address: string; readonly bps: number }>;
}

/**
 * What a creator asks the server before switching modules on. Shares are in
 * hundredths of a percent and add up to 10000. The token must be listed, and
 * `dev` must be the wallet the chain names as its creator.
 */
export interface ModulePrepareRequest {
  readonly mint: string;
  /** The wallet that will sign: the token's creator. */
  readonly dev: string;
  readonly burnBps: number;
  readonly wallets: ReadonlyArray<{ readonly address: string; readonly bps: number }>;
}

/** The server's answer: where the creator role goes, and the memo that carries the settings. */
export interface ModulePrepareResponse {
  /** The wallet the server runs for this token with exactly these settings. The creator role is handed to it. */
  readonly wallet: string;
  /** The settings as one line of text. It goes into the transaction as a memo. */
  readonly memo: string;
}

/** One thing a module did, as the token's page shows it. */
export interface ModuleEventView {
  /** `payout`: fees divided between the wallets and the buyback pot. `buyback`: tokens bought and burned. `burn`: tokens burned without a buy. `setup`: token accounts opened. */
  readonly kind: 'payout' | 'buyback' | 'burn' | 'setup';
  readonly signature: string;
  readonly at: number;
  /** Base units of the pair token that moved: paid out, or spent on the buy. "0" when none. */
  readonly quote: string;
  /** Base units of the token itself that were burned. "0" when none. */
  readonly tokens: string;
}

/** A token's fee modules, as its page shows them. */
export interface ModuleView {
  /** The wallet that switched the modules on. */
  readonly dev: string;
  /** The wallet that holds the creator role now and collects the creator's fees. The server runs it. */
  readonly wallet: string;
  /** The wallet that holds the buyback share until it is spent. Null when nothing is burned. */
  readonly pot: string | null;
  readonly burnBps: number;
  readonly wallets: ReadonlyArray<{ readonly address: string; readonly bps: number }>;
  /** The settings exactly as the creator signed them. */
  readonly memo: string;
  readonly since: number;
  /** So far, in base units: pair token paid to the wallets, pair token spent on buybacks, and tokens burned. */
  readonly totals: { readonly paid: string; readonly spent: string; readonly burned: string };
  /** The latest things it did, newest first. */
  readonly events: readonly ModuleEventView[];
  /** When the server last looked at this token. 0 before the first pass. */
  readonly lastPassAt: number;
  /** True when the last pass could not finish for this token. It is tried again on the next one. */
  readonly stalled: boolean;
  /**
   * True when the payout is waiting because a sharing wallet has no account
   * for the pair token and the server will not open one: it does that once
   * per wallet, and that account was closed again. The payout goes ahead once
   * every sharing wallet holds such an account. Never true for a SOL pair.
   */
  readonly needsAccounts: boolean;
}

export interface StatusResponse {
  /** The release the server is running, for instance "v22". */
  readonly release: string;
  readonly network: Network;
  /** RPC configured, confirmed to be mainnet, and at least one tier live. */
  readonly ready: boolean;
  readonly rpcConfigured: boolean;
  /** The SOL pair's tiers. The same list is `pairs[0].tiers`. */
  readonly tiers: readonly TierStatus[];
  /** Every pair token this build knows, SOL first. A token can be launched against the live ones. */
  readonly pairs: readonly PairStatus[];
  /**
   * Configs kept from earlier sets, once the server has confirmed them on
   * chain. A token launched on one keeps the fee split that config was created
   * with, which may differ from `economics`.
   */
  readonly previousConfigs: readonly PreviousConfigStatus[];
  /** The fee split new launches get, shared by every pair, and the SOL curve's size. Other pairs' sizes are in `pairs`. */
  readonly economics: LaunchEconomics;
  /**
   * Percent of graduated-pool fees that this platform pays on to a token's
   * creator when it claims them. The platform holds all locked liquidity, so
   * this is the platform's payment, not a right the creator holds on chain.
   */
  readonly creatorPoolPayoutPct: number;
  /**
   * Every address this site answers at, the main one first. A page opened at
   * any other address can be read but cannot send anything. Empty when the
   * server has no PUBLIC_ORIGIN (local development), where any address works.
   */
  readonly origins: readonly string[];
  /**
   * The priority fee to attach right now, as a price in micro-lamports per
   * compute unit. Each transaction pays this times the units it reserves.
   */
  readonly priorityMicroLamports: number;
  readonly slippage: { readonly defaultBps: number; readonly maxBps: number };
  readonly desk: {
    readonly enabled: boolean;
    readonly address: string | null;
    /** Whether the desk wallet is registered with Rings. Absent when the desk is not configured. */
    readonly registered?: boolean;
    readonly spreadBps: number;
    /** The most the desk fills in one trade, on the SOL side of it. */
    readonly maxOrderLamports: string;
    /** How long the desk holds a quoted price, in milliseconds. */
    readonly quoteTtlMs?: number;
  };
  readonly uploads: { readonly pinned: boolean; readonly maxImageBytes: number };
  /**
   * Paying with, or being paid in, something other than a token's pair token.
   * `assets` are what can stand in: SOL and USDC. When `enabled` is false the
   * pages offer the pair token only. `anyToken` says whether a token that was
   * not launched here can be bought and sold with them too, on the swap page.
   */
  readonly convert: { readonly enabled: boolean; readonly assets: readonly PairRef[]; readonly anyToken: boolean };
  /** Fee modules: whether a creator can switch them on here, and the limits they run under. */
  readonly modules: ModulesStatus;
  /** Operator limits in force right now. They never apply to the wallet page. */
  readonly limits: {
    /**
     * Largest single trade or first buy through the site, in lamports. "0" means no cap.
     * For a token priced in another pair token the same limit applies at that pair's `unitsPerSol`.
     */
    readonly maxTradeLamports: string;
    readonly launchesPaused: boolean;
    readonly tradingPaused: boolean;
    /** The operator's own line about a pause, if they wrote one. */
    readonly notice: string | null;
  };
}

export interface TokenSummary {
  readonly mint: string;
  readonly pool: string;
  readonly feeBps: number;
  /**
   * The wallet that launched the token. For a token with fee modules this is
   * still that wallet, although the pool's creator role on chain is held by
   * the module's wallet (`TokenDetail.module.wallet`).
   */
  readonly creator: string;
  /**
   * Set when the token's creator fees run through fee modules: how much of
   * them is burned, and between how many wallets the rest is shared.
   */
  readonly modules: { readonly burnBps: number; readonly wallets: number } | null;
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly image: string;
  readonly website: string;
  readonly twitter: string;
  readonly stage: 'curve' | 'migrating' | 'graduated';
  /** What the token is priced and traded in. Every amount below is in this token. */
  readonly pair: PairRef;
  /** Pair tokens per whole token, as a decimal string. */
  readonly price: string;
  /** In whole pair tokens. */
  readonly marketCap: string;
  /** 0-1. */
  readonly progress: number;
  /** What the curve holds, in base units of the pair token. */
  readonly reserve: string;
  /** What the curve must hold to graduate, in base units of the pair token. */
  readonly threshold: string;
  /** Lifetime trading fees, in base units of the pair token. */
  readonly fees: string;
  /**
   * Traded since launch, in base units of the pair token: the lifetime fees
   * over the token's fee rate. This is the volume the pages show.
   */
  readonly volume: string;
  /** Traded in the last 24 hours, in base units of the pair token. What "Trending" is ordered by. */
  readonly volume24h: string;
  /** The token's supply on chain now, in base units (6 decimals). Empty until it has been read. */
  readonly supply: string;
  /** Base units destroyed by burning: the starting supply less the supply now. "0" when none, or not read yet. */
  readonly burned: string;
  readonly createdAt: number;
  /**
   * The price over the last 24 hours, oldest first: up to 32 evenly spaced
   * points, in the pair token, for the small chart on a card. A token first
   * seen less than a day ago has the time since then. Sent with the market's
   * pages only.
   */
  readonly spark?: readonly number[];
  /**
   * The price now against the price 24 hours ago, as a fraction: 0.12 is 12%
   * up. For a token first seen less than a day ago, against its first price.
   * Null when there is nothing to compare with. Sent with the market's pages
   * and a token's own page.
   */
  readonly change24h?: number | null;
}

/**
 * How a page of the market's list is ordered. `hot` is the most traded in the
 * last 24 hours, then the most traded since launch; `volume` is the most
 * traded since launch.
 */
export type TokenSort = 'hot' | 'new' | 'cap' | 'volume' | 'graduation';

export const TOKEN_SORTS: readonly TokenSort[] = ['hot', 'new', 'cap', 'volume', 'graduation'];

/** Tokens on one page of the market. A page never carries more. */
export const MARKET_PAGE_SIZE = 24;

/** One page of the market's list. */
export interface TokenPageResponse {
  readonly tokens: readonly TokenSummary[];
  /** Listed tokens that match the search, across all pages. */
  readonly total: number;
  /** This page's number, from 1. */
  readonly page: number;
  /** How many pages there are. At least 1. */
  readonly pages: number;
  /** Tokens per page. */
  readonly size: number;
}

export interface TokenDetail extends TokenSummary {
  /** Price points, in pair tokens per whole token. */
  readonly history: ReadonlyArray<{ readonly at: number; readonly price: string }>;
  /** The token's fee modules, with what they have done. Null when its creator claims the fees by hand. */
  readonly module: ModuleView | null;
}

/**
 * Totals over every listed token, in SOL terms (lamports). Tokens priced in
 * SOL count exactly. Tokens priced in another pair token count at that pair's
 * `unitsPerSol`, which comes from how its curve was sized and is not a live
 * price: with more than one pair in use these are approximations.
 */
export interface PlatformStats {
  readonly tokens: number;
  readonly reserveLamports: string;
  /** Traded on every listed token since its launch. This is the volume the front page shows. */
  readonly volumeLamports: string;
  readonly volume24hLamports: string;
  readonly feeLamports: string;
  readonly graduated: number;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
