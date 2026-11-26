/**
 * What prvmax does with vaults. Almost all of it is the same flows a single
 * wallet uses, run with a vault in the wallet's place: registering, private
 * transfers, shielded trades, Ghost fills, withdrawals. The transactions that
 * are prvmax's own touch no private balance: giving vaults their SOL for
 * fees, moving what a trade left in a vault's ordinary token accounts,
 * closing those accounts, and sending a vault's SOL back.
 *
 * Nothing here is tried twice once a transaction may have gone out. A step
 * that fails after that point could have moved the money, and running it
 * again could move it twice, so the run stops and says where; the chain is
 * read again before anything else is done. The one step that is repeated is
 * a spend refused because the balance is in too many notes: that refusal
 * comes while the proof is being prepared, before anything is signed.
 */

import { type Address, address } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';

import { GAS_RESERVE_LAMPORTS, TOKEN_PROGRAM_ID, WSOL_MINT } from '../../shared/src/constants.js';
import { type Landed, type PrivateHolding, SOL_MINT, isRegistered, privateBalance, privateHoldings, signAndSend, simulate } from '../../shared/src/privacy.js';
import { quoteAssetOf } from '../../shared/src/routes.js';
import {
  CLOSE_BATCH,
  CREATOR_MESSAGE,
  type GasTransfer,
  SYSTEM_RENT_EXEMPT_LAMPORTS,
  buildCloseAccounts,
  buildGasFunding,
  buildMoveToken,
  buildSweep,
  creatorRefused,
  gasTopUps,
  hasGas,
} from '../../shared/src/vaults.js';
import { connection, loadMarketEnv, publicLamports, ringsClient } from './chain.js';
import { sol } from './format.js';
import type { VaultHandle, VaultSet } from './subwallets.js';
import {
  FlowError,
  type Settled,
  type Stage,
  consolidate,
  ensureRegistered,
  friendlyError,
  QuoteMoved,
  ghostFill,
  ghostQuote,
  knowAsset,
  planShieldedBuy,
  planShieldedSell,
  sendPrivate,
  shieldedBuy,
  shieldedSell,
  withdraw,
} from './trade.js';
import { type Session, ownAddresses } from './wallet.js';

export const VAULT_SOL = SOL_MINT as Address;

/**
 * Something this file found out for itself and says in a whole sentence: a
 * vault that is short of SOL, a token its owner created, a quote that moved.
 * A page shows these as written. Every other failure is the chain's or the
 * network's, and goes through the site's usual explanations.
 */
export class VaultNotice extends FlowError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultNotice';
  }
}

/* ---------------- Pacing ---------------- */

/**
 * The server lets one visitor ask for a limited number of proofs a minute.
 * Steps that need one are started at least this far apart, so that a run over
 * ten vaults stays under that limit instead of stopping halfway.
 */
export const PROOF_SPACING_MS = 6_000;
let lastProofAt = 0;

async function proofTurn(): Promise<void> {
  const wait = lastProofAt + PROOF_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastProofAt = Date.now();
}

const labelOf = (handle: VaultHandle): string => `Vault ${handle.index}`;

/** A vault signs for itself, so the flows' "sign in your wallet" lines would be wrong for it. */
function vaultStage(handle: VaultHandle, onStage: Stage): Stage {
  return (message) => onStage(`${labelOf(handle)}: ${message.replace(/Sign the (transaction|transfer|withdrawal) in your wallet…/, 'Sending…').replace('your private wallet', 'it').replace(/\byour private balance\b/g, 'its private balance')}`);
}

/* ---------------- Reading a vault ---------------- */

export interface VaultState {
  readonly index: number;
  readonly address: Address;
  /** Public SOL, in lamports: what the vault pays fees from. Null when it could not be read. */
  readonly lamports: bigint | null;
  /** Whether the vault is registered with Rings. Null when that could not be read. */
  readonly registered: boolean | null;
  /** The vault's private balances. Null when they could not be read; never shown as zero then. */
  readonly holdings: readonly PrivateHolding[] | null;
}

/**
 * A vault as the chain has it now. Never throws: what could not be read is
 * null. A vault known to hold no SOL and known never to have registered has
 * not been used, so nothing can have been sent to it privately and its notes
 * are not asked for.
 */
export async function readVaultState(handle: VaultHandle): Promise<VaultState> {
  const client = await ringsClient().catch(() => null);
  const [lamports, registered] = await Promise.all([
    publicLamports(handle.address).catch(() => null),
    client ? isRegistered(client, handle.address).catch(() => null) : Promise.resolve(null),
  ]);
  if (lamports === 0n && registered === false) return { index: handle.index, address: handle.address, lamports, registered, holdings: [] };
  let holdings: readonly PrivateHolding[] | null;
  try {
    const session = await handle.session();
    await session.sync();
    holdings = privateHoldings(session.ctx);
  } catch {
    holdings = null;
  }
  return { index: handle.index, address: handle.address, lamports, registered, holdings };
}

/** Reads several vaults, three at a time, and answers in the order given. */
export async function readVaultStates(handles: readonly VaultHandle[]): Promise<VaultState[]> {
  const states = new Array<VaultState>(handles.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const mine = next;
      next += 1;
      const handle = handles[mine];
      if (!handle) return;
      states[mine] = await readVaultState(handle);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return states;
}

/* ---------------- Getting vaults ready ---------------- */

/** Checks a transaction against the chain, and only then signs and sends it. */
async function sendChecked(session: Session, transaction: Parameters<typeof signAndSend>[1], what: string): Promise<Landed> {
  const run = await simulate(session.ctx.client, transaction);
  if (!run.ok) throw new FlowError(`${what} would fail, so nothing was sent: ${run.error}`);
  return signAndSend(session.ctx, transaction);
}

/**
 * One transaction from the wallet that brings each of these vaults up to
 * `target` lamports of public SOL. Null when none of them needs any.
 */
export async function fundGas(
  main: Session,
  vaults: ReadonlyArray<{ readonly address: string; readonly lamports: bigint }>,
  target: bigint,
  onStage: Stage,
): Promise<{ landed: Landed; transfers: GasTransfer[]; total: bigint } | null> {
  const transfers = gasTopUps(vaults, target);
  if (transfers.length === 0) return null;
  const total = transfers.reduce((sum, transfer) => sum + transfer.lamports, 0n);
  const available = await publicLamports(main.address);
  if (available < total + GAS_RESERVE_LAMPORTS) {
    throw new VaultNotice(
      `The wallet needs ${sol(total + GAS_RESERVE_LAMPORTS, 4)} public SOL for this: ${sol(total, 4)} for the vaults and 0.015 for its own fees. It holds ${sol(available, 4)}. SOL in the private balance does not count here: withdraw some to the wallet first, on the Wallet page.`,
    );
  }
  onStage(`Sending SOL for fees to ${transfers.length} vault${transfers.length === 1 ? '' : 's'}. Sign it in your wallet…`);
  const landed = await sendChecked(main, await buildGasFunding(main.ctx, transfers), 'Funding the vaults');
  return { landed, transfers, total };
}

/** Registers a vault with Rings, once, so that it can be sent to privately. The vault signs and pays for it itself. */
export async function registerVault(handle: VaultHandle, onStage: Stage): Promise<void> {
  await ensureRegistered(await handle.session(), vaultStage(handle, onStage));
}

/* ---------------- Spread ---------------- */

/** One private transfer from the wallet to a vault. The vault must be registered. */
export async function spreadTo(main: Session, handle: VaultHandle, asset: Address, amount: bigint, onStage: Stage): Promise<Settled> {
  if (amount <= 0n) throw new VaultNotice('Enter an amount greater than zero.');
  if (!(await isRegistered(await ringsClient(), handle.address))) {
    throw new VaultNotice(`${labelOf(handle)} is not registered yet, so it cannot be sent to privately. Use Get ready first.`);
  }
  await proofTurn();
  const landed = await sendPrivate(main, asset, amount, handle.address, (message) => onStage(`${labelOf(handle)}: ${message}`));
  // So the vault can read what it was just sent without searching Rings' whole list of tokens for it. Only a convenience.
  await handle
    .session()
    .then((session) => knowAsset(session, asset))
    .catch(() => undefined);
  return landed;
}

/* ---------------- Trading from a vault ---------------- */

const FRAGMENTED = /TOO_MANY_INPUTS|TOO_FRAGMENTED|too many notes/i;

/**
 * Runs `step`, and when it is refused because the balance is in too many
 * notes, merges that balance and runs it once more. The refusal comes while
 * the proof is being prepared, before anything is signed, so nothing has moved.
 */
async function withMerge<T>(session: Session, asset: Address, handle: VaultHandle, onStage: Stage, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const text = `${error instanceof Error ? error.message : String(error)} ${(error as { code?: unknown } | null)?.code ?? ''} ${friendlyError(error)}`;
    if (!FRAGMENTED.test(text)) throw error;
    onStage(`${labelOf(handle)}: its balance is in too many notes. Merging them first…`);
    await proofTurn();
    await consolidate(session, asset, vaultStage(handle, onStage));
    return step();
  }
}

/** A token to trade, as the site lists it. `creator` is the wallet that launched it. */
export interface TradeToken {
  readonly mint: string;
  readonly creator: string;
}

export interface TradeRules {
  readonly slippageBps: number;
  /** The operator's per-trade limit in the pair token's base units, or 0n for none. */
  readonly cap: bigint;
}

export interface VaultTrade {
  readonly signature: string;
  /** False when the vault's balance could not be re-read afterwards. The trade settled all the same. */
  readonly synced: boolean;
  readonly route: 'shielded' | 'ghost';
  readonly mint: string;
  /** The pair token's id. */
  readonly pair: string;
  /** Pair token, base units: the most paid for a buy, the least received for a sell. Exact for a Ghost fill. */
  readonly quote: bigint;
  /** The token, base units. */
  readonly tokens: bigint;
}

async function tradeEnv(vaults: VaultSet, token: TradeToken) {
  const env = await loadMarketEnv(token.mint);
  const creators = [token.creator, env.market.creator.toBase58()];
  if (creatorRefused(creators, vaults.main.address, [...vaults.all.map((vault) => vault.address), ...ownAddresses()])) throw new VaultNotice(CREATOR_MESSAGE);
  if (env.market.stage === 'migrating') throw new VaultNotice('This curve is complete and is migrating to its pool. Trading resumes in a moment.');
  return env;
}

function overCap(units: bigint, rules: TradeRules, symbol: string, decimals: number): string | null {
  if (rules.cap <= 0n || units <= rules.cap) return null;
  return `Trades are limited to ${Number(rules.cap) / 10 ** decimals} ${symbol} each on this site for now. Use a smaller amount for each vault.`;
}

/** Brings a vault's view of its own balance up to date before something is spent from it. */
async function readForSpend(session: Session, assets: readonly Address[]): Promise<void> {
  for (const asset of assets) await knowAsset(session, asset).catch(() => undefined);
  await session.sync();
}

/**
 * A Shielded buy from one vault: out of its private balance, through the
 * pool, back into its private balance. The trade on the pool is public.
 */
export async function vaultBuy(vaults: VaultSet, handle: VaultHandle, token: TradeToken, spend: bigint, rules: TradeRules, onStage: Stage): Promise<VaultTrade> {
  if (spend <= 0n) throw new VaultNotice('Enter an amount greater than zero.');
  const env = await tradeEnv(vaults, token);
  const { pair } = env.market;
  const limit = overCap(spend, rules, pair.symbol, pair.decimals);
  if (limit) throw new VaultNotice(limit);
  const session = await handle.session();
  const asset = quoteAssetOf(env.market);
  await readForSpend(session, [address(token.mint), asset]);
  if (privateBalance(session.ctx, asset) < spend) {
    throw new VaultNotice(`${labelOf(handle)} holds less ${pair.symbol} privately than this buy spends. Spread more to it, or lower the amount.`);
  }
  const done = await withMerge(session, asset, handle, onStage, async () => {
    // Priced again on every attempt: each vault's buy moves the price the next one pays.
    const fresh = await loadMarketEnv(token.mint);
    const plan = await planShieldedBuy(fresh, spend, rules.slippageBps);
    await proofTurn();
    return { landed: await shieldedBuy(session, fresh, plan, vaultStage(handle, onStage)), plan };
  });
  return { signature: done.landed.signature, synced: done.landed.synced, route: 'shielded', mint: token.mint, pair: pair.id, quote: done.plan.spendCap, tokens: done.plan.quote.amountOut };
}

/** A Shielded sell of `units` of a token from one vault. The proceeds stay in the vault's private balance. */
export async function vaultSell(vaults: VaultSet, handle: VaultHandle, token: TradeToken, units: bigint, rules: TradeRules, onStage: Stage): Promise<VaultTrade> {
  if (units <= 0n) throw new VaultNotice('Enter an amount greater than zero.');
  const env = await tradeEnv(vaults, token);
  const { pair } = env.market;
  const session = await handle.session();
  const asset = address(token.mint);
  await readForSpend(session, [asset, quoteAssetOf(env.market)]);
  if (privateBalance(session.ctx, asset) < units) throw new VaultNotice(`${labelOf(handle)} holds less of this token privately than this sell asks for.`);
  const done = await withMerge(session, asset, handle, onStage, async () => {
    const fresh = await loadMarketEnv(token.mint);
    const plan = await planShieldedSell(fresh, units, rules.slippageBps);
    const limit = overCap(plan.amountOut, rules, pair.symbol, pair.decimals);
    if (limit) throw new VaultNotice(limit);
    await proofTurn();
    return { landed: await shieldedSell(session, fresh, plan, vaultStage(handle, onStage)), plan };
  });
  return { signature: done.landed.signature, synced: done.landed.synced, route: 'shielded', mint: token.mint, pair: pair.id, quote: done.plan.minimumAmountOut, tokens: units };
}

/**
 * A Ghost fill from one vault: the vault and the desk swap two private
 * transfers in one transaction, and the pool is not touched, so the token and
 * the amounts stay encrypted. `amount` is what the vault pays: SOL for a buy,
 * the token for a sell. `leastReceived` is the least the vault accepts back;
 * a quote below it is refused before anything is signed.
 */
export async function vaultGhost(
  vaults: VaultSet,
  handle: VaultHandle,
  token: TradeToken,
  side: 'buy' | 'sell',
  amount: bigint,
  leastReceived: bigint,
  onStage: Stage,
): Promise<VaultTrade> {
  if (amount <= 0n) throw new VaultNotice('Enter an amount greater than zero.');
  const env = await tradeEnv(vaults, token);
  if (!env.market.pair.native) throw new VaultNotice(`Ghost fill trades tokens priced in SOL only. This one is priced in ${env.market.pair.symbol}: use the Shielded route.`);
  const session = await handle.session();
  const paying = side === 'buy' ? VAULT_SOL : address(token.mint);
  await readForSpend(session, [address(token.mint), VAULT_SOL]);
  if (privateBalance(session.ctx, paying) < amount) throw new VaultNotice(`${labelOf(handle)} holds less privately than this trade pays.`);
  const fill = await withMerge(session, paying, handle, onStage, async () => {
    onStage(`${labelOf(handle)}: asking the desk for a quote…`);
    const quote = await ghostQuote(side, token.mint, amount);
    if (BigInt(quote.payAmount) !== amount) throw new VaultNotice('The desk quoted a different amount than was asked. Nothing was sent.');
    if (BigInt(quote.receiveAmount) < leastReceived) {
      throw new VaultNotice('The desk’s price has moved past your limit since the quote you were shown. Nothing was sent. Look at a new quote, then press again.');
    }
    await proofTurn();
    try {
      // The desk is asked for its price again once the proof is made; that price is the one that settles.
      const result = await ghostFill(session, quote, leastReceived, vaultStage(handle, onStage));
      return { result, quote: result.quote };
    } catch (error) {
      if (error instanceof QuoteMoved) {
        throw new VaultNotice('The desk’s price has moved past your limit since the quote you were shown. Nothing was sent. Look at a new quote, then press again.');
      }
      throw error;
    }
  });
  const paid = BigInt(fill.quote.payAmount);
  const received = BigInt(fill.quote.receiveAmount);
  return {
    signature: fill.result.signature,
    synced: fill.result.synced,
    route: 'ghost',
    mint: token.mint,
    pair: env.market.pair.id,
    quote: side === 'buy' ? paid : received,
    tokens: side === 'buy' ? received : paid,
  };
}

/* ---------------- Recall ---------------- */

export interface TokenAccountLine {
  readonly account: string;
  readonly mint: string;
  readonly amount: bigint;
}

/** A wallet's ordinary token accounts: the ones a trade in a pair token other than SOL opens, and leaves its change in. */
export async function publicTokenAccounts(owner: string): Promise<TokenAccountLine[]> {
  const result = await connection().getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: new PublicKey(TOKEN_PROGRAM_ID) });
  const lines: TokenAccountLine[] = [];
  for (const entry of result.value) {
    const info = (entry.account.data as { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown } } } }).parsed?.info;
    if (!info || typeof info.mint !== 'string' || typeof info.tokenAmount?.amount !== 'string') continue;
    lines.push({ account: entry.pubkey.toBase58(), mint: info.mint, amount: BigInt(info.tokenAmount.amount) });
  }
  return lines;
}

export interface RecallResult {
  readonly index: number;
  /** What left the private balance, one line per token. */
  readonly moved: ReadonlyArray<{ readonly mint: string; readonly amount: bigint; readonly signature: string; readonly privately: boolean }>;
  /** Tokens that sat in the vault's ordinary token accounts and were sent on by an ordinary, public transfer. */
  readonly movedPublic: ReadonlyArray<{ readonly mint: string; readonly amount: bigint; readonly signature: string }>;
  /** Tokens in an ordinary token account that could not be moved, and why. */
  readonly left: ReadonlyArray<{ readonly mint: string; readonly amount: bigint; readonly reason: string }>;
  /** How many token accounts were closed: the empty ones, and any that held wrapped SOL, which closing pays out. */
  readonly closed: number;
  /** Public SOL sent back, in lamports. Zero when the vault held none worth sending. */
  readonly swept: bigint;
  /** Why the SOL stayed, when it did. Empty otherwise. */
  readonly note: string;
}

/**
 * Empties one vault into `destination`.
 *
 *   1. every private balance: a private transfer when `privately` (the
 *      destination must be registered), otherwise a withdrawal, in public;
 *   2. whatever sits in the vault's ordinary token accounts, by an ordinary
 *      transfer, and those accounts are closed;
 *   3. the vault's public SOL, all of it.
 *
 * The order matters. The SOL goes last because every earlier step pays its
 * fee from it, and a vault whose SOL is gone can do nothing more.
 */
export async function recallVault(handle: VaultHandle, destination: Address, privately: boolean, onStage: Stage): Promise<RecallResult> {
  const label = labelOf(handle);
  if (destination === handle.address) throw new VaultNotice('A vault cannot be recalled into itself.');
  const client = await ringsClient();
  // Read without a net: a recall that could not see the vault must say so, not report it empty.
  const [before, registered] = await Promise.all([publicLamports(handle.address), isRegistered(client, handle.address)]);
  const moved: Array<{ mint: string; amount: bigint; signature: string; privately: boolean }> = [];
  const movedPublic: Array<{ mint: string; amount: bigint; signature: string }> = [];
  const left: Array<{ mint: string; amount: bigint; reason: string }> = [];
  if (before === 0n && !registered) return { index: handle.index, moved, movedPublic, left, closed: 0, swept: 0n, note: 'Never used.' };

  const session = await handle.session();
  onStage(`${label}: reading its private balance…`);
  await session.sync();
  const holdings = privateHoldings(session.ctx);
  for (const holding of holdings) {
    // Asked before every move: each one pays its fee from the vault's public SOL, and the flows refuse to start below the reserve.
    const gas = await publicLamports(handle.address);
    if (!hasGas(gas)) {
      throw new VaultNotice(
        `${label} still holds private balances but only ${sol(gas, 4)} public SOL, and moving them needs 0.015 there for fees. Use Get ready to top its SOL up, then recall again. ${moved.length > 0 ? 'What already moved from it stays moved.' : 'Nothing was moved from it.'}`,
      );
    }
    const landed = await withMerge(session, holding.mint, handle, onStage, async () => {
      await proofTurn();
      return privately
        ? sendPrivate(session, holding.mint, holding.amount, destination, vaultStage(handle, onStage))
        : withdraw(session, holding.mint, holding.amount, destination, vaultStage(handle, onStage));
    });
    moved.push({ mint: holding.mint, amount: holding.amount, signature: landed.signature, privately });
  }

  // What trades left in the vault's ordinary token accounts. Wrapped SOL is SOL: closing its account pays it out.
  let closed = 0;
  if ((await publicLamports(handle.address)) > 0n) {
    const accounts = await publicTokenAccounts(handle.address);
    for (const line of accounts.filter((entry) => entry.amount > 0n && entry.mint !== WSOL_MINT)) {
      const transaction = await buildMoveToken(session.ctx, destination, line);
      const run = await simulate(client, transaction);
      if (!run.ok) {
        left.push({ mint: line.mint, amount: line.amount, reason: run.error });
        continue;
      }
      onStage(`${label}: sending on what a trade left in its token account…`);
      const landed = await signAndSend(session.ctx, transaction);
      movedPublic.push({ mint: line.mint, amount: line.amount, signature: landed.signature });
    }
    const closable = accounts.filter((entry) => entry.amount === 0n || entry.mint === WSOL_MINT).map((entry) => entry.account);
    for (let start = 0; start < closable.length; start += CLOSE_BATCH) {
      const batch = closable.slice(start, start + CLOSE_BATCH);
      onStage(`${label}: closing ${batch.length} token account${batch.length === 1 ? '' : 's'} it no longer needs…`);
      await sendChecked(session, await buildCloseAccounts(session.ctx, batch), 'Closing the token accounts');
      closed += batch.length;
    }
  }

  // Last: the SOL itself, so that the vault is left holding exactly nothing.
  const balance = await publicLamports(handle.address);
  if (balance === 0n) return { index: handle.index, moved, movedPublic, left, closed, swept: 0n, note: '' };
  const sweep = await buildSweep(session.ctx, destination, balance);
  if (!sweep) return { index: handle.index, moved, movedPublic, left, closed, swept: 0n, note: 'What is left is less than the fee of sending it.' };
  if (sweep.lamports < SYSTEM_RENT_EXEMPT_LAMPORTS && (await publicLamports(destination)) === 0n) {
    return { index: handle.index, moved, movedPublic, left, closed, swept: 0n, note: 'What is left is too little to open the destination’s account with.' };
  }
  onStage(`${label}: sending its SOL back…`);
  const exact = await simulate(client, sweep.transaction);
  if (exact.ok) {
    await signAndSend(session.ctx, sweep.transaction);
    return { index: handle.index, moved, movedPublic, left, closed, swept: sweep.lamports, note: '' };
  }
  // The chain would not take the transfer that leaves exactly nothing. An account may also be left
  // holding the least an account can hold, so that is tried once, and the rest still comes back.
  const most = await buildSweep(session.ctx, destination, balance, SYSTEM_RENT_EXEMPT_LAMPORTS);
  if (most && (await simulate(client, most.transaction)).ok) {
    await signAndSend(session.ctx, most.transaction);
    return {
      index: handle.index,
      moved,
      movedPublic,
      left,
      closed,
      swept: most.lamports,
      note: `${sol(SYSTEM_RENT_EXEMPT_LAMPORTS, 6)} SOL stayed in the vault: the chain refused the transfer that would have emptied it exactly.`,
    };
  }
  throw new FlowError(`Sending the SOL back would fail, so it was not sent: ${exact.error}`);
}
