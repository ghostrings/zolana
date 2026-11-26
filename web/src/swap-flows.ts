/**
 * Buying and selling a token that was not launched here, through Jupiter.
 *
 * Each trade is one transaction the wallet signs: what is paid leaves the
 * private balance (or the public one), Jupiter swaps it, and what the swap is
 * certain to return goes into the private balance. Jupiter's instructions are
 * read and checked before anything is built (`readBuild`), the finished
 * transaction is run against the chain and what it would leave in the wallet
 * is compared with what it should (`settleConverted`), and only then is the
 * wallet asked to sign.
 *
 * A swap says what it pays in, not what it returns, so a buy deposits the
 * least the swap can return. What it returns above that is left in the
 * wallet's public token account; `shieldRest` moves it into the private
 * balance as a second, ordinary deposit.
 */

import { address } from '@solana/kit';

import type { PairRef } from '../../shared/src/api.js';
import { GAS_RESERVE_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS, WSOL_MINT } from '../../shared/src/constants.js';
import { type ConversionSwap, OUTSIDE_ACCOUNTS } from '../../shared/src/jupiter.js';
import { markSpend, privateBalance, signAndSend } from '../../shared/src/privacy.js';
import {
  type OutsideToken,
  type OutsideTrade,
  RINGS_INTERFACE_RENT_LAMPORTS,
  buildOutsideBuy,
  buildOutsideSell,
  buildShieldRest,
  ringsAssetOf,
} from '../../shared/src/routes.js';
import { TxError } from '../../shared/src/tx.js';
import { minusBps } from '../../shared/src/units.js';
import { connection, publicLamports, publicTokenUnits } from './chain.js';
import { sol } from './format.js';
import { amount as pairAmount } from './pairs.js';
import {
  type ConversionSource,
  FlowError,
  type Settled,
  type Stage,
  afterLanding,
  assertCounter,
  fetchConversion,
  knowAsset,
  requireGas,
  settleConverted,
  shorterRoute,
} from './trade.js';
import type { Session } from './wallet.js';

const NO_ROOM = 'This route does not fit in one transaction with the deposit. Nothing was sent. Try a smaller amount, which often takes a shorter route.';
const WORSE_ROUTE = 'The only route that fits in one transaction returns less than your limit allows. Nothing was sent. Try a smaller amount.';

const defaultAccounts = (source: ConversionSource): number => (source === 'public' ? OUTSIDE_ACCOUNTS.fromPublic : OUTSIDE_ACCOUNTS.fromPrivate);

/* ---------------- Buying ---------------- */

export interface OutsideBuyPlan {
  readonly token: OutsideToken;
  /** What is paid with: SOL or USDC. */
  readonly paying: PairRef;
  /** Exactly what is paid, in base units of `paying`. */
  readonly payAmount: bigint;
  readonly source: ConversionSource;
  /** The swap into the token. Its `minimumOut` is what goes into the private balance. */
  readonly swap: ConversionSwap;
  readonly slippageBps: number;
  readonly maxAccounts: number;
}

/**
 * Asks Jupiter for the swap of exactly `payAmount` into the token, for this
 * wallet, and reads the answer. The slippage limit is the swap's own: there is
 * no second swap to share it with.
 */
export async function planOutsideBuy(
  taker: string,
  token: OutsideToken,
  paying: PairRef,
  payAmount: bigint,
  slippageBps: number,
  source: ConversionSource,
  maxAccounts: number = defaultAccounts(source),
): Promise<OutsideBuyPlan> {
  if (paying.mint === token.mint) throw new FlowError(`${paying.symbol} cannot be bought with itself.`);
  await assertCounter(paying);
  const swap = await fetchConversion({ inputMint: paying.mint, outputMint: token.mint, amount: payAmount, taker, slippageBps, maxAccounts, outputProgram: token.programId });
  return { token, paying, payAmount, source, swap, slippageBps, maxAccounts };
}

export interface OutsideBought extends Settled {
  /** What went into the private balance, in the token's base units: the least the swap could return. */
  readonly deposited: bigint;
  /** What the swap returned above that, now in the wallet's public token account. Null when it could not be read. */
  readonly leftover: bigint | null;
  /** True when the wallet had no public account for the token before this buy, so that account can be closed once it is empty. */
  readonly accountIsNew: boolean;
  /** True when this buy was the first deposit of the token into Rings, and paid for its registry entry and vault. */
  readonly createdInterface: boolean;
}

export async function outsideBuy(session: Session, plan: OutsideBuyPlan, onStage: Stage): Promise<OutsideBought> {
  const { paying, token } = plan;
  const payingSol = paying.mint === WSOL_MINT;
  const mint = address(token.mint);
  const lamports = await publicLamports(session.address);
  if (plan.source === 'public') {
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
    if (lamports < GAS_RESERVE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS) {
      throw new FlowError('Keep at least 0.018 public SOL in the wallet: fees are paid from it, and so is the rent of the token account the swap delivers into.');
    }
    await knowAsset(session, ringsAssetOf(paying.mint));
    if (privateBalance(session.ctx, ringsAssetOf(paying.mint)) < plan.payAmount) {
      throw new FlowError(`Your private ${paying.symbol} balance does not cover this buy. Deposit ${paying.symbol} in the wallet first, or pay from the public balance.`);
    }
  }
  // The wallet may not have met this token yet. When Rings has no place for it, this buy makes one.
  await knowAsset(session, mint).catch(() => undefined);

  let current = plan;
  for (let attempt = 0; ; attempt += 1) {
    let trade: OutsideTrade | null = null;
    const mark = markSpend(session.ctx);
    try {
      onStage(current.source === 'private' ? 'Proving the withdrawal from your private balance…' : 'Building the trade…');
      trade = await buildOutsideBuy(session.ctx, connection(), { swap: current.swap, token, source: current.source, payingSymbol: paying.symbol });
      if (trade.createsInterface) {
        const needed = GAS_RESERVE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS + RINGS_INTERFACE_RENT_LAMPORTS + (current.source === 'public' && payingSol ? current.payAmount : 0n);
        if (lamports < needed) {
          throw new FlowError(
            `Nobody has held ${token.symbol} privately before, so this buy also creates its place in Rings. That costs about ${sol(RINGS_INTERFACE_RENT_LAMPORTS, 4)} SOL of rent, once, and whoever is first pays it. This buy needs ${sol(needed, 4)} public SOL in the wallet, which holds ${sol(lamports, 4)}.`,
          );
        }
      }
      const landed = await settleConverted(session, trade, onStage);
      // From here on the money has moved, and nothing may turn that into an error.
      onStage('Syncing your private balance…');
      await knowAsset(session, mint).catch(() => undefined);
      const synced = await afterLanding(session, landed.slot);
      let leftover: bigint | null;
      try {
        const now = await publicTokenUnits(session.address, token.mint, token.programId);
        leftover = now > trade.publicBefore ? now - trade.publicBefore : 0n;
      } catch {
        leftover = null;
      }
      return { ...landed, synced, deposited: current.swap.minimumOut, leftover, accountIsNew: !trade.tokenAccountExisted, createdInterface: trade.createsInterface };
    } catch (error) {
      // A try that was never sent gives back the notes it was built on, so the next one can use them.
      mark.release();
      // Too big for one transaction: nothing has been signed, so ask for a shorter route, once.
      const fewer = attempt === 0 ? shorterRoute(error, session.address, trade, current.maxAccounts) : null;
      if (fewer === null) throw error instanceof TxError ? new FlowError(NO_ROOM) : error;
      onStage('Finding a shorter route…');
      current = await planOutsideBuy(session.address, token, paying, plan.payAmount, plan.slippageBps, plan.source, fewer);
      if (current.swap.minimumOut < minusBps(plan.swap.minimumOut, plan.slippageBps)) throw new FlowError(WORSE_ROUTE);
    }
  }
}

/* ---------------- Selling ---------------- */

export interface OutsideSellPlan {
  readonly token: OutsideToken;
  /** What is received: SOL or USDC. */
  readonly receiving: PairRef;
  /** Exactly what is sold, in the token's base units. */
  readonly units: bigint;
  /** Where the tokens come from. */
  readonly source: ConversionSource;
  /** The swap out of the token. Its `minimumOut` is what goes into the private balance. */
  readonly swap: ConversionSwap;
  readonly slippageBps: number;
  readonly maxAccounts: number;
}

export async function planOutsideSell(
  taker: string,
  token: OutsideToken,
  receiving: PairRef,
  units: bigint,
  slippageBps: number,
  source: ConversionSource,
  maxAccounts: number = defaultAccounts(source),
): Promise<OutsideSellPlan> {
  if (receiving.mint === token.mint) throw new FlowError(`${receiving.symbol} cannot be sold for itself.`);
  await assertCounter(receiving);
  const swap = await fetchConversion({ inputMint: token.mint, outputMint: receiving.mint, amount: units, taker, slippageBps, maxAccounts, inputProgram: token.programId });
  return { token, receiving, units, source, swap, slippageBps, maxAccounts };
}

export interface OutsideSold extends Settled {
  /** What went into the private balance, in base units of what was received: the least the swap could return. */
  readonly deposited: bigint;
}

export async function outsideSell(session: Session, plan: OutsideSellPlan, onStage: Stage): Promise<OutsideSold> {
  const { receiving, token } = plan;
  const mint = address(token.mint);
  if (receiving.mint === WSOL_MINT) await requireGas(session);
  else if ((await publicLamports(session.address)) < GAS_RESERVE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS) {
    throw new FlowError(`Keep at least 0.018 public SOL in the wallet: fees, temporary account rent, and the token account a sale for ${receiving.symbol} opens the first time.`);
  }
  if (plan.source === 'private') {
    await knowAsset(session, mint);
    if (privateBalance(session.ctx, mint) < plan.units) throw new FlowError(`Your private ${token.symbol} balance does not cover this sale.`);
  } else {
    const held = await publicTokenUnits(session.address, token.mint, token.programId);
    if (held < plan.units) throw new FlowError(`Your public ${token.symbol} balance does not cover this sale.`);
  }
  // So the proceeds can be read as soon as they land in the private balance.
  await knowAsset(session, ringsAssetOf(receiving.mint)).catch(() => undefined);

  let current = plan;
  for (let attempt = 0; ; attempt += 1) {
    let trade: OutsideTrade | null = null;
    const mark = markSpend(session.ctx);
    try {
      onStage(current.source === 'private' ? 'Proving the withdrawal from your private balance…' : 'Building the trade…');
      trade = await buildOutsideSell(session.ctx, connection(), { swap: current.swap, token, source: current.source, receivingSymbol: receiving.symbol });
      const landed = await settleConverted(session, trade, onStage);
      onStage('Syncing your private balance…');
      return { ...landed, synced: await afterLanding(session, landed.slot), deposited: current.swap.minimumOut };
    } catch (error) {
      // A try that was never sent gives back the notes it was built on, so the next one can use them.
      mark.release();
      const fewer = attempt === 0 ? shorterRoute(error, session.address, trade, current.maxAccounts) : null;
      if (fewer === null) throw error instanceof TxError ? new FlowError(NO_ROOM) : error;
      onStage('Finding a shorter route…');
      current = await planOutsideSell(session.address, token, receiving, plan.units, plan.slippageBps, plan.source, fewer);
      if (current.swap.minimumOut < minusBps(plan.swap.minimumOut, plan.slippageBps)) throw new FlowError(WORSE_ROUTE);
    }
  }
}

/* ---------------- What a buy left over ---------------- */

export interface RestShielded extends Settled {
  /** What was moved into the private balance, in the token's base units. */
  readonly amount: bigint;
  /** True when the public token account was closed and its rent returned. */
  readonly closed: boolean;
}

/**
 * Moves `amount` of the token from the wallet's public token account into the
 * private balance. With `closeWhenEmpty` the account is closed in the same
 * transaction when the deposit takes everything in it, and its rent comes
 * back. The balance is read again first: closing is only valid for an account
 * this empties.
 */
export async function shieldRest(session: Session, token: OutsideToken, amount: bigint, closeWhenEmpty: boolean, onStage: Stage): Promise<RestShielded> {
  await requireGas(session);
  const held = await publicTokenUnits(session.address, token.mint, token.programId);
  if (held < amount) throw new FlowError(`The wallet's public ${token.symbol} balance is lower than it was a moment ago, so nothing was moved. Open the wallet to see what it holds.`);
  const close = closeWhenEmpty && held === amount;
  if (amount === 0n && !close) throw new FlowError('There is nothing left over to move.');
  onStage(amount > 0n ? 'Sign the deposit of what was left over…' : 'Sign to close the empty token account…');
  const transaction = await buildShieldRest(session.ctx, token, amount, close);
  const landed = await signAndSend(session.ctx, transaction);
  await knowAsset(session, address(token.mint)).catch(() => undefined);
  return { ...landed, synced: await afterLanding(session, landed.slot), amount, closed: close };
}
