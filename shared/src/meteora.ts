/**
 * Meteora: reads, quotes and instruction builders for the bonding curve (DBC)
 * and for graduated pools (DAMM v2).
 *
 * Everything here is public-chain activity by nature: a pool's reserves are
 * readable by anyone, so a swap against it reveals its size. Privacy is added
 * around these instructions by `routes.ts`, never inside them.
 */

import BN from 'bn.js';
import { type Connection, type Keypair, PublicKey, type Transaction, type TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  BaseFeeMode as DammBaseFeeMode,
  CpAmm,
  type PoolState as DammPoolState,
  SwapMode as DammSwapMode,
  decodePodAlignedFeeTimeScheduler,
  getBaseFeeModeFromPodAlignedData,
  getUnClaimLpFee,
} from '@meteora-ag/cp-amm-sdk';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  type PoolConfig,
  SwapMode,
  type VirtualPool,
  deriveDammV1MigrationMetadataAddress,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  getCurrentPoint,
  getPriceFromSqrtPrice,
  getQuoteFromInputAmount,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  INITIAL_SUPPLY_UNITS,
  TOKEN_DECIMALS,
  TOKEN_PROGRAM_ID,
  TOKEN_TOTAL_SUPPLY,
} from './constants.js';
import { type OnChainConfigLike, type TierConfigParameters, assertFeeGuarantee, feeTermsFromAccount } from './curve.js';
import type { TradingPair } from './quotes.js';
import { type FeeTier, FEE_DENOMINATOR, tierByFeeBps } from './tiers.js';
import { minusBps, plusBps } from './units.js';

export class MarketError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
  }
}

const ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
const SPL_TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);

export type Side = 'buy' | 'sell';
export type Stage = 'curve' | 'migrating' | 'graduated';

export interface Market {
  readonly mint: PublicKey;
  readonly pool: PublicKey;
  readonly configAddress: PublicKey;
  readonly config: PoolConfig;
  readonly state: VirtualPool;
  readonly tier: FeeTier;
  /** What the token is priced and traded in. Fixed by the config it was launched under. */
  readonly pair: TradingPair;
  readonly stage: Stage;
  readonly creator: PublicKey;
  /** Set once the curve has migrated. */
  readonly dammPool: PublicKey | null;
}

/** One of the platform's configs: which fee tier it is, and which pair token it is priced in. */
export interface AllowedConfig {
  readonly tier: FeeTier;
  readonly pair: TradingPair;
  /**
   * True for a config kept from an earlier set. Its tokens are listed, traded
   * and earn fees exactly as before; nothing new is launched on it.
   */
  readonly previous?: boolean;
}

/** The pair token's mint, as a key. */
export function quoteMintOf(market: Pick<Market, 'pair'>): PublicKey {
  return new PublicKey(market.pair.mint);
}

export function createDbc(connection: Connection): DynamicBondingCurveClient {
  return new DynamicBondingCurveClient(connection, 'confirmed');
}

/** Curve fee in basis points, read from the config account itself. */
export function configFeeBps(config: PoolConfig): number {
  const numerator = Number(config.poolFees.baseFee.cliffFeeNumerator.toString());
  return (numerator * 10_000) / FEE_DENOMINATOR;
}

/**
 * The creator's share (0-100) of what is left of each curve fee after
 * Meteora's cut, as this token's own config fixed it at launch. Configs
 * created at different times can carry different shares, so a page that shows
 * a token's split reads it from here, never from the settings new launches get.
 */
export function creatorFeeSharePctOf(market: Pick<Market, 'config'>): number {
  return Number(market.config.creatorTradingFeePercentage);
}

function stageOf(state: VirtualPool, config: PoolConfig): Stage {
  if (Number(state.poolState.isMigrated) !== 0) return 'graduated';
  // 0 pre-bonding curve, 1 post-bonding curve, 2 locked vesting, 3 created pool.
  if (Number(state.poolState.migrationProgress) !== 0) return 'migrating';
  // A curve that holds its whole target takes no more trades, whatever the progress field says.
  return state.poolState.quoteReserve.gte(config.migrationQuoteThreshold) ? 'migrating' : 'curve';
}

/**
 * Loads a launchpad market by mint. Only pools created under one of the
 * platform's own configs are accepted, and the config's fee terms are
 * re-asserted on every load, so a pool under a look-alike config cannot be
 * traded through this interface.
 *
 * A token's pool address follows from its mint, its config and its pair
 * token, so there is one candidate per config. They are read together, in one
 * request however many pairs there are.
 */
export async function loadMarket(
  dbc: DynamicBondingCurveClient,
  mint: PublicKey,
  allowedConfigs: ReadonlyMap<string, AllowedConfig>,
): Promise<Market> {
  const candidates = [...allowedConfigs.entries()].map(([configAddress, allowed]) => ({
    allowed,
    pool: deriveDbcPoolAddress(new PublicKey(allowed.pair.mint), mint, new PublicKey(configAddress)),
  }));
  const states = await loadPoolStates(dbc, dbc.connection, candidates.map((candidate) => candidate.pool));
  const at = states.findIndex((state) => state !== null);
  const state = at === -1 ? null : (states[at] as VirtualPool);
  const candidate = at === -1 ? undefined : candidates[at];
  if (!state || !candidate) throw new MarketError('NOT_LISTED', 'This mint was not launched on privacycash.fun.');
  const configAddress = state.poolState.config;
  const allowed = allowedConfigs.get(configAddress.toBase58());
  if (!allowed) throw new MarketError('NOT_LISTED', 'This pool uses a config that is not one of the platform tiers.');
  const config = await dbc.state.getPoolConfig(configAddress);
  if (!config) throw new MarketError('CONFIG_MISSING', 'The pool config account could not be read.');
  return marketFromAccounts({ mint, pool: candidate.pool, state, config, tier: allowed.tier, pair: allowed.pair });
}

/**
 * Builds a market from accounts already read from chain, with the same checks
 * `loadMarket` makes. The pool must belong to `config`, and `config` must be
 * the account of `tier`.
 */
export function marketFromAccounts(input: {
  readonly mint: PublicKey;
  readonly pool: PublicKey;
  readonly state: VirtualPool;
  readonly config: PoolConfig;
  readonly tier: FeeTier;
  readonly pair: TradingPair;
}): Market {
  const { mint, pool, state, config, tier, pair } = input;
  if (!state.poolState.baseMint.equals(mint)) throw new MarketError('WRONG_POOL', 'That pool is for a different mint.');
  assertFeeGuarantee(feeTermsFromAccount(config as unknown as OnChainConfigLike), tier);
  // The config account itself says what the pool is priced in. It must be the pair this config is listed under.
  if (config.quoteMint.toBase58() !== pair.mint) {
    throw new MarketError('WRONG_QUOTE', `This pool is not priced in ${pair.symbol}, the pair its config is listed under.`);
  }
  const stage = stageOf(state, config);
  return {
    mint,
    pool,
    configAddress: state.poolState.config,
    config,
    state,
    tier,
    pair,
    stage,
    creator: state.poolState.creator,
    dammPool: stage === 'graduated' ? graduatedPoolAddress(config, mint) : null,
  };
}

/** The DAMM v2 pool a curve migrates into. */
export function graduatedPoolAddress(config: PoolConfig, mint: PublicKey): PublicKey {
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[Number(config.migrationFeeOption)];
  if (!dammConfig) throw new MarketError('NO_DAMM_CONFIG', 'This config has no DAMM v2 migration config.');
  return deriveDammV2PoolAddress(new PublicKey(dammConfig), mint, config.quoteMint);
}

/* ------------------------------------------------------------------ */
/* Display numbers                                                     */
/* ------------------------------------------------------------------ */

/** Display numbers for a market. Amounts are in the market's pair token: whole units where it says so, base units otherwise. */
export interface MarketStats {
  /** Pair tokens per whole token, as a decimal string. */
  readonly price: string;
  /** In whole pair tokens, at the launch supply. */
  readonly marketCap: string;
  /** 0-1: quote reserve over the migration threshold. */
  readonly progress: number;
  /** Base units of the pair token held by the curve. */
  readonly quoteReserve: string;
  readonly migrationThreshold: string;
  /** Lifetime trading fees taken in the pair token (creator + platform share, protocol share excluded), in base units. */
  readonly tradingFee: string;
  readonly creatorClaimable: string;
  readonly partnerClaimable: string;
}

export function curveStats(market: Market): MarketStats {
  const price = getPriceFromSqrtPrice(market.state.poolState.sqrtPrice, TOKEN_DECIMALS, market.pair.decimals);
  const threshold = market.config.migrationQuoteThreshold;
  const reserve = market.state.poolState.quoteReserve;
  const progress = threshold.isZero() ? 0 : Math.min(1, Number(reserve.mul(new BN(1_000_000)).div(threshold).toString()) / 1_000_000);
  return {
    price: price.toFixed(12),
    marketCap: price.mul(TOKEN_TOTAL_SUPPLY).toFixed(6),
    progress: market.stage === 'curve' ? progress : 1,
    quoteReserve: reserve.toString(),
    migrationThreshold: threshold.toString(),
    tradingFee: market.state.poolState.metrics.totalTradingQuoteFee.toString(),
    creatorClaimable: market.state.poolState.creatorQuoteFee.toString(),
    partnerClaimable: market.state.poolState.partnerQuoteFee.toString(),
  };
}

/* ------------------------------------------------------------------ */
/* Quotes                                                              */
/* ------------------------------------------------------------------ */

export interface TradeQuote {
  readonly side: Side;
  readonly venue: 'curve' | 'damm-v2';
  /** Exact-in trades fix `amountIn`; exact-out trades fix `amountOut`. */
  readonly mode: 'exact-in' | 'exact-out';
  /** Base units of the input asset (the pair token for a buy, the token itself for a sell). */
  readonly amountIn: bigint;
  /** Base units of the output asset. */
  readonly amountOut: bigint;
  /** Exact-in: the least output accepted. */
  readonly minimumAmountOut: bigint;
  /** Exact-out: the most input accepted. */
  readonly maximumAmountIn: bigint;
  /** Total fee taken from the trade, in base units of the pair token, at the tier rate. */
  readonly fee: bigint;
  readonly feeBps: number;
  readonly slippageBps: number;
  /** True for the buy that takes everything a curve has left, which completes it. */
  readonly completesCurve?: boolean;
}

const big = (value: BN): bigint => BigInt(value.toString());

/**
 * Whether an SDK quote failed because the curve has nothing more to give in
 * that direction: a buy past the graduation price, or a sell past the start.
 */
function exceedsCurve(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /insufficient|not enough liquidity|amount left is not zero/i.test(text);
}

const BUY_TOO_LARGE = 'This is more than the curve has left before it graduates. Reduce the amount.';
const SELL_TOO_LARGE = 'The curve cannot fill this size. Reduce the amount.';
const bn = (value: bigint): BN => new BN(value.toString());

export interface QuoteRequest {
  readonly side: Side;
  readonly mode: 'exact-in' | 'exact-out';
  /** The fixed amount: input for exact-in, output for exact-out. */
  readonly amount: bigint;
  readonly slippageBps: number;
}

/** A quote against the bonding curve, using the SDK's port of the program's own math. */
export async function quoteCurve(
  dbc: DynamicBondingCurveClient,
  connection: Connection,
  market: Market,
  request: QuoteRequest,
): Promise<TradeQuote> {
  if (market.stage !== 'curve') throw new MarketError('CURVE_CLOSED', 'This curve is complete.');
  if (request.amount <= 0n) throw new MarketError('BAD_AMOUNT', 'Enter an amount greater than zero.');
  const currentPoint = await getCurrentPoint(connection, market.config.activationType);
  if (currentPoint.lt(market.state.poolState.activationPoint)) throw new MarketError('NOT_ACTIVE', 'This pool is not active yet.');
  const selling = request.side === 'sell';
  const common = {
    virtualPool: market.state,
    config: market.config,
    swapBaseForQuote: selling,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps: request.slippageBps,
  };
  const tooLarge = new MarketError('TOO_LARGE', selling ? SELL_TOO_LARGE : BUY_TOO_LARGE);
  const quoted = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (exceedsCurve(error)) throw tooLarge;
      throw error;
    }
  };
  if (request.mode === 'exact-in') {
    const result = quoted(() => dbc.pool.swapQuote2({ ...common, swapMode: SwapMode.ExactIn, amountIn: bn(request.amount) }));
    if (!result.amountLeft.isZero()) throw tooLarge;
    const out = big(result.outputAmount);
    if (out <= 0n) throw new MarketError('DUST', 'This trade is too small to return anything.');
    return {
      side: request.side,
      venue: 'curve',
      mode: 'exact-in',
      amountIn: request.amount,
      amountOut: out,
      minimumAmountOut: result.minimumAmountOut ? big(result.minimumAmountOut) : minusBps(out, request.slippageBps),
      maximumAmountIn: request.amount,
      fee: big(result.tradingFee.add(result.protocolFee).add(result.referralFee)),
      feeBps: market.tier.feeBps,
      slippageBps: request.slippageBps,
    };
  }
  const result = quoted(() => dbc.pool.swapQuote2({ ...common, swapMode: SwapMode.ExactOut, amountOut: bn(request.amount) }));
  const amountIn = big(result.includedTransferFeeAmountIn);
  if (amountIn <= 0n) throw new MarketError('DUST', 'This trade is too small.');
  return {
    side: request.side,
    venue: 'curve',
    mode: 'exact-out',
    amountIn,
    amountOut: request.amount,
    minimumAmountOut: request.amount,
    maximumAmountIn: result.maximumAmountIn ? big(result.maximumAmountIn) : plusBps(amountIn, request.slippageBps),
    fee: big(result.tradingFee.add(result.protocolFee).add(result.referralFee)),
    feeBps: market.tier.feeBps,
    slippageBps: request.slippageBps,
  };
}

/**
 * The buy that completes a curve, or null when `maxQuoteIn` does not cover
 * what the curve has left.
 *
 * A curve stops selling at its graduation price. A buy for more of the pair token than it
 * has room for cannot be filled as asked, and a buy sized inside the room
 * always leaves a little behind, so without this nobody could finish a curve
 * from a private balance. The quote is exact-out for every token the curve
 * still sells: a deposit that follows can name that amount, and the swap ends
 * exactly on the graduation price. If somebody else buys first, those tokens
 * are no longer there and the whole transaction fails without moving anything.
 * If somebody sells first, it costs less and the curve stays open.
 *
 * Pure: `currentPoint` is the slot or time the pool's activation is measured in.
 */
export function closingBuy(
  dbc: DynamicBondingCurveClient,
  market: Market,
  currentPoint: BN,
  maxQuoteIn: bigint,
  slippageBps: number,
): TradeQuote | null {
  if (market.stage !== 'curve' || maxQuoteIn <= 0n) return null;
  if (currentPoint.lt(market.state.poolState.activationPoint)) return null;
  const common = {
    virtualPool: market.state,
    config: market.config,
    swapBaseForQuote: false,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps,
  };
  const fill = dbc.pool.swapQuote2({ ...common, swapMode: SwapMode.PartialFill, amountIn: bn(maxQuoteIn) });
  // Everything offered was used: the curve has at least this much room, so this is an ordinary buy.
  if (fill.amountLeft.isZero()) return null;
  const tokens = big(fill.outputAmount);
  if (tokens <= 0n) return null;
  const exact = dbc.pool.swapQuote2({ ...common, swapMode: SwapMode.ExactOut, amountOut: bn(tokens) });
  const cost = big(exact.includedTransferFeeAmountIn);
  if (cost <= 0n || cost > maxQuoteIn) return null;
  const ceiling = plusBps(cost, slippageBps);
  return {
    side: 'buy',
    venue: 'curve',
    mode: 'exact-out',
    amountIn: cost,
    amountOut: tokens,
    minimumAmountOut: tokens,
    maximumAmountIn: ceiling > maxQuoteIn ? maxQuoteIn : ceiling,
    fee: big(exact.tradingFee.add(exact.protocolFee).add(exact.referralFee)),
    feeBps: market.tier.feeBps,
    slippageBps,
    completesCurve: true,
  };
}

/** `closingBuy` against the chain's current slot or time. */
export async function quoteCurveClose(
  dbc: DynamicBondingCurveClient,
  connection: Connection,
  market: Market,
  maxQuoteIn: bigint,
  slippageBps: number,
): Promise<TradeQuote | null> {
  if (market.stage !== 'curve' || maxQuoteIn <= 0n) return null;
  const currentPoint = await getCurrentPoint(connection, market.config.activationType);
  return closingBuy(dbc, market, currentPoint, maxQuoteIn, slippageBps);
}

/**
 * The exact output of the very first buy on a pool that does not exist yet.
 * The pool starts at the config's start price and the fee is constant, so this
 * is deterministic as long as the buy shares a transaction with pool creation.
 * `quoteIn` and the fee are in base units of the config's pair token.
 */
export function quoteFirstBuy(config: TierConfigParameters, quoteIn: bigint): { tokensOut: bigint; fee: bigint } {
  if (quoteIn <= 0n) throw new MarketError('BAD_AMOUNT', 'The first buy must be greater than zero.');
  const tooLarge = new MarketError('TOO_LARGE', 'The first buy is larger than the whole curve. Choose a smaller one.');
  let result: ReturnType<typeof getQuoteFromInputAmount>;
  try {
    result = getQuoteFromInputAmount({
      config,
      swapBaseForQuote: false,
      amountIn: bn(quoteIn),
      swapMode: SwapMode.ExactIn,
      hasReferral: false,
    });
  } catch (error) {
    if (exceedsCurve(error)) throw tooLarge;
    throw error;
  }
  if (!result.amountLeft.isZero()) throw tooLarge;
  return {
    tokensOut: big(result.outputAmount),
    fee: big(result.tradingFee.add(result.protocolFee).add(result.referralFee)),
  };
}

/* ------------------------------------------------------------------ */
/* Instructions                                                        */
/* ------------------------------------------------------------------ */

/**
 * Makes every associated-token-account creation idempotent. Meteora's builders
 * add a create instruction when the account is missing at build time; in a
 * composed transaction an earlier instruction may already have created it.
 */
export function makeAtaCreatesIdempotent(instructions: readonly TransactionInstruction[]): TransactionInstruction[] {
  return instructions.map((instruction) => {
    if (!instruction.programId.equals(ATA_PROGRAM)) return instruction;
    const isCreate = instruction.data.length === 0 || instruction.data[0] === 0;
    if (!isCreate) return instruction;
    return Object.assign(Object.create(Object.getPrototypeOf(instruction) as object) as TransactionInstruction, instruction, {
      data: Buffer.from([1]),
    });
  });
}

function instructionsOf(transaction: Transaction): TransactionInstruction[] {
  // Compute budget instructions are dropped: a v1 message carries its limits in the header.
  const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
  return makeAtaCreatesIdempotent(
    transaction.instructions.filter((instruction) => instruction.programId.toBase58() !== COMPUTE_BUDGET),
  );
}

/**
 * Swap on the bonding curve. `owner` pays and receives. For a SOL pair the SOL
 * is wrapped and unwrapped inside; any other pair token moves through
 * `owner`'s ordinary token account for it, which is created if it is missing.
 *
 * `rentPayer` pays the rent of any token account the swap has to open. It is
 * `owner` unless another address is given, which must then sign as well.
 */
export async function curveSwapInstructions(
  dbc: DynamicBondingCurveClient,
  market: Market,
  owner: PublicKey,
  quote: TradeQuote,
  rentPayer: PublicKey = owner,
): Promise<TransactionInstruction[]> {
  if (quote.venue !== 'curve') throw new MarketError('WRONG_VENUE', 'This quote is not for the bonding curve.');
  const base = {
    owner,
    payer: rentPayer,
    pool: market.pool,
    swapBaseForQuote: quote.side === 'sell',
    referralTokenAccount: null,
  };
  const transaction =
    quote.mode === 'exact-in'
      ? await dbc.pool.swap2({
          ...base,
          swapMode: SwapMode.ExactIn,
          amountIn: bn(quote.amountIn),
          minimumAmountOut: bn(quote.minimumAmountOut),
        })
      : await dbc.pool.swap2({
          ...base,
          swapMode: SwapMode.ExactOut,
          amountOut: bn(quote.amountOut),
          maximumAmountIn: bn(quote.maximumAmountIn),
        });
  return instructionsOf(transaction);
}

export interface CreatePoolInput {
  readonly configAddress: PublicKey;
  readonly baseMint: PublicKey;
  readonly creator: PublicKey;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  /** Base units of the config's pair token for an optional first buy in the same transaction. 0 for none. */
  readonly firstBuy: bigint;
  /** Exact tokens the first buy must return; from `quoteFirstBuy`. */
  readonly firstBuyTokensOut: bigint;
}

/** Create the pool (and mint), optionally followed by the creator's first buy. `baseMint` must sign. */
export async function createPoolInstructions(
  dbc: DynamicBondingCurveClient,
  input: CreatePoolInput,
): Promise<TransactionInstruction[]> {
  const createPoolParam = {
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    payer: input.creator,
    poolCreator: input.creator,
    config: input.configAddress,
    baseMint: input.baseMint,
  };
  if (input.firstBuy <= 0n) {
    return instructionsOf(await dbc.creator.createPool(createPoolParam));
  }
  const transaction = await dbc.creator.createPoolWithFirstBuy({
    createPoolParam,
    firstBuyParam: {
      buyer: input.creator,
      buyAmount: bn(input.firstBuy),
      minimumAmountOut: bn(input.firstBuyTokensOut),
      referralTokenAccount: null,
    },
  });
  return instructionsOf(transaction);
}

/**
 * Claim the creator's share of curve trading fees. It is paid in the pair
 * token: as SOL to the creator's wallet for a SOL pair, and into the creator's
 * token account for any other. `amount` is in base units of the pair token.
 */
export async function claimCreatorFeeInstructions(
  dbc: DynamicBondingCurveClient,
  market: Market,
  creator: PublicKey,
): Promise<{ instructions: TransactionInstruction[]; amount: bigint }> {
  if (!market.creator.equals(creator)) throw new MarketError('NOT_CREATOR', 'Only the pool creator can claim creator fees.');
  const amount = big(market.state.poolState.creatorQuoteFee);
  if (amount <= 0n) throw new MarketError('NOTHING_TO_CLAIM', 'There are no creator fees to claim yet.');
  const transaction = await dbc.creator.claimCreatorTradingFee({
    creator,
    payer: creator,
    pool: market.pool,
    maxBaseAmount: new BN(0),
    maxQuoteAmount: market.state.poolState.creatorQuoteFee,
  });
  return { instructions: instructionsOf(transaction), amount };
}

/** Claim the platform's share of curve trading fees, in the pair token. */
export async function claimPartnerFeeInstructions(
  dbc: DynamicBondingCurveClient,
  market: Market,
  feeClaimer: PublicKey,
): Promise<{ instructions: TransactionInstruction[]; amount: bigint }> {
  const amount = big(market.state.poolState.partnerQuoteFee);
  if (amount <= 0n) throw new MarketError('NOTHING_TO_CLAIM', 'There are no platform fees to claim on this pool.');
  const transaction = await dbc.partner.claimPartnerTradingFee({
    feeClaimer,
    payer: feeClaimer,
    pool: market.pool,
    maxBaseAmount: new BN(0),
    maxQuoteAmount: market.state.poolState.partnerQuoteFee,
  });
  return { instructions: instructionsOf(transaction), amount };
}

/**
 * The one instruction that claims `amount` of the creator's curve fees, with
 * nothing around it: no account is opened and nothing is unwrapped. The fee
 * arrives in `creator`'s token account for the pair token (for SOL, its
 * wrapped-SOL account), and the program also wants `creator`'s token account
 * for the token itself to exist, although nothing is paid into it. Both must
 * exist when this runs. `creator` must sign.
 *
 * Pure: it reads nothing from chain, so the accounts it names are exactly the
 * ones given here.
 */
export async function creatorClaimInstruction(
  dbc: DynamicBondingCurveClient,
  market: Pick<Market, 'pool' | 'mint' | 'state' | 'pair'>,
  creator: PublicKey,
  amount: bigint,
): Promise<TransactionInstruction> {
  if (amount <= 0n) throw new MarketError('NOTHING_TO_CLAIM', 'There are no creator fees to claim yet.');
  const quoteMint = new PublicKey(market.pair.mint);
  return dbc.program.methods
    .claimCreatorTradingFee(new BN(0), bn(amount))
    .accountsPartial({
      pool: market.pool,
      tokenAAccount: getAssociatedTokenAddressSync(market.mint, creator, true),
      tokenBAccount: getAssociatedTokenAddressSync(quoteMint, creator, true),
      baseVault: market.state.poolState.baseVault,
      quoteVault: market.state.poolState.quoteVault,
      baseMint: market.mint,
      quoteMint,
      creator,
      tokenBaseProgram: SPL_TOKEN_PROGRAM,
      tokenQuoteProgram: SPL_TOKEN_PROGRAM,
    })
    .instruction();
}

/**
 * The instruction that hands a pool's creator role to `newCreator`. From then
 * on only `newCreator` can claim the creator's share of the curve fees, and
 * the platform's payout of pool fees after graduation goes to it too.
 * `creator`, the current holder, must sign. There is no way back except
 * `newCreator` handing it on again.
 *
 * Meteora's program allows this while the curve is still open and again once
 * the graduated pool exists. In between, while a completed curve waits to be
 * migrated, it refuses.
 *
 * Pure: it reads nothing from chain.
 */
export async function transferCreatorInstruction(
  dbc: DynamicBondingCurveClient,
  input: { readonly pool: PublicKey; readonly config: PublicKey; readonly creator: PublicKey; readonly newCreator: PublicKey },
): Promise<TransactionInstruction> {
  if (input.newCreator.equals(input.creator)) throw new MarketError('SAME_CREATOR', 'The new creator must be a different address.');
  return dbc.program.methods
    .transferPoolCreator()
    .accountsPartial({ virtualPool: input.pool, config: input.config, creator: input.creator, newCreator: input.newCreator })
    // The program reads this account only for pools that migrate to DAMM v1. Meteora's own builder always names it.
    .remainingAccounts([{ pubkey: deriveDammV1MigrationMetadataAddress(input.pool), isSigner: false, isWritable: false }])
    .instruction();
}

/**
 * The instruction that moves a completed curve into its DAMM v2 pool.
 *
 * Meteora's keeper sends this by itself for the pairs and sizes it covers.
 * For the rest it is here for anyone to send: the instruction is
 * permissionless, the liquidity positions go where the config says (to the
 * platform, locked), and whoever pays gains nothing but a token that trades
 * again. `signers` are the two fresh position mints, which must sign.
 */
export async function migrationInstructions(
  dbc: DynamicBondingCurveClient,
  market: Market,
  payer: PublicKey,
): Promise<{ instructions: TransactionInstruction[]; signers: Keypair[]; dammConfig: PublicKey }> {
  if (market.stage === 'graduated') throw new MarketError('ALREADY_GRADUATED', 'This token has already graduated.');
  if (market.stage !== 'migrating') throw new MarketError('CURVE_OPEN', 'This curve is not complete yet, so it cannot graduate.');
  const listed = DAMM_V2_MIGRATION_FEE_ADDRESS[Number(market.config.migrationFeeOption)];
  if (!listed) throw new MarketError('NO_DAMM_CONFIG', 'This config has no DAMM v2 migration config.');
  const dammConfig = new PublicKey(listed);
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbc.migration.migrateToDammV2({
    payer,
    pool: market.pool,
    dammConfig,
  });
  return { instructions: instructionsOf(transaction), signers: [firstPositionNftKeypair, secondPositionNftKeypair], dammConfig };
}

/* ------------------------------------------------------------------ */
/* Graduated pools (DAMM v2)                                           */
/* ------------------------------------------------------------------ */

export interface GraduatedPool {
  readonly address: PublicKey;
  readonly state: DammPoolState;
}

export async function loadGraduatedPool(connection: Connection, market: Market): Promise<GraduatedPool> {
  if (!market.dammPool) throw new MarketError('NOT_GRADUATED', 'This token has not graduated yet.');
  const amm = new CpAmm(connection);
  const state = await amm.fetchPoolState(market.dammPool);
  return { address: market.dammPool, state };
}

/** How many accounts one `getMultipleAccounts` call may name. */
const ACCOUNT_BATCH = 100;

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * The current supply of many mints, in base units, in as few RPC calls as
 * possible. The result lines up with `mints`; an address that is not an SPL
 * Token mint gives null. Burning lowers a mint's supply, so this is how a burn
 * shows up.
 */
export async function loadMintSupplies(connection: Connection, mints: readonly PublicKey[]): Promise<Array<bigint | null>> {
  const out: Array<bigint | null> = [];
  for (const group of batches(mints, ACCOUNT_BATCH)) {
    const infos = await connection.getMultipleAccountsInfo(group, 'confirmed');
    for (const info of infos) out.push(mintSupply(info));
  }
  return out;
}

/** The supply field of an SPL Token mint account, or null for anything else. */
export function mintSupply(info: { owner: PublicKey; data: Uint8Array } | null): bigint | null {
  // A mint is 82 bytes: 36 for the optional mint authority, then the supply as a little-endian u64.
  if (!info || !info.owner.equals(SPL_TOKEN_PROGRAM) || info.data.length !== 82) return null;
  return Buffer.from(info.data.buffer, info.data.byteOffset, info.data.byteLength).readBigUInt64LE(36);
}

/** The decimals of an SPL Token mint, or null for anything else. */
export function mintDecimals(info: { owner: PublicKey; data: Uint8Array } | null): number | null {
  // After the 36-byte authority and the 8-byte supply comes one byte of decimals.
  if (!info || !info.owner.equals(SPL_TOKEN_PROGRAM) || info.data.length !== 82) return null;
  return info.data[44] ?? null;
}

/**
 * Who can still create more of a token: the mint's authority, or null when it
 * has none and the supply can only ever fall. `undefined` for anything that is
 * not an SPL Token mint.
 */
export function mintAuthorityOf(info: { owner: PublicKey; data: Uint8Array } | null): PublicKey | null | undefined {
  if (!info || !info.owner.equals(SPL_TOKEN_PROGRAM) || info.data.length !== 82) return undefined;
  const bytes = Buffer.from(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  // The first four bytes say whether an authority follows; the next 32 are its address.
  return bytes.readUInt32LE(0) === 0 ? null : new PublicKey(bytes.subarray(4, 36));
}

export { INITIAL_SUPPLY_UNITS };

/** What has been burned, given the supply now. Zero when the supply is unknown or not below the start. */
export function burnedUnits(supply: bigint | null | undefined): bigint {
  return supply === null || supply === undefined || supply >= INITIAL_SUPPLY_UNITS ? 0n : INITIAL_SUPPLY_UNITS - supply;
}

/**
 * Reads many bonding-curve pool accounts in as few RPC calls as possible.
 * The result lines up with `pools`; an address that holds no pool account
 * gives null. This is how the listing stays current on mainnet without
 * scanning Meteora's whole program.
 */
export async function loadPoolStates(
  dbc: DynamicBondingCurveClient,
  connection: Connection,
  pools: readonly PublicKey[],
): Promise<Array<VirtualPool | null>> {
  const out: Array<VirtualPool | null> = [];
  for (const group of batches(pools, ACCOUNT_BATCH)) {
    const infos = await connection.getMultipleAccountsInfo(group, 'confirmed');
    for (const info of infos) {
      if (!info || !info.owner.equals(dbc.program.programId)) {
        out.push(null);
        continue;
      }
      try {
        // The coder checks the account's discriminator and throws for any other account type.
        out.push(dbc.program.coder.accounts.decode('virtualPool', info.data) as VirtualPool);
      } catch {
        out.push(null);
      }
    }
  }
  return out;
}

/**
 * Reads many config accounts in as few RPC calls as possible. The result
 * lines up with `addresses`; an address that holds no config account gives
 * null.
 */
export async function loadPoolConfigs(
  dbc: DynamicBondingCurveClient,
  connection: Connection,
  addresses: readonly PublicKey[],
): Promise<Array<PoolConfig | null>> {
  const out: Array<PoolConfig | null> = [];
  for (const group of batches(addresses, ACCOUNT_BATCH)) {
    const infos = await connection.getMultipleAccountsInfo(group, 'confirmed');
    for (const info of infos) {
      if (!info || !info.owner.equals(dbc.program.programId)) {
        out.push(null);
        continue;
      }
      try {
        // The coder checks the account's discriminator and throws for any other account type.
        out.push(dbc.program.coder.accounts.decode('poolConfig', info.data) as PoolConfig);
      } catch {
        out.push(null);
      }
    }
  }
  return out;
}

/** The same, for graduated DAMM v2 pools. A pool that cannot be read gives null. */
export async function loadGraduatedPools(connection: Connection, addresses: readonly PublicKey[]): Promise<Array<GraduatedPool | null>> {
  const amm = new CpAmm(connection);
  const out: Array<GraduatedPool | null> = [];
  for (const group of batches(addresses, ACCOUNT_BATCH)) {
    let states: Array<DammPoolState | null>;
    try {
      states = (await amm.getMultiplePools(group)) as Array<DammPoolState | null>;
    } catch {
      // One unreadable account fails the whole batch in some SDK versions: read them one by one.
      states = await Promise.all(group.map((address) => amm.fetchPoolState(address).catch(() => null)));
    }
    group.forEach((address, index) => {
      const state = states[index];
      out.push(state ? { address, state } : null);
    });
  }
  return out;
}

/**
 * Cumulative trading fees a graduated pool has taken in the pair token, in
 * base units: what liquidity providers earned plus Meteora's protocol share.
 */
export function graduatedQuoteFees(market: Market, pool: GraduatedPool): bigint {
  const metrics = pool.state.metrics;
  const quoteIsB = pool.state.tokenAMint.equals(market.mint);
  return quoteIsB
    ? big(metrics.totalLpBFee) + big(metrics.totalProtocolBFee)
    : big(metrics.totalLpAFee) + big(metrics.totalProtocolAFee);
}

/** Fee terms of a graduated pool, for `assertGraduatedFee` and the ops verifier. */
export interface GraduatedFeeTerms {
  readonly baseFeeMode: number;
  readonly feeBps: number;
  readonly schedulerPeriods: number;
  readonly periodFrequency: string;
  readonly reductionFactor: string;
  readonly dynamicFeeInitialized: boolean;
}

export function graduatedFeeTerms(state: DammPoolState): GraduatedFeeTerms {
  const data = Buffer.from(state.poolFees.baseFee.baseFeeInfo.data);
  const baseFeeMode = Number(getBaseFeeModeFromPodAlignedData(data));
  const dynamicFeeInitialized = Number(state.poolFees.dynamicFee.initialized) !== 0;
  if (baseFeeMode !== DammBaseFeeMode.FeeTimeSchedulerLinear && baseFeeMode !== DammBaseFeeMode.FeeTimeSchedulerExponential) {
    // A market-cap scheduler or rate limiter: by definition not a constant fee.
    return { baseFeeMode, feeBps: Number.NaN, schedulerPeriods: -1, periodFrequency: '?', reductionFactor: '?', dynamicFeeInitialized };
  }
  const scheduler = decodePodAlignedFeeTimeScheduler(data);
  return {
    baseFeeMode,
    feeBps: (Number(scheduler.cliffFeeNumerator.toString()) * 10_000) / FEE_DENOMINATOR,
    schedulerPeriods: Number(scheduler.numberOfPeriod),
    periodFrequency: scheduler.periodFrequency.toString(),
    reductionFactor: scheduler.reductionFactor.toString(),
    dynamicFeeInitialized,
  };
}

/** After graduation the pool must still charge exactly the tier fee, with nothing that could lower it. */
export function assertGraduatedFee(terms: GraduatedFeeTerms, tier: FeeTier): void {
  if (terms.baseFeeMode !== DammBaseFeeMode.FeeTimeSchedulerLinear) {
    throw new MarketError('FEE_DRIFT', `The graduated pool uses base fee mode ${terms.baseFeeMode}, not the plain time scheduler.`);
  }
  if (terms.feeBps !== tier.feeBps) {
    throw new MarketError('FEE_DRIFT', `The graduated pool charges ${terms.feeBps} bps; the tier is ${tier.feeBps} bps.`);
  }
  if (terms.schedulerPeriods !== 0 || terms.reductionFactor !== '0') {
    throw new MarketError('FEE_DRIFT', 'The graduated pool has a fee schedule.');
  }
  if (terms.dynamicFeeInitialized) throw new MarketError('FEE_DRIFT', 'The graduated pool has a dynamic fee.');
}

export async function quoteGraduated(
  connection: Connection,
  market: Market,
  pool: GraduatedPool,
  request: QuoteRequest,
): Promise<TradeQuote> {
  if (request.amount <= 0n) throw new MarketError('BAD_AMOUNT', 'Enter an amount greater than zero.');
  const amm = new CpAmm(connection);
  const selling = request.side === 'sell';
  const quoteMint = quoteMintOf(market);
  const inputTokenMint = selling ? market.mint : quoteMint;
  const currentPoint = await getCurrentPoint(connection, pool.state.activationType);
  const aIsBase = pool.state.tokenAMint.equals(market.mint);
  const common = {
    inputTokenMint,
    slippage: request.slippageBps / 100,
    currentPoint,
    poolState: pool.state,
    tokenADecimal: aIsBase ? TOKEN_DECIMALS : market.pair.decimals,
    tokenBDecimal: aIsBase ? market.pair.decimals : TOKEN_DECIMALS,
    hasReferral: false,
  };
  // The pool takes its fee in the pair token: from the input of a buy, from the output of a sell.
  const feeOnGross = (units: bigint) => (units * BigInt(market.tier.feeBps)) / 10_000n;
  const feeOnNet = (units: bigint) => (units * BigInt(market.tier.feeBps)) / BigInt(10_000 - market.tier.feeBps);
  if (request.mode === 'exact-in') {
    const result = amm.getQuote2({ ...common, swapMode: DammSwapMode.ExactIn, amountIn: bn(request.amount) });
    const out = big(result.outputAmount);
    if (out <= 0n) throw new MarketError('DUST', 'This trade is too small to return anything.');
    return {
      side: request.side,
      venue: 'damm-v2',
      mode: 'exact-in',
      amountIn: request.amount,
      amountOut: out,
      minimumAmountOut: result.minimumAmountOut ? big(result.minimumAmountOut) : minusBps(out, request.slippageBps),
      maximumAmountIn: request.amount,
      fee: selling ? feeOnNet(out) : feeOnGross(request.amount),
      feeBps: market.tier.feeBps,
      slippageBps: request.slippageBps,
    };
  }
  const result = amm.getQuote2({ ...common, swapMode: DammSwapMode.ExactOut, amountOut: bn(request.amount) });
  const amountIn = big(result.includedFeeInputAmount);
  return {
    side: request.side,
    venue: 'damm-v2',
    mode: 'exact-out',
    amountIn,
    amountOut: request.amount,
    minimumAmountOut: request.amount,
    maximumAmountIn: result.maximumAmountIn ? big(result.maximumAmountIn) : plusBps(amountIn, request.slippageBps),
    fee: selling ? feeOnNet(request.amount) : feeOnGross(amountIn),
    feeBps: market.tier.feeBps,
    slippageBps: request.slippageBps,
  };
}

/**
 * Swap on the graduated pool. `owner` pays and receives. `rentPayer` pays the
 * rent of any token account the swap has to open: `owner` unless another
 * address is given, which must then sign as well.
 */
export async function graduatedSwapInstructions(
  connection: Connection,
  market: Market,
  pool: GraduatedPool,
  owner: PublicKey,
  quote: TradeQuote,
  rentPayer: PublicKey = owner,
): Promise<TransactionInstruction[]> {
  if (quote.venue !== 'damm-v2') throw new MarketError('WRONG_VENUE', 'This quote is not for the graduated pool.');
  const amm = new CpAmm(connection);
  const selling = quote.side === 'sell';
  const quoteMint = quoteMintOf(market);
  const base = {
    // The SDK calls the rent payer `payer` and, when the two differ, the trader `receiver`.
    payer: rentPayer,
    ...(rentPayer.equals(owner) ? {} : { receiver: owner }),
    pool: pool.address,
    inputTokenMint: selling ? market.mint : quoteMint,
    outputTokenMint: selling ? quoteMint : market.mint,
    tokenAMint: pool.state.tokenAMint,
    tokenBMint: pool.state.tokenBMint,
    tokenAVault: pool.state.tokenAVault,
    tokenBVault: pool.state.tokenBVault,
    tokenAProgram: SPL_TOKEN_PROGRAM,
    tokenBProgram: SPL_TOKEN_PROGRAM,
    referralTokenAccount: null,
    poolState: pool.state,
  };
  const transaction =
    quote.mode === 'exact-in'
      ? await amm.swap2({
          ...base,
          swapMode: DammSwapMode.ExactIn,
          amountIn: bn(quote.amountIn),
          minimumAmountOut: bn(quote.minimumAmountOut),
        })
      : await amm.swap2({
          ...base,
          swapMode: DammSwapMode.ExactOut,
          amountOut: bn(quote.amountOut),
          maximumAmountIn: bn(quote.maximumAmountIn),
        });
  return instructionsOf(transaction);
}

/**
 * A liquidity position in a graduated pool. Migration gives the creator and
 * the platform one each, permanently locked: the principal can never be
 * withdrawn, but the trading fees it earns can be claimed.
 */
export interface PositionFees {
  readonly position: PublicKey;
  readonly positionNftAccount: PublicKey;
  /** Unclaimed fees in the pair token, in base units. */
  readonly quoteUnits: bigint;
  /** Unclaimed fees in the token. Zero for a pool that collects its fee in the pair token. */
  readonly tokenUnits: bigint;
  readonly permanentlyLocked: boolean;
}

/** `owner`'s positions in the graduated pool, with what each has earned, largest first. */
export async function graduatedPositionFees(
  connection: Connection,
  market: Market,
  pool: GraduatedPool,
  owner: PublicKey,
): Promise<PositionFees[]> {
  const amm = new CpAmm(connection);
  const aIsBase = pool.state.tokenAMint.equals(market.mint);
  const positions = await amm.getUserPositionByPool(pool.address, owner);
  return positions
    .map((entry) => {
      const fees = getUnClaimLpFee(pool.state, entry.positionState);
      return {
        position: entry.position,
        positionNftAccount: entry.positionNftAccount,
        quoteUnits: big(aIsBase ? fees.feeTokenB : fees.feeTokenA),
        tokenUnits: big(aIsBase ? fees.feeTokenA : fees.feeTokenB),
        permanentlyLocked: !entry.positionState.permanentLockedLiquidity.isZero(),
      };
    })
    .sort((a, b) => (a.quoteUnits === b.quoteUnits ? 0 : a.quoteUnits > b.quoteUnits ? -1 : 1));
}

/**
 * How much of the graduated pool's permanently locked liquidity `owner`'s
 * positions hold, in hundredths of a percent (10000 = all of it).
 */
export async function lockedLiquidityShareBps(connection: Connection, pool: GraduatedPool, owner: PublicKey): Promise<number> {
  const total = BigInt(pool.state.permanentLockLiquidity.toString());
  if (total <= 0n) return 0;
  const amm = new CpAmm(connection);
  const positions = await amm.getUserPositionByPool(pool.address, owner);
  const held = positions.reduce((sum, entry) => sum + BigInt(entry.positionState.permanentLockedLiquidity.toString()), 0n);
  return Number((held * 10_000n) / total);
}

/**
 * Claim the fees one position has earned, in the pair token: SOL is unwrapped
 * into `owner`'s wallet, any other pair token lands in `owner`'s token account
 * for it. The returned `amount` is what was owed when this was built; the
 * claim itself pays whatever has accrued by the time it lands, never less.
 */
export async function claimPositionFeeInstructions(
  connection: Connection,
  pool: GraduatedPool,
  owner: PublicKey,
  fees: PositionFees,
): Promise<{ instructions: TransactionInstruction[]; amount: bigint }> {
  if (fees.quoteUnits <= 0n && fees.tokenUnits <= 0n) {
    throw new MarketError('NOTHING_TO_CLAIM', 'This position has no fees to claim yet.');
  }
  const amm = new CpAmm(connection);
  const transaction = await amm.claimPositionFee2({
    owner,
    receiver: owner,
    feePayer: owner,
    pool: pool.address,
    position: fees.position,
    positionNftAccount: fees.positionNftAccount,
    tokenAMint: pool.state.tokenAMint,
    tokenBMint: pool.state.tokenBMint,
    tokenAVault: pool.state.tokenAVault,
    tokenBVault: pool.state.tokenBVault,
    tokenAProgram: SPL_TOKEN_PROGRAM,
    tokenBProgram: SPL_TOKEN_PROGRAM,
  });
  return { instructions: instructionsOf(transaction), amount: fees.quoteUnits };
}

/**
 * The platform's configs by address: one per fee tier per pair for new
 * launches, and any number kept from earlier sets (`previous`). A config whose
 * address is unset is left out, and an address that appears twice is refused,
 * because a config is priced in exactly one pair token.
 */
export function allowedConfigMap(
  entries: ReadonlyArray<{ readonly address: string | null | undefined; readonly feeBps: number; readonly pair: TradingPair; readonly previous?: boolean }>,
): Map<string, AllowedConfig> {
  const map = new Map<string, AllowedConfig>();
  for (const entry of entries) {
    if (!entry.address) continue;
    const tier = tierByFeeBps(entry.feeBps);
    if (!tier) throw new MarketError('BAD_TIER', `No tier charges ${entry.feeBps} bps.`);
    const address = new PublicKey(entry.address).toBase58();
    if (map.has(address)) throw new MarketError('BAD_CONFIG', `Config ${address} is set for more than one tier or pair.`);
    map.set(address, entry.previous ? { tier, pair: entry.pair, previous: true } : { tier, pair: entry.pair });
  }
  return map;
}
