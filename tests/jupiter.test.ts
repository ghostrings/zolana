import { beforeAll, describe, expect, it } from 'vitest';
import { AccountRole, type Address, type Blockhash, type Instruction, getTransactionSize, isAddress } from '@solana/kit';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SOL_MINT, ShieldedKeypair } from '@heliuslabs/spr';
import { transactInstruction } from '@heliuslabs/spr/interface';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  TOKEN_PROGRAM_ID,
  TX_V1_MAX_ACCOUNTS,
  TX_V1_MAX_BYTES,
  WSOL_MINT,
} from '../shared/src/constants.js';
import {
  type BalanceFloor,
  type BuildRequest,
  CONVERSION_ACCOUNTS,
  CONVERSION_FEE_ALLOWANCE_LAMPORTS,
  ConvertError,
  JUPITER_PROGRAM_ID,
  balanceIn,
  buildQuery,
  floorsBroken,
  legSlippageBps,
  readBuild,
  solOverhead,
  tunedComputeLimit,
} from '../shared/src/jupiter.js';
import { MarketError } from '../shared/src/meteora.js';
import { buildConvertedBuy, buildConvertedSell, ringsAssetOf } from '../shared/src/routes.js';
import { TxError, composeV1, countAccounts, decompileMessage, messageBytesOf, requiredSigners } from '../shared/src/tx.js';
import { explainError } from '../web/src/errors.js';
import { USDC_QUICK_AMOUNTS, counterOf, counterOptions } from '../web/src/convert.js';
import { CONVERT_ASSETS } from '../server/src/convert.js';
import { USDC, ZEC, statusFixture } from './fixtures.js';
import { buildLeg, setup } from './helpers.js';
import {
  BONK_MINT,
  LIVE_BONK_TO_SOL,
  LIVE_PYUSD_ACCOUNT,
  LIVE_SOL_TO_BONK,
  LIVE_SOL_TO_PYUSD,
  LIVE_SOL_TO_USDC,
  LIVE_TAKER,
  LIVE_USDC_TO_ZEC,
  LIVE_ZEC_TO_SOL,
  PYUSD_MINT,
  type RawInstruction,
  USDC_MINT,
  ZEC_MINT,
  answerFor,
  swapData,
  tokenAccount,
} from './jupiter-fixtures.js';

const signersOf = (instruction: Instruction): string[] =>
  (instruction.accounts ?? []).filter((account) => account.role === AccountRole.WRITABLE_SIGNER || account.role === AccountRole.READONLY_SIGNER).map((account) => account.address);

/** A deep copy of an answer that a test can change one thing in. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('a live answer from Jupiter', () => {
  it('SOL to USDC: is read as wrap, swap, unwrap, for exactly what was asked', () => {
    const swap = readBuild(LIVE_SOL_TO_USDC.body, LIVE_SOL_TO_USDC.request);
    expect(swap.amountIn).toBe(100_000_000n);
    expect(swap.expectedOut).toBe(7_726_964n);
    // Jupiter states 7,688,330, rounded up; what is built on is one unit less.
    expect(swap.minimumOut).toBe(7_688_329n);
    expect(swap.route).toEqual(['Raydium CLMM', '1DEX']);
    expect(swap.instructions.map((instruction) => instruction.programAddress)).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      JUPITER_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
    ]);
    // Nobody but the wallet it was built for is asked to sign.
    for (const instruction of swap.instructions) expect(signersOf(instruction).every((signer) => signer === LIVE_TAKER)).toBe(true);
    // Every address in it is one.
    for (const instruction of swap.instructions) for (const account of instruction.accounts ?? []) expect(isAddress(account.address)).toBe(true);
  });

  it('SOL to USDC: the swap names no more accounts than were allowed', () => {
    const swap = readBuild(LIVE_SOL_TO_USDC.body, LIVE_SOL_TO_USDC.request);
    const jupiter = swap.instructions.find((instruction) => instruction.programAddress === JUPITER_PROGRAM_ID) as Instruction;
    expect(jupiter.accounts).toHaveLength(37);
    expect(new Set((jupiter.accounts ?? []).map((account) => account.address)).size).toBeLessThanOrEqual(LIVE_SOL_TO_USDC.request.maxAccounts);
  });

  it('USDC to ZEC: the other swap instruction Jupiter uses is read too', () => {
    const swap = readBuild(LIVE_USDC_TO_ZEC.body, LIVE_USDC_TO_ZEC.request);
    expect(swap.expectedOut).toBe(5_696_591n);
    expect(swap.minimumOut).toBe(5_668_108n);
    expect(swap.route).toEqual(['BisonFi', 'Whirlpool']);
    // One account opened for the wallet, then the swap. Nothing to unwrap.
    expect(swap.instructions.map((instruction) => instruction.programAddress)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, JUPITER_PROGRAM_ID]);
  });

  it('ZEC to SOL: the SOL is unwrapped back to the wallet at the end', () => {
    const swap = readBuild(LIVE_ZEC_TO_SOL.body, LIVE_ZEC_TO_SOL.request);
    expect(swap.expectedOut).toBe(570_180_000n);
    expect(swap.instructions.map((instruction) => instruction.programAddress)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, JUPITER_PROGRAM_ID, TOKEN_PROGRAM_ID]);
    const close = swap.instructions[2] as Instruction;
    expect([...(close.data ?? [])]).toEqual([9]);
    expect((close.accounts ?? []).map((account) => account.address)).toEqual([tokenAccount(LIVE_TAKER, WSOL_MINT), LIVE_TAKER, LIVE_TAKER]);
  });

  it('the wallet’s own token accounts are where this code expects them in both swap instructions', () => {
    // If Jupiter moved them, `readBuild` would refuse every answer; this says so by name.
    expect(tokenAccount(LIVE_TAKER, WSOL_MINT)).toBe('GSFbPvFTbfcRNGs4EEZVF8tBjV6ChcTaBrTYGGsDAq8o');
    expect(tokenAccount(LIVE_TAKER, USDC_MINT)).toBe('GWWjoZ2bZikAhhMAH5V3Mp6goHqnWAT6KqCZSHmqtoZ');
    expect(tokenAccount(LIVE_TAKER, ZEC_MINT)).toBe('8cW5vcR4WjtxThuQHaA9aq47uTvS2aMZzAfMcba3y8ri');
  });

  it('an account that is opened is opened only if it is missing', () => {
    const body = copy(LIVE_USDC_TO_ZEC.body);
    // The plain "create", which fails when an earlier instruction already opened the account.
    (body.setupInstructions[0] as RawInstruction).data = '';
    const swap = readBuild(body, LIVE_USDC_TO_ZEC.request);
    expect([...((swap.instructions[0] as Instruction).data ?? [])]).toEqual([1]);
  });
});

describe('the request to Jupiter', () => {
  it('names everything and asks for version 1 instructions', () => {
    const query = buildQuery(LIVE_SOL_TO_USDC.request);
    expect(Object.fromEntries(query)).toEqual({
      inputMint: WSOL_MINT,
      outputMint: USDC_MINT,
      amount: '100000000',
      taker: LIVE_TAKER,
      slippageBps: '50',
      maxAccounts: '28',
      transactionVersion: '1',
    });
  });
});

describe('an answer that is not what was asked for is refused', () => {
  const taker = Keypair.generate().publicKey.toBase58();
  const stranger = Keypair.generate().publicKey.toBase58();
  const fromSol: BuildRequest = { inputMint: WSOL_MINT, outputMint: ZEC_MINT, amount: 250_000_000n, taker, slippageBps: 50, maxAccounts: 30 };
  const fromUsdc: BuildRequest = { inputMint: USDC_MINT, outputMint: ZEC_MINT, amount: 25_000_000n, taker, slippageBps: 50, maxAccounts: 30 };
  const toSol: BuildRequest = { inputMint: ZEC_MINT, outputMint: WSOL_MINT, amount: 4_000_000n, taker, slippageBps: 50, maxAccounts: 30 };

  const refused = (body: unknown, request: BuildRequest, saying: RegExp): void => {
    let thrown: unknown;
    try {
      readBuild(body, request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConvertError);
    expect((thrown as Error).message).toMatch(saying);
  };

  it('accepts its own fixtures, in both swap layouts and all three directions', () => {
    for (const request of [fromSol, fromUsdc, toSol]) {
      for (const kind of ['route_v2', 'shared_accounts_route_v2'] as const) {
        const swap = readBuild(answerFor(request, { kind }), request);
        expect(swap.amountIn).toBe(request.amount);
        expect(swap.minimumOut).toBeLessThanOrEqual(swap.expectedOut);
      }
    }
  });

  it('other tokens, another amount, another kind of swap, another transaction version', () => {
    refused({ ...answerFor(fromSol), outputMint: USDC_MINT }, fromSol, /different tokens/);
    refused({ ...answerFor(fromSol), inAmount: '250000001' }, fromSol, /different amount/);
    refused({ ...answerFor(fromSol), swapMode: 'ExactOut' }, fromSol, /exact-in/);
    refused({ ...answerFor(fromSol), transactionVersion: 0 }, fromSol, /version 1/);
    refused({ ...answerFor(fromSol), addressesByLookupTableAddress: { [stranger]: [stranger] } }, fromSol, /lookup tables/);
    refused({ ...answerFor(fromSol), tipInstruction: answerFor(fromSol).cleanupInstruction }, fromSol, /tip/);
    refused({ ...answerFor(fromSol), slippageBps: 500 }, fromSol, /slippage/);
    refused('not an object', fromSol, /not an object/);
  });

  it('a minimum looser than the slippage asked for', () => {
    const body = answerFor(fromSol, { expectedOut: 1_000_000n });
    refused({ ...body, otherAmountThreshold: '900000' }, fromSol, /minimum does not follow/);
    refused({ ...body, otherAmountThreshold: '1000001' }, fromSol, /minimum does not follow/);
    // Exactly the floor is fine, and one unit under it is what gets counted on.
    expect(readBuild({ ...body, otherAmountThreshold: '995000' }, fromSol).minimumOut).toBe(994_999n);
  });

  it('an amount too small to return anything says so plainly', () => {
    expect(() => readBuild({ ...answerFor(fromSol), outAmount: '0', otherAmountThreshold: '0' }, fromSol)).toThrow(/too small to convert/);
    // A conversion that is certain of a single unit is certain of nothing once that unit is allowed for.
    expect(() => readBuild({ ...answerFor(fromSol), outAmount: '1', otherAmountThreshold: '1' }, fromSol)).toThrow(/too small to convert/);
  });

  it('a swap in any program but Jupiter’s, or one this code cannot read', () => {
    const elsewhere = answerFor(fromUsdc);
    elsewhere.swapInstruction.programId = stranger;
    refused(elsewhere, fromUsdc, /not Jupiter's program/);
    const unreadable = answerFor(fromUsdc);
    unreadable.swapInstruction.data = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
    refused(unreadable, fromUsdc, /cannot read/);
  });

  for (const kind of ['route_v2', 'shared_accounts_route_v2'] as const) {
    const positions = kind === 'route_v2' ? { authority: 0, source: 1, destination: 2, sourceMint: 3 } : { authority: 1, source: 2, destination: 5, sourceMint: 6 };

    it(`${kind}: a swap that would spend, price or limit differently from the quote`, () => {
      const change = (input: Parameters<typeof swapData>[1]) => {
        const body = answerFor(fromUsdc, { kind, expectedOut: 2_000_000n });
        body.swapInstruction.data = swapData(kind, input);
        return body;
      };
      // Every wallet token, instead of the amount asked.
      refused(change({ amountIn: 18_446_744_073_709_551_615n, quotedOut: 2_000_000n, slippageBps: 50 }), fromUsdc, /spend a different amount/);
      refused(change({ amountIn: 25_000_000n, quotedOut: 1n, slippageBps: 50 }), fromUsdc, /priced differently/);
      refused(change({ amountIn: 25_000_000n, quotedOut: 2_000_000n, slippageBps: 9_000 }), fromUsdc, /different slippage limit/);
      refused(change({ amountIn: 25_000_000n, quotedOut: 2_000_000n, slippageBps: 50, platformFeeBps: 100 }), fromUsdc, /pays a fee/);
    });

    it(`${kind}: a swap that pays somebody else, or spends from somewhere else`, () => {
      const move = (index: number, to: string) => {
        const body = answerFor(fromUsdc, { kind });
        (body.swapInstruction.accounts[index] as { pubkey: string }).pubkey = to;
        return body;
      };
      refused(move(positions.destination, tokenAccount(stranger, ZEC_MINT)), fromUsdc, /does not pay into this wallet's own/);
      refused(move(positions.source, tokenAccount(stranger, USDC_MINT)), fromUsdc, /does not spend from this wallet's own/);
      refused(move(positions.sourceMint, WSOL_MINT), fromUsdc, /different tokens/);
      refused(move(positions.authority, stranger), fromUsdc, /signature from somebody else|not signed for by this wallet/);
    });
  }

  it('anything that asks a second party to sign', () => {
    const body = answerFor(fromUsdc);
    (body.swapInstruction.accounts[12] as { isSigner: boolean }).isSigner = true;
    refused(body, fromUsdc, /signature from somebody else/);
  });

  it('SOL sent anywhere but the wallet’s own wrapped-SOL account, or more of it than is converted', () => {
    const elsewhere = answerFor(fromSol);
    ((elsewhere.setupInstructions[1] as RawInstruction).accounts[1] as { pubkey: string }).pubkey = stranger;
    refused(elsewhere, fromSol, /somewhere other than this wallet's own wrapped-SOL account/);
    const more = answerFor(fromSol);
    const lamports = Buffer.alloc(12);
    lamports.writeUInt32LE(2, 0);
    lamports.writeBigUInt64LE(fromSol.amount + 1n, 4);
    (more.setupInstructions[1] as RawInstruction).data = lamports.toString('base64');
    refused(more, fromSol, /wraps more SOL than is being converted/);
    // A transfer of SOL has no place in a conversion that starts from USDC.
    const uninvited = answerFor(fromUsdc);
    uninvited.setupInstructions.push(answerFor(fromSol).setupInstructions[1] as RawInstruction);
    refused(uninvited, fromUsdc, /does not start from SOL/);
    // Nor has any other system instruction: this is "assign".
    const assign = answerFor(fromSol);
    (assign.setupInstructions[1] as RawInstruction).data = Buffer.from([1, 0, 0, 0, ...new Uint8Array(32)]).toString('base64');
    refused(assign, fromSol, /other than a transfer/);
  });

  it('a token instruction that is not the wrapping or unwrapping of the wallet’s own SOL', () => {
    const wrapped = tokenAccount(taker, WSOL_MINT);
    const approve = answerFor(fromSol);
    // Approve (4): would let somebody else spend from the account later.
    approve.setupInstructions.push({ programId: TOKEN_PROGRAM_ID, data: Buffer.from([4, 255, 255, 255, 255, 255, 255, 255, 255]).toString('base64'), accounts: [{ pubkey: wrapped, isSigner: false, isWritable: true }, { pubkey: stranger, isSigner: false, isWritable: false }, { pubkey: taker, isSigner: true, isWritable: false }] });
    refused(approve, fromSol, /other than wrapping or unwrapping/);
    const closeElsewhere = answerFor(toSol);
    ((closeElsewhere.cleanupInstruction as RawInstruction).accounts[1] as { pubkey: string }).pubkey = stranger;
    refused(closeElsewhere, toSol, /other than wrapping or unwrapping/);
    const closeOther = answerFor(toSol);
    ((closeOther.cleanupInstruction as RawInstruction).accounts[0] as { pubkey: string }).pubkey = tokenAccount(taker, ZEC_MINT);
    refused(closeOther, toSol, /other than wrapping or unwrapping/);
  });

  it('a token account opened for anybody but the wallet', () => {
    const forStranger = answerFor(fromUsdc);
    const open = forStranger.setupInstructions[0] as RawInstruction;
    (open.accounts[2] as { pubkey: string }).pubkey = stranger;
    (open.accounts[1] as { pubkey: string }).pubkey = tokenAccount(stranger, ZEC_MINT);
    refused(forStranger, fromUsdc, /for somebody else/);
    const notItsOwn = answerFor(fromUsdc);
    ((notItsOwn.setupInstructions[0] as RawInstruction).accounts[1] as { pubkey: string }).pubkey = stranger;
    refused(notItsOwn, fromUsdc, /not this wallet's own/);
  });

  it('an instruction in a program a conversion has no use for', () => {
    const memo = answerFor(fromUsdc);
    memo.setupInstructions.push({ programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', data: 'aGk=', accounts: [] });
    refused(memo, fromUsdc, /has no use for/);
    // Jupiter's own program is trusted for the swap, and for nothing around it.
    const second = answerFor(fromUsdc);
    second.setupInstructions.push(second.swapInstruction);
    refused(second, fromUsdc, /has no use for/);
  });

  it('is explained to the person in its own words, not as a failed trade', () => {
    let thrown: unknown;
    try {
      readBuild({ ...answerFor(fromSol), slippageBps: 500 }, fromSol);
    } catch (error) {
      thrown = error;
    }
    // The sentence mentions slippage, which the general explainer would otherwise read as "the price moved".
    expect(explainError(thrown)).toBe((thrown as Error).message);
    expect(explainError(thrown)).toMatch(/nothing was built from it/);
  });
});

describe('what a converted trade may leave in the wallet', () => {
  const owner = Keypair.generate().publicKey;
  const mint = new PublicKey(USDC_MINT);
  const tokenAccountData = (amount: bigint): Uint8Array => {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return data;
  };
  const floors: BalanceFloor[] = [
    { account: owner.toBase58() as Address, kind: 'lamports', label: 'your public SOL', minimum: 90_000_000n },
    { account: getAssociatedTokenAddressSync(mint, owner).toBase58() as Address, kind: 'token', label: 'your public USDC', minimum: 5_000_000n },
  ];

  it('reads SOL from an account and a token balance from a token account; a missing account holds nothing', () => {
    expect(balanceIn('lamports', { lamports: 123n, data: new Uint8Array() })).toBe(123n);
    expect(balanceIn('token', { lamports: 2_039_280n, data: tokenAccountData(42n) })).toBe(42n);
    expect(balanceIn('token', null)).toBe(0n);
    expect(balanceIn('lamports', null)).toBe(0n);
  });

  it('passes a run that leaves every balance at or above its floor', () => {
    expect(floorsBroken(floors, [{ lamports: 90_000_000n, data: new Uint8Array() }, { lamports: 2_039_280n, data: tokenAccountData(5_000_000n) }])).toEqual([]);
  });

  it('names the balance a run would take too much from', () => {
    expect(floorsBroken(floors, [{ lamports: 89_999_999n, data: new Uint8Array() }, { lamports: 2_039_280n, data: tokenAccountData(5_000_000n) }])).toEqual(['it would leave your public SOL lower than this trade allows']);
    // The token account emptied, or closed.
    expect(floorsBroken(floors, [{ lamports: 95_000_000n, data: new Uint8Array() }, { lamports: 2_039_280n, data: tokenAccountData(0n) }])).toHaveLength(1);
    expect(floorsBroken(floors, [{ lamports: 95_000_000n, data: new Uint8Array() }, null])).toHaveLength(1);
  });

  it('does not pass a run that did not report every account', () => {
    expect(floorsBroken(floors, [{ lamports: 95_000_000n, data: new Uint8Array() }])).toEqual(['your public USDC could not be checked']);
    expect(floorsBroken(floors, [])).toHaveLength(2);
  });

  it('allows SOL for each token account a transaction opens, and a fixed sum for fees', () => {
    const swap = readBuild(LIVE_SOL_TO_USDC.body, LIVE_SOL_TO_USDC.request);
    expect(solOverhead(swap.instructions)).toBe(2n * TOKEN_ACCOUNT_RENT_LAMPORTS + CONVERSION_FEE_ALLOWANCE_LAMPORTS);
    expect(solOverhead([])).toBe(CONVERSION_FEE_ALLOWANCE_LAMPORTS);
  });
});

describe('sizing a converted trade', () => {
  it('splits the slippage limit between the two swaps, with a floor', () => {
    expect(legSlippageBps(100)).toBe(50);
    expect(legSlippageBps(250)).toBe(125);
    expect(legSlippageBps(15)).toBe(10);
    expect(legSlippageBps(1)).toBe(10);
  });

  it('gives a transaction the compute a run of it used and a fifth more, never over the ceiling', () => {
    expect(tunedComputeLimit(500_000n)).toBe(620_000);
    expect(tunedComputeLimit(500_000)).toBe(620_000);
    expect(tunedComputeLimit(1_300_000n)).toBe(1_400_000);
    // An RPC that does not say how much was used gets the ceiling.
    expect(tunedComputeLimit(undefined)).toBe(1_400_000);
    expect(tunedComputeLimit(0n)).toBe(1_400_000);
  });

  it('leaves the conversion fewer accounts when a private balance is spent in the same transaction', () => {
    expect(CONVERSION_ACCOUNTS.fromPrivate).toBeLessThan(CONVERSION_ACCOUNTS.fromPublic);
    expect(CONVERSION_ACCOUNTS.fromPublic).toBeLessThan(TX_V1_MAX_ACCOUNTS);
    expect(CONVERSION_ACCOUNTS.smallest).toBeGreaterThanOrEqual(8);
  });

  it('names SOL to Rings as SOL and any other token by its mint', () => {
    expect(ringsAssetOf(WSOL_MINT)).toBe(SOL_MINT);
    expect(ringsAssetOf(USDC_MINT)).toBe(USDC_MINT);
  });
});

describe('a converted trade as one transaction', () => {
  const lifetime = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 100n };
  let holder: ShieldedKeypair;
  let wallet: Address;
  let transact: Instruction;

  /**
   * An instruction that brings `fresh` accounts nothing else in the transaction
   * names, standing in for the Meteora swap or a Rings deposit. The program is
   * one of them. Beyond those it names accounts the conversion names already
   * (the wallet, its token accounts, the mints, the token program), as the real
   * ones do.
   */
  const standIn = (fresh: number, shared: readonly string[] = []): Instruction => ({
    programAddress: Keypair.generate().publicKey.toBase58() as Address,
    accounts: [
      { address: wallet, role: AccountRole.WRITABLE_SIGNER },
      ...shared.map((account) => ({ address: account as Address, role: AccountRole.READONLY })),
      ...Array.from({ length: fresh - 1 }, (_unused, index) => ({ address: Keypair.generate().publicKey.toBase58() as Address, role: index % 2 === 0 ? AccountRole.WRITABLE : AccountRole.READONLY })),
    ],
    data: new Uint8Array(40),
  });
  /**
   * What a Meteora swap adds that a conversion does not already name: the pool, its config and
   * authority, two vaults, the token's mint and the wallet's account for it, the event authority
   * and the program. And a Rings deposit: the tree, the Rings program and the token's vault, of
   * which the first two are already there when a withdrawal shares the transaction.
   */
  const POOL_SWAP_FRESH = 9;
  const DEPOSIT_FRESH = 3;

  beforeAll(async () => {
    const { tree } = await setup();
    holder = ShieldedKeypair.generate();
    wallet = holder.toSolanaSigner().address;
    // A Rings instruction of the real size and shape stands in for the withdrawal; only its proof is a placeholder.
    const data = buildLeg({ from: holder, to: ShieldedKeypair.generate(), feePayer: wallet, asset: SOL_MINT as Address, noteAmount: 900_000_000n, sendAmount: 250_000_000n });
    transact = await transactInstruction({ payer: wallet, ownerSigners: [wallet], inputTree: tree, outputTree: tree, data });
  });

  it('a buy from the private balance fits version 1: withdraw, convert, buy, deposit', () => {
    const request: BuildRequest = { inputMint: WSOL_MINT, outputMint: ZEC_MINT, amount: 250_000_000n, taker: wallet, slippageBps: 50, maxAccounts: CONVERSION_ACCOUNTS.fromPrivate };
    // A conversion that uses every account it was allowed.
    const swap = readBuild(answerFor(request, { routeAccounts: CONVERSION_ACCOUNTS.fromPrivate - 8 }), request);
    const jupiter = swap.instructions.find((instruction) => instruction.programAddress === JUPITER_PROGRAM_ID) as Instruction;
    expect(new Set((jupiter.accounts ?? []).map((account) => account.address)).size).toBe(CONVERSION_ACCOUNTS.fromPrivate);
    const shared = [tokenAccount(wallet, ZEC_MINT), ZEC_MINT, TOKEN_PROGRAM_ID];
    const instructions = [transact, ...swap.instructions, standIn(POOL_SWAP_FRESH, shared), standIn(DEPOSIT_FRESH, shared)];
    const transaction = composeV1({ feePayer: wallet, lifetime, instructions, computeUnitLimit: 1_400_000 });
    expect(getTransactionSize(transaction)).toBeLessThan(TX_V1_MAX_BYTES);
    // With room left for a wallet whose balance is in several notes: each one spent adds an account.
    expect(countAccounts(wallet, instructions)).toBeLessThanOrEqual(TX_V1_MAX_ACCOUNTS - 6);
    const message = decompileMessage(messageBytesOf(transaction));
    expect(message.version).toBe(1);
    expect(message.instructions).toHaveLength(instructions.length);
    // The wallet is the only signer of all of it.
    expect(requiredSigners(wallet, instructions)).toEqual([wallet]);
  });

  it('a buy from the public balance has room for a longer route', () => {
    const request: BuildRequest = { inputMint: USDC_MINT, outputMint: ZEC_MINT, amount: 25_000_000n, taker: wallet, slippageBps: 50, maxAccounts: CONVERSION_ACCOUNTS.fromPublic };
    const swap = readBuild(answerFor(request, { kind: 'shared_accounts_route_v2', routeAccounts: CONVERSION_ACCOUNTS.fromPublic - 11 }), request);
    const shared = [tokenAccount(wallet, ZEC_MINT), ZEC_MINT, TOKEN_PROGRAM_ID];
    const instructions = [...swap.instructions, standIn(POOL_SWAP_FRESH, shared), standIn(DEPOSIT_FRESH, shared)];
    expect(() => composeV1({ feePayer: wallet, lifetime, instructions, computeUnitLimit: 1_400_000 })).not.toThrow();
    expect(countAccounts(wallet, instructions)).toBeLessThanOrEqual(TX_V1_MAX_ACCOUNTS - 4);
  });

  it('one that does not fit is refused before anything is signed, with the number that says by how much', () => {
    const request: BuildRequest = { inputMint: USDC_MINT, outputMint: ZEC_MINT, amount: 25_000_000n, taker: wallet, slippageBps: 50, maxAccounts: 64 };
    const swap = readBuild(answerFor(request, { routeAccounts: 50 }), request);
    const instructions = [transact, ...swap.instructions, standIn(POOL_SWAP_FRESH), standIn(DEPOSIT_FRESH)];
    let thrown: unknown;
    try {
      composeV1({ feePayer: wallet, lifetime, instructions, computeUnitLimit: 1_400_000 });
    } catch (error) {
      thrown = error;
    }
    // This code's own error, which the page reads to ask for a shorter route.
    expect(thrown).toBeInstanceOf(TxError);
    expect((thrown as TxError).code).toBe('TOO_MANY_ACCOUNTS');
    expect(countAccounts(wallet, instructions)).toBeGreaterThan(TX_V1_MAX_ACCOUNTS);
  });
});

describe('a converted trade is refused before anything is read from chain when its parts do not belong together', () => {
  const taker = Keypair.generate().publicKey.toBase58();
  const market = { pair: ZEC, mint: Keypair.generate().publicKey } as never;
  const env = { market } as never;
  const ctx = { owner: taker } as never;
  const buyQuote = { side: 'buy', mode: 'exact-out', venue: 'curve', amountIn: 900n, amountOut: 5_000n, minimumAmountOut: 5_000n, maximumAmountIn: 1_000n, fee: 30n, feeBps: 300, slippageBps: 50 } as const;
  const sellQuote = { side: 'sell', mode: 'exact-in', venue: 'curve', amountIn: 5_000n, amountOut: 1_000n, minimumAmountOut: 990n, maximumAmountIn: 5_000n, fee: 30n, feeBps: 300, slippageBps: 50 } as const;
  const into = (request: Partial<BuildRequest>, expectedOut: bigint) => {
    const full: BuildRequest = { inputMint: WSOL_MINT, outputMint: ZEC.mint, amount: 1_000_000n, taker, slippageBps: 50, maxAccounts: 30, ...request };
    return readBuild(answerFor(full, { expectedOut }), full);
  };

  it('a buy whose conversion is into another token', async () => {
    const swap = into({ outputMint: USDC_MINT }, 2_000n);
    await expect(buildConvertedBuy(ctx, env, { swap, quote: buyQuote, source: 'public', payingSymbol: 'SOL' })).rejects.toThrow(/not into ZEC/);
  });

  it('a buy that could need more than the conversion guarantees', async () => {
    // The conversion guarantees 994; the pool may take up to 1,000.
    const swap = into({}, 1_000n);
    expect(swap.minimumOut).toBe(994n);
    await expect(buildConvertedBuy(ctx, env, { swap, quote: buyQuote, source: 'public', payingSymbol: 'SOL' })).rejects.toThrow(/more than the conversion guarantees/);
  });

  it('a buy quote of the wrong kind', async () => {
    const swap = into({}, 2_000n);
    await expect(buildConvertedBuy(ctx, env, { swap, quote: sellQuote, source: 'public', payingSymbol: 'SOL' })).rejects.toThrow(MarketError);
  });

  it('a sell whose conversion is not sized to exactly what the sell guarantees', async () => {
    const out = (amount: bigint) => {
      const full: BuildRequest = { inputMint: ZEC.mint, outputMint: WSOL_MINT, amount, taker, slippageBps: 50, maxAccounts: 30 };
      return readBuild(answerFor(full), full);
    };
    await expect(buildConvertedSell(ctx, env, { quote: sellQuote, swap: out(1_000n), receivingSymbol: 'SOL' })).rejects.toThrow(/not sized to what the sell guarantees/);
    await expect(buildConvertedSell(ctx, env, { quote: buyQuote, swap: out(990n), receivingSymbol: 'SOL' })).rejects.toThrow(MarketError);
    const wrongWay: BuildRequest = { inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: 990n, taker, slippageBps: 50, maxAccounts: 30 };
    await expect(buildConvertedSell(ctx, env, { quote: sellQuote, swap: readBuild(answerFor(wrongWay), wrongWay), receivingSymbol: 'SOL' })).rejects.toThrow(/not out of ZEC/);
  });
});

describe('what a trade can be paid with', () => {
  const on = statusFixture({ convert: { enabled: true, assets: CONVERT_ASSETS, anyToken: true } });
  const off = statusFixture();
  const sol = { id: 'SOL', symbol: 'SOL', mint: WSOL_MINT, decimals: 9 };

  it('is the pair token alone when the site does not convert', () => {
    expect(counterOptions(off, USDC).map((option) => option.id)).toEqual(['USDC']);
    expect(counterOptions(null, sol).map((option) => option.id)).toEqual(['SOL']);
  });

  it('is the pair token first, then SOL and USDC, each once', () => {
    expect(counterOptions(on, sol).map((option) => option.id)).toEqual(['SOL', 'USDC']);
    expect(counterOptions(on, USDC).map((option) => option.id)).toEqual(['USDC', 'SOL']);
    expect(counterOptions(on, ZEC).map((option) => option.id)).toEqual(['ZEC', 'SOL', 'USDC']);
  });

  it('falls back to the pair token for a choice that is not on offer', () => {
    expect(counterOf(on, ZEC, 'USDC').id).toBe('USDC');
    expect(counterOf(on, ZEC, '').id).toBe('ZEC');
    expect(counterOf(on, ZEC, 'NEAR').id).toBe('ZEC');
    expect(counterOf(off, ZEC, 'SOL').id).toBe('ZEC');
  });

  it('SOL and USDC are the two tokens that can stand in, with the decimals their mints have', () => {
    expect(CONVERT_ASSETS.map((asset) => [asset.id, asset.mint, asset.decimals])).toEqual([
      ['SOL', WSOL_MINT, 9],
      ['USDC', USDC_MINT, 6],
    ]);
    expect(USDC_QUICK_AMOUNTS.every((value) => /^[1-9][0-9]*$/.test(value))).toBe(true);
  });
});

describe('a live answer for a token that was not launched here', () => {
  it('SOL to BONK: wrap, open the wallet’s BONK account, swap, unwrap', () => {
    const swap = readBuild(LIVE_SOL_TO_BONK.body, LIVE_SOL_TO_BONK.request);
    expect(swap.amountIn).toBe(100_000_000n);
    expect(swap.expectedOut).toBe(328_017_147_199n);
    // Jupiter states 326,377,061,464, rounded up; what is built on is one unit less.
    expect(swap.minimumOut).toBe(326_377_061_463n);
    // Three hops on one venue are one venue.
    expect(swap.route).toEqual(['Whirlpool']);
    expect(swap.instructions.map((instruction) => instruction.programAddress)).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      JUPITER_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
    ]);
    // The account Jupiter pays into is the one this code works out for the wallet, with nothing told to it but the mint.
    const jupiter = swap.instructions[4] as Instruction;
    expect(jupiter.accounts?.[5]?.address).toBe(tokenAccount(LIVE_TAKER, BONK_MINT));
    expect(signersOf(jupiter)).toEqual([LIVE_TAKER]);
  });

  it('BONK to SOL: the sale spends from the wallet’s BONK account and unwraps what it is paid', () => {
    const swap = readBuild(LIVE_BONK_TO_SOL.body, LIVE_BONK_TO_SOL.request);
    expect(swap.amountIn).toBe(1_000_000_000_000n);
    expect(swap.expectedOut).toBe(304_960_000n);
    expect(swap.minimumOut).toBe(303_435_199n);
    expect(swap.route).toEqual(['Scorch']);
    const programs = swap.instructions.map((instruction) => instruction.programAddress);
    expect(programs).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, JUPITER_PROGRAM_ID, TOKEN_PROGRAM_ID]);
    expect((swap.instructions[1] as Instruction).accounts?.[1]?.address).toBe(tokenAccount(LIVE_TAKER, BONK_MINT));
  });

  it('SOL to a Token-2022 token: read when the request says which program the mint belongs to', () => {
    const swap = readBuild(LIVE_SOL_TO_PYUSD.body, LIVE_SOL_TO_PYUSD.request);
    expect(swap.expectedOut).toBe(6_795_558n);
    expect(swap.minimumOut).toBe(6_761_580n);
    expect(swap.route).toEqual(['Kipseli', 'Manifest']);
    // The wallet's account for it is the one the Token-2022 program gives, and it is opened under that program.
    expect(tokenAccount(LIVE_TAKER, PYUSD_MINT, TOKEN_2022_PROGRAM_ID)).toBe(LIVE_PYUSD_ACCOUNT);
    expect(tokenAccount(LIVE_TAKER, PYUSD_MINT)).not.toBe(LIVE_PYUSD_ACCOUNT);
    const opened = swap.instructions.filter((instruction) => instruction.programAddress === ASSOCIATED_TOKEN_PROGRAM_ID);
    // Wrapped SOL, the USDC the route passes through, and the token itself: three accounts, all the wallet's own.
    expect(opened).toHaveLength(3);
    expect(opened.map((instruction) => instruction.accounts?.[2]?.address)).toEqual([LIVE_TAKER, LIVE_TAKER, LIVE_TAKER]);
    expect(opened[2]?.accounts?.[1]?.address).toBe(LIVE_PYUSD_ACCOUNT);
    expect(opened[2]?.accounts?.[5]?.address).toBe(TOKEN_2022_PROGRAM_ID);
    // Every one of them is opened only if it is missing.
    for (const instruction of opened) expect([...(instruction.data ?? [])]).toEqual([1]);
  });

  it('SOL to a Token-2022 token: the swap names no more distinct accounts than were allowed', () => {
    const swap = readBuild(LIVE_SOL_TO_PYUSD.body, LIVE_SOL_TO_PYUSD.request);
    const jupiter = swap.instructions.find((instruction) => instruction.programAddress === JUPITER_PROGRAM_ID) as Instruction;
    expect(jupiter.accounts).toHaveLength(42);
    expect(new Set((jupiter.accounts ?? []).map((account) => account.address)).size).toBeLessThanOrEqual(30);
  });

  it('the same answer is refused when the request takes the mint for an SPL Token one', () => {
    const { outputProgram: _dropped, ...asSpl } = LIVE_SOL_TO_PYUSD.request;
    expect(() => readBuild(LIVE_SOL_TO_PYUSD.body, asSpl)).toThrow(/does not pay into this wallet's own token account/);
  });
});

describe('a swap for a Token-2022 token is held to its own token program', () => {
  const taker = Keypair.generate().publicKey.toBase58();
  const token = Keypair.generate().publicKey.toBase58();
  const buy: BuildRequest = { inputMint: WSOL_MINT, outputMint: token, amount: 1_000_000n, taker, slippageBps: 100, maxAccounts: 30, outputProgram: TOKEN_2022_PROGRAM_ID };
  const sell: BuildRequest = { inputMint: token, outputMint: WSOL_MINT, amount: 5_000_000n, taker, slippageBps: 100, maxAccounts: 30, inputProgram: TOKEN_2022_PROGRAM_ID };

  for (const kind of ['route_v2', 'shared_accounts_route_v2'] as const) {
    it(`${kind}: a buy and a sale are read, with the wallet’s accounts where that program puts them`, () => {
      const bought = readBuild(answerFor(buy, { kind }), buy);
      const jupiter = bought.instructions.find((instruction) => instruction.programAddress === JUPITER_PROGRAM_ID) as Instruction;
      expect((jupiter.accounts ?? []).map((account) => account.address)).toContain(tokenAccount(taker, token, TOKEN_2022_PROGRAM_ID));
      expect((jupiter.accounts ?? []).map((account) => account.address)).not.toContain(tokenAccount(taker, token));
      expect(readBuild(answerFor(sell, { kind }), sell).amountIn).toBe(5_000_000n);
    });

    it(`${kind}: an answer built for the other token program is refused, whichever way round`, () => {
      // Built as if the mint were an SPL Token one, for a request that knows it is not.
      const { outputProgram: _a, ...buySpl } = buy;
      expect(() => readBuild(answerFor(buySpl, { kind }), buy)).toThrow(ConvertError);
      // And the reverse.
      expect(() => readBuild(answerFor(buy, { kind }), buySpl)).toThrow(ConvertError);
      const { inputProgram: _b, ...sellSpl } = sell;
      expect(() => readBuild(answerFor(sellSpl, { kind }), sell)).toThrow(/does not spend from this wallet's own token account/);
    });

    it(`${kind}: the right accounts with the wrong program beside them are refused`, () => {
      const answer = answerFor(buy, { kind });
      const at = kind === 'route_v2' ? 6 : 9;
      (answer.swapInstruction.accounts[at] as { pubkey: string }).pubkey = TOKEN_PROGRAM_ID;
      expect(() => readBuild(answer, buy)).toThrow(/another token program than the one its mint belongs to/);
    });
  }

  it('a request that names a program that is not a token program is refused before anything is read', () => {
    const odd = { ...buy, outputProgram: SYSTEM_PROGRAM_ID };
    expect(() => readBuild(answerFor(buy), odd)).toThrow(/names a token program this site does not use/);
  });
});

describe('a swap that would hand part of the trade to somebody else is refused', () => {
  const taker = Keypair.generate().publicKey.toBase58();
  const request: BuildRequest = { inputMint: WSOL_MINT, outputMint: BONK_MINT, amount: 1_000_000n, taker, slippageBps: 100, maxAccounts: 30 };

  for (const kind of ['route_v2', 'shared_accounts_route_v2'] as const) {
    it(`${kind}: one that keeps back part of a better price`, () => {
      const answer = answerFor(request, { kind });
      const data = Buffer.from(answer.swapInstruction.data, 'base64');
      // The share of a better-than-quoted price that goes to a fee account: the last of the five numbers.
      data.writeUInt16LE(5_000, (kind === 'route_v2' ? 8 : 9) + 20);
      answer.swapInstruction.data = data.toString('base64');
      expect(() => readBuild(answer, request)).toThrow(/keeps part of a better price/);
    });
  }

  it('route_v2: one that passes what it buys on to another account', () => {
    const answer = answerFor(request);
    expect((answer.swapInstruction.accounts[7] as { pubkey: string }).pubkey).toBe(JUPITER_PROGRAM_ID);
    (answer.swapInstruction.accounts[7] as { pubkey: string }).pubkey = tokenAccount(Keypair.generate().publicKey.toBase58(), BONK_MINT);
    expect(() => readBuild(answer, request)).toThrow(/passes what it buys on to an account that is not this wallet's own/);
    // The wallet's own account there changes nothing about where the tokens end up.
    (answer.swapInstruction.accounts[7] as { pubkey: string }).pubkey = tokenAccount(taker, BONK_MINT);
    expect(readBuild(answer, request).outputMint).toBe(BONK_MINT);
  });

  it('every live answer leaves that account out, and keeps nothing back', () => {
    for (const live of [LIVE_SOL_TO_USDC, LIVE_ZEC_TO_SOL, LIVE_BONK_TO_SOL, LIVE_SOL_TO_PYUSD]) {
      expect((live.body.swapInstruction.accounts[7] as { pubkey: string }).pubkey).toBe(JUPITER_PROGRAM_ID);
      expect(Buffer.from(live.body.swapInstruction.data, 'base64').readUInt16LE(8 + 20)).toBe(0);
    }
    for (const live of [LIVE_USDC_TO_ZEC, LIVE_SOL_TO_BONK]) expect(Buffer.from(live.body.swapInstruction.data, 'base64').readUInt16LE(9 + 20)).toBe(0);
  });
});

describe('how far Jupiter says a trade moves the price', () => {
  const request: BuildRequest = { inputMint: WSOL_MINT, outputMint: BONK_MINT, amount: 1_000_000n, taker: Keypair.generate().publicKey.toBase58(), slippageBps: 100, maxAccounts: 30 };
  const withImpact = (value: unknown) => readBuild({ ...answerFor(request), priceImpactPct: value }, request).impactPct;

  it('is read as a percentage, for a warning and nothing else', () => {
    expect(readBuild(LIVE_SOL_TO_USDC.body, LIVE_SOL_TO_USDC.request).impactPct).toBeCloseTo(0.0289, 3);
    expect(withImpact('0.3')).toBeCloseTo(30, 6);
    expect(withImpact('0')).toBe(0);
    expect(withImpact('2.5')).toBe(100);
    // A trade that improves the price has nothing to warn about.
    expect(withImpact('-0.01')).toBe(0);
  });

  it('is nothing at all when the answer gives no usable figure', () => {
    expect(readBuild(answerFor(request), request).impactPct).toBeNull();
    for (const value of [0.3, 'a lot', '', '1e9', null, '0.3%', { ratio: 1 }]) expect(withImpact(value)).toBeNull();
  });
});
