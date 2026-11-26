/**
 * The flows a person can start from the interface. Each one builds a
 * transaction in the browser, has the wallet sign it, sends it and waits for
 * it to land. `onStage` reports progress in plain words.
 */

import { type Address, address, generateKeyPairSigner } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DEFAULT_TREE_ID, transactInstruction } from '@heliuslabs/spr/interface';
import { resolveRegisteredAddress } from '@heliuslabs/spr/wallet';

import type { PairRef, StatusResponse } from '../../shared/src/api.js';
import {
  GAS_RESERVE_LAMPORTS,
  TOKEN_2022_ACCOUNT_RENT_LAMPORTS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  TOKEN_PROGRAM_ID,
  TX_V1_MAX_ACCOUNTS,
  WSOL_MINT,
} from '../../shared/src/constants.js';
import { buildTierConfig } from '../../shared/src/curve.js';
import {
  type GhostQuote,
  assertGhostMessage,
  assertIncoming,
  assertPlainTransfer,
  decodeTransactData,
  encodeTransactData,
} from '../../shared/src/ghost.js';
import {
  type BuildRequest,
  CONVERSION_ACCOUNTS,
  type ConversionSwap,
  buildQuery,
  floorsBroken,
  legSlippageBps,
  readBuild,
  tunedComputeLimit,
} from '../../shared/src/jupiter.js';
import { MarketError, type TradeQuote, quoteFirstBuy } from '../../shared/src/meteora.js';
import { checkModuleSettings, encodeModuleMemo } from '../../shared/src/modules.js';
import {
  type Landed,
  SOL_MINT,
  buildGhostLeg,
  depositTransaction,
  fetchAssetId,
  isRegistered,
  markSpend,
  mergeTransaction,
  priorityOf,
  privateBalance,
  registrationTransactions,
  sendSigned,
  signAndSend,
  simulate,
  spending,
  transferTransaction,
  withdrawTransaction,
} from '../../shared/src/privacy.js';
import {
  type ConvertedTrade,
  type MarketEnv,
  type ModuleActivation,
  type RewardSource,
  type Rewards,
  buildBurnFromPrivate,
  buildBurnPublic,
  buildClaimToPrivate,
  buildConvertedBuy,
  buildConvertedSell,
  buildGraduation,
  buildLaunch,
  buildModuleActivation,
  buildPublicBuyToPrivate,
  buildShieldedBuy,
  buildShieldedSell,
  quoteAssetOf,
  readRewards,
  ringsAssetOf,
} from '../../shared/src/routes.js';
import { addSignature } from '../../shared/src/signing.js';
import { tierById } from '../../shared/src/tiers.js';
import { SEND_COMPUTE_UNITS, buildPublicSend, destinationProblem } from '../../shared/src/transfers.js';
import { TxError, base64ToBytes, bytesToBase64, countAccounts, transactionFromMessage } from '../../shared/src/tx.js';
import { minusBps } from '../../shared/src/units.js';
import { SIGNATURE_FEE_LAMPORTS, SYSTEM_RENT_EXEMPT_LAMPORTS, buildSweep } from '../../shared/src/vaults.js';
import { ApiError, api } from './api.js';
import { assertPairMint, connection, dbc, loadMarketEnv, publicLamports, publicTokenUnits, quote, quoteClose, recentRefusal, ringsClient } from './chain.js';
import { explainError } from './errors.js';
import { sol } from './format.js';
import { noteOwnSlot } from './local-records.js';
import { amount as pairAmount, curveQuoteOf, pairOf, tradingPairOf } from './pairs.js';
import type { Session } from './wallet.js';

export type Stage = (message: string) => void;

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowError';
  }
}

const SOL = SOL_MINT as Address;

/** Turns SDK and program error codes into something a person can act on. */
export function friendlyError(error: unknown): string {
  return explainError(error, recentRefusal());
}

/** A transaction that landed, and whether this page's view of the private balance caught up with it. */
export interface Settled extends Landed {
  /** False when the balance could not be re-read afterwards. The transaction settled all the same. */
  readonly synced: boolean;
}

/**
 * After a transaction has landed the money has moved, and nothing that follows
 * may turn that into an error: somebody told "failed" tries again and pays
 * twice. A sync that fails here only leaves the page's balance out of date,
 * which the caller says in so many words.
 */
export async function afterLanding(session: Session, slot: bigint): Promise<boolean> {
  // What this transaction brought into the wallet is the wallet's own doing, not an arrival to announce.
  try {
    noteOwnSlot(session.address, slot);
  } catch {
    // Keeping that note is a convenience. Nothing after a landing may turn it into an error.
  }
  try {
    await session.sync(slot);
    return true;
  } catch {
    return false;
  }
}

/** What to tell someone whose transaction settled but whose balance could not be re-read. */
export const STALE_BALANCE_NOTE = 'It settled on chain. The balance shown here could not be refreshed afterwards: reload the page to see it.';

export async function requireGas(session: Session): Promise<void> {
  const lamports = await publicLamports(session.address);
  if (lamports < GAS_RESERVE_LAMPORTS) {
    throw new FlowError('Keep at least 0.015 public SOL in the wallet for fees and temporary account rent.');
  }
}

/** Registers the wallet with Rings (once) so it can receive private transfers by address. */
export async function ensureRegistered(session: Session, onStage: Stage): Promise<void> {
  if (await isRegistered(session.ctx.client, session.address)) return;
  onStage('Registering your private wallet (one time)…');
  await requireGas(session);
  for (const transaction of await registrationTransactions(session.ctx)) {
    await signAndSend(session.ctx, transaction);
  }
}

/** Teaches the wallet a mint's Rings asset id, so it can read and spend its notes in that token. */
export async function knowAsset(session: Session, mint: Address): Promise<void> {
  if (mint === SOL) return;
  const assetId = await fetchAssetId(session.ctx.client, mint);
  if (assetId !== undefined) session.ctx.wallet.ensureAsset(assetId, mint);
}

/* ---------------- Shielded route ---------------- */

export interface ShieldedBuyPlan {
  readonly quote: TradeQuote;
  /** The most of the pair token that leaves the balance paying for it, in base units. */
  readonly spendCap: bigint;
  /** True when this buy takes everything the curve has left, so the token graduates. */
  readonly completesCurve: boolean;
}

/**
 * Sizes a buy for `spend` base units of the token's pair token. The swap is
 * exact-out so the deposit that follows can name its amount: you receive
 * exactly `quote.amountOut` tokens and pay at most `spendCap`.
 *
 * When `spend` is more than the curve has room for, the plan is the buy that
 * completes the curve: all the tokens it still sells, for less than was
 * entered.
 */
export async function planShieldedBuy(env: MarketEnv, spend: bigint, slippageBps: number): Promise<ShieldedBuyPlan> {
  let probe: TradeQuote;
  try {
    probe = await quote(env, { side: 'buy', mode: 'exact-in', amount: spend, slippageBps });
  } catch (error) {
    if (!(error instanceof MarketError) || error.code !== 'TOO_LARGE') throw error;
    const closing = await quoteClose(env, spend, slippageBps);
    if (!closing) throw error;
    return { quote: closing, spendCap: closing.maximumAmountIn, completesCurve: true };
  }
  const exact = await quote(env, { side: 'buy', mode: 'exact-out', amount: minusBps(probe.amountOut, slippageBps), slippageBps });
  const spendCap = exact.maximumAmountIn > spend ? spend : exact.maximumAmountIn;
  if (spendCap < exact.amountIn) throw new FlowError('The price moved while quoting. Try again.');
  return { quote: { ...exact, maximumAmountIn: spendCap }, spendCap, completesCurve: false };
}

/**
 * A wallet trading against a pair token other than SOL needs an ordinary
 * token account for it. A trade opens it when it is missing, and that costs
 * its rent on top of the usual reserve for fees.
 */
async function requireGasFor(session: Session, env: MarketEnv): Promise<void> {
  if (env.market.pair.native) return requireGas(session);
  const lamports = await publicLamports(session.address);
  if (lamports < GAS_RESERVE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS) {
    throw new FlowError(`Keep at least 0.018 public SOL in the wallet: fees, temporary account rent, and the token account a ${env.market.pair.symbol} trade opens the first time.`);
  }
}

export async function shieldedBuy(session: Session, env: MarketEnv, plan: ShieldedBuyPlan, onStage: Stage): Promise<Settled> {
  const { symbol } = env.market.pair;
  await requireGasFor(session, env);
  await knowAsset(session, address(env.market.mint.toBase58()));
  await knowAsset(session, quoteAssetOf(env.market));
  if (privateBalance(session.ctx, quoteAssetOf(env.market)) < plan.spendCap) {
    throw new FlowError(`Your private ${symbol} balance does not cover this buy. Deposit ${symbol} in the wallet first.`);
  }
  const landed = await spending(session.ctx, async () => {
    onStage('Proving the withdrawal from your private balance…');
    const transaction = await buildShieldedBuy(session.ctx, env, plan.quote);
    onStage('Sign the transaction in your wallet…');
    return signAndSend(session.ctx, transaction);
  });
  onStage('Syncing your private balance…');
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

/**
 * Buy with the public balance of the pair token, receive into the private
 * balance. For a wallet that has not moved its SOL, or its pair token, into
 * Rings yet: one transaction instead of a deposit and then a trade. The plan
 * is the same exact-out plan a shielded buy uses.
 */
export async function publicBuyToPrivate(session: Session, env: MarketEnv, plan: ShieldedBuyPlan, onStage: Stage): Promise<Settled> {
  const { pair } = env.market;
  if (pair.native) {
    const available = await publicLamports(session.address);
    if (available < plan.spendCap + GAS_RESERVE_LAMPORTS) {
      throw new FlowError('Your public SOL does not cover this buy plus 0.015 SOL for fees and temporary account rent.');
    }
  } else {
    await requireGas(session);
    const held = await publicTokenUnits(session.address, pair.mint);
    if (held < plan.spendCap) {
      throw new FlowError(`Your public ${pair.symbol} does not cover this buy: it needs up to ${pairAmount(plan.spendCap, pair, 6)} ${pair.symbol}, and the wallet holds ${pairAmount(held, pair, 6)}.`);
    }
  }
  onStage('Building the trade…');
  const transaction = await buildPublicBuyToPrivate(session.ctx, env, plan.quote);
  onStage('Sign the transaction in your wallet…');
  const landed = await signAndSend(session.ctx, transaction);
  onStage('Syncing your private balance…');
  await knowAsset(session, address(env.market.mint.toBase58())).catch(() => undefined);
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

export async function planShieldedSell(env: MarketEnv, units: bigint, slippageBps: number): Promise<TradeQuote> {
  return quote(env, { side: 'sell', mode: 'exact-in', amount: units, slippageBps });
}

export async function shieldedSell(session: Session, env: MarketEnv, plan: TradeQuote, onStage: Stage): Promise<Settled> {
  await requireGasFor(session, env);
  const mint = address(env.market.mint.toBase58());
  await knowAsset(session, mint);
  // So the proceeds can be read as soon as they land in the private balance.
  await knowAsset(session, quoteAssetOf(env.market)).catch(() => undefined);
  if (privateBalance(session.ctx, mint) < plan.amountIn) throw new FlowError('Your private token balance does not cover this sell.');
  const landed = await spending(session.ctx, async () => {
    onStage('Proving the withdrawal from your private balance…');
    const transaction = await buildShieldedSell(session.ctx, env, plan);
    onStage('Sign the transaction in your wallet…');
    return signAndSend(session.ctx, transaction);
  });
  onStage('Syncing your private balance…');
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

/* ---------------- Converted trades ---------------- */

/**
 * Paying for a token with SOL or USDC when it is priced in something else, or
 * being paid in them. The conversion runs on Jupiter, inside the same
 * transaction as the trade on the pool, so there is never a moment where one
 * has happened without the other.
 *
 * The slippage limit covers the whole trade and is split between the two
 * swaps. What either of them returns above its guaranteed minimum is not
 * lost: it stays in the wallet, public.
 */

export type ConversionSource = 'private' | 'public';

/** A conversion Jupiter built for this wallet, read and checked. Throws `ConvertError` when it is not what was asked. */
export async function fetchConversion(request: BuildRequest): Promise<ConversionSwap> {
  let body: unknown;
  try {
    body = await api.convertBuild(buildQuery(request));
  } catch (error) {
    // Jupiter's allowance is shared by every visitor of this site. A moment's wait covers a short queue; a longer one is reported.
    if (!(error instanceof ApiError) || error.code !== 'CONVERTER_BUSY') throw error;
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    body = await api.convertBuild(buildQuery(request));
  }
  return readBuild(body, request);
}

/** The pair token a conversion goes into or out of must be the mint the chain says it is, like the pair itself. */
export async function assertCounter(asset: PairRef): Promise<void> {
  if (asset.mint === WSOL_MINT) return;
  await assertPairMint({ id: asset.id, symbol: asset.symbol, name: asset.symbol, mint: asset.mint, decimals: asset.decimals, native: false });
}

export interface ConvertedBuyPlan {
  /** What is paid with. */
  readonly paying: PairRef;
  /** Exactly what is paid, in base units of `paying`. */
  readonly payAmount: bigint;
  readonly source: ConversionSource;
  /** The conversion into the token's pair token. */
  readonly swap: ConversionSwap;
  /** The buy on the pool, sized on what the conversion guarantees. */
  readonly buy: ShieldedBuyPlan;
  /** The slippage limit chosen for the whole trade. */
  readonly slippageBps: number;
  readonly maxAccounts: number;
}

/**
 * Sizes a buy paid for with `payAmount` of something other than the pair
 * token. Exactly `payAmount` is converted; the pool buy is then sized on the
 * least the conversion can return, for an exact number of tokens.
 */
export async function planConvertedBuy(
  env: MarketEnv,
  taker: string,
  paying: PairRef,
  payAmount: bigint,
  slippageBps: number,
  source: ConversionSource,
  maxAccounts: number = source === 'public' ? CONVERSION_ACCOUNTS.fromPublic : CONVERSION_ACCOUNTS.fromPrivate,
): Promise<ConvertedBuyPlan> {
  const { pair } = env.market;
  if (paying.mint === pair.mint) throw new FlowError(`This token is priced in ${pair.symbol}: there is nothing to convert.`);
  await assertCounter(paying);
  const leg = legSlippageBps(slippageBps);
  const swap = await fetchConversion({ inputMint: paying.mint, outputMint: pair.mint, amount: payAmount, taker, slippageBps: leg, maxAccounts });
  const buy = await planShieldedBuy(env, swap.minimumOut, leg);
  // A buy that completes the curve takes less than was converted. A little of that is the ordinary
  // remainder; a lot of it would leave somebody holding a pair token they never meant to buy.
  if (buy.completesCurve && buy.spendCap < minusBps(swap.minimumOut, 300)) {
    const enough = (payAmount * buy.spendCap) / swap.minimumOut;
    throw new FlowError(
      `This is more than the curve has left before it graduates. It has room for about ${pairAmount(buy.spendCap, pair, 4)} ${pair.symbol}, which is about ${pairAmount(enough, paying, 4)} ${paying.symbol}. Enter that or less.`,
    );
  }
  return { paying, payAmount, source, swap, buy, slippageBps, maxAccounts };
}

export interface ConvertedSellPlan {
  /** What is received. */
  readonly receiving: PairRef;
  /** The sell on the pool. */
  readonly sell: TradeQuote;
  /** The conversion of exactly what the sell guarantees. Its `minimumOut` is what goes into the private balance. */
  readonly swap: ConversionSwap;
  readonly slippageBps: number;
  readonly maxAccounts: number;
}

/** Sizes a sell of `units` tokens that is paid out in something other than the pair token. */
export async function planConvertedSell(
  env: MarketEnv,
  taker: string,
  receiving: PairRef,
  units: bigint,
  slippageBps: number,
  maxAccounts: number = CONVERSION_ACCOUNTS.fromPrivate,
): Promise<ConvertedSellPlan> {
  const { pair } = env.market;
  if (receiving.mint === pair.mint) throw new FlowError(`This token is priced in ${pair.symbol}: there is nothing to convert.`);
  await assertCounter(receiving);
  const leg = legSlippageBps(slippageBps);
  const sell = await planShieldedSell(env, units, leg);
  const swap = await fetchConversion({ inputMint: pair.mint, outputMint: receiving.mint, amount: sell.minimumAmountOut, taker, slippageBps: leg, maxAccounts });
  return { receiving, sell, swap, slippageBps, maxAccounts };
}

/**
 * Runs a converted trade against the chain, checks what it would leave in the
 * wallet, and only then asks for a signature. The run also says how much
 * compute the transaction needs, which is what it is then given.
 */
export async function settleConverted(session: Session, trade: ConvertedTrade, onStage: Stage): Promise<Landed> {
  onStage('Checking the whole trade against the chain…');
  // The most compute a transaction can have, and no priority fee: this run is never sent.
  const probe = trade.compose(1_400_000, 0n);
  const check = await simulate(
    session.ctx.client,
    probe,
    trade.floors.map((floor) => floor.account),
  );
  if (!check.ok) throw new FlowError(`The trade would fail, so it was not sent. ${check.error}`);
  const broken = floorsBroken(trade.floors, check.accounts);
  if (broken.length > 0) throw new FlowError(`This trade was not sent: ${broken[0]}. Nothing was signed.`);
  const limit = tunedComputeLimit(check.unitsConsumed);
  onStage('Sign the transaction in your wallet…');
  return signAndSend(session.ctx, trade.compose(limit, priorityOf(session.ctx, limit)));
}

/**
 * When a converted trade does not fit one transaction, the number of accounts
 * to allow the conversion on a second try, or null when a second try cannot
 * help. `trade` is what was built, when it got that far.
 */
export function shorterRoute(error: unknown, feePayer: Address, trade: ConvertedTrade | null, maxAccounts: number): number | null {
  if (!(error instanceof TxError)) return null;
  let fewer: number;
  if (error.code === 'TOO_MANY_ACCOUNTS' && trade) fewer = maxAccounts - (countAccounts(feePayer, trade.instructions) - TX_V1_MAX_ACCOUNTS) - 1;
  else if (error.code === 'TOO_LARGE') fewer = maxAccounts - 8;
  else return null;
  return fewer >= CONVERSION_ACCOUNTS.smallest ? fewer : null;
}

const NO_ROOM = 'This conversion does not fit in one transaction with the trade. Convert on Jupiter first, then pay with the pair token.';

export async function convertedBuy(session: Session, env: MarketEnv, plan: ConvertedBuyPlan, onStage: Stage): Promise<Settled> {
  const { paying } = plan;
  const payingSol = paying.mint === WSOL_MINT;
  const mint = address(env.market.mint.toBase58());
  if (plan.source === 'public') {
    const lamports = await publicLamports(session.address);
    if (payingSol) {
      if (lamports < plan.payAmount + GAS_RESERVE_LAMPORTS) throw new FlowError('Your public SOL does not cover this buy plus 0.015 SOL for fees and temporary account rent.');
    } else {
      if (lamports < GAS_RESERVE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS) throw new FlowError('Keep at least 0.018 public SOL in the wallet for fees, temporary account rent and a token account this trade may open.');
      const held = await publicTokenUnits(session.address, paying.mint);
      if (held < plan.payAmount) {
        throw new FlowError(`Your public ${paying.symbol} does not cover this buy: it pays ${pairAmount(plan.payAmount, paying, 6)} ${paying.symbol}, and the wallet holds ${pairAmount(held, paying, 6)}.`);
      }
    }
  } else {
    await requireGasFor(session, env);
    await knowAsset(session, ringsAssetOf(paying.mint));
    if (privateBalance(session.ctx, ringsAssetOf(paying.mint)) < plan.payAmount) {
      throw new FlowError(`Your private ${paying.symbol} balance does not cover this buy. Deposit ${paying.symbol} in the wallet first, or use Public entry.`);
    }
  }
  await knowAsset(session, mint).catch(() => undefined);

  let current = plan;
  for (let attempt = 0; ; attempt += 1) {
    let trade: ConvertedTrade | null = null;
    const mark = markSpend(session.ctx);
    try {
      onStage(current.source === 'private' ? 'Proving the withdrawal from your private balance…' : 'Building the trade…');
      trade = await buildConvertedBuy(session.ctx, env, { swap: current.swap, quote: current.buy.quote, source: current.source, payingSymbol: paying.symbol });
      const landed = await settleConverted(session, trade, onStage);
      onStage('Syncing your private balance…');
      await knowAsset(session, mint).catch(() => undefined);
      return { ...landed, synced: await afterLanding(session, landed.slot) };
    } catch (error) {
      // A try that was never sent gives back the notes it was built on, so the next one can use them.
      mark.release();
      // Too big for one transaction: nothing has been signed, so ask for a shorter route, once.
      const fewer = attempt === 0 ? shorterRoute(error, session.address, trade, current.maxAccounts) : null;
      if (fewer === null) throw error instanceof TxError ? new FlowError(NO_ROOM) : error;
      onStage('Finding a shorter route for the conversion…');
      current = await planConvertedBuy(env, session.address, paying, plan.payAmount, plan.slippageBps, plan.source, fewer);
      if (current.buy.quote.amountOut < minusBps(plan.buy.quote.amountOut, plan.slippageBps)) {
        throw new FlowError('The only route that fits in one transaction returns less than your limit allows. Nothing was sent. Convert on Jupiter first, then pay with the pair token.');
      }
    }
  }
}

export async function convertedSell(session: Session, env: MarketEnv, plan: ConvertedSellPlan, onStage: Stage): Promise<Settled> {
  const { receiving } = plan;
  const mint = address(env.market.mint.toBase58());
  await requireGasFor(session, env);
  await knowAsset(session, mint);
  // So the proceeds can be read as soon as they land in the private balance.
  await knowAsset(session, ringsAssetOf(receiving.mint)).catch(() => undefined);
  if (privateBalance(session.ctx, mint) < plan.sell.amountIn) throw new FlowError('Your private token balance does not cover this sell.');

  let current = plan;
  for (let attempt = 0; ; attempt += 1) {
    let trade: ConvertedTrade | null = null;
    const mark = markSpend(session.ctx);
    try {
      onStage('Proving the withdrawal from your private balance…');
      trade = await buildConvertedSell(session.ctx, env, { quote: current.sell, swap: current.swap, receivingSymbol: receiving.symbol });
      const landed = await settleConverted(session, trade, onStage);
      onStage('Syncing your private balance…');
      return { ...landed, synced: await afterLanding(session, landed.slot) };
    } catch (error) {
      // A try that was never sent gives back the notes it was built on, so the next one can use them.
      mark.release();
      const fewer = attempt === 0 ? shorterRoute(error, session.address, trade, current.maxAccounts) : null;
      if (fewer === null) throw error instanceof TxError ? new FlowError(NO_ROOM) : error;
      onStage('Finding a shorter route for the conversion…');
      current = await planConvertedSell(env, session.address, receiving, plan.sell.amountIn, plan.slippageBps, fewer);
      if (current.swap.minimumOut < minusBps(plan.swap.minimumOut, plan.slippageBps)) {
        throw new FlowError('The only route that fits in one transaction returns less than your limit allows. Nothing was sent. Receive the pair token instead, and convert it on Jupiter.');
      }
    }
  }
}

/* ---------------- Ghost fill ---------------- */

export function ghostQuote(side: 'buy' | 'sell', mint: string, amount: bigint): Promise<GhostQuote> {
  return api.deskQuote({ side, mint, amount: amount.toString() });
}

/** The desk's price moved further than the trader's limit allows while the trader's proof was being made. */
export class QuoteMoved extends Error {
  /** The desk's price now. Nothing was sent; it is shown, to be taken or not. */
  readonly fresh: GhostQuote;
  constructor(fresh: GhostQuote) {
    super('The price moved while your transfer was being proved. Nothing was sent.');
    this.name = 'QuoteMoved';
    this.fresh = fresh;
  }
}

/**
 * Executes a Ghost fill, starting from the quote on screen (`shown`).
 *
 * The desk holds a price for seconds, and a proof takes seconds to make. So
 * the proof is made first: it pays the desk the amount that was typed and does
 * not depend on the price. Only then is the desk asked for its price again,
 * and that second price is taken only when it returns at least `leastReceive`.
 * Otherwise `QuoteMoved` is thrown with the new price and nothing is sent.
 *
 * Before this wallet signs anything it:
 *  1. rebuilds the desk's transfer from the data the desk sent,
 *  2. decrypts it and checks it commits the quoted amount to this wallet,
 *  3. checks the transaction to be signed is exactly the two transfers, paid
 *     for by the desk, with no other instruction and no other signer.
 */
export async function ghostFill(
  session: Session,
  shown: GhostQuote,
  leastReceive: bigint,
  onStage: Stage,
): Promise<{ signature: string; slot: bigint; synced: boolean; quote: GhostQuote }> {
  const { ctx } = session;
  if (!ctx.keypair) throw new FlowError('Ghost fill needs the built-in ghost wallet. With an external wallet, use the Shielded route.');
  await ensureRegistered(session, onStage);

  const desk = address(shown.desk);
  const payAsset = address(shown.payAsset);
  const receiveAsset = address(shown.receiveAsset);
  await knowAsset(session, payAsset);
  await knowAsset(session, receiveAsset);

  const resolved = await resolveRegisteredAddress({ rpc: ctx.client, owner: desk });
  if (!resolved) throw new FlowError('The desk wallet is not registered. Use the Shielded route.');

  onStage('Proving your confidential transfer…');
  const legData = await buildGhostLeg(ctx, {
    asset: payAsset,
    amount: BigInt(shown.payAmount),
    recipient: resolved.address,
    feePayer: desk,
  });

  onStage('Asking the desk for its price…');
  const deskQuote = await api.deskQuote({ side: shown.side, mint: shown.mint, amount: shown.payAmount });
  if (
    deskQuote.desk !== shown.desk ||
    deskQuote.side !== shown.side ||
    deskQuote.mint !== shown.mint ||
    deskQuote.payAsset !== shown.payAsset ||
    deskQuote.payAmount !== shown.payAmount ||
    deskQuote.receiveAsset !== shown.receiveAsset
  ) {
    throw new FlowError('The desk answered with a different trade than the one asked for. Nothing was sent.');
  }
  if (leastReceive <= 0n || BigInt(deskQuote.receiveAmount) < leastReceive) throw new QuoteMoved(deskQuote);

  onStage('The desk is checking your transfer and preparing its own…');
  const prepared = await api.deskPrepare({ quoteId: deskQuote.id, trader: ctx.owner, leg: encodeTransactData(legData) });

  onStage('Checking the desk’s transfer before signing…');
  const tree = ctx.client.tree;
  const traderLeg = await transactInstruction({ payer: desk, ownerSigners: [ctx.owner], inputTree: tree, outputTree: tree, data: legData });
  const deskData = decodeTransactData(prepared.deskLeg);
  assertPlainTransfer(deskData);
  const deskLeg = await transactInstruction({ payer: desk, ownerSigners: [desk], inputTree: tree, outputTree: tree, data: deskData });
  const messageBytes = base64ToBytes(prepared.message);
  assertGhostMessage(messageBytes, { desk, trader: ctx.owner, traderLeg, deskLeg });
  await assertIncoming(
    {
      data: deskData,
      instructionAccounts: (deskLeg.accounts ?? []).map((account) => account.address),
      recipient: ctx.keypair,
      registry: ctx.wallet.registry,
      tree,
      treeId: DEFAULT_TREE_ID,
    },
    { asset: receiveAsset, minAmount: BigInt(deskQuote.receiveAmount) },
  );

  onStage('Signing…');
  const signed = await ctx.sign(transactionFromMessage(messageBytes, [desk, ctx.owner]));
  const signature = signed.signatures[ctx.owner];
  if (!signature) throw new FlowError('The wallet did not sign.');

  onStage('Settling both transfers in one transaction…');
  const result = await api.deskSubmit({ quoteId: deskQuote.id, signature: bytesToBase64(signature as Uint8Array) });
  const slot = BigInt(result.slot);
  onStage('Syncing your private balance…');
  return { signature: result.signature, slot, synced: await afterLanding(session, slot), quote: deskQuote };
}

/* ---------------- Wallet operations ---------------- */

export async function depositSol(session: Session, lamports: bigint, onStage: Stage): Promise<Settled> {
  const available = await publicLamports(session.address);
  if (available < lamports + GAS_RESERVE_LAMPORTS) throw new FlowError('Leave at least 0.015 SOL public for fees.');
  onStage('Sign the deposit in your wallet…');
  const landed = await signAndSend(session.ctx, await depositTransaction(session.ctx, { asset: SOL, amount: lamports }));
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

/** The token program to name to Rings for a move: nothing for the SPL Token program, which is what it assumes. */
const programParam = (tokenProgram: string): { tokenProgram?: Address } => (tokenProgram === TOKEN_PROGRAM_ID ? {} : { tokenProgram: address(tokenProgram) });

function assertTokenProgram(tokenProgram: string): void {
  if (tokenProgram !== TOKEN_PROGRAM_ID && tokenProgram !== TOKEN_2022_PROGRAM_ID) throw new FlowError('This token belongs to a token program this site does not use. Nothing was built.');
}

/**
 * public -> private for SOL or for a token held in the wallet's ordinary token
 * account. `tokenProgram` is the token program the token's mint belongs to,
 * which decides where that account is: the SPL Token program unless said.
 */
export async function deposit(session: Session, asset: Address, amount: bigint, onStage: Stage, tokenProgram: string = TOKEN_PROGRAM_ID): Promise<Settled> {
  if (asset === SOL) return depositSol(session, amount, onStage);
  assertTokenProgram(tokenProgram);
  await requireGas(session);
  const source = getAssociatedTokenAddressSync(new PublicKey(asset), new PublicKey(session.address), false, new PublicKey(tokenProgram));
  onStage('Sign the deposit in your wallet…');
  const transaction = await depositTransaction(session.ctx, { asset, amount, sourceTokenAccount: address(source.toBase58()), ...programParam(tokenProgram) });
  const landed = await signAndSend(session.ctx, transaction);
  await knowAsset(session, asset).catch(() => undefined);
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

export async function withdraw(session: Session, asset: Address, amount: bigint, recipient: Address, onStage: Stage, tokenProgram: string = TOKEN_PROGRAM_ID): Promise<Settled> {
  if (asset !== SOL) assertTokenProgram(tokenProgram);
  await requireGas(session);
  await knowAsset(session, asset);
  const landed = await spending(session.ctx, async () => {
    onStage('Proving the withdrawal…');
    const transaction = await withdrawTransaction(session.ctx, { asset, amount, recipient, ...(asset === SOL ? {} : programParam(tokenProgram)) });
    onStage('Sign the withdrawal in your wallet…');
    return signAndSend(session.ctx, transaction);
  });
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

export async function sendPrivate(session: Session, asset: Address, amount: bigint, recipient: Address, onStage: Stage): Promise<Settled> {
  await requireGas(session);
  await knowAsset(session, asset);
  const landed = await spending(session.ctx, async () => {
    onStage('Proving the confidential transfer…');
    const transaction = await transferTransaction(session.ctx, { asset, amount, recipient });
    onStage('Sign the transfer in your wallet…');
    return signAndSend(session.ctx, transaction);
  });
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

/**
 * Refuses a destination that is not a wallet: a token account, a token's
 * mint, a program, or an account a program runs. Reads one account and signs
 * nothing. Returns the public SOL the address holds, zero when nothing has
 * happened at it yet.
 */
export async function requireWalletAddress(recipient: Address): Promise<bigint> {
  const info = await connection().getAccountInfo(new PublicKey(recipient), 'confirmed');
  const problem = destinationProblem(info ? { owner: info.owner.toBase58(), executable: info.executable } : null);
  if (problem) throw new FlowError(problem);
  return info ? BigInt(info.lamports) : 0n;
}

/**
 * An ordinary transfer out of the public balance: SOL, or a token from the
 * wallet's own token account. Everything about it is public. `everything`
 * sends all of the wallet's public SOL and leaves exactly zero; it is for SOL
 * only. Nothing is signed unless the chain accepts the transfer in simulation.
 *
 * It asks for no gas reserve: a wallet may be emptied. What it does check is
 * what the chain would refuse anyway, said in words: a remainder too small to
 * be held, an empty address opened with too little, a destination that is not
 * a wallet, and too little SOL to pay for a token transfer.
 */
export async function sendPublic(
  session: Session,
  asset: Address,
  amount: bigint,
  recipient: Address,
  everything: boolean,
  onStage: Stage,
  /** For a token of the Token-2022 program: its decimals, as its mint has them. Absent for SOL and SPL Token mints. */
  token2022?: { readonly decimals: number },
): Promise<Landed & { readonly amount: bigint }> {
  if (recipient === session.address) throw new FlowError('That is this wallet’s own address.');
  onStage('Checking the address…');
  const recipientLamports = await requireWalletAddress(recipient);
  const lamports = await publicLamports(session.address);
  let transaction;
  let sent = amount;
  if (asset === SOL) {
    if (everything) {
      const sweep = await buildSweep(session.ctx, recipient, lamports);
      if (!sweep) throw new FlowError('This wallet holds no more public SOL than the fee of sending it.');
      transaction = sweep.transaction;
      sent = sweep.lamports;
    } else {
      const fee = SIGNATURE_FEE_LAMPORTS + priorityOf(session.ctx, SEND_COMPUTE_UNITS.sol);
      const left = lamports - amount - fee;
      if (left < 0n) throw new FlowError('This wallet’s public SOL does not cover that amount and the network fee.');
      if (left < SYSTEM_RENT_EXEMPT_LAMPORTS) {
        throw new FlowError('That would leave less in this wallet than an account may hold (about 0.0009 SOL). Send a little less, or press MAX to send all of it.');
      }
      transaction = await buildPublicSend(session.ctx, { asset, amount, recipient });
    }
    if (sent < SYSTEM_RENT_EXEMPT_LAMPORTS && recipientLamports === 0n) {
      throw new FlowError('That address holds nothing yet, and the least an account can be opened with is about 0.0009 SOL. Send at least that.');
    }
  } else {
    if (everything) throw new FlowError('Sending everything is for SOL only.');
    const tokenProgram = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const held = await publicTokenUnits(session.address, asset, tokenProgram);
    if (held < amount) throw new FlowError('This wallet’s public balance of that token does not cover the amount.');
    // The sender pays the fee, and the rent of the recipient's token account when this is the first of this token they hold.
    const theirs = getAssociatedTokenAddressSync(new PublicKey(asset), new PublicKey(recipient), true, new PublicKey(tokenProgram));
    const opened = (await connection().getAccountInfo(theirs, 'confirmed')) !== null;
    const rent = token2022 ? TOKEN_2022_ACCOUNT_RENT_LAMPORTS : TOKEN_ACCOUNT_RENT_LAMPORTS;
    const needed = SIGNATURE_FEE_LAMPORTS + priorityOf(session.ctx, SEND_COMPUTE_UNITS.token) + (opened ? 0n : rent) + SYSTEM_RENT_EXEMPT_LAMPORTS;
    if (lamports < needed) {
      // Rounded up, so that holding the figure shown is enough.
      const shown = ((needed + 99_999n) / 100_000n) * 100_000n;
      throw new FlowError(
        `A token transfer needs about ${sol(shown, 4)} public SOL in this wallet: the network fee${opened ? '' : ', the rent of the recipient’s new token account'} and the least a wallet may be left with. It holds ${sol(lamports, 5)}.`,
      );
    }
    transaction = await buildPublicSend(session.ctx, { asset, amount, recipient, ...(token2022 ? { token2022 } : {}) });
  }
  onStage('Checking it against the chain…');
  const run = await simulate(session.ctx.client, transaction);
  if (!run.ok) throw new FlowError(`The chain would refuse this transfer, so nothing was sent: ${run.error}`);
  onStage('Sign the transfer in your wallet…');
  const landed = await signAndSend(session.ctx, transaction);
  return { ...landed, amount: sent };
}

/**
 * Whether `recipient` can be sent a private transfer. An address can receive
 * one only after its owner has registered with Rings, which publishes the
 * encryption key a sender needs. Asking costs nothing and signs nothing.
 */
export async function canReceivePrivately(recipient: Address): Promise<boolean> {
  return isRegistered(await ringsClient(), recipient);
}

/* ---------------- Burning ---------------- */

/**
 * Destroys `amount` base units of a launched token held in the private
 * balance. One transaction: the tokens leave the private balance and are
 * burned by the next instruction, so they are never left sitting in public.
 *
 * The burn itself is public: the wallet, the token and the amount. It has to
 * be, because it lowers the supply everyone reads.
 */
export async function burnFromPrivate(session: Session, mint: Address, amount: bigint, onStage: Stage): Promise<Settled> {
  if (mint === SOL) throw new FlowError('SOL cannot be burned.');
  await requireGas(session);
  await knowAsset(session, mint);
  if (privateBalance(session.ctx, mint) < amount) throw new FlowError('Your private balance of this token does not cover that burn.');
  const landed = await spending(session.ctx, async () => {
    onStage('Proving the withdrawal from your private balance…');
    const transaction = await buildBurnFromPrivate(session.ctx, connection(), new PublicKey(mint), amount);
    onStage('Sign the burn in your wallet…');
    return signAndSend(session.ctx, transaction);
  });
  onStage('Syncing your private balance…');
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

/**
 * Destroys `amount` base units held in the wallet's ordinary token account.
 * Nothing private moves, so the result says nothing about the private balance.
 */
export async function burnFromPublic(session: Session, mint: Address, amount: bigint, onStage: Stage): Promise<Landed> {
  if (mint === SOL) throw new FlowError('SOL cannot be burned.');
  await requireGas(session);
  // Read the account again now: closing it is only valid when this burn empties it.
  const held = await publicTokenUnits(session.address, mint);
  if (held < amount) throw new FlowError('Your public balance of this token does not cover that burn.');
  onStage('Sign the burn in your wallet…');
  const transaction = await buildBurnPublic(session.ctx, new PublicKey(mint), amount, held === amount);
  return signAndSend(session.ctx, transaction);
}

export async function consolidate(session: Session, asset: Address, onStage: Stage): Promise<Settled> {
  await requireGas(session);
  await ensureRegistered(session, onStage);
  onStage('Proving the merge…');
  const landed = await signAndSend(session.ctx, await mergeTransaction(session.ctx, asset));
  return { ...landed, synced: await afterLanding(session, landed.slot) };
}

export function rewards(session: Session, env: MarketEnv): Promise<Rewards> {
  return readRewards(env, session.address);
}

/**
 * Below this a claim costs more in fees than it is worth. A SOL amount: for a
 * token priced in another pair token it applies at that pair's rate
 * (`inPairUnits` in `pairs.ts`).
 */
export const MIN_CLAIM_LAMPORTS = 1_000_000n;

/**
 * Claims everything this wallet has earned on a token into its private
 * balance: curve fees first, then the graduated pool's. One transaction each.
 * Rewards are paid in the token's pair token; `minimum` is the smallest
 * amount worth claiming and `amount` what was claimed, both in its base units.
 */
export async function claimRewards(session: Session, env: MarketEnv, minimum: bigint, onStage: Stage): Promise<{ amount: bigint; landed: Landed[]; synced: boolean }> {
  const { pair } = env.market;
  await requireGasFor(session, env);
  const available = await readRewards(env, session.address);
  const sources: RewardSource[] = [];
  if (available.curve > 0n && available.curve >= minimum) sources.push('curve');
  const largest = available.positions[0]?.quoteUnits ?? 0n;
  if (largest > 0n && largest >= minimum) sources.push('pool');
  if (sources.length === 0) throw new FlowError(`There is less than ${pairAmount(minimum, pair, 6)} ${pair.symbol} to claim. Let it build up first.`);
  await knowAsset(session, quoteAssetOf(env.market)).catch(() => undefined);
  const landed: Landed[] = [];
  let amount = 0n;
  for (const source of sources) {
    try {
      onStage(source === 'curve' ? 'Building the curve fee claim…' : 'Building the pool fee claim…');
      const built = await buildClaimToPrivate(session.ctx, env, source);
      onStage('Sign the claim in your wallet…');
      landed.push(await signAndSend(session.ctx, built.transaction));
      amount += built.amount;
    } catch (error) {
      // The second claim failing does not undo the first: report what was claimed.
      if (landed.length === 0) throw error;
      break;
    }
  }
  const last = landed[landed.length - 1];
  return { amount, landed, synced: last ? await afterLanding(session, last.slot) : true };
}

/* ---------------- Graduation ---------------- */

/** Roughly what sending a graduation costs: the rent of the new pool's accounts, and the fee. For the message only. */
export const GRADUATION_COST_LAMPORTS = 60_000_000n;

/**
 * Sends the instruction that moves a completed curve into its Meteora pool.
 * Anyone may: Meteora's keeper usually does it, but not for every pair token
 * or curve size. The wallet pays the new pool's account rent and the fee and
 * gets nothing for it but a token that trades again.
 *
 * The transaction is run against the chain first, so one that would fail
 * (somebody else graduated the curve a moment ago) is never sent.
 */
export async function graduate(session: Session, mint: string, onStage: Stage): Promise<Landed> {
  onStage('Reading the curve…');
  const env = await loadMarketEnv(mint);
  if (env.market.stage === 'graduated') throw new FlowError('This token has already graduated. Reload the page.');
  if (env.market.stage !== 'migrating') throw new FlowError('This curve is not complete yet, so it cannot graduate.');
  const lamports = await publicLamports(session.address);
  if (lamports < GRADUATION_COST_LAMPORTS) {
    throw new FlowError('Graduating a curve needs about 0.06 public SOL: the rent of the new pool\'s accounts, and the fee.');
  }
  onStage('Building the graduation…');
  const built = await buildGraduation(session.ctx, dbc(), env.market);
  onStage('Checking it against the chain…');
  const check = await simulate(session.ctx.client, built.transaction);
  if (!check.ok) throw new FlowError(`The graduation would fail, so it was not sent. ${check.error}`);
  onStage('Sign the graduation in your wallet…');
  let signed = await session.ctx.sign(built.transaction);
  for (const signer of built.signers) signed = await addSignature(signer, signed);
  onStage('Sending…');
  const landed = await sendSigned(session.ctx, signed);
  await api.refreshToken(mint).catch(() => null);
  return landed;
}

/* ---------------- Launch ---------------- */

export interface LaunchRequest {
  /** The pair token the new token is priced in: `SOL`, `USDC`, ... */
  readonly pairId: string;
  readonly tierId: string;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  /** The creator's first buy, in base units of the pair token. 0 for none. */
  readonly firstBuy: bigint;
  /**
   * Fee modules to switch on straight after the launch, in a second
   * transaction. Shares in hundredths of a percent, adding up to 10000.
   */
  readonly modules?: ModuleSettingsChoice;
}

/** What a creator chose in the fee modules form. */
export interface ModuleSettingsChoice {
  readonly burnBps: number;
  readonly wallets: ReadonlyArray<{ readonly address: string; readonly bps: number }>;
}

/**
 * Asks the server where the creator role must go for `choice` to apply to
 * `mint`, and checks its answer: the memo it returns must be, to the letter,
 * the one this page writes for the same settings. The wallet it names is the
 * one thing that has to be taken on trust, and it is the platform's own
 * server that will run it.
 */
async function prepareModules(mint: string, dev: string, choice: ModuleSettingsChoice): Promise<ModuleActivation> {
  const status = await api.status();
  if (!status.modules.enabled) throw new FlowError('Fee modules are not available on this site right now.');
  const settings = checkModuleSettings({ mint, dev, burnBps: choice.burnBps, wallets: choice.wallets });
  const prepared = await api.prepareModules({ mint, dev, burnBps: settings.burnBps, wallets: settings.wallets });
  if (prepared.memo !== encodeModuleMemo(settings)) throw new FlowError('The server answered with different fee module settings than the ones you chose. Nothing was sent.');
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(prepared.wallet);
  } catch {
    throw new FlowError('The server did not name a wallet for the fee modules. Nothing was sent.');
  }
  if (wallet.toBase58() === dev || settings.wallets.some((entry) => entry.address === wallet.toBase58())) {
    throw new FlowError('The server named one of your own wallets as the fee module wallet. Nothing was sent.');
  }
  return { wallet, memo: prepared.memo };
}

/**
 * Has the server look over a creator's fee module settings before a launch
 * is started: the shares, and what each wallet is on chain. The token does not
 * exist yet, so nothing is offered or kept; the modules are switched on, and
 * checked again, once it does.
 */
export async function checkModules(choice: ModuleSettingsChoice): Promise<void> {
  const status = await api.status();
  if (!status.modules.enabled) throw new FlowError('Fee modules are not available on this site right now.');
  await api.checkModules({ burnBps: choice.burnBps, wallets: choice.wallets });
}

/**
 * Switches the fee modules of a token on. The wallet must hold the token's
 * creator role, which this hands over for good. The transaction is run
 * against the chain first, so one that would fail is never sent.
 */
export async function activateModules(session: Session, mint: string, choice: ModuleSettingsChoice, onStage: Stage): Promise<Landed> {
  await requireGas(session);
  onStage('Reading the token…');
  const env = await loadMarketEnv(mint);
  if (env.market.creator.toBase58() !== session.address) {
    throw new FlowError("This wallet does not hold the token's creator role, so it cannot switch its fee modules on.");
  }
  // Meteora lets the creator role move while the curve is open and again once the pool exists, not in between.
  if (env.market.stage === 'migrating') {
    throw new FlowError('This curve is complete and is moving to its pool. Fee modules can be switched on once it has graduated.');
  }
  onStage('Asking the server for the fee module wallet…');
  const modules = await prepareModules(mint, session.address, choice);
  onStage('Building the transaction…');
  const transaction = await buildModuleActivation(session.ctx, dbc(), env.market, modules);
  onStage('Checking it against the chain…');
  const check = await simulate(session.ctx.client, transaction);
  if (!check.ok) throw new FlowError(`Switching the fee modules on would fail, so nothing was sent. ${check.error}`);
  onStage('Sign in your wallet. This is permanent…');
  const landed = await signAndSend(session.ctx, transaction);
  onStage('Telling the server…');
  // The server takes the memo once its own read of the chain shows the hand-over, which can trail
  // this wallet's by a moment. If it never does here, its next pass finds the modules by itself.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await pause(2_000);
    const listed = await api.refreshToken(mint, modules.memo).catch(() => null);
    if (listed?.modules) break;
  }
  return landed;
}

/** What a first buy of `quoteIn` base units of the pair token returns on a new token of this pair and tier. */
export function firstBuyPreview(status: StatusResponse, pairId: string, tierId: string, quoteIn: bigint): { tokensOut: bigint; fee: bigint } {
  if (quoteIn <= 0n) return { tokensOut: 0n, fee: 0n };
  const pair = pairOf(status, pairId);
  if (!pair) throw new FlowError('That pair token is not known to this site.');
  return quoteFirstBuy(buildTierConfig(tierById(tierId), status.economics, curveQuoteOf(pair)), quoteIn);
}

export interface Launched extends Landed {
  readonly mint: string;
  /** True when a few token units of rounding from the first buy stayed in the public token account. */
  readonly dustLeftPublic: boolean;
  /**
   * Set when fee modules were asked for. The launch itself has landed either
   * way: this says whether the second transaction switched the modules on,
   * and why not when it did not.
   */
  readonly modules?: { readonly on: true; readonly signature: string } | { readonly on: false; readonly reason: string };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The checks a launch can fail before anything is uploaded or built: the pair
 * and the tier are live, the pair token is what the site says it is, and the
 * wallet can pay. Returns the config address of that pair and tier.
 */
export async function checkLaunch(session: Session, request: Pick<LaunchRequest, 'pairId' | 'tierId' | 'firstBuy' | 'modules'>): Promise<string> {
  const status = await api.status();
  const pair = pairOf(status, request.pairId);
  if (!pair) throw new FlowError('That pair token is not known to this site.');
  if (pair.problem) throw new FlowError(`Tokens cannot be launched against ${pair.symbol} right now. ${pair.problem}`);
  const tier = pair.tiers.find((candidate) => candidate.id === request.tierId);
  if (!tier?.config || !tier.live) throw new FlowError(tier?.problem ? `That fee tier cannot take launches right now. ${tier.problem}` : 'That fee tier is not live yet.');
  await assertPairMint(tradingPairOf(pair));
  const lamports = await publicLamports(session.address);
  // Mint, pool, vaults, metadata and the Rings interface all need rent, on top of any first buy.
  // Fee modules are a second transaction straight after, which must still find its fee in the wallet.
  const rent = 60_000_000n + (request.modules ? GAS_RESERVE_LAMPORTS : 0n);
  const needed = request.modules ? '0.075 public SOL for account rent and fees, the fee modules transaction included' : '0.06 public SOL for account rent and fees';
  if (pair.native) {
    if (lamports < request.firstBuy + rent) throw new FlowError(`Launching needs about ${needed}, plus your first buy.`);
  } else {
    if (lamports < rent) throw new FlowError(`Launching needs about ${needed}.`);
    if (request.firstBuy > 0n) {
      // The first buy is paid from the wallet's ordinary token account for the pair token.
      const held = await publicTokenUnits(session.address, pair.mint);
      if (held < request.firstBuy) {
        throw new FlowError(`Your first buy is paid from your public ${pair.symbol}, and the wallet holds ${pairAmount(held, pair, 6)} ${pair.symbol}. Lower it, or move ${pair.symbol} into the wallet first.`);
      }
    }
  }
  return tier.config;
}

export async function launch(session: Session, request: LaunchRequest, onStage: Stage): Promise<Launched> {
  const status = await api.status();
  const config = await checkLaunch(session, request);
  const mintSigner = await generateKeyPairSigner();
  const firstBuy = firstBuyPreview(status, request.pairId, request.tierId, request.firstBuy);
  const base = {
    configAddress: new PublicKey(config),
    baseMint: new PublicKey(mintSigner.address),
    name: request.name,
    symbol: request.symbol,
    uri: request.uri,
    firstBuy: request.firstBuy,
  };
  onStage('Building the launch transaction…');
  let transaction = await buildLaunch(session.ctx, dbc(), { ...base, firstBuyTokensOut: firstBuy.tokensOut });
  let dustLeftPublic = false;

  // Run it against the chain before asking for a signature.
  onStage('Checking the launch against the chain…');
  const check = await simulate(session.ctx.client, transaction);
  if (!check.ok) {
    if (request.firstBuy <= 0n) throw new FlowError(`The launch would fail, so it was not sent. ${check.error}`);
    // The first buy is sized with the curve's own arithmetic, and the plan is
    // exact to the unit. If the chain disagrees by a rounding unit, fall back to
    // a launch that accepts it: slightly less is guaranteed, and a surplus of a
    // few units stays in the public token account instead of failing the launch.
    const tolerant = await buildLaunch(session.ctx, dbc(), {
      ...base,
      firstBuyTokensOut: minusBps(firstBuy.tokensOut, 5),
      closeTokenAccount: false,
    });
    const second = await simulate(session.ctx.client, tolerant);
    if (!second.ok) throw new FlowError(`The launch would fail, so it was not sent. ${second.error}`);
    transaction = tolerant;
    dustLeftPublic = true;
  }

  onStage('Sign the launch in your wallet…');
  const signed = await addSignature(mintSigner, await session.ctx.sign(transaction));
  onStage('Sending…');
  const landed = await sendSigned(session.ctx, signed);
  onStage('Listing your token…');
  let listed = await api.refreshToken(mintSigner.address).catch(() => null);
  await session.sync(landed.slot).catch(() => undefined);
  if (!request.modules) return { ...landed, mint: mintSigner.address, dustLeftPublic };

  // Fee modules are a second transaction, sent once the server lists the token: it offers a
  // module wallet only for a token it can see, to the wallet the chain names as its creator.
  // The launch above has landed whatever happens here.
  let modules: Launched['modules'];
  for (let attempt = 0; !listed && attempt < 6; attempt += 1) {
    await pause(2_500);
    listed = await api.refreshToken(mintSigner.address).catch(() => null);
  }
  if (!listed) {
    modules = { on: false, reason: 'The server has not listed the token yet, so it could not offer a fee module wallet for it.' };
  } else {
    try {
      onStage('Your token is live. Now switching its fee modules on…');
      const switched = await activateModules(session, mintSigner.address, request.modules, onStage);
      modules = { on: true, signature: switched.signature };
    } catch (error) {
      modules = { on: false, reason: friendlyError(error) };
    }
  }
  return { ...landed, mint: mintSigner.address, dustLeftPublic, modules };
}
