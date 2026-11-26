/**
 * The three fee tiers a creator picks from at launch.
 *
 * A tier is one immutable Meteora DBC config. The same percentage is charged on
 * the bonding curve and on the graduated DAMM v2 pool; there is no schedule and
 * no dynamic component, so the fee never moves in either phase.
 */

export const TIER_IDS = ['tier-200', 'tier-300', 'tier-400'] as const;
export type TierId = (typeof TIER_IDS)[number];

export interface FeeTier {
  readonly id: TierId;
  /** Trading fee in basis points, before and after graduation. */
  readonly feeBps: number;
  readonly label: string;
  /** Environment variable that holds this tier's on-chain config address. */
  readonly envKey: string;
  readonly blurb: string;
}

export const FEE_TIERS: readonly FeeTier[] = Object.freeze([
  { id: 'tier-200', feeBps: 200, label: '2%', envKey: 'DBC_CONFIG_200', blurb: 'Lowest friction. For tokens that want volume.' },
  { id: 'tier-300', feeBps: 300, label: '3%', envKey: 'DBC_CONFIG_300', blurb: 'Balanced. The default.' },
  { id: 'tier-400', feeBps: 400, label: '4%', envKey: 'DBC_CONFIG_400', blurb: 'Highest creator take per trade.' },
]);

export function tierById(id: string): FeeTier {
  const tier = FEE_TIERS.find((candidate) => candidate.id === id);
  if (!tier) throw new Error(`Unknown fee tier: ${id}`);
  return tier;
}

export function tierByFeeBps(feeBps: number): FeeTier | undefined {
  return FEE_TIERS.find((candidate) => candidate.feeBps === feeBps);
}

/** Meteora's fee denominator: a numerator of 1e9 is 100%. */
export const FEE_DENOMINATOR = 1_000_000_000;

/** Basis points -> Meteora fee numerator. 200 bps -> 20_000_000. */
export function feeNumeratorFromBps(feeBps: number): number {
  return (feeBps * FEE_DENOMINATOR) / 10_000;
}

/**
 * Launch economics shared by every tier. These are defaults; `ops/configs.ts`
 * prints the derived numbers for review before anything is created, and reads
 * overrides from `ops/economics.json` when that file exists.
 */
export interface LaunchEconomics {
  /** Fully diluted value at the first trade, in SOL. */
  readonly initialMarketCapSol: number;
  /** Fully diluted value at which the curve completes and migrates, in SOL. */
  readonly migrationMarketCapSol: number;
  /**
   * Creator's share (0-100) of each bonding-curve trading fee that is left
   * after Meteora's protocol share. It accrues to the creator on chain and
   * only the creator can claim it. The platform gets the rest.
   *
   * It says nothing about the graduated pool: there all liquidity is locked
   * and held by the platform (`PLATFORM_LOCKED_LIQUIDITY_PCT`).
   */
  readonly creatorFeeSharePct: number;
  /** Share of the raise taken as a migration fee (0-99). 0 means the whole raise becomes liquidity. */
  readonly migrationFeePct: number;
  /** Creator's share of that migration fee (0-100). */
  readonly creatorMigrationFeeSharePct: number;
}

/**
 * How large one pair's curve is, in whole units of that pair token: 30 and 420
 * for the SOL curve, a few thousand and tens of thousands for a dollar token.
 * The fee split and the migration fee are shared by every pair; only these two
 * numbers differ, because only they are priced in the pair token.
 */
export interface CurveSize {
  /** Fully diluted value at the first trade. */
  readonly initialMarketCap: number;
  /** Fully diluted value at which the curve completes and migrates. */
  readonly migrationMarketCap: number;
}

/** The SOL curve's size, which lives in the economics it has always lived in. */
export function solCurveSize(economics: Pick<LaunchEconomics, 'initialMarketCapSol' | 'migrationMarketCapSol'>): CurveSize {
  return { initialMarketCap: economics.initialMarketCapSol, migrationMarketCap: economics.migrationMarketCapSol };
}

export function checkCurveSize(size: CurveSize, label: string): CurveSize {
  if (!(size.initialMarketCap > 0) || !Number.isFinite(size.initialMarketCap)) {
    throw new Error(`${label}: the starting market cap must be positive.`);
  }
  if (!(size.migrationMarketCap > size.initialMarketCap) || !Number.isFinite(size.migrationMarketCap)) {
    throw new Error(`${label}: the graduation market cap must be greater than the starting market cap.`);
  }
  return Object.freeze({ initialMarketCap: size.initialMarketCap, migrationMarketCap: size.migrationMarketCap });
}

export const DEFAULT_ECONOMICS: LaunchEconomics = Object.freeze({
  initialMarketCapSol: 30,
  migrationMarketCapSol: 420,
  creatorFeeSharePct: 30,
  migrationFeePct: 0,
  creatorMigrationFeeSharePct: 0,
});

/**
 * Who holds the graduated pool's liquidity. All of it is locked for good and
 * all of it belongs to the platform's position: the creator holds none. What a
 * creator earns after graduation is paid by the platform out of the fees that
 * position collects (`splitPoolFees`), not by a position of the creator's own.
 */
export const PLATFORM_LOCKED_LIQUIDITY_PCT = 100;

/**
 * Meteora's own cut of every bonding-curve trading fee, in percent of the fee.
 * It is set by the DBC program, not by this platform (Meteora docs, "What is
 * DBC": 20% of the trading fee goes to the protocol; the remaining 80% is split
 * between partner and creator). The graduated pool has its own protocol share,
 * stored on the pool account; `npm run verify:graduated` prints it.
 */
export const METEORA_PROTOCOL_FEE_PCT = 20;

export interface FeeSplit {
  /** Percent of the whole trading fee, to one decimal place. */
  readonly creatorPct: number;
  readonly platformPct: number;
  readonly protocolPct: number;
}

/** Where a curve trading fee goes, as shares of the whole fee. */
export function feeSplit(economics: Pick<LaunchEconomics, 'creatorFeeSharePct'>): FeeSplit {
  const afterProtocol = 100 - METEORA_PROTOCOL_FEE_PCT;
  const creatorPct = Math.round(afterProtocol * economics.creatorFeeSharePct) / 100;
  return {
    creatorPct,
    platformPct: Math.round((afterProtocol - creatorPct) * 100) / 100,
    protocolPct: METEORA_PROTOCOL_FEE_PCT,
  };
}

/**
 * How one claim of graduated-pool fees is divided. The platform's locked
 * position collects all of it; `creatorPayoutPct` percent is the creator's,
 * rounded down to the base unit, and the rest stays with the platform.
 *
 * `lamports` is the claimed amount in base units of the pool's pair token:
 * lamports for a SOL pair, and the pair token's own smallest unit otherwise.
 */
export function splitPoolFees(lamports: bigint, creatorPayoutPct: number): { creator: bigint; platform: bigint } {
  if (!Number.isInteger(creatorPayoutPct) || creatorPayoutPct < 0 || creatorPayoutPct > 100) {
    throw new Error('The creator payout must be a whole percentage from 0 to 100.');
  }
  if (lamports < 0n) throw new Error('A fee amount cannot be negative.');
  const creator = (lamports * BigInt(creatorPayoutPct)) / 100n;
  return { creator, platform: lamports - creator };
}

export interface PoolClaimPlan {
  /** Base units of the pair token sent on to the token's creator in the same transaction as the claim. */
  readonly creator: bigint;
  /** Base units the platform keeps. */
  readonly platform: bigint;
  /**
   * Why the position is left unclaimed for now, or null when it should be
   * claimed. Fees that are not claimed are not lost: they stay in the pool,
   * owed to the position, and keep accruing.
   */
  readonly wait: 'nothing' | 'too-small' | 'creator-share-too-small' | null;
}

/**
 * Decides one claim of the platform's graduated-pool fees.
 *
 * A claim and the creator's payout always travel in one transaction, so there
 * is never a claimed amount whose creator share is still owed. That is why a
 * position whose creator share is below the smallest payout is not claimed at
 * all yet, rather than claimed with the share carried on a ledger.
 */
export function planPoolClaim(input: {
  readonly lamports: bigint;
  readonly creatorPayoutPct: number;
  /** The platform launched this token itself: there is nobody else to pay. */
  readonly creatorIsPlatform: boolean;
  readonly minClaimLamports: bigint;
  readonly minPayoutLamports: bigint;
}): PoolClaimPlan {
  const share = input.creatorIsPlatform
    ? { creator: 0n, platform: input.lamports < 0n ? 0n : input.lamports }
    : splitPoolFees(input.lamports < 0n ? 0n : input.lamports, input.creatorPayoutPct);
  if (input.lamports <= 0n) return { ...share, wait: 'nothing' };
  if (input.lamports < input.minClaimLamports) return { ...share, wait: 'too-small' };
  if (share.creator > 0n && share.creator < input.minPayoutLamports) return { ...share, wait: 'creator-share-too-small' };
  return { ...share, wait: null };
}

export function checkEconomics(input: LaunchEconomics): LaunchEconomics {
  const integer = (value: number, min: number, max: number, label: string) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    }
  };
  if (!(input.initialMarketCapSol > 0) || !Number.isFinite(input.initialMarketCapSol)) {
    throw new Error('initialMarketCapSol must be positive.');
  }
  if (!(input.migrationMarketCapSol > input.initialMarketCapSol) || !Number.isFinite(input.migrationMarketCapSol)) {
    throw new Error('migrationMarketCapSol must be greater than initialMarketCapSol.');
  }
  integer(input.creatorFeeSharePct, 0, 100, 'creatorFeeSharePct');
  integer(input.migrationFeePct, 0, 99, 'migrationFeePct');
  integer(input.creatorMigrationFeeSharePct, 0, 100, 'creatorMigrationFeeSharePct');
  return Object.freeze({ ...input });
}
