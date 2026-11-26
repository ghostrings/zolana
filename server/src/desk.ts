/**
 * The Ghost desk: the platform's own wallet, acting as counterparty for Ghost
 * fills.
 *
 * A fill is one transaction with two confidential transfers, signed by the
 * trader and by the desk. The desk never takes custody of a trader's funds:
 * it signs last, only after it has decrypted the trader's transfer and seen
 * that it commits the quoted amount to the desk, and its own signature is
 * what makes the transaction valid at all.
 *
 * INVENTORY
 *   The desk keeps a SOL float in its private balance. It keeps a token
 *   inventory only for the mints the operator lists in DESK_STOCK_MINTS; for
 *   those it restocks on Meteora toward a target, so buys can be filled. For
 *   every other token it holds nothing of its own accord: tokens it receives
 *   from sellers are sold on to the pool over the next few passes, in slices
 *   of random size. It never buys an arbitrary token because that token was
 *   listed; a desk that did would be exit liquidity for whoever launched it.
 *
 * RISK LIMITS
 *   The desk quotes the pool's price without moving the pool, so it only
 *   takes orders whose price impact is small (DESK_MAX_IMPACT_BPS), never
 *   more than DESK_MAX_ORDER_LAMPORTS at once, and never lets its holding of
 *   one token exceed twice the inventory target. The spread is its only
 *   compensation for the time it carries a position.
 *
 * PAIR TOKENS
 *   The desk trades SOL against tokens priced in SOL, and nothing else. Its
 *   float, its limits and its restocking are all in SOL. A token priced in
 *   another pair token is refused here by name and trades on the Shielded
 *   route.
 *
 * WHAT AN OBSERVER CAN DO
 *   The desk's own pool trades are public. They are on a jittered timer and
 *   in sizes that do not match single fills, but with one trader active the
 *   correlation is still easy; with many it is not. The interface says so.
 *
 * TIME
 *   A quote holds a price for DESK_QUOTE_TTL_MS. The trader's page makes its
 *   proof first and asks for the price after, so that time only has to cover
 *   the request itself. Once the desk has prepared its side the trader has
 *   DESK_SIGN_WINDOW_MS to check it, sign and send it back.
 *
 * WHAT IT TELLS A TRADER AFTER SENDING
 *   Only what the chain has decided: landed, rejected, or too old to land. If
 *   the RPC stops answering it says that it does not know yet, never that
 *   nothing moved.
 *
 * Off by default. Turning it on also needs GHOST_DESK_MAINNET_ACK=YES.
 */

import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import {
  type Address,
  type Instruction,
  type Transaction,
  type TransactionPartialSigner,
  address,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
} from '@solana/kit';
import { LocalKeys, ShieldedKeypair, SigningKey, type ShieldedAddress } from '@heliuslabs/spr';
import type { SprClient } from '@heliuslabs/spr/client';
import { DEFAULT_TREE_ID, transactInstruction } from '@heliuslabs/spr/interface';
import { resolveRegisteredAddress } from '@heliuslabs/spr/wallet';

import { COMPUTE_UNITS, GAS_RESERVE_LAMPORTS, TOKEN_DECIMALS } from '../../shared/src/constants.js';
import { DESK_MAX_NOTES, DESK_SIGN_WINDOW_MS, type Outcome, mostFragmented } from '../../shared/src/desk-rules.js';
import {
  type GhostPrepareRequest,
  type GhostPrepareResponse,
  type GhostQuote,
  type GhostSide,
  type GhostSubmitRequest,
  type GhostSubmitResponse,
  GhostError,
  assertIncoming,
  assertLegAccounts,
  assertPlainTransfer,
  composeGhostFill,
  decodeTransactData,
  encodeTransactData,
} from '../../shared/src/ghost.js';
import { type Market, MarketError, quoteCurve, quoteGraduated, type TradeQuote } from '../../shared/src/meteora.js';
import {
  type RingsContext,
  SOL_MINT,
  buildGhostLeg,
  createRingsClient,
  depositTransaction,
  fetchAssetId,
  isRegistered,
  latestLifetime,
  mergeTransaction,
  newWalletState,
  priorityOf,
  privateBalance,
  privateHoldings,
  registrationTransactions,
  sendAndSettle,
  sendSigned,
  syncRings,
} from '../../shared/src/privacy.js';
import { buildShieldedBuy, buildShieldedSell, type MarketEnv } from '../../shared/src/routes.js';
import { addSignature, isValidSignature, withSignature } from '../../shared/src/signing.js';
import { base64ToBytes, composeV1, messageToBase64 } from '../../shared/src/tx.js';
import { minusBps } from '../../shared/src/units.js';
import type { Chain } from './chain.js';
import type { Store, TokenRow } from './db.js';
import { type PriorityOracle, fixedPriority } from './priority.js';
import { type AppEnv, parseSecretKey, requireRpc } from './env.js';

export class DeskError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'DeskError';
    this.code = code;
    this.status = status;
  }
}

interface Pending {
  readonly quoteId: string;
  readonly trader: Address;
  readonly transaction: Transaction;
  readonly expiresAt: number;
  /** The last block the prepared transaction can land in. */
  readonly lastValidBlockHeight: bigint;
}

/** What the desk says to a trader when its own side failed for a reason that is not theirs. */
const UNAVAILABLE = 'The desk could not do its side of this just now. Nothing was sent. Use the Shielded route, or try again in a minute.';
/** Seconds between two attempts to bring the desk up when the network was not there. */
const BOOT_RETRY_MS = 30_000;
/** Below this much public SOL the log says the desk is running out of fee money. */
export const DESK_LOW_GAS_LAMPORTS = GAS_RESERVE_LAMPORTS * 5n;

const SOL = SOL_MINT as Address;
/** A token position worth less than this is not worth a pool trade's fees. */
const DUST_VALUE_LAMPORTS = 5_000_000n;

/**
 * Public SOL the desk keeps for fees and temporary account rent. It trades
 * from its private balance only. Public SOL is moved there once the wallet
 * holds more than twice this, and this much is left behind. A desk funded with
 * less than that has nothing to trade with.
 */
export const DESK_PUBLIC_RESERVE_LAMPORTS = GAS_RESERVE_LAMPORTS * 20n;

/** What to tell an operator whose desk has no private SOL and too little public SOL to make any. */
export function deskFundingHint(publicLamports: bigint, privateLamports: bigint): string | null {
  if (privateLamports > 0n || publicLamports > DESK_PUBLIC_RESERVE_LAMPORTS * 2n) return null;
  const sol = (lamports: bigint): string => (Number(lamports) / 1e9).toString();
  return `The desk has no private SOL to trade with. It keeps ${sol(DESK_PUBLIC_RESERVE_LAMPORTS)} SOL public for fees and moves the rest into its private balance, but only once it holds more than ${sol(DESK_PUBLIC_RESERVE_LAMPORTS * 2n)} SOL. It holds ${sol(publicLamports)} SOL. Send it more.`;
}

export class Desk {
  readonly #env: AppEnv;
  readonly #chain: Chain;
  readonly #store: Store;
  readonly #log: (message: string) => void;
  #ctx: RingsContext | undefined;
  #signer: TransactionPartialSigner | undefined;
  #registered = false;
  /** True once the wallet has been read for the first time. Nothing is quoted before that. */
  #ready = false;
  #bootTimer: NodeJS.Timeout | undefined;
  /** Rings asset numbers by mint. They never change, so each is read from chain once. */
  readonly #assets = new Map<string, bigint>();
  /** When the log last said the same thing about fee money or split balances, so it says it hourly, not every pass. */
  readonly #said = new Map<string, number>();
  /** One fill at a time: the desk's notes cannot back two transactions at once. */
  #pending: Pending | undefined;
  #busy: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  /**
   * Wallets that had the desk prepare a fill and then never signed it. Each
   * prepared fill costs the desk a proof, so walking away earns a cooldown
   * that doubles with every repeat.
   */
  readonly #strikes = new Map<string, { count: number; until: number }>();

  readonly #priority: PriorityOracle;

  constructor(env: AppEnv, chain: Chain, store: Store, log: (message: string) => void, priority?: PriorityOracle) {
    this.#env = env;
    this.#chain = chain;
    this.#store = store;
    this.#log = log;
    this.#priority = priority ?? fixedPriority(env.priorityMinMicroLamports);
  }

  get enabled(): boolean {
    return this.#env.desk.enabled && this.#ctx !== undefined && this.#ready;
  }

  info(): { enabled: boolean; address: string | null; registered: boolean; spreadBps: number; maxOrderLamports: string; quoteTtlMs: number } {
    return {
      enabled: this.enabled && this.#registered,
      address: this.#ctx?.owner ?? null,
      registered: this.#registered,
      spreadBps: this.#env.desk.spreadBps,
      maxOrderLamports: this.#env.desk.maxOrderLamports.toString(),
      quoteTtlMs: this.#env.desk.quoteTtlMs,
    };
  }

  /** Builds the desk's wallet context. Used by the server and by `ops/desk.ts`. */
  static async context(
    env: AppEnv,
    priority: PriorityOracle = fixedPriority(env.priorityMinMicroLamports),
  ): Promise<{ ctx: RingsContext; signer: TransactionPartialSigner; client: SprClient }> {
    if (!env.desk.secretKey) throw new DeskError('NO_KEY', 'DESK_SECRET_KEY is not set.', 500);
    const { rpcUrl, sprUrl } = requireRpc(env);
    const secret = parseSecretKey(env.desk.secretKey, (text) => bs58.decode(text));
    const seed = new Uint8Array(secret.subarray(0, 32));
    const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as never));
    seed.fill(0);
    secret.fill(0);
    const client = await createRingsClient({ rpcUrl, sprUrl, priorityMicroLamports: priority.current() });
    const signer = keypair.toSolanaSigner();
    const shielded = keypair.shieldedAddress();
    const ctx: RingsContext = {
      client,
      wallet: newWalletState(shielded),
      keys: LocalKeys.fromKeypair(keypair, client.proofService),
      owner: signer.address,
      shielded,
      keypair,
      sign: (transaction) => addSignature(signer, transaction),
      priority: () => priority.current(),
    };
    return { ctx, signer, client };
  }

  async start(): Promise<void> {
    if (!this.#env.desk.enabled) return;
    // The key is read once. A key that cannot be read is a setting to fix, not something to retry.
    const { ctx, signer } = await Desk.context(this.#env, this.#priority);
    this.#ctx = ctx;
    this.#signer = signer;
    await this.#boot();
  }

  /**
   * Reads the wallet for the first time, and keeps trying when the network is
   * not there: a server that starts during an RPC outage must not be left with
   * a desk that never comes up, or one that quotes from a wallet it has not read.
   */
  async #boot(): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    try {
      await this.#chain.assertNetwork();
      this.#registered = await isRegistered(ctx.client, ctx.owner);
      if (!this.#registered) {
        this.#log(`desk: ${ctx.owner} is not registered with Rings. Run \`npm run desk:register\`. Ghost fill comes on by itself within a few minutes of that.`);
      }
      await syncRings(ctx);
      const publicLamports = await ctx.client.getBalance(ctx.owner);
      this.#ready = true;
      this.#log(`desk: ready at ${ctx.owner}, private SOL ${privateBalance(ctx, SOL).toString()} lamports`);
      const hint = deskFundingHint(publicLamports, privateBalance(ctx, SOL));
      if (hint) this.#log(`desk: ${hint}`);
      this.#scheduleRebalance();
    } catch (error) {
      this.#log(`desk: not up yet (${error instanceof Error ? error.message : String(error)}). Trying again in ${BOOT_RETRY_MS / 1000} seconds; Ghost fill is off until then.`);
      this.#bootTimer = setTimeout(() => void this.#boot(), BOOT_RETRY_MS);
      this.#bootTimer.unref();
    }
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#bootTimer) clearTimeout(this.#bootTimer);
  }

  /** Runs `work` after everything queued before it. Desk spends are strictly serial. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#busy.then(work, work);
    this.#busy = next.catch(() => undefined);
    return next;
  }

  #require(): { ctx: RingsContext; signer: TransactionPartialSigner } {
    if (!this.#ctx || !this.#signer || !this.#env.desk.enabled) {
      throw new DeskError('DESK_OFF', 'Ghost fill is not available right now. Use the Shielded route.', 503);
    }
    if (!this.#ready) throw new DeskError('DESK_OFF', 'The desk is still starting. Use the Shielded route, or try again in a minute.', 503);
    if (!this.#registered) throw new DeskError('DESK_OFF', 'The desk wallet is not registered yet. Use the Shielded route.', 503);
    return { ctx: this.#ctx, signer: this.#signer };
  }

  /**
   * An error a trader can be shown. The desk's own refusals pass through, and
   * so do the market's ("not listed", "migrating"). Anything else is the
   * desk's side failing for a reason that is not the trader's: it is logged
   * with its cause and the trader is pointed at the route that does not need
   * the desk.
   */
  #shown(error: unknown, during: string): unknown {
    if (error instanceof DeskError || error instanceof MarketError || error instanceof GhostError) return error;
    const code = (error as { code?: unknown } | null)?.code;
    const detail = error instanceof Error ? error.message : String(error);
    this.#log(`desk: ${during} failed: ${typeof code === 'string' ? `${code} ` : ''}${detail}`);
    if (code === 'TOO_FRAGMENTED' || code === 'TOO_MANY_INPUTS') {
      this.#log('desk: its own balance is split across too many notes for this order. Consolidate it: set DESK_AUTO_CONSOLIDATE=YES, or import the desk key on the wallet page and consolidate there.');
    }
    return new DeskError('DESK_UNAVAILABLE', UNAVAILABLE, 503);
  }

  async #publicQuote(market: Market, env: MarketEnv, side: GhostSide, amount: bigint): Promise<TradeQuote> {
    const request = { side, mode: 'exact-in' as const, amount, slippageBps: this.#env.desk.maxSlippageBps };
    if (market.stage === 'curve') return quoteCurve(this.#chain.dbc, this.#chain.connection, market, request);
    if (market.stage === 'graduated' && env.graduated) {
      return quoteGraduated(this.#chain.connection, market, env.graduated, request);
    }
    throw new DeskError('MIGRATING', 'This token is migrating to its pool. Try again in a moment.', 409);
  }

  /**
   * Price impact of an order, in basis points: how much worse the whole order
   * prices than a twentieth of it does, per unit.
   */
  async #impactBps(market: Market, env: MarketEnv, side: GhostSide, amount: bigint, fullOut: bigint): Promise<number> {
    const slice = amount / 20n;
    if (slice <= 0n) return 0;
    let sliceOut: bigint;
    try {
      sliceOut = (await this.#publicQuote(market, env, side, slice)).amountOut;
    } catch {
      return 0; // too small to quote a twentieth of: the order itself is tiny
    }
    if (sliceOut <= 0n) return 0;
    const marginal = Number(sliceOut) / Number(slice);
    const average = Number(fullOut) / Number(amount);
    if (!(marginal > 0)) return 0;
    return Math.max(0, Math.round((1 - average / marginal) * 10_000));
  }

  /* ---------------- quote ---------------- */

  async quote(input: { side: unknown; mint: unknown; amount: unknown }): Promise<GhostQuote> {
    try {
      return await this.#quote(input);
    } catch (error) {
      throw this.#shown(error, 'a quote');
    }
  }

  async #quote(input: { side: unknown; mint: unknown; amount: unknown }): Promise<GhostQuote> {
    const { ctx } = this.#require();
    if (input.side !== 'buy' && input.side !== 'sell') throw new DeskError('BAD_REQUEST', 'side must be buy or sell.');
    if (typeof input.mint !== 'string' || !isAddress(input.mint)) throw new DeskError('BAD_REQUEST', 'mint must be an address.');
    if (typeof input.amount !== 'string' || !/^[1-9][0-9]{0,18}$/.test(input.amount)) {
      throw new DeskError('BAD_REQUEST', 'amount must be a positive whole number of base units.');
    }
    const side: GhostSide = input.side;
    const amount = BigInt(input.amount);
    const mint = address(input.mint);
    const { market, graduated } = await this.#chain.market(mint);
    if (!market.pair.native) {
      throw new DeskError('PAIR_UNSUPPORTED', `Ghost fill trades tokens priced in SOL only. This one is priced in ${market.pair.symbol}: use the Shielded route.`, 409);
    }
    const env: MarketEnv = { connection: this.#chain.connection, dbc: this.#chain.dbc, market, ...(graduated ? { graduated } : {}) };
    // Without this the desk could neither read nor spend its notes in this token.
    await this.#knowAsset(ctx, mint);
    const reference = await this.#publicQuote(market, env, side, amount);
    const receive = minusBps(reference.amountOut, this.#env.desk.spreadBps);
    if (receive <= 0n) throw new DeskError('DUST', 'This trade is too small.');

    const notional = side === 'buy' ? amount : reference.amountOut;
    if (notional > this.#env.desk.maxOrderLamports) {
      throw new DeskError('TOO_LARGE', 'This is larger than the desk fills in one trade. Split it, or use the Shielded route.', 409);
    }
    if (this.#env.maxTradeLamports > 0n && notional > this.#env.maxTradeLamports) {
      throw new DeskError('TOO_LARGE', 'This is larger than the per-trade limit currently set on this site.', 409);
    }
    // The desk fills at the pool's price without moving the pool. That is only
    // safe for orders that would barely have moved it.
    const impactBps = await this.#impactBps(market, env, side, amount, reference.amountOut);
    if (impactBps > this.#env.desk.maxImpactBps) {
      throw new DeskError('TOO_LARGE', 'This order is large for the pool\'s current depth, so the desk will not fill it. Use the Shielded route, or a smaller size.', 409);
    }
    if (side === 'sell') {
      // Taking these tokens must not push the desk's holding past its cap.
      const perUnit = Number(reference.amountOut) / Number(amount);
      const heldValue = BigInt(Math.floor(Number(privateBalance(ctx, mint)) * perUnit));
      if (heldValue + notional > this.#env.desk.targetInventoryLamports * 2n) {
        throw new DeskError('NO_CAPACITY', 'The desk already holds as much of this token as it will carry. Use the Shielded route, or try again shortly.', 409);
      }
    }
    const receiveAsset = side === 'buy' ? mint : SOL;
    const now = Date.now();
    this.#store.expireQuotes(now);
    const reserved = this.#store.reservedOut(now).get(receiveAsset) ?? 0n;
    const available = privateBalance(ctx, receiveAsset) - reserved;
    if (available < receive) {
      throw new DeskError('NO_INVENTORY', 'The desk does not hold enough of this asset right now. Use the Shielded route, or try a smaller size.', 409);
    }
    const quote: GhostQuote = {
      id: randomBytes(16).toString('hex'),
      side,
      mint,
      desk: ctx.owner,
      payAsset: side === 'buy' ? SOL : mint,
      payAmount: amount.toString(),
      receiveAsset,
      receiveAmount: receive.toString(),
      referenceAmount: reference.amountOut.toString(),
      spreadBps: this.#env.desk.spreadBps,
      expiresAtMs: now + this.#env.desk.quoteTtlMs,
    };
    this.#store.saveQuote({
      id: quote.id,
      side,
      mint,
      trader: null,
      pay_asset: quote.payAsset,
      pay_amount: quote.payAmount,
      receive_asset: quote.receiveAsset,
      receive_amount: quote.receiveAmount,
      reference_amount: quote.referenceAmount,
      spread_bps: quote.spreadBps,
      status: 'quoted',
      message: null,
      signature: null,
      expires_at: quote.expiresAtMs,
      created_at: now,
    });
    return quote;
  }

  /* ---------------- prepare ---------------- */

  prepare(request: GhostPrepareRequest): Promise<GhostPrepareResponse> {
    return this.#serial(() => this.#prepare(request)).catch((error: unknown) => {
      throw this.#shown(error, 'preparing a fill');
    });
  }

  async #prepare(request: GhostPrepareRequest): Promise<GhostPrepareResponse> {
    const { ctx } = this.#require();
    const now = Date.now();
    if (this.#pending && this.#pending.expiresAt > now) {
      throw new DeskError('BUSY', 'The desk is settling another fill. Try again in a few seconds.', 429);
    }
    if (this.#pending) this.#strike(this.#pending.trader, now); // prepared, never signed
    this.#pending = undefined;
    if (typeof request.quoteId !== 'string' || typeof request.trader !== 'string' || !isAddress(request.trader)) {
      throw new DeskError('BAD_REQUEST', 'quoteId and trader are required.');
    }
    const strike = this.#strikes.get(request.trader);
    if (strike && strike.until > now) {
      throw new DeskError('COOLDOWN', 'This wallet left a prepared fill unsigned. Ghost fill is paused for it for a while; the Shielded route is not.', 429);
    }
    const row = this.#store.quote(request.quoteId);
    if (!row || row.status !== 'quoted') throw new DeskError('UNKNOWN_QUOTE', 'That quote is not open.', 404);
    if (row.expires_at < now) throw new DeskError('EXPIRED', 'That quote has expired. Request a new one.', 410);
    const trader = address(request.trader);
    if (trader === ctx.owner) throw new DeskError('BAD_REQUEST', 'The desk cannot trade with itself.');

    const resolved = await resolveRegisteredAddress({ rpc: ctx.client, owner: trader });
    if (!resolved) throw new DeskError('NOT_REGISTERED', 'Register your wallet with Rings before using Ghost fill.', 409);

    // 1. The trader's transfer, as data. Rebuild the instruction here; never accept one as bytes.
    let traderLeg: Instruction;
    try {
      const data = decodeTransactData(request.leg);
      assertPlainTransfer(data);
      traderLeg = await transactInstruction({
        payer: ctx.owner,
        ownerSigners: [trader],
        inputTree: ctx.client.tree,
        outputTree: ctx.client.tree,
        data,
      });
      assertLegAccounts(traderLeg, { payer: ctx.owner, owner: trader, counterparty: ctx.owner });

      // 2. Decrypt it. It must commit the quoted amount of the quoted asset to the desk.
      const payAsset = address(row.pay_asset);
      await this.#knowAsset(ctx, payAsset);
      await assertIncoming(
        {
          data,
          instructionAccounts: (traderLeg.accounts ?? []).map((account) => account.address),
          recipient: ctx.keypair as ShieldedKeypair,
          registry: ctx.wallet.registry,
          tree: ctx.client.tree,
          treeId: DEFAULT_TREE_ID,
        },
        { asset: payAsset, minAmount: BigInt(row.pay_amount) },
      );
    } catch (error) {
      if (error instanceof GhostError) throw new DeskError(error.code, error.message);
      throw new DeskError('BAD_LEG', 'Your transfer could not be read. Rebuild the trade and try again.');
    }

    // 3. Check the trader's proof against chain state before spending a proof of our own.
    const lifetime = await latestLifetime(ctx.client);
    await this.#simulate(
      composeV1({ feePayer: ctx.owner, lifetime, instructions: [traderLeg], computeUnitLimit: COMPUTE_UNITS.single }),
      'Your transfer does not verify against the current chain state. Sync your wallet and try again.',
    );

    // 4. The desk's transfer to the trader.
    const receiveAsset = address(row.receive_asset);
    await this.#knowAsset(ctx, receiveAsset);
    await syncRings(ctx);
    if (privateBalance(ctx, receiveAsset) < BigInt(row.receive_amount)) {
      throw new DeskError('NO_INVENTORY', 'The desk no longer holds enough of this asset. Nothing was sent; use the Shielded route.', 409);
    }
    const deskData = await buildGhostLeg(ctx, {
      asset: receiveAsset,
      amount: BigInt(row.receive_amount),
      recipient: resolved.address as ShieldedAddress,
      feePayer: ctx.owner,
    });
    const deskLeg = await transactInstruction({
      payer: ctx.owner,
      ownerSigners: [ctx.owner],
      inputTree: ctx.client.tree,
      outputTree: ctx.client.tree,
      data: deskData,
    });

    // 5. One transaction, both legs, desk pays the fee.
    // The desk pays the fee, so it also pays for priority.
    const transaction = composeGhostFill({ desk: ctx.owner, trader, traderLeg, deskLeg }, lifetime, priorityOf(ctx, COMPUTE_UNITS.ghostFill));
    await this.#simulate(transaction, 'The fill does not simulate. Nothing was sent; request a new quote.');

    const message = messageToBase64(transaction);
    // The price was held until the trader's proof arrived. From here the clock is the signing
    // window: it starts now, when the desk's own side is done, however long that took.
    const signBy = Date.now() + DESK_SIGN_WINDOW_MS;
    if (!this.#store.advanceQuote(row.id, 'quoted', 'prepared', { trader, message, expires_at: signBy })) {
      throw new DeskError('UNKNOWN_QUOTE', 'That quote is no longer open.', 409);
    }
    this.#pending = { quoteId: row.id, trader, transaction, expiresAt: signBy, lastValidBlockHeight: lifetime.lastValidBlockHeight };
    return { quoteId: row.id, deskLeg: encodeTransactData(deskData), message, signByMs: signBy };
  }

  /* ---------------- submit ---------------- */

  submit(request: GhostSubmitRequest): Promise<GhostSubmitResponse> {
    return this.#serial(() => this.#submit(request)).catch((error: unknown) => {
      throw this.#shown(error, 'settling a fill');
    });
  }

  async #submit(request: GhostSubmitRequest): Promise<GhostSubmitResponse> {
    const { ctx, signer } = this.#require();
    const pending = this.#pending;
    if (!pending || pending.quoteId !== request.quoteId) throw new DeskError('UNKNOWN_QUOTE', 'There is no prepared fill for that quote.', 404);
    if (pending.expiresAt < Date.now()) {
      // Late, but it did come back with a signature attempt: no strike.
      this.#pending = undefined;
      throw new DeskError('EXPIRED', 'That quote expired before it was signed. Nothing was sent.', 410);
    }
    let traderSignature: Uint8Array;
    try {
      traderSignature = base64ToBytes(String(request.signature));
    } catch {
      throw new DeskError('BAD_SIGNATURE', 'The signature is not valid base64.');
    }
    if (!(await isValidSignature(pending.transaction, pending.trader, traderSignature))) {
      throw new DeskError('BAD_SIGNATURE', 'That is not your signature over this fill.');
    }
    if (!this.#store.advanceQuote(pending.quoteId, 'prepared', 'submitted')) {
      throw new DeskError('UNKNOWN_QUOTE', 'That quote is no longer open.', 409);
    }
    this.#pending = undefined;

    // The desk signs last. Until this line the transaction could not land.
    const signed = await addSignature(signer, withSignature(pending.transaction, pending.trader, traderSignature));
    const signature = getSignatureFromTransaction(signed);
    let outcome: Outcome;
    try {
      outcome = await sendAndSettle(ctx, signed, pending.lastValidBlockHeight);
    } catch (error) {
      // The RPC ran the transaction before sending it and turned it down: it never left this server.
      this.#store.advanceQuote(pending.quoteId, 'submitted', 'failed', { signature });
      await syncRings(ctx).catch(() => undefined);
      this.#log(`desk: fill ${pending.quoteId} was refused before it was sent: ${error instanceof Error ? error.message : String(error)}`);
      throw new DeskError('NOT_LANDED', 'The fill was refused before it was sent. Nothing moved: both transfers settle together or not at all.', 502);
    }
    if (outcome.kind === 'landed') {
      this.#store.advanceQuote(pending.quoteId, 'submitted', 'landed', { signature });
      return { signature, slot: outcome.slot.toString() };
    }
    if (outcome.kind === 'pending') {
      // The RPC stopped answering. The quote stays "submitted": saying "failed" here would be a guess.
      this.#log(`desk: fill ${pending.quoteId} (${signature}) was sent and has not been seen to land or to expire; the RPC is not answering`);
      throw new DeskError(
        'UNCONFIRMED',
        'The fill was sent, but its confirmation has not been seen. It settles whole within the next minute or not at all. Check your private balance before trading again.',
        504,
      );
    }
    this.#store.advanceQuote(pending.quoteId, 'submitted', 'failed', { signature });
    await syncRings(ctx).catch(() => undefined);
    this.#log(`desk: fill ${pending.quoteId} (${signature}) ${outcome.kind === 'rejected' ? 'was rejected on chain' : 'expired before it was included'}`);
    throw new DeskError('NOT_LANDED', 'The fill did not land. Nothing moved: both transfers settle together or not at all.', 502);
  }

  /* ---------------- helpers ---------------- */

  #strike(trader: string, now: number): void {
    const previous = this.#strikes.get(trader);
    const count = Math.min((previous?.count ?? 0) + 1, 8);
    // 5 minutes, then 10, 20, ... capped at about ten hours.
    this.#strikes.set(trader, { count, until: now + 5 * 60_000 * 2 ** (count - 1) });
    if (this.#strikes.size > 10_000) {
      for (const [key, value] of this.#strikes) if (value.until < now - 86_400_000) this.#strikes.delete(key);
    }
  }

  /** Teaches the desk wallet a mint's Rings asset id, so it can decrypt and spend that asset. */
  async #knowAsset(ctx: RingsContext, mint: Address): Promise<void> {
    if (mint === SOL) return;
    let assetId = this.#assets.get(mint);
    if (assetId === undefined) {
      assetId = await fetchAssetId(ctx.client, mint);
      if (assetId === undefined) throw new DeskError('NO_INTERFACE', 'This token has no Rings interface yet.', 409);
      this.#assets.set(mint, assetId);
    }
    ctx.wallet.ensureAsset(assetId, mint);
  }

  /** Says a thing in the log at most once an hour. */
  #sayHourly(key: string, message: string): void {
    const now = Date.now();
    if (now - (this.#said.get(key) ?? 0) < 3_600_000) return;
    this.#said.set(key, now);
    this.#log(message);
  }

  async #simulate(transaction: Transaction, message: string): Promise<void> {
    const { ctx } = this.#require();
    const wire = getBase64EncodedWireTransaction(transaction);
    const result = await ctx.client.solanaRpc
      .simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
      .send();
    if (result.value.err) {
      this.#log(`desk: simulation failed: ${JSON.stringify(result.value.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      throw new DeskError('SIMULATION_FAILED', message, 409);
    }
  }

  /* ---------------- inventory ---------------- */

  #scheduleRebalance(): void {
    const base = this.#env.desk.rebalanceSeconds * 1000;
    // Jitter decouples the desk's public pool trades from the fills that caused them.
    const delay = base / 2 + Math.random() * base;
    this.#timer = setTimeout(() => {
      void this.#serial(() => this.#rebalance())
        .catch((error) => this.#log(`desk: rebalance: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.#scheduleRebalance());
    }, delay);
    this.#timer.unref();
  }

  /**
   * One inventory pass. At most one pool trade per pass, picked at random
   * among the tokens that need one.
   *
   *  - A mint in DESK_STOCK_MINTS is kept near the target: bought when the
   *    desk holds less than half of it, trimmed when it holds more than double.
   *  - Any other token is unwound: a random slice of whatever the desk holds
   *    is sold, so a position taken from a seller is gone within a few passes
   *    and no single pool trade mirrors a single fill.
   */
  async #rebalance(): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx || !this.#ready) return;
    if (!this.#registered) {
      // Registered from the operator's computer after this server started: no restart needed.
      this.#registered = await isRegistered(ctx.client, ctx.owner);
      if (!this.#registered) return;
      this.#log('desk: the wallet is registered with Rings now. Ghost fill is on.');
    }
    if (this.#pending && this.#pending.expiresAt > Date.now()) return;
    await syncRings(ctx);
    const publicLamports = await this.#keepGasReserve(ctx);
    if (publicLamports < DESK_LOW_GAS_LAMPORTS) {
      this.#sayHourly('gas', `desk: only ${(Number(publicLamports) / 1e9).toString()} public SOL left for fees. Every fill and pool trade is paid from it, and they stop when it runs out. Send SOL to ${ctx.owner}.`);
    }
    if (await this.#consolidate(ctx)) return;

    const target = this.#env.desk.targetInventoryLamports;
    const stocked = new Set(this.#env.desk.stockMints);
    // What the desk holds, and what it is told to keep in stock: nothing else can need a trade.
    // (Reading the wallet resolves every token in it, so a token taken from a seller is found here
    // however many tokens the site lists.)
    const held = privateHoldings(ctx)
      .map((holding) => holding.mint as string)
      .filter((mint) => mint !== SOL);
    const candidates = this.#store
      .tokensByMints([...new Set([...held, ...stocked])])
      // Only tokens priced in SOL: the desk holds and quotes nothing else.
      .filter((token) => token.pair === 'SOL' && (token.stage === 'curve' || token.stage === 'graduated'))
      .sort(() => Math.random() - 0.5);

    for (const token of candidates) {
      try {
        if (await this.#rebalanceOne(ctx, token, stocked.has(token.mint), target)) return;
      } catch (error) {
        // One token that cannot be traded right now must not stop the others.
        this.#log(`desk: ${token.symbol || token.mint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Returns true when it sent a pool trade. */
  async #rebalanceOne(ctx: RingsContext, token: TokenRow, isStocked: boolean, target: bigint): Promise<boolean> {
    const mint = address(token.mint);
    await this.#knowAsset(ctx, mint).catch(() => undefined);
    const held = privateBalance(ctx, mint);
    if (!isStocked && held <= 0n) return false;
    const priceLamportsPerUnit = (Number(token.price_sol) * 1e9) / 10 ** TOKEN_DECIMALS;
    if (!(priceLamportsPerUnit > 0)) return false;
    const heldValue = BigInt(Math.floor(Number(held) * priceLamportsPerUnit));
    const { market, graduated } = await this.#chain.market(token.mint);
    if (!market.pair.native) return false;
    const env: MarketEnv = { connection: this.#chain.connection, dbc: this.#chain.dbc, market, ...(graduated ? { graduated } : {}) };
    const quoteOf = (request: { side: 'buy' | 'sell'; mode: 'exact-in' | 'exact-out'; amount: bigint; slippageBps: number }) =>
      market.stage === 'curve'
        ? quoteCurve(this.#chain.dbc, this.#chain.connection, market, request)
        : quoteGraduated(this.#chain.connection, market, graduated!, request);

    if (isStocked && heldValue * 2n < target) {
      const spend = target - heldValue;
      if (privateBalance(ctx, SOL) < spend * 2n) return false; // keep at least as much SOL float as we spend
      const probe = await this.#publicQuote(market, env, 'buy', spend);
      const tokensOut = minusBps(probe.amountOut, 50);
      const quote = await quoteOf({ side: 'buy', mode: 'exact-out', amount: tokensOut, slippageBps: this.#env.desk.maxSlippageBps });
      const landed = await sendSigned(ctx, await ctx.sign(await buildShieldedBuy(ctx, env, quote)));
      this.#log(`desk: restocked ${token.symbol || token.mint} (${landed.signature})`);
      return true;
    }

    let sellUnits = 0n;
    if (isStocked) {
      if (heldValue > target * 2n) sellUnits = held - BigInt(Math.floor(Number(target) / priceLamportsPerUnit));
    } else if (heldValue >= DUST_VALUE_LAMPORTS) {
      // 40% to 100% of the position, so the size on chain is not the size of any one fill.
      const share = 40n + BigInt(Math.floor(Math.random() * 61));
      sellUnits = heldValue <= DUST_VALUE_LAMPORTS * 4n ? held : (held * share) / 100n;
    }
    if (sellUnits <= 0n) return false;
    const quote = await quoteOf({ side: 'sell', mode: 'exact-in', amount: sellUnits, slippageBps: this.#env.desk.maxSlippageBps });
    const landed = await sendSigned(ctx, await ctx.sign(await buildShieldedSell(ctx, env, quote)));
    this.#log(`desk: ${isStocked ? 'trimmed' : 'unwound'} ${token.symbol || token.mint} (${landed.signature})`);
    return true;
  }

  /** Public SOL above the gas reserve is moved into the private float. Returns the public SOL left. */
  async #keepGasReserve(ctx: RingsContext): Promise<bigint> {
    const publicLamports = await ctx.client.getBalance(ctx.owner);
    const keep = DESK_PUBLIC_RESERVE_LAMPORTS;
    if (publicLamports > keep * 2n) {
      const transaction = await depositTransaction(ctx, { asset: SOL, amount: publicLamports - keep });
      const landed = await sendSigned(ctx, await ctx.sign(transaction));
      this.#log(`desk: moved public SOL into the private float (${landed.signature})`);
      return keep;
    }
    return publicLamports;
  }

  /**
   * A balance split across many notes makes fills fail: one transfer can spend
   * five. When DESK_AUTO_CONSOLIDATE is on, the most split balance is merged
   * into one note, one balance per pass; otherwise the log says so, hourly.
   * Returns true when it sent a transaction.
   */
  async #consolidate(ctx: RingsContext): Promise<boolean> {
    const crowded = mostFragmented(privateHoldings(ctx).map((holding) => ({ mint: holding.mint as string, notes: holding.notes })));
    if (!crowded) return false;
    const label = crowded.mint === SOL ? 'SOL' : crowded.mint;
    if (!this.#env.desk.autoConsolidate) {
      this.#sayHourly(
        `notes:${crowded.mint}`,
        `desk: its ${label} is split across ${crowded.notes} notes. One fill can spend five, so larger orders of it will be refused. Set DESK_AUTO_CONSOLIDATE=YES to have the desk merge them (keep more than ${DESK_MAX_NOTES} from building up), or import the desk key on the wallet page and consolidate there.`,
      );
      return false;
    }
    try {
      const landed = await sendSigned(ctx, await ctx.sign(await mergeTransaction(ctx, address(crowded.mint))));
      this.#log(`desk: consolidated ${crowded.notes} notes of ${label} (${landed.signature})`);
      return true;
    } catch (error) {
      this.#sayHourly(`merge:${crowded.mint}`, `desk: could not consolidate its ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** For `ops/desk.ts register`. */
  static async register(env: AppEnv, priority?: PriorityOracle): Promise<string[]> {
    const { ctx } = await Desk.context(env, priority);
    const signatures: string[] = [];
    for (const transaction of await registrationTransactions(ctx)) {
      const landed = await sendSigned(ctx, await ctx.sign(transaction));
      signatures.push(landed.signature);
    }
    return signatures;
  }
}
