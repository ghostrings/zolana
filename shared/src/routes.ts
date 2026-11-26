/**
 * Trade routes: how a private balance meets a public pool.
 *
 * SHIELDED ROUTE (this file)
 *   One atomic transaction: withdraw from the private balance, swap on
 *   Meteora, deposit the proceeds back into the private balance. No
 *   counterparty, no custody, works with any wallet. The swap leg is a public
 *   pool trade, so the wallet, the token and the size are visible on chain.
 *   What stays private is the balance the funds came from and went back to.
 *
 * PAIR TOKENS
 *   A token is priced in the pair token it was launched against: SOL, or an
 *   SPL token such as USDC. The routes are the same either way. SOL is
 *   wrapped and unwrapped inside the swap and held natively by Rings; any
 *   other pair token passes through the wallet's ordinary token account for
 *   it, which is opened if it is missing and then left open.
 *
 * CONVERTED TRADES (the end of this file, and `jupiter.ts`)
 *   Paying with SOL or USDC for a token priced in something else, or being
 *   paid in them. A conversion through Jupiter is placed in front of the
 *   Meteora swap (a buy) or behind it (a sell), in the same transaction, so
 *   either all of it happens or none of it does.
 *
 * OUTSIDE TOKENS (the end of this file, and `jupiter.ts`)
 *   A token that was not launched here has no pool this site knows. It is
 *   bought and sold through Jupiter alone: withdraw what is paid, swap, and
 *   deposit what the swap is certain to return, in one transaction.
 *
 * GHOST FILL (`ghost.ts`, `privacy.ts`)
 *   Two confidential transfers in one co-signed transaction between the trader
 *   and the desk. The asset and the amount are encrypted on chain.
 */

import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
  address,
  createKeyPairSignerFromBytes,
} from '@solana/kit';
import { type Connection, PublicKey } from '@solana/web3.js';
import {
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { buildDepositTransaction } from '@heliuslabs/spr';
import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { COMPUTE_UNITS, TOKEN_2022_PROGRAM_ID, TOKEN_DECIMALS, TOKEN_PROGRAM_ID, WSOL_MINT } from './constants.js';
import { type BalanceFloor, type ConversionSwap, balanceIn, solOverhead } from './jupiter.js';
import {
  type GraduatedPool,
  type Market,
  MarketError,
  type PositionFees,
  type TradeQuote,
  claimCreatorFeeInstructions,
  claimPositionFeeInstructions,
  createPoolInstructions,
  curveSwapInstructions,
  graduatedPositionFees,
  graduatedSwapInstructions,
  migrationInstructions,
  quoteMintOf,
  transferCreatorInstruction,
} from './meteora.js';
import { moduleMemoInstruction, parseModuleMemo } from './modules.js';
import {
  type RingsContext,
  SOL_MINT,
  createInterfaceInstruction,
  depositInstructions,
  fetchAssetId,
  latestLifetime,
  readProtocolFacts,
  withdrawInstructions,
  priorityOf,
} from './privacy.js';
import { composeV1, fromLegacyInstruction, fromLegacyInstructions, instructionsOf } from './tx.js';

const TOKEN_PROGRAM = address(TOKEN_PROGRAM_ID);

export interface MarketEnv {
  readonly connection: Connection;
  readonly dbc: DynamicBondingCurveClient;
  readonly market: Market;
  /** Required when `market.stage` is `graduated`. */
  readonly graduated?: GraduatedPool;
}

function tokenAccountOf(owner: Address, mint: PublicKey, program: string = TOKEN_PROGRAM_ID): { key: PublicKey; address: Address } {
  const key = getAssociatedTokenAddressSync(mint, new PublicKey(owner), false, new PublicKey(program));
  return { key, address: address(key.toBase58()) };
}

async function accountExists(connection: Connection, key: PublicKey): Promise<boolean> {
  return (await connection.getAccountInfo(key, 'confirmed')) !== null;
}

/** The Rings asset a market's pair token is held as: native SOL, or the pair token's mint. */
export function quoteAssetOf(market: Pick<Market, 'pair'>): Address {
  return market.pair.native ? (SOL_MINT as Address) : address(market.pair.mint);
}

const closeAccount = (account: PublicKey, owner: PublicKey, program: string = TOKEN_PROGRAM_ID): Instruction =>
  fromLegacyInstruction(createCloseAccountInstruction(account, owner, owner, [], new PublicKey(program)));

async function swapInstructions(env: MarketEnv, owner: Address, quote: TradeQuote): Promise<Instruction[]> {
  const ownerKey = new PublicKey(owner);
  if (env.market.stage === 'curve') {
    return fromLegacyInstructions(await curveSwapInstructions(env.dbc, env.market, ownerKey, quote));
  }
  if (env.market.stage === 'graduated') {
    if (!env.graduated) throw new MarketError('NOT_LOADED', 'The graduated pool was not loaded.');
    return fromLegacyInstructions(
      await graduatedSwapInstructions(env.connection, env.market, env.graduated, ownerKey, quote),
    );
  }
  throw new MarketError('MIGRATING', 'This curve is complete and is migrating to its pool. Trading resumes in a moment.');
}

/**
 * Buy from a private balance of the pair token into a private token balance.
 *
 * The quote must be exact-out: the swap returns exactly `amountOut` tokens, so
 * the deposit that follows can name that amount. Up to `maximumAmountIn` of
 * the pair token leaves the private balance; whatever the swap does not use
 * stays in the wallet, public: as SOL, or in the wallet's token account for
 * the pair token.
 */
export async function buildShieldedBuy(ctx: RingsContext, env: MarketEnv, quote: TradeQuote): Promise<Transaction> {
  if (quote.side !== 'buy' || quote.mode !== 'exact-out') {
    throw new MarketError('BAD_QUOTE', 'A shielded buy needs an exact-out buy quote.');
  }
  await requireInterface(ctx, env.market.mint);
  const mint = address(env.market.mint.toBase58());
  const token = tokenAccountOf(ctx.owner, env.market.mint);
  const tokenAccountExisted = await accountExists(env.connection, token.key);

  // For a pair token other than SOL the withdrawal opens the wallet's token account for it when it is missing.
  const withdraw = await withdrawInstructions(ctx, {
    asset: quoteAssetOf(env.market),
    amount: quote.maximumAmountIn,
    recipient: ctx.owner,
    tokenProgram: TOKEN_PROGRAM,
  });
  const swap = await swapInstructions(env, ctx.owner, quote);
  const deposit = await depositInstructions(ctx, {
    asset: mint,
    amount: quote.amountOut,
    sourceTokenAccount: token.address,
    tokenProgram: TOKEN_PROGRAM,
  });
  // The token account only existed to carry the tokens from the pool to the
  // private balance. If this transaction created it, close it and take the rent back.
  const cleanup = tokenAccountExisted ? [] : [closeAccount(token.key, new PublicKey(ctx.owner))];

  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: [...withdraw, ...swap, ...deposit, ...cleanup],
    computeUnitLimit: COMPUTE_UNITS.shieldedTrade,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.shieldedTrade),
  });
}

/**
 * Sell from a private token balance into a private balance of the pair token.
 *
 * The quote must be exact-in. Exactly `minimumAmountOut` of the pair token is
 * deposited back; any better execution above that stays in the wallet,
 * public: as SOL, or in the wallet's token account for the pair token.
 */
export async function buildShieldedSell(ctx: RingsContext, env: MarketEnv, quote: TradeQuote): Promise<Transaction> {
  if (quote.side !== 'sell' || quote.mode !== 'exact-in') {
    throw new MarketError('BAD_QUOTE', 'A shielded sell needs an exact-in sell quote.');
  }
  const mint = address(env.market.mint.toBase58());
  const token = tokenAccountOf(ctx.owner, env.market.mint);
  const tokenAccountExisted = await accountExists(env.connection, token.key);

  const withdraw = await withdrawInstructions(ctx, {
    asset: mint,
    amount: quote.amountIn,
    recipient: ctx.owner,
    tokenProgram: TOKEN_PROGRAM,
  });
  const swap = await swapInstructions(env, ctx.owner, quote);
  const deposit = await depositQuote(ctx, env.market, quote.minimumAmountOut);
  const cleanup = tokenAccountExisted ? [] : [closeAccount(token.key, new PublicKey(ctx.owner))];

  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: [...withdraw, ...swap, ...deposit, ...cleanup],
    computeUnitLimit: COMPUTE_UNITS.shieldedTrade,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.shieldedTrade),
  });
}

/**
 * Moves `amount` of a market's pair token from the wallet into its private
 * balance: SOL straight from the wallet, any other pair token from the
 * wallet's token account for it.
 */
async function depositQuote(ctx: RingsContext, market: Market, amount: bigint): Promise<Instruction[]> {
  if (market.pair.native) return depositInstructions(ctx, { asset: SOL_MINT, amount });
  const quoteMint = quoteMintOf(market);
  await requireInterface(ctx, quoteMint);
  return depositInstructions(ctx, {
    asset: address(market.pair.mint),
    amount,
    sourceTokenAccount: tokenAccountOf(ctx.owner, quoteMint).address,
    tokenProgram: TOKEN_PROGRAM,
  });
}

/**
 * Buy with the public balance of the pair token straight into a private token
 * balance: swap, then deposit. For a wallet that has not moved its SOL, or
 * its pair token, into Rings yet. A pair token other than SOL is taken from
 * the wallet's ordinary token account for it.
 */
export async function buildPublicBuyToPrivate(ctx: RingsContext, env: MarketEnv, quote: TradeQuote): Promise<Transaction> {
  if (quote.side !== 'buy' || quote.mode !== 'exact-out') {
    throw new MarketError('BAD_QUOTE', 'This route needs an exact-out buy quote.');
  }
  await requireInterface(ctx, env.market.mint);
  const mint = address(env.market.mint.toBase58());
  const token = tokenAccountOf(ctx.owner, env.market.mint);
  const tokenAccountExisted = await accountExists(env.connection, token.key);
  const swap = await swapInstructions(env, ctx.owner, quote);
  const deposit = await depositInstructions(ctx, {
    asset: mint,
    amount: quote.amountOut,
    sourceTokenAccount: token.address,
    tokenProgram: TOKEN_PROGRAM,
  });
  const cleanup = tokenAccountExisted ? [] : [closeAccount(token.key, new PublicKey(ctx.owner))];
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: [...swap, ...deposit, ...cleanup],
    computeUnitLimit: COMPUTE_UNITS.shieldedTrade,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.shieldedTrade),
  });
}

/** A mint can only be held privately once its Rings interface exists. */
async function requireInterface(ctx: RingsContext, mint: PublicKey): Promise<void> {
  const assetId = await fetchAssetId(ctx.client, address(mint.toBase58()));
  if (assetId !== undefined) return;
  const facts = await readProtocolFacts(ctx.client);
  if (!facts.splInterfaceCreationIsPermissionless) {
    throw new MarketError(
      'INTERFACE_RESTRICTED',
      'This token has no Rings interface yet, and Rings does not currently allow just anyone to create one.',
    );
  }
  // `depositInstructions` adds the creation itself when the interface is missing.
}

/* ------------------------------------------------------------------ */
/* Launch                                                              */
/* ------------------------------------------------------------------ */

export interface LaunchInput {
  readonly configAddress: PublicKey;
  /** A fresh keypair's address. The keypair must sign the transaction. */
  readonly baseMint: PublicKey;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  /**
   * The creator's first buy, in base units of the config's pair token: paid
   * from the wallet's public SOL, or from its ordinary token account for any
   * other pair token. 0 for none.
   */
  readonly firstBuy: bigint;
  /**
   * The least the first buy may return, and the exact amount deposited into
   * the private balance. From `quoteFirstBuy`. Ignored when `firstBuy` is 0.
   */
  readonly firstBuyTokensOut: bigint;
  /**
   * Close the creator's public token account at the end (default). This holds
   * only if the first buy returns exactly `firstBuyTokensOut`. Pass false to
   * tolerate a first buy that returns a few units more: the surplus then stays
   * in the public token account, which is left open.
   */
  readonly closeTokenAccount?: boolean;
}

/** What switching a token's fee modules on needs from the server (`/api/modules/prepare`). */
export interface ModuleActivation {
  /** The wallet the server runs for exactly these settings. The pool's creator role is handed to it. */
  readonly wallet: PublicKey;
  /** The settings, as the one line of text that goes on chain as a memo. */
  readonly memo: string;
}

/**
 * The two instructions that switch a token's fee modules on: the pool's
 * creator role goes to the module's wallet, and the settings go on chain as a
 * memo. `creator` signs both. This is permanent: nothing here, or anywhere
 * else in this project, hands the role back.
 *
 * The memo is read back first and must be for this token and this creator, so
 * a memo meant for another token can never be attached by mistake.
 */
export async function moduleActivationInstructions(
  dbc: DynamicBondingCurveClient,
  input: { readonly mint: PublicKey; readonly pool: PublicKey; readonly config: PublicKey; readonly creator: PublicKey; readonly modules: ModuleActivation },
): Promise<Instruction[]> {
  const settings = parseModuleMemo(input.modules.memo);
  if (settings.mint !== input.mint.toBase58() || settings.dev !== input.creator.toBase58()) {
    throw new MarketError('WRONG_MODULES', 'These fee module settings are for another token or another creator.');
  }
  return fromLegacyInstructions([
    await transferCreatorInstruction(dbc, { pool: input.pool, config: input.config, creator: input.creator, newCreator: input.modules.wallet }),
    moduleMemoInstruction(input.modules.memo, input.creator),
  ]);
}

/**
 * One transaction that switches a token's fee modules on. The wallet must hold
 * the pool's creator role. Any creator fees it has not claimed yet go with the
 * role: the modules pay them out.
 *
 * It is always a transaction of its own, also right after a launch. The
 * server offers a module wallet only for a token it already lists, to the
 * wallet the chain names as its creator, which is what makes "switched on by"
 * something a visitor can rely on.
 */
export async function buildModuleActivation(ctx: RingsContext, dbc: DynamicBondingCurveClient, market: Market, modules: ModuleActivation): Promise<Transaction> {
  const creator = new PublicKey(ctx.owner);
  if (!market.creator.equals(creator)) throw new MarketError('NOT_CREATOR', "Only the wallet that holds this token's creator role can switch its fee modules on.");
  const instructions = await moduleActivationInstructions(dbc, { mint: market.mint, pool: market.pool, config: market.configAddress, creator, modules });
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions,
    computeUnitLimit: COMPUTE_UNITS.moduleActivation,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.moduleActivation),
  });
}

/**
 * One transaction: create the mint and its bonding-curve pool, create the
 * mint's Rings interface so it can be held privately from the first block,
 * and, if asked, make the creator's first buy and move it into the creator's
 * private balance.
 *
 * The creation and the first buy are public pool activity. The creator's
 * holding ends up private.
 */
export async function buildLaunch(ctx: RingsContext, dbc: DynamicBondingCurveClient, input: LaunchInput): Promise<Transaction> {
  const facts = await readProtocolFacts(ctx.client);
  if (!facts.splInterfaceCreationIsPermissionless) {
    throw new MarketError(
      'INTERFACE_RESTRICTED',
      'This network does not allow permissionless Rings interfaces, so a new token could not be held privately. Launching is disabled.',
    );
  }
  const mint = address(input.baseMint.toBase58());
  const creator = new PublicKey(ctx.owner);
  const create = fromLegacyInstructions(
    await createPoolInstructions(dbc, {
      configAddress: input.configAddress,
      baseMint: input.baseMint,
      creator,
      name: input.name,
      symbol: input.symbol,
      uri: input.uri,
      firstBuy: input.firstBuy,
      firstBuyTokensOut: input.firstBuyTokensOut,
    }),
  );
  const instructions: Instruction[] = [...create, await createInterfaceInstruction(ctx.owner, mint, TOKEN_PROGRAM)];
  if (input.firstBuy > 0n) {
    const token = tokenAccountOf(ctx.owner, input.baseMint);
    // The interface is created by the instruction just above, so the deposit
    // builder must not add a second creation.
    const deposit = await depositOnly(ctx, mint, input.firstBuyTokensOut, token.address);
    instructions.push(...deposit);
    if (input.closeTokenAccount ?? true) instructions.push(closeAccount(token.key, creator));
  }
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions,
    computeUnitLimit: COMPUTE_UNITS.launch,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.launch),
  });
}

/** A token deposit with no interface creation, for when an earlier instruction already creates it. */
async function depositOnly(ctx: RingsContext, mint: Address, amount: bigint, sourceTokenAccount: Address): Promise<Instruction[]> {
  const transaction = await buildDepositTransaction({
    client: ctx.client,
    feePayer: ctx.owner,
    recipient: ctx.shielded,
    asset: mint,
    amount,
    splTokenAccount: sourceTokenAccount,
    splTokenProgram: TOKEN_PROGRAM,
    createSplInterface: false,
  });
  return [...instructionsOf(transaction)];
}

/* ------------------------------------------------------------------ */
/* Burn                                                                */
/* ------------------------------------------------------------------ */

/**
 * The instructions that destroy `amount` units of a launched token held in
 * `owner`'s ordinary token account. The token's supply on chain goes down by
 * the same amount; nothing can bring them back.
 *
 * `closeAccount` adds the instruction that closes the token account
 * afterwards and returns its rent. That is only valid when the burn empties it.
 *
 * Pure: it reads nothing from chain.
 */
export function burnInstructions(owner: Address, mint: PublicKey, amount: bigint, closeAccount: boolean): Instruction[] {
  if (amount <= 0n) throw new MarketError('BAD_AMOUNT', 'Enter an amount greater than zero.');
  const ownerKey = new PublicKey(owner);
  const token = tokenAccountOf(owner, mint);
  // The checked form names the mint and its decimals, so it cannot burn anything but this token.
  const burn = fromLegacyInstruction(createBurnCheckedInstruction(token.key, mint, ownerKey, amount, TOKEN_DECIMALS));
  return closeAccount ? [burn, fromLegacyInstruction(createCloseAccountInstruction(token.key, ownerKey, ownerKey))] : [burn];
}

/**
 * Burn from the private balance, in one atomic transaction: the tokens leave
 * the private balance for the wallet's own token account, and are destroyed
 * there in the next instruction.
 *
 * A burn is public by nature. It changes the token's supply, which anyone can
 * read, so the wallet, the token and the amount are all visible. What stays
 * private is everything else the wallet holds, and that it held these at all
 * until this moment.
 *
 * The token account is only a place for the tokens to pass through. If this
 * transaction created it, it is closed again and its rent comes back.
 */
export async function buildBurnFromPrivate(ctx: RingsContext, connection: Connection, mint: PublicKey, amount: bigint): Promise<Transaction> {
  if (amount <= 0n) throw new MarketError('BAD_AMOUNT', 'Enter an amount greater than zero.');
  const token = tokenAccountOf(ctx.owner, mint);
  const tokenAccountExisted = await accountExists(connection, token.key);
  const withdraw = await withdrawInstructions(ctx, {
    asset: address(mint.toBase58()),
    amount,
    recipient: ctx.owner,
    tokenProgram: TOKEN_PROGRAM,
  });
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: [...withdraw, ...burnInstructions(ctx.owner, mint, amount, !tokenAccountExisted)],
    computeUnitLimit: COMPUTE_UNITS.burn,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.burn),
  });
}

/**
 * Burn tokens that sit in the wallet's ordinary, public token account.
 * `emptiesAccount` is true when `amount` is everything the account holds: it
 * is then closed and its rent returned.
 */
export async function buildBurnPublic(ctx: RingsContext, mint: PublicKey, amount: bigint, emptiesAccount: boolean): Promise<Transaction> {
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: burnInstructions(ctx.owner, mint, amount, emptiesAccount),
    computeUnitLimit: COMPUTE_UNITS.publicBurn,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.publicBurn),
  });
}

/* ------------------------------------------------------------------ */
/* Rewards                                                             */
/* ------------------------------------------------------------------ */

/** What a wallet can claim on one token. Every amount is in base units of the token's pair token. */
export interface Rewards {
  /** The creator's share of fees taken on the bonding curve, not yet claimed. Zero for anyone else. */
  readonly curve: bigint;
  /** Fees earned by this wallet's liquidity positions in the graduated pool. */
  readonly positions: readonly PositionFees[];
  readonly pool: bigint;
}

export type RewardSource = 'curve' | 'pool';

export async function readRewards(env: MarketEnv, owner: Address): Promise<Rewards> {
  const ownerKey = new PublicKey(owner);
  const curve = env.market.creator.equals(ownerKey) ? BigInt(env.market.state.poolState.creatorQuoteFee.toString()) : 0n;
  const positions =
    env.market.stage === 'graduated' && env.graduated
      ? await graduatedPositionFees(env.connection, env.market, env.graduated, ownerKey)
      : [];
  const pool = positions.reduce((sum, position) => sum + position.quoteUnits, 0n);
  return { curve, positions, pool };
}

/**
 * Claim rewards and move them into the private balance in the same
 * transaction. The claim is a public event with a public amount; from then on
 * the proceeds are private. They are paid in the token's pair token, and
 * `amount` is in its base units.
 *
 *  - `curve`: the creator's share of the fees taken while the token traded on
 *    its bonding curve.
 *  - `pool`: the fees earned by the wallet's locked liquidity position in the
 *    graduated pool. One position per transaction, the one that has earned
 *    the most.
 */
export async function buildClaimToPrivate(
  ctx: RingsContext,
  env: MarketEnv,
  source: RewardSource = 'curve',
): Promise<{ transaction: Transaction; amount: bigint }> {
  const ownerKey = new PublicKey(ctx.owner);
  const native = env.market.pair.native;
  const token = tokenAccountOf(ctx.owner, env.market.mint);
  const quoteToken = tokenAccountOf(ctx.owner, quoteMintOf(env.market));
  let claim: Instruction[];
  let amount: bigint;
  /** Closing the token account the claim opened for the token side of the fee, which stays empty. */
  let closeToken: Instruction[] = [];
  /** Closing the pair token's account, when this transaction opened it and leaves it empty. */
  let closeQuote: Instruction[] = [];

  if (source === 'curve') {
    // Read before the claim is built: the claim opens both accounts when they are missing.
    const tokenAccountExisted = native ? true : await accountExists(env.connection, token.key);
    const quoteAccountExisted = native ? true : await accountExists(env.connection, quoteToken.key);
    const built = await claimCreatorFeeInstructions(env.dbc, env.market, ownerKey);
    claim = fromLegacyInstructions(built.instructions);
    amount = built.amount;
    // A curve claim pays exactly the amount it names, and none of it in the token. So for a pair
    // token other than SOL, both accounts are empty again once the deposit has taken the proceeds.
    if (!tokenAccountExisted) closeToken = [closeAccount(token.key, ownerKey)];
    if (!quoteAccountExisted) closeQuote = [closeAccount(quoteToken.key, ownerKey)];
  } else {
    if (env.market.stage !== 'graduated' || !env.graduated) {
      throw new MarketError('NOT_GRADUATED', 'This token has not graduated yet, so it has no pool rewards.');
    }
    const [position] = await graduatedPositionFees(env.connection, env.market, env.graduated, ownerKey);
    if (!position || position.quoteUnits <= 0n) {
      throw new MarketError('NOTHING_TO_CLAIM', 'There are no pool rewards to claim yet.');
    }
    // The claim opens a public token account for the token side of the fee.
    // This pool collects its fee in the pair token, so that account stays
    // empty: close it again unless it was already there.
    const tokenAccountExisted = await accountExists(env.connection, token.key);
    const built = await claimPositionFeeInstructions(env.connection, env.graduated, ownerKey, position);
    claim = fromLegacyInstructions(built.instructions);
    amount = built.amount;
    if (!tokenAccountExisted && position.tokenUnits === 0n) closeToken = [closeAccount(token.key, ownerKey)];
    // The pair token's account is left open: a pool claim pays whatever has accrued by the time
    // it lands, so a little more than `amount` may arrive, and that stays there, public.
  }

  const deposit = await depositQuote(ctx, env.market, amount);
  const transaction = composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: [...claim, ...closeToken, ...deposit, ...closeQuote],
    computeUnitLimit: COMPUTE_UNITS.shieldedTrade,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.shieldedTrade),
  });
  return { transaction, amount };
}

/* ------------------------------------------------------------------ */
/* Graduation                                                          */
/* ------------------------------------------------------------------ */

/**
 * One transaction that moves a completed curve into its Meteora pool.
 *
 * Anyone may send it. Meteora's keeper normally does, but only for the pair
 * tokens and curve sizes it covers; for the rest a completed curve waits for
 * somebody to send this. The payer pays the rent of the new pool's accounts
 * and the network fee, and receives nothing: the liquidity goes to the
 * platform's locked position, as the token's config says.
 *
 * `signers` are the two new position mints. They must sign next to the payer.
 */
export async function buildGraduation(
  ctx: RingsContext,
  dbc: DynamicBondingCurveClient,
  market: Market,
): Promise<{ transaction: Transaction; signers: KeyPairSigner[] }> {
  const built = await migrationInstructions(dbc, market, new PublicKey(ctx.owner));
  const signers = await Promise.all(built.signers.map((keypair) => createKeyPairSignerFromBytes(keypair.secretKey)));
  const transaction = composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: fromLegacyInstructions(built.instructions),
    computeUnitLimit: COMPUTE_UNITS.graduation,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.graduation),
  });
  return { transaction, signers };
}

/* ------------------------------------------------------------------ */
/* Converted trades                                                    */
/* ------------------------------------------------------------------ */

/**
 * A converted trade, complete but for its compute budget. The budget is set
 * from a run of the transaction against the chain, which is also where
 * `floors` are checked, so `compose` is called twice: once to run it, once to
 * sign it.
 */
export interface ConvertedTrade {
  readonly instructions: readonly Instruction[];
  /** What the wallet must still hold once this has run. */
  readonly floors: readonly BalanceFloor[];
  /** Compiles the transaction with a compute limit and a whole priority fee in lamports. */
  compose(computeUnitLimit: number, priorityFeeLamports: bigint): Transaction;
}

/** A mint as Rings names the asset: native SOL for the wrapped-SOL mint, the mint itself otherwise. */
export function ringsAssetOf(mint: string): Address {
  return mint === WSOL_MINT ? (SOL_MINT as Address) : address(mint);
}

/** A balance a floor is wanted for. `mint` null is the wallet's SOL; `program` is the mint's token program when it is not the SPL Token one. */
interface FloorWanted {
  readonly mint: string | null;
  readonly label: string;
  readonly allowance: bigint;
  readonly program?: string;
}

/**
 * Reads what the wallet holds now and turns it into floors. `allowance` is how
 * far each balance may fall: what the trade itself spends from it, and for SOL
 * the rent and fees on top. `mint` null is the wallet's SOL.
 */
function floorsFor(env: MarketEnv, owner: Address, wanted: readonly FloorWanted[]): Promise<BalanceFloor[]> {
  return floorsOn(env.connection, owner, wanted);
}

async function floorsOn(connection: Connection, owner: Address, wanted: readonly FloorWanted[]): Promise<BalanceFloor[]> {
  const ownerKey = new PublicKey(owner);
  const accounts = wanted.map((entry) => (entry.mint === null ? ownerKey : getAssociatedTokenAddressSync(new PublicKey(entry.mint), ownerKey, false, new PublicKey(entry.program ?? TOKEN_PROGRAM_ID))));
  const infos = await connection.getMultipleAccountsInfo(accounts, 'confirmed');
  return wanted.map((entry, index): BalanceFloor => {
    const info = infos[index] ?? null;
    const kind = entry.mint === null ? 'lamports' : 'token';
    const held = balanceIn(kind, info ? { lamports: BigInt(info.lamports), data: info.data } : null);
    return {
      account: address((accounts[index] as PublicKey).toBase58()),
      kind,
      label: entry.label,
      minimum: held > entry.allowance ? held - entry.allowance : 0n,
    };
  });
}

async function convertedTrade(ctx: RingsContext, instructions: readonly Instruction[], floors: readonly BalanceFloor[]): Promise<ConvertedTrade> {
  const lifetime = await latestLifetime(ctx.client);
  return {
    instructions,
    floors,
    compose: (computeUnitLimit, priorityFeeLamports) => composeV1({ feePayer: ctx.owner, lifetime, instructions, computeUnitLimit, priorityFeeLamports }),
  };
}

export interface ConvertedBuyInput {
  /** The conversion into the token's pair token, already read and checked. */
  readonly swap: ConversionSwap;
  /** The exact-out buy on the pool, sized so it never needs more than the conversion guarantees. */
  readonly quote: TradeQuote;
  /** Where what is paid comes from: the private balance (withdrawn in this transaction) or the public one. */
  readonly source: 'private' | 'public';
  /** The ticker of what is paid with, for messages. */
  readonly payingSymbol: string;
}

/**
 * Buy a token with something other than its pair token, into the private
 * balance, in one transaction:
 *
 *   [withdraw what is paid, when it is private]
 *   convert it to the pair token (Jupiter)
 *   buy on the pool (Meteora), for an exact number of tokens
 *   deposit those tokens into the private balance
 *
 * The conversion spends exactly `swap.amountIn`. What it returns above what
 * the pool takes stays in the wallet as the pair token, public.
 */
export async function buildConvertedBuy(ctx: RingsContext, env: MarketEnv, input: ConvertedBuyInput): Promise<ConvertedTrade> {
  const { swap, quote, source } = input;
  const { market } = env;
  if (quote.side !== 'buy' || quote.mode !== 'exact-out') throw new MarketError('BAD_QUOTE', 'A converted buy needs an exact-out buy quote.');
  if (swap.outputMint !== market.pair.mint || swap.inputMint === market.pair.mint) {
    throw new MarketError('BAD_PLAN', `The conversion is not into ${market.pair.symbol}, which this token is priced in.`);
  }
  // The pool is never asked for more than the conversion is certain to deliver.
  if (quote.maximumAmountIn > swap.minimumOut) throw new MarketError('BAD_PLAN', 'The buy is sized for more than the conversion guarantees.');
  await requireInterface(ctx, market.mint);
  const ownerKey = new PublicKey(ctx.owner);
  const mint = address(market.mint.toBase58());
  const token = tokenAccountOf(ctx.owner, market.mint);
  const tokenAccountExisted = await accountExists(env.connection, token.key);

  const withdraw =
    source === 'private'
      ? await withdrawInstructions(ctx, { asset: ringsAssetOf(swap.inputMint), amount: swap.amountIn, recipient: ctx.owner, tokenProgram: TOKEN_PROGRAM })
      : [];
  const poolSwap = await swapInstructions(env, ctx.owner, quote);
  const deposit = await depositInstructions(ctx, { asset: mint, amount: quote.amountOut, sourceTokenAccount: token.address, tokenProgram: TOKEN_PROGRAM });
  const cleanup = tokenAccountExisted ? [] : [closeAccount(token.key, ownerKey)];
  const instructions = [...withdraw, ...swap.instructions, ...poolSwap, ...deposit, ...cleanup];

  // From the public balance the trade spends `amountIn`. From the private one the withdrawal puts
  // it in the wallet first, so the public balance must come out where it started.
  const spent = source === 'public' ? swap.amountIn : 0n;
  const payingSol = swap.inputMint === WSOL_MINT;
  const floors = await floorsFor(env, ctx.owner, [
    { mint: null, label: 'your public SOL', allowance: solOverhead(instructions) + (payingSol ? spent : 0n) },
    ...(payingSol ? [] : [{ mint: swap.inputMint, label: `your public ${input.payingSymbol}`, allowance: spent }]),
    // The pair token only ever arrives here: the conversion pays it in and the pool takes less than that.
    ...(market.pair.native ? [] : [{ mint: market.pair.mint, label: `your public ${market.pair.symbol}`, allowance: 0n }]),
  ]);
  return convertedTrade(ctx, instructions, floors);
}

export interface ConvertedSellInput {
  /** The exact-in sell on the pool. */
  readonly quote: TradeQuote;
  /** The conversion out of the pair token, for exactly what the sell is certain to return. */
  readonly swap: ConversionSwap;
  /** The ticker of what is received, for messages. */
  readonly receivingSymbol: string;
}

/**
 * Sell a token from the private balance and be paid in something other than
 * its pair token, into the private balance, in one transaction:
 *
 *   withdraw the tokens
 *   sell on the pool (Meteora)
 *   convert exactly what the pool guarantees (Jupiter)
 *   deposit exactly what the conversion guarantees into the private balance
 *
 * Whatever either swap returns above its guarantee stays in the wallet,
 * public: the pool's surplus as the pair token, the conversion's as what is
 * received.
 */
export async function buildConvertedSell(ctx: RingsContext, env: MarketEnv, input: ConvertedSellInput): Promise<ConvertedTrade> {
  const { swap, quote } = input;
  const { market } = env;
  if (quote.side !== 'sell' || quote.mode !== 'exact-in') throw new MarketError('BAD_QUOTE', 'A converted sell needs an exact-in sell quote.');
  if (swap.inputMint !== market.pair.mint || swap.outputMint === market.pair.mint) {
    throw new MarketError('BAD_PLAN', `The conversion is not out of ${market.pair.symbol}, which this token is priced in.`);
  }
  // The conversion spends exactly what the pool is certain to have paid by then, no more.
  if (swap.amountIn !== quote.minimumAmountOut) throw new MarketError('BAD_PLAN', 'The conversion is not sized to what the sell guarantees.');
  const receivingSol = swap.outputMint === WSOL_MINT;
  if (!receivingSol && (await fetchAssetId(ctx.client, address(swap.outputMint))) === undefined) {
    throw new MarketError('NO_INTERFACE', `Rings has no interface for ${input.receivingSymbol} yet, so it cannot be received into a private balance. Receive SOL or ${market.pair.symbol} instead.`);
  }
  const ownerKey = new PublicKey(ctx.owner);
  const mint = address(market.mint.toBase58());
  const token = tokenAccountOf(ctx.owner, market.mint);
  const tokenAccountExisted = await accountExists(env.connection, token.key);

  const withdraw = await withdrawInstructions(ctx, { asset: mint, amount: quote.amountIn, recipient: ctx.owner, tokenProgram: TOKEN_PROGRAM });
  const poolSwap = await swapInstructions(env, ctx.owner, quote);
  const deposit = receivingSol
    ? await depositInstructions(ctx, { asset: SOL_MINT as Address, amount: swap.minimumOut })
    : await depositInstructions(ctx, {
        asset: address(swap.outputMint),
        amount: swap.minimumOut,
        sourceTokenAccount: tokenAccountOf(ctx.owner, new PublicKey(swap.outputMint)).address,
        tokenProgram: TOKEN_PROGRAM,
      });
  const cleanup = tokenAccountExisted ? [] : [closeAccount(token.key, ownerKey)];
  const instructions = [...withdraw, ...poolSwap, ...swap.instructions, ...deposit, ...cleanup];

  // Everything this trade spends arrives inside it, so no public balance may end lower than it began.
  const floors = await floorsFor(env, ctx.owner, [
    { mint: null, label: 'your public SOL', allowance: solOverhead(instructions) },
    ...(receivingSol ? [] : [{ mint: swap.outputMint, label: `your public ${input.receivingSymbol}`, allowance: 0n }]),
    ...(market.pair.native ? [] : [{ mint: market.pair.mint, label: `your public ${market.pair.symbol}`, allowance: 0n }]),
    ...(tokenAccountExisted ? [{ mint: market.mint.toBase58(), label: 'your public balance of this token', allowance: 0n }] : []),
  ]);
  return convertedTrade(ctx, instructions, floors);
}


/* ------------------------------------------------------------------ */
/* Outside tokens                                                      */
/* ------------------------------------------------------------------ */

/**
 * What the first deposit of a token costs on top of an ordinary one. A token
 * can be held privately once Rings has a registry entry and a vault for it;
 * whoever deposits it first creates both and pays their rent, once, for
 * everybody after them. The registry entry is 48 bytes and the vault is a
 * token account, which comes to 3,264,240 lamports; this is that, rounded up.
 */
export const RINGS_INTERFACE_RENT_LAMPORTS = 3_300_000n;

/** A token that was not launched here, as the page read it from its mint. */
export interface OutsideToken {
  readonly mint: string;
  /** The token program the mint belongs to: SPL Token or Token-2022. */
  readonly programId: string;
  /** What to call it in a message. */
  readonly symbol: string;
}

/** An outside trade, complete but for its compute budget, with what the page needs to tell its story afterwards. */
export interface OutsideTrade extends ConvertedTrade {
  /** True when this transaction also creates the token's registry entry and vault in Rings, and pays their rent. */
  readonly createsInterface: boolean;
  /** Whether the wallet had a public token account for the token before this. */
  readonly tokenAccountExisted: boolean;
  /** What that account held, in base units. Zero when there was none. */
  readonly publicBefore: bigint;
}

function assertOutside(token: OutsideToken): void {
  if (token.mint === WSOL_MINT) throw new MarketError('BAD_PLAN', 'SOL is not a token to buy or sell here: it is what tokens are paid for with.');
  if (token.programId !== TOKEN_PROGRAM_ID && token.programId !== TOKEN_2022_PROGRAM_ID) {
    throw new MarketError('BAD_PLAN', 'This token belongs to a token program this site does not use.');
  }
}

/** The wallet's public token account for an outside token, and what it holds right now. */
async function readOutsideAccount(connection: Connection, owner: Address, token: OutsideToken): Promise<{ key: PublicKey; address: Address; existed: boolean; held: bigint }> {
  const account = tokenAccountOf(owner, new PublicKey(token.mint), token.programId);
  const info = await connection.getAccountInfo(account.key, 'confirmed');
  return { ...account, existed: info !== null, held: balanceIn('token', info ? { lamports: BigInt(info.lamports), data: info.data } : null) };
}

export interface OutsideBuyInput {
  /** The swap from what is paid into the token, already read and checked. */
  readonly swap: ConversionSwap;
  readonly token: OutsideToken;
  /** Where what is paid comes from: the private balance (withdrawn in this transaction) or the public one. */
  readonly source: 'private' | 'public';
  /** The ticker of what is paid with, for messages. */
  readonly payingSymbol: string;
}

/**
 * Buy a token that was not launched here, into the private balance, in one
 * transaction:
 *
 *   [withdraw what is paid, when it is private]
 *   swap it for the token (Jupiter)
 *   deposit what the swap is certain to return into the private balance
 *
 * The swap spends exactly `swap.amountIn`. A swap names what it pays in, not
 * what it returns, and a deposit must name its amount before anything is
 * signed, so the deposit is for `swap.minimumOut`: the least the swap can
 * return and still succeed. Whatever it returns above that stays in the
 * wallet's public token account (`buildShieldRest` moves it afterwards).
 *
 * When nobody has deposited this token before, the deposit also creates its
 * place in Rings and this wallet pays that rent.
 */
export async function buildOutsideBuy(ctx: RingsContext, connection: Connection, input: OutsideBuyInput): Promise<OutsideTrade> {
  const { swap, token, source } = input;
  assertOutside(token);
  if (swap.outputMint !== token.mint || swap.inputMint === token.mint) throw new MarketError('BAD_PLAN', `The swap is not into ${token.symbol}.`);
  if (swap.minimumOut <= 0n) throw new MarketError('BAD_PLAN', 'The swap guarantees nothing, so there is nothing to deposit.');
  const mint = address(token.mint);
  let createsInterface = false;
  if ((await fetchAssetId(ctx.client, mint)) === undefined) {
    const facts = await readProtocolFacts(ctx.client);
    if (!facts.splInterfaceCreationIsPermissionless) {
      throw new MarketError('INTERFACE_RESTRICTED', `Nobody has held ${token.symbol} privately yet, and Rings does not currently let just anyone add a token. It cannot be bought into a private balance for now.`);
    }
    createsInterface = true;
  }
  const account = await readOutsideAccount(connection, ctx.owner, token);

  const withdraw =
    source === 'private'
      ? await withdrawInstructions(ctx, { asset: ringsAssetOf(swap.inputMint), amount: swap.amountIn, recipient: ctx.owner, tokenProgram: TOKEN_PROGRAM })
      : [];
  // `depositInstructions` puts the creation of the token's registry entry and vault in front of the deposit when they are missing.
  const deposit = await depositInstructions(ctx, { asset: mint, amount: swap.minimumOut, sourceTokenAccount: account.address, tokenProgram: address(token.programId) });
  const instructions = [...withdraw, ...swap.instructions, ...deposit];

  // From the public balance the trade spends `amountIn`. From the private one the withdrawal puts
  // it in the wallet first, so the public balance must come out where it started.
  const spent = source === 'public' ? swap.amountIn : 0n;
  const payingSol = swap.inputMint === WSOL_MINT;
  const floors = await floorsOn(connection, ctx.owner, [
    { mint: null, label: 'your public SOL', allowance: solOverhead(instructions) + (createsInterface ? RINGS_INTERFACE_RENT_LAMPORTS : 0n) + (payingSol ? spent : 0n) },
    ...(payingSol ? [] : [{ mint: swap.inputMint, label: `your public ${input.payingSymbol}`, allowance: spent }]),
    // The token only ever arrives here: the swap pays in at least what the deposit then takes.
    { mint: token.mint, program: token.programId, label: `your public ${token.symbol}`, allowance: 0n },
  ]);
  return { ...(await convertedTrade(ctx, instructions, floors)), createsInterface, tokenAccountExisted: account.existed, publicBefore: account.held };
}

export interface OutsideSellInput {
  /** The swap from the token into what is received, already read and checked. */
  readonly swap: ConversionSwap;
  readonly token: OutsideToken;
  /** Where the tokens come from: the private balance (withdrawn in this transaction) or the public token account. */
  readonly source: 'private' | 'public';
  /** The ticker of what is received, for messages. */
  readonly receivingSymbol: string;
}

/**
 * Sell a token that was not launched here and be paid into the private
 * balance, in one transaction:
 *
 *   [withdraw the tokens, when they are private]
 *   swap exactly that many (Jupiter)
 *   deposit what the swap is certain to return into the private balance
 *
 * Whatever the swap returns above its guarantee stays in the wallet, public,
 * as what was received. A token account that only existed to carry the
 * tokens from the private balance to the swap is closed again.
 */
export async function buildOutsideSell(ctx: RingsContext, connection: Connection, input: OutsideSellInput): Promise<OutsideTrade> {
  const { swap, token, source } = input;
  assertOutside(token);
  if (swap.inputMint !== token.mint || swap.outputMint === token.mint) throw new MarketError('BAD_PLAN', `The swap is not out of ${token.symbol}.`);
  if (swap.minimumOut <= 0n) throw new MarketError('BAD_PLAN', 'The swap guarantees nothing, so there is nothing to deposit.');
  const receivingSol = swap.outputMint === WSOL_MINT;
  if (!receivingSol && (await fetchAssetId(ctx.client, address(swap.outputMint))) === undefined) {
    throw new MarketError('NO_INTERFACE', `Rings has no interface for ${input.receivingSymbol} yet, so it cannot be received into a private balance. Receive SOL instead.`);
  }
  const ownerKey = new PublicKey(ctx.owner);
  const account = await readOutsideAccount(connection, ctx.owner, token);

  const withdraw =
    source === 'private'
      ? await withdrawInstructions(ctx, { asset: address(token.mint), amount: swap.amountIn, recipient: ctx.owner, tokenProgram: address(token.programId) })
      : [];
  const deposit = receivingSol
    ? await depositInstructions(ctx, { asset: SOL_MINT as Address, amount: swap.minimumOut })
    : await depositInstructions(ctx, {
        asset: address(swap.outputMint),
        amount: swap.minimumOut,
        sourceTokenAccount: tokenAccountOf(ctx.owner, new PublicKey(swap.outputMint)).address,
        tokenProgram: TOKEN_PROGRAM,
      });
  // From the private balance, exactly what was withdrawn is sold, so an account this transaction opened is empty again.
  const cleanup = source === 'private' && !account.existed ? [closeAccount(account.key, ownerKey, token.programId)] : [];
  const instructions = [...withdraw, ...swap.instructions, ...deposit, ...cleanup];

  const floors = await floorsOn(connection, ctx.owner, [
    { mint: null, label: 'your public SOL', allowance: solOverhead(instructions) },
    ...(receivingSol ? [] : [{ mint: swap.outputMint, label: `your public ${input.receivingSymbol}`, allowance: 0n }]),
    // Sold from the public balance, it falls by what is sold. Sold from the private one, it ends where it began.
    ...(source === 'public'
      ? [{ mint: token.mint, program: token.programId, label: `your public ${token.symbol}`, allowance: swap.amountIn }]
      : account.existed
        ? [{ mint: token.mint, program: token.programId, label: `your public ${token.symbol}`, allowance: 0n }]
        : []),
  ]);
  return { ...(await convertedTrade(ctx, instructions, floors)), createsInterface: false, tokenAccountExisted: account.existed, publicBefore: account.held };
}

/**
 * Moves `amount` of an outside token from the wallet's public token account
 * into the private balance: what a buy left there above its guaranteed
 * minimum. `closeAfter` also closes the account and returns its rent, which is
 * only valid when the deposit empties it. With nothing to deposit it only
 * closes the account.
 */
export async function buildShieldRest(ctx: RingsContext, token: OutsideToken, amount: bigint, closeAfter: boolean): Promise<Transaction> {
  assertOutside(token);
  if (amount < 0n || (amount === 0n && !closeAfter)) throw new MarketError('BAD_AMOUNT', 'There is nothing left over to move.');
  const account = tokenAccountOf(ctx.owner, new PublicKey(token.mint), token.programId);
  const deposit =
    amount > 0n ? await depositInstructions(ctx, { asset: address(token.mint), amount, sourceTokenAccount: account.address, tokenProgram: address(token.programId) }) : [];
  const cleanup = closeAfter ? [closeAccount(account.key, new PublicKey(ctx.owner), token.programId)] : [];
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: [...deposit, ...cleanup],
    computeUnitLimit: COMPUTE_UNITS.single,
    priorityFeeLamports: priorityOf(ctx, COMPUTE_UNITS.single),
  });
}
