/**
 * Tokens that were not launched here: which of them can be bought, what they
 * call themselves, and the transactions that buy, sell and tidy up after
 * them.
 *
 * The trade builders run here against the real Rings SDK. Its deposit builder
 * needs no prover, so a buy and a sale from the public balance are built in
 * full, down to the instruction that creates a token's place in Rings; a
 * stand-in answers the three accounts it reads. A withdrawal needs the remote
 * prover, so trades from the private balance are sized with a real Rings
 * instruction of the right shape in the withdrawal's place.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountRole, type Address, type Blockhash, type Instruction, address, getTransactionSize } from '@solana/kit';
import { type AccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, ExtensionType, MintLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SOL_MINT, ShieldedKeypair, Wallet } from '@heliuslabs/spr';
import { getProtocolConfigAddress, getSplAssetRegistryAddress, getSplAssetVaultAddress } from '@heliuslabs/spr/addresses';
import { InstructionTag, TransactWithdrawal, transactInstruction } from '@heliuslabs/spr/interface';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_ACCOUNT_RENT_LAMPORTS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  TOKEN_PROGRAM_ID,
  TX_V1_MAX_ACCOUNTS,
  TX_V1_MAX_BYTES,
  WSOL_MINT,
} from '../shared/src/constants.js';
import { type BuildRequest, JUPITER_PROGRAM_ID, OUTSIDE_ACCOUNTS, readBuild, solOverhead } from '../shared/src/jupiter.js';
import { MarketError } from '../shared/src/meteora.js';
import { DESCRIPTIVE_EXTENSIONS, type MintFacts, outsideMintNotes, outsideMintProblems, readMintFacts } from '../shared/src/mint.js';
import type { RingsContext } from '../shared/src/privacy.js';
import { type OutsideToken, RINGS_INTERFACE_RENT_LAMPORTS, buildOutsideBuy, buildOutsideSell, buildShieldRest } from '../shared/src/routes.js';
import { METADATA_PROGRAM_ID, NAME_MAX, TICKER_MAX, metadataAddress, readMetaplexName, readMintName, tidyTokenText } from '../shared/src/token-names.js';
import { TransferError, publicSendInstructions } from '../shared/src/transfers.js';
import { composeV1, countAccounts, instructionsOf, requiredSigners } from '../shared/src/tx.js';
import { explainError } from '../web/src/errors.js';
import { buildLeg, setup } from './helpers.js';
import { USDC_MINT, answerFor, tokenAccount } from './jupiter-fixtures.js';

const key = (): string => Keypair.generate().publicKey.toBase58();
const bytes = (...parts: Array<number | Uint8Array>): Uint8Array => Uint8Array.from(parts.flatMap((part) => (typeof part === 'number' ? [part] : [...part])));
const u16 = (value: number): Uint8Array => Uint8Array.of(value & 0xff, value >> 8);
const u32 = (value: number): Uint8Array => Uint8Array.of(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/* ------------------------------------------------------------------ */
/* Mints, as they are on chain                                         */
/* ------------------------------------------------------------------ */

interface MintInput {
  readonly decimals?: number;
  readonly supply?: bigint;
  readonly mintAuthority?: string | null;
  readonly freezeAuthority?: string | null;
  readonly initialized?: boolean;
  /** Token-2022 extensions, as type and content. Giving any makes the mint a Token-2022 one. */
  readonly extensions?: ReadonlyArray<readonly [type: number, content: Uint8Array]>;
  readonly token2022?: boolean;
}

/** A mint account as an RPC returns it. */
function mintAccount(input: MintInput = {}): AccountInfo<Buffer> {
  const base = Buffer.alloc(MintLayout.span);
  const none = PublicKey.default;
  MintLayout.encode(
    {
      mintAuthorityOption: input.mintAuthority ? 1 : 0,
      mintAuthority: input.mintAuthority ? new PublicKey(input.mintAuthority) : none,
      supply: input.supply ?? 1_000_000_000_000n,
      decimals: input.decimals ?? 6,
      isInitialized: input.initialized ?? true,
      freezeAuthorityOption: input.freezeAuthority ? 1 : 0,
      freezeAuthority: input.freezeAuthority ? new PublicKey(input.freezeAuthority) : none,
    },
    base,
  );
  const token2022 = input.token2022 ?? input.extensions !== undefined;
  let data = base;
  if (input.extensions && input.extensions.length > 0) {
    // After the mint itself: room up to the size of a token account, one byte saying this is a mint, then each extension.
    const entries = Buffer.concat(input.extensions.map(([type, content]) => Buffer.from(bytes(u16(type), u16(content.length), content))));
    data = Buffer.concat([base, Buffer.alloc(ACCOUNT_SIZE - MintLayout.span), Buffer.of(1), entries]);
  }
  return { executable: false, lamports: 1_461_600, owner: new PublicKey(token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID), data };
}

/** The content of a Token-2022 mint's own metadata: update authority, mint, name, ticker, address of the artwork. */
function metadataExtension(mint: string, name: string, symbol: string): Uint8Array {
  const text = (value: string): Uint8Array => bytes(u32(utf8(value).length), utf8(value));
  return bytes(new Uint8Array(32), new PublicKey(mint).toBytes(), text(name), text(symbol), text('https://example.invalid/art.json'), u32(0));
}

const mintKey = Keypair.generate().publicKey;
const MINT = mintKey.toBase58();
const facts = (input: MintInput = {}): MintFacts => readMintFacts(mintKey, mintAccount(input));

describe('what a mint is, read from its account', () => {
  it('an SPL Token mint: its program, decimals, supply and who controls it', () => {
    const issuer = key();
    const read = facts({ decimals: 5, supply: 88_000_000_000_000_000n, freezeAuthority: issuer });
    expect(read).toEqual({
      program: 'spl-token',
      programId: TOKEN_PROGRAM_ID,
      initialized: true,
      decimals: 5,
      supply: 88_000_000_000_000_000n,
      mintAuthority: null,
      freezeAuthority: issuer,
      extensions: [],
      restrictive: [],
    });
  });

  it('a Token-2022 mint: the same, and the extensions it carries by name', () => {
    const read = facts({ decimals: 6, extensions: [[ExtensionType.MetadataPointer, new Uint8Array(64)], [ExtensionType.TokenMetadata, metadataExtension(MINT, 'Coin', 'COIN')]] });
    expect(read.program).toBe('token-2022');
    expect(read.programId).toBe(TOKEN_2022_PROGRAM_ID);
    expect(read.extensions).toEqual(['MetadataPointer', 'TokenMetadata']);
    expect(read.restrictive).toEqual([]);
    // A Token-2022 mint with no extension at all is only as long as an SPL Token one.
    expect(facts({ token2022: true }).extensions).toEqual([]);
  });

  it('an account that is not a mint of either token program is not read as one', () => {
    const wallet: AccountInfo<Buffer> = { executable: false, lamports: 5, owner: new PublicKey(SYSTEM_PROGRAM_ID), data: Buffer.alloc(0) };
    expect(() => readMintFacts(mintKey, wallet)).toThrow(/not a token program/);
    expect(() => readMintFacts(mintKey, null)).toThrow(/no account/);
    // A token account is owned by the token program too, and is the wrong size for a mint.
    const account: AccountInfo<Buffer> = { executable: false, lamports: 5, owner: new PublicKey(TOKEN_PROGRAM_ID), data: Buffer.alloc(ACCOUNT_SIZE) };
    expect(() => readMintFacts(mintKey, account)).toThrow();
  });
});

describe('which tokens that were not launched here can be bought', () => {
  it('an SPL Token mint can, whoever controls it', () => {
    expect(outsideMintProblems(facts())).toEqual([]);
    expect(outsideMintProblems(facts({ decimals: 0, mintAuthority: key(), freezeAuthority: key() }))).toEqual([]);
    expect(outsideMintProblems(facts({ decimals: 18 }))).toEqual([]);
  });

  it('a Token-2022 mint can when all it carries describes it', () => {
    expect(outsideMintProblems(facts({ token2022: true }))).toEqual([]);
    const described = facts({
      extensions: [
        [ExtensionType.MetadataPointer, new Uint8Array(64)],
        [ExtensionType.TokenMetadata, metadataExtension(MINT, 'Coin', 'COIN')],
        [ExtensionType.GroupPointer, new Uint8Array(64)],
        [ExtensionType.GroupMemberPointer, new Uint8Array(64)],
      ],
    });
    expect(outsideMintProblems(described)).toEqual([]);
    expect([...DESCRIPTIVE_EXTENSIONS].sort()).toEqual(['GroupMemberPointer', 'GroupPointer', 'MetadataPointer', 'TokenGroup', 'TokenGroupMember', 'TokenMetadata']);
  });

  const changing: ReadonlyArray<readonly [string, number, number]> = [
    ['TransferFeeConfig', ExtensionType.TransferFeeConfig, 108],
    ['TransferHook', ExtensionType.TransferHook, 64],
    ['PermanentDelegate', ExtensionType.PermanentDelegate, 32],
    ['NonTransferable', ExtensionType.NonTransferable, 0],
    ['DefaultAccountState', ExtensionType.DefaultAccountState, 1],
    ['MintCloseAuthority', ExtensionType.MintCloseAuthority, 32],
    ['InterestBearingConfig', ExtensionType.InterestBearingConfig, 52],
    ['ConfidentialTransferMint', ExtensionType.ConfidentialTransferMint, 65],
  ];
  for (const [name, type, size] of changing) {
    it(`a Token-2022 mint with ${name} cannot, and the reason names it`, () => {
      const read = facts({ extensions: [[ExtensionType.MetadataPointer, new Uint8Array(64)], [type, new Uint8Array(size)]] });
      const problems = outsideMintProblems(read);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(new RegExp(`features that change how it moves or who controls it: ${name}\\.`));
      expect(problems[0]).not.toMatch(/MetadataPointer/);
    });
  }

  it('an extension this build has never heard of is refused like any other', () => {
    const problems = outsideMintProblems(facts({ extensions: [[4321, new Uint8Array(8)]] }));
    expect(problems[0]).toMatch(/extension 4321/);
  });

  it('a mint that was never initialised, or with more decimals than amounts are written with, cannot', () => {
    expect(outsideMintProblems(facts({ initialized: false }))[0]).toMatch(/never made into a token/);
    expect(outsideMintProblems(facts({ decimals: 19 }))[0]).toMatch(/19 decimals/);
  });

  it('says who can freeze it or make more of it, without refusing it for that', () => {
    expect(outsideMintNotes(facts())).toEqual([]);
    const issuer = key();
    const minter = key();
    const notes = outsideMintNotes(facts({ freezeAuthority: issuer, mintAuthority: minter }));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/can freeze any account that holds it, the Rings vault behind every private balance of it included/);
    expect(notes[0]).toContain(issuer);
    expect(notes[1]).toMatch(/More of it can be created at any time/);
    expect(notes[1]).toContain(minter);
  });

  it('Rings refusing a token it does not take is said in words, whichever way the chain puts it', () => {
    expect(explainError(new Error('The trade would fail, so it was not sent. Program ring1 failed: custom program error: 0x1b7f'))).toMatch(/carries a Token-2022 feature Rings does not support/);
    expect(explainError(new Error('UnsupportedToken2022Extension'))).toMatch(/Nothing was sent/);
    expect(explainError(new Error('custom program error: 0x1b7e'))).toMatch(/Rings does not take this token as it is on chain/);
    expect(explainError(new Error('Program log: Error: Account is frozen'))).toMatch(/frozen by the token’s issuer/);
    expect(explainError(new Error('Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x11'))).toMatch(/frozen/);
    // The slippage error of Jupiter's own program keeps its own wording.
    expect(explainError(new Error('custom program error: 0x1771'))).toMatch(/slippage limit/);
  });
});

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

describe('what a token calls itself', () => {
  /** A Metaplex metadata account: key, update authority, mint, then name, ticker and address, padded with zero bytes as Metaplex pads them. */
  const metaplex = (mint: string, name: string, symbol: string, kind = 4): Uint8Array => {
    const padded = (value: string, size: number): Uint8Array => {
      const out = new Uint8Array(size);
      out.set(utf8(value).subarray(0, size));
      return bytes(u32(size), out);
    };
    return bytes(kind, new Uint8Array(32), new PublicKey(mint).toBytes(), padded(name, 32), padded(symbol, 10), padded('https://example.invalid/a.json', 200), u16(0), 0);
  };
  const held = (data: Uint8Array, owner = METADATA_PROGRAM_ID) => ({ owner, data });

  it('is read from the Metaplex account of an SPL Token mint, without its padding', () => {
    expect(readMetaplexName(MINT, held(metaplex(MINT, 'Bonk', 'Bonk')))).toEqual({ name: 'Bonk', symbol: 'Bonk' });
    expect(readMetaplexName(MINT, held(metaplex(MINT, 'A token with a long name, 32 chr', 'TENLETTERS')))).toEqual({ name: 'A token with a long name, 32 chr', symbol: 'TENLETTERS' });
  });

  it('is read from a Token-2022 mint that carries it', () => {
    expect(readMintName(MINT, metadataExtension(MINT, 'Pump Coin', 'PUMP'))).toEqual({ name: 'Pump Coin', symbol: 'PUMP' });
    expect(readMintName(MINT, null)).toBeNull();
  });

  it('is nothing when the text is kept for another mint, by another program, or is not that kind of account', () => {
    const other = key();
    expect(readMetaplexName(MINT, held(metaplex(other, 'Bonk', 'BONK')))).toBeNull();
    expect(readMetaplexName(MINT, held(metaplex(MINT, 'Bonk', 'BONK'), key()))).toBeNull();
    expect(readMetaplexName(MINT, held(metaplex(MINT, 'Bonk', 'BONK', 6)))).toBeNull();
    expect(readMetaplexName(MINT, null)).toBeNull();
    expect(readMintName(MINT, metadataExtension(other, 'Pump Coin', 'PUMP'))).toBeNull();
  });

  it('is nothing when the account is cut short or claims more text than it holds', () => {
    const whole = metaplex(MINT, 'Bonk', 'BONK');
    for (const length of [0, 1, 64, 65, 68, 80, 101, 110]) expect(readMetaplexName(MINT, held(whole.subarray(0, length)))).toBeNull();
    const lying = Uint8Array.from(whole);
    // The name's length, where the reader finds it, set to far more than the account holds.
    lying.set(u32(50_000), 65);
    expect(readMetaplexName(MINT, held(lying))).toBeNull();
    expect(readMintName(MINT, metadataExtension(MINT, 'Pump Coin', 'PUMP').subarray(0, 70))).toBeNull();
  });

  it('is cleaned before anybody sees it: nothing invisible, nothing that turns the text around, one space at a time', () => {
    const turn = String.fromCodePoint(0x202e);
    const zero = String.fromCodePoint(0x200b);
    const mark = String.fromCodePoint(0xfeff);
    const wide = String.fromCodePoint(0x3000);
    expect(tidyTokenText(`US${zero}DC${turn}`, 40)).toBe('USDC');
    expect(tidyTokenText(`${mark}  Wrapped\t\n  Sol${wide}${wide}ana  `, 40)).toBe('Wrapped Sol ana');
    expect(tidyTokenText('\u0000\u0007Bonk\u0000\u0000', 40)).toBe('Bonk');
    // Cut by characters, not by bytes, and never left ending in a space.
    expect(tidyTokenText('abcde fghij', 6)).toBe('abcde');
    expect(tidyTokenText('💎'.repeat(50), NAME_MAX)).toBe('💎'.repeat(NAME_MAX));
    expect(tidyTokenText(`${turn}${zero}`, 40)).toBe('');
    const named = readMetaplexName(MINT, held(metaplex(MINT, `Real${turn}Coin`, `RE${zero}AL`)));
    expect(named).toEqual({ name: 'RealCoin', symbol: 'REAL' });
    expect(readMintName(MINT, metadataExtension(MINT, 'x'.repeat(300), 'y'.repeat(300)))).toEqual({ name: 'x'.repeat(NAME_MAX), symbol: 'y'.repeat(TICKER_MAX) });
  });

  it('a token that says nothing has no name', () => {
    expect(readMetaplexName(MINT, held(metaplex(MINT, '', '')))).toBeNull();
    expect(readMintName(MINT, metadataExtension(MINT, ' ', ''))).toBeNull();
  });

  it('the Metaplex account of a mint is the one that program derives for it', () => {
    const program = new PublicKey(METADATA_PROGRAM_ID);
    const expected = PublicKey.findProgramAddressSync([Buffer.from('metadata'), program.toBuffer(), mintKey.toBuffer()], program)[0].toBase58();
    expect(metadataAddress(MINT)).toBe(expected);
    expect(metadataAddress(MINT)).not.toBe(metadataAddress(USDC_MINT));
  });
});

/* ------------------------------------------------------------------ */
/* Trades                                                              */
/* ------------------------------------------------------------------ */

describe('buying and selling a token that was not launched here', () => {
  const lifetime = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 100n };
  let holder: ShieldedKeypair;
  let wallet: Address;
  let tree: Address;
  let treeId: number;
  let configAddress: string;
  /** What the stand-in for the Rings client answers with: Rings' own accounts, by address. */
  const ringsAccounts = new Map<string, { owner: Address; data: Uint8Array; lamports: bigint }>();
  /** What the stand-in for the chain answers with: the wallet's public accounts, by address. */
  const chainAccounts = new Map<string, AccountInfo<Buffer>>();
  let ctx: RingsContext;

  const connection = {
    getAccountInfo: async (target: PublicKey) => chainAccounts.get(target.toBase58()) ?? null,
    getMultipleAccountsInfo: async (targets: PublicKey[]) => targets.map((target) => chainAccounts.get(target.toBase58()) ?? null),
  } as never;

  /** Rings' rules, as its config account holds them: five authorities, three switches and a counter. */
  const setPermissionless = (allowed: boolean): void => {
    const authority = (): Uint8Array => Keypair.generate().publicKey.toBytes();
    ringsAccounts.set(configAddress, { owner: SPP_PROGRAM_ID as Address, lamports: 1n, data: bytes(3, authority(), authority(), authority(), authority(), authority(), 1, 1, allowed ? 1 : 0, 7, 0) });
  };
  /** Gives a mint its place in Rings, as somebody's first deposit would have. */
  const register = async (mint: string): Promise<void> => {
    ringsAccounts.set(await getSplAssetRegistryAddress(mint as Address), { owner: SPP_PROGRAM_ID as Address, lamports: 1n, data: bytes(5, new Uint8Array(7), new PublicKey(mint).toBytes(), 9, new Uint8Array(7)) });
  };
  const tokenBalance = (mint: string, units: bigint, program = TOKEN_PROGRAM_ID): void => {
    const data = Buffer.alloc(program === TOKEN_PROGRAM_ID ? ACCOUNT_SIZE : ACCOUNT_SIZE + 5);
    AccountLayout.encode(
      { mint: new PublicKey(mint), owner: new PublicKey(wallet), amount: units, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default },
      data,
    );
    chainAccounts.set(tokenAccount(wallet, mint, program), { executable: false, lamports: 2_039_280, owner: new PublicKey(program), data });
  };
  const fresh = (program = TOKEN_PROGRAM_ID, symbol = 'COIN'): OutsideToken => ({ mint: key(), programId: program, symbol });
  const swapInto = (token: OutsideToken, request: Partial<BuildRequest> = {}, expectedOut?: bigint) => {
    const full: BuildRequest = { inputMint: WSOL_MINT, outputMint: token.mint, amount: 250_000_000n, taker: wallet, slippageBps: 100, maxAccounts: OUTSIDE_ACCOUNTS.fromPublic, outputProgram: token.programId, ...request };
    return readBuild(answerFor(full, expectedOut === undefined ? {} : { expectedOut }), full);
  };
  const swapOutOf = (token: OutsideToken, request: Partial<BuildRequest> = {}, expectedOut?: bigint) => {
    const full: BuildRequest = { inputMint: token.mint, outputMint: WSOL_MINT, amount: 40_000_000n, taker: wallet, slippageBps: 100, maxAccounts: OUTSIDE_ACCOUNTS.fromPublic, inputProgram: token.programId, ...request };
    return readBuild(answerFor(full, expectedOut === undefined ? {} : { expectedOut }), full);
  };
  const ours = (instructions: readonly Instruction[]): number[] => instructions.filter((instruction) => instruction.programAddress === SPP_PROGRAM_ID).map((instruction) => instruction.data?.[0] ?? -1);
  const floorOf = (trade: { floors: ReadonlyArray<{ account: string; minimum: bigint; label: string; kind: string }> }, account: string) => trade.floors.find((floor) => floor.account === account);

  beforeAll(async () => {
    ({ tree, treeId } = await setup());
    holder = ShieldedKeypair.generate();
    wallet = holder.toSolanaSigner().address;
    configAddress = await getProtocolConfigAddress();
    const client = {
      tree,
      treeId,
      getAccount: async (target: Address) => ringsAccounts.get(target),
      getLatestBlockhash: async () => lifetime,
    };
    ctx = { client, owner: wallet, shielded: holder.shieldedAddress(), wallet: new Wallet({ identity: holder.shieldedAddress() }), keys: holder, sign: async (transaction: never) => transaction } as never;
    setPermissionless(true);
    chainAccounts.set(wallet, { executable: false, lamports: 500_000_000, owner: new PublicKey(SYSTEM_PROGRAM_ID), data: Buffer.alloc(0) });
  });

  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const named = program === TOKEN_PROGRAM_ID ? 'an SPL Token mint' : 'a Token-2022 mint';

    it(`a first buy of ${named} from the public balance: swap, make its place in Rings, deposit`, async () => {
      const token = fresh(program);
      const swap = swapInto(token);
      const trade = await buildOutsideBuy(ctx, connection, { swap, token, source: 'public', payingSymbol: 'SOL' });
      expect(trade.createsInterface).toBe(true);
      expect(trade.tokenAccountExisted).toBe(false);
      expect(trade.publicBefore).toBe(0n);
      // Jupiter's instructions exactly as they were read, then Rings': create the registry entry and vault, then deposit.
      expect(trade.instructions.slice(0, swap.instructions.length)).toEqual(swap.instructions);
      expect(ours(trade.instructions)).toEqual([InstructionTag.createSplInterface, InstructionTag.deposit]);
      const [create, deposit] = trade.instructions.slice(-2) as [Instruction, Instruction];
      const accounts = (instruction: Instruction): string[] => (instruction.accounts ?? []).map((account) => account.address);
      // The place in Rings is made for this mint, under its own token program, and this wallet pays for it.
      expect(accounts(create)[0]).toBe(wallet);
      expect(accounts(create)).toContain(token.mint);
      expect(accounts(create)).toContain(await getSplAssetVaultAddress(token.mint as Address));
      expect(accounts(create).at(-1)).toBe(program);
      // The deposit takes from the wallet's own account for the token, where that program puts it.
      const source = getAssociatedTokenAddressSync(new PublicKey(token.mint), new PublicKey(wallet), false, new PublicKey(program)).toBase58();
      expect(accounts(deposit)).toContain(source);
      expect(accounts(deposit)).toContain(program);
      // What is deposited is the least the swap can return: eight bytes of the deposit say so.
      const amount = Buffer.alloc(8);
      amount.writeBigUInt64LE(swap.minimumOut);
      expect(Buffer.from(deposit.data ?? []).includes(amount)).toBe(true);
      // Nobody but the wallet signs any of it.
      expect(requiredSigners(wallet, trade.instructions)).toEqual([wallet]);
      // The wallet's SOL may fall by what is paid, the rent of each account opened, the token's place in Rings and the fees. No further.
      const sol = floorOf(trade, wallet);
      expect(sol?.kind).toBe('lamports');
      expect(sol?.minimum).toBe(500_000_000n - 250_000_000n - solOverhead(trade.instructions) - RINGS_INTERFACE_RENT_LAMPORTS);
      // The token only arrives: its public balance may not end lower than it began, which was nothing.
      expect(floorOf(trade, source)).toMatchObject({ kind: 'token', minimum: 0n, label: 'your public COIN' });
      expect(trade.floors).toHaveLength(2);
      // It compiles as one version 1 transaction.
      const transaction = trade.compose(1_400_000, 5_000n);
      expect(getTransactionSize(transaction)).toBeLessThan(TX_V1_MAX_BYTES);
      expect(instructionsOf(transaction)).toHaveLength(trade.instructions.length);
    });

    it(`a later buy of ${named} only deposits, and allows no rent for a place that exists`, async () => {
      const token = fresh(program);
      await register(token.mint);
      tokenBalance(token.mint, 777n, program);
      const swap = swapInto(token);
      const trade = await buildOutsideBuy(ctx, connection, { swap, token, source: 'public', payingSymbol: 'SOL' });
      expect(trade.createsInterface).toBe(false);
      expect(ours(trade.instructions)).toEqual([InstructionTag.deposit]);
      expect(floorOf(trade, wallet)?.minimum).toBe(500_000_000n - 250_000_000n - solOverhead(trade.instructions));
      // The wallet already held some of the token in public: that is found, and may not end lower.
      expect(trade.tokenAccountExisted).toBe(true);
      expect(trade.publicBefore).toBe(777n);
      expect(floorOf(trade, tokenAccount(wallet, token.mint, program))?.minimum).toBe(777n);
    });

    it(`a sale of ${named} from the public balance: swap, then deposit the SOL it is certain to pay`, async () => {
      const token = fresh(program);
      await register(token.mint);
      tokenBalance(token.mint, 100_000_000n, program);
      const swap = swapOutOf(token);
      const trade = await buildOutsideSell(ctx, connection, { swap, token, source: 'public', receivingSymbol: 'SOL' });
      expect(trade.createsInterface).toBe(false);
      expect(trade.instructions.slice(0, swap.instructions.length)).toEqual(swap.instructions);
      // One Rings instruction, a deposit, and the public token account is left as it is.
      expect(ours(trade.instructions)).toEqual([InstructionTag.deposit]);
      expect(trade.instructions).toHaveLength(swap.instructions.length + 1);
      const amount = Buffer.alloc(8);
      amount.writeBigUInt64LE(swap.minimumOut);
      expect(Buffer.from(trade.instructions.at(-1)?.data ?? []).includes(amount)).toBe(true);
      expect(requiredSigners(wallet, trade.instructions)).toEqual([wallet]);
      // The token falls by exactly what is sold; SOL only by rent and fees, since what is deposited has just arrived.
      expect(floorOf(trade, tokenAccount(wallet, token.mint, program))?.minimum).toBe(100_000_000n - 40_000_000n);
      expect(floorOf(trade, wallet)?.minimum).toBe(500_000_000n - solOverhead(trade.instructions));
      expect(getTransactionSize(trade.compose(1_400_000, 0n))).toBeLessThan(TX_V1_MAX_BYTES);
    });
  }

  it('a buy paid in USDC holds the public USDC to what is paid, and SOL to rent and fees', async () => {
    const token = fresh();
    await register(token.mint);
    tokenBalance(USDC_MINT, 90_000_000n);
    const swap = swapInto(token, { inputMint: USDC_MINT, amount: 25_000_000n });
    const trade = await buildOutsideBuy(ctx, connection, { swap, token, source: 'public', payingSymbol: 'USDC' });
    expect(floorOf(trade, tokenAccount(wallet, USDC_MINT))).toMatchObject({ minimum: 65_000_000n, label: 'your public USDC' });
    expect(floorOf(trade, wallet)?.minimum).toBe(500_000_000n - solOverhead(trade.instructions));
    expect(trade.floors).toHaveLength(3);
  });

  it('a sale for USDC deposits from the wallet’s USDC account, and is refused while Rings has no place for USDC', async () => {
    const token = fresh();
    await register(token.mint);
    tokenBalance(token.mint, 100_000_000n);
    const swap = swapOutOf(token, { outputMint: USDC_MINT });
    await expect(buildOutsideSell(ctx, connection, { swap, token, source: 'public', receivingSymbol: 'USDC' })).rejects.toThrow(/no interface for USDC yet/);
    await register(USDC_MINT);
    const trade = await buildOutsideSell(ctx, connection, { swap, token, source: 'public', receivingSymbol: 'USDC' });
    const deposit = trade.instructions.at(-1) as Instruction;
    expect((deposit.accounts ?? []).map((account) => account.address)).toContain(tokenAccount(wallet, USDC_MINT));
    // What is received only arrives: it may not end lower than it began.
    expect(floorOf(trade, tokenAccount(wallet, USDC_MINT))?.minimum).toBe(90_000_000n);
    ringsAccounts.delete(await getSplAssetRegistryAddress(USDC_MINT as Address));
  });

  it('a first buy is refused when Rings does not let just anyone add a token', async () => {
    const token = fresh(TOKEN_PROGRAM_ID, 'NEWCOIN');
    setPermissionless(false);
    try {
      await expect(buildOutsideBuy(ctx, connection, { swap: swapInto(token), token, source: 'public', payingSymbol: 'SOL' })).rejects.toThrow(/Nobody has held NEWCOIN privately yet/);
    } finally {
      setPermissionless(true);
    }
  });

  it('parts that do not belong together are refused before anything is read from chain', async () => {
    const token = fresh();
    const other = fresh();
    const nothing = { getAccountInfo: async () => Promise.reject(new Error('read')), getMultipleAccountsInfo: async () => Promise.reject(new Error('read')) } as never;
    // A swap into another token than the one named.
    await expect(buildOutsideBuy(ctx, nothing, { swap: swapInto(other), token, source: 'public', payingSymbol: 'SOL' })).rejects.toThrow(/not into COIN/);
    // A sale whose swap goes the wrong way.
    await expect(buildOutsideSell(ctx, nothing, { swap: swapInto(token), token, source: 'public', receivingSymbol: 'SOL' })).rejects.toThrow(/not out of COIN/);
    // SOL is not a token to buy, and a token of an unknown program is not built for.
    const wrapped: OutsideToken = { mint: WSOL_MINT, programId: TOKEN_PROGRAM_ID, symbol: 'SOL' };
    await expect(buildOutsideBuy(ctx, nothing, { swap: swapInto(token), token: wrapped, source: 'public', payingSymbol: 'SOL' })).rejects.toThrow(MarketError);
    const odd: OutsideToken = { ...token, programId: SYSTEM_PROGRAM_ID };
    await expect(buildOutsideBuy(ctx, nothing, { swap: swapInto(token), token: odd, source: 'public', payingSymbol: 'SOL' })).rejects.toThrow(/token program this site does not use/);
    await expect(buildShieldRest(ctx, odd, 5n, false)).rejects.toThrow(/token program this site does not use/);
  });

  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    it(`what a buy left over is deposited, and its account closed, under ${program === TOKEN_PROGRAM_ID ? 'the SPL Token program' : 'the Token-2022 program'}`, async () => {
      const token = fresh(program);
      await register(token.mint);
      const account = tokenAccount(wallet, token.mint, program);
      const both = instructionsOf(await buildShieldRest(ctx, token, 1_234n, true)).filter((instruction) => instruction.programAddress !== 'ComputeBudget111111111111111111111111111111');
      expect(both.map((instruction) => instruction.programAddress)).toEqual([SPP_PROGRAM_ID, program]);
      // Close: the account, then where its rent goes, then who may close it. Both are the wallet.
      const close = both[1] as Instruction;
      expect([...(close.data ?? [])]).toEqual([9]);
      expect((close.accounts ?? []).map((entry) => entry.address)).toEqual([account, wallet, wallet]);
      // It signs: read back from a compiled transaction, the wallet is also the one that pays, so it is writable as well.
      expect([AccountRole.READONLY_SIGNER, AccountRole.WRITABLE_SIGNER]).toContain(close.accounts?.[2]?.role);
      // Without closing, the deposit alone. With nothing to deposit, the close alone.
      const only = instructionsOf(await buildShieldRest(ctx, token, 1_234n, false)).filter((instruction) => instruction.programAddress !== 'ComputeBudget111111111111111111111111111111');
      expect(only.map((instruction) => instruction.programAddress)).toEqual([SPP_PROGRAM_ID]);
      const empty = instructionsOf(await buildShieldRest(ctx, token, 0n, true)).filter((instruction) => instruction.programAddress !== 'ComputeBudget111111111111111111111111111111');
      expect(empty.map((instruction) => instruction.programAddress)).toEqual([program]);
      await expect(buildShieldRest(ctx, token, 0n, false)).rejects.toThrow(/nothing left over/);
    });
  }

  describe('room in one transaction', () => {
    /** An answer whose swap names exactly `distinct` different accounts. */
    const sized = (request: BuildRequest, kind: 'route_v2' | 'shared_accounts_route_v2', distinct: number) => {
      for (let route = 0; route <= 64; route += 1) {
        const swap = readBuild(answerFor(request, { kind, routeAccounts: route }), request);
        const jupiter = swap.instructions.find((instruction) => instruction.programAddress === JUPITER_PROGRAM_ID) as Instruction;
        if (new Set((jupiter.accounts ?? []).map((entry) => entry.address)).size === distinct) return swap;
      }
      throw new Error(`no answer with ${distinct} accounts`);
    };
    /** A Rings instruction of a withdrawal's real size and accounts; only its proof is a placeholder. */
    const withdrawal = async (asset: 'sol' | { mint: string; program: string }): Promise<Instruction> => {
      const data = buildLeg({ from: holder, to: ShieldedKeypair.generate(), feePayer: wallet, asset: SOL_MINT as Address, noteAmount: 900_000_000n, sendAmount: 250_000_000n });
      const target =
        asset === 'sol'
          ? TransactWithdrawal.sol({ recipient: wallet })
          : TransactWithdrawal.spl({
              mint: asset.mint as Address,
              splTokenInterface: await getSplAssetVaultAddress(asset.mint as Address),
              recipientTokenAccount: tokenAccount(wallet, asset.mint, asset.program) as Address,
              tokenProgram: address(asset.program),
            });
      return transactInstruction({ payer: wallet, ownerSigners: [wallet], inputTree: tree, outputTree: tree, data, withdrawal: target });
    };

    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      for (const kind of ['route_v2', 'shared_accounts_route_v2'] as const) {
        const label = `${program === TOKEN_PROGRAM_ID ? 'SPL Token' : 'Token-2022'}, ${kind}`;

        it(`a first buy from the private balance fits with room to spare (${label})`, async () => {
          const token = fresh(program);
          for (const [paying, head] of [[WSOL_MINT, await withdrawal('sol')], [USDC_MINT, await withdrawal({ mint: USDC_MINT, program: TOKEN_PROGRAM_ID })]] as const) {
            const request: BuildRequest = { inputMint: paying, outputMint: token.mint, amount: 250_000_000n, taker: wallet, slippageBps: 100, maxAccounts: OUTSIDE_ACCOUNTS.fromPrivate, outputProgram: program };
            const swap = sized(request, kind, OUTSIDE_ACCOUNTS.fromPrivate);
            // The public-balance builder gives the real instructions that follow the swap; the withdrawal goes in front.
            const rest = (await buildOutsideBuy(ctx, connection, { swap, token, source: 'public', payingSymbol: 'SOL' })).instructions;
            const instructions = [head, ...rest];
            expect(ours(instructions)).toEqual([InstructionTag.transact, InstructionTag.createSplInterface, InstructionTag.deposit]);
            // Each further note a split balance spends adds an account: there is room for several.
            expect(countAccounts(wallet, instructions)).toBeLessThanOrEqual(TX_V1_MAX_ACCOUNTS - 9);
            expect(getTransactionSize(composeV1({ feePayer: wallet, lifetime, instructions, computeUnitLimit: 1_400_000 }))).toBeLessThan(TX_V1_MAX_BYTES - 300);
            expect(requiredSigners(wallet, instructions)).toEqual([wallet]);
          }
        });

        it(`a first buy from the public balance fits (${label})`, async () => {
          const token = fresh(program);
          const request: BuildRequest = { inputMint: WSOL_MINT, outputMint: token.mint, amount: 250_000_000n, taker: wallet, slippageBps: 100, maxAccounts: OUTSIDE_ACCOUNTS.fromPublic, outputProgram: program };
          const trade = await buildOutsideBuy(ctx, connection, { swap: sized(request, kind, OUTSIDE_ACCOUNTS.fromPublic), token, source: 'public', payingSymbol: 'SOL' });
          expect(countAccounts(wallet, trade.instructions)).toBeLessThanOrEqual(TX_V1_MAX_ACCOUNTS - 6);
          expect(getTransactionSize(trade.compose(1_400_000, 0n))).toBeLessThan(TX_V1_MAX_BYTES - 300);
        });

        it(`a sale from the private balance fits, with the temporary account closed at the end (${label})`, async () => {
          const token = fresh(program);
          await register(token.mint);
          const request: BuildRequest = { inputMint: token.mint, outputMint: WSOL_MINT, amount: 40_000_000n, taker: wallet, slippageBps: 100, maxAccounts: OUTSIDE_ACCOUNTS.fromPrivate, inputProgram: program };
          const swap = sized(request, kind, OUTSIDE_ACCOUNTS.fromPrivate);
          const rest = (await buildOutsideSell(ctx, connection, { swap, token, source: 'public', receivingSymbol: 'SOL' })).instructions;
          const close = instructionsOf(await buildShieldRest(ctx, token, 0n, true)).filter((instruction) => instruction.programAddress === program);
          const instructions = [await withdrawal({ mint: token.mint, program }), ...rest, ...close];
          expect(countAccounts(wallet, instructions)).toBeLessThanOrEqual(TX_V1_MAX_ACCOUNTS - 9);
          expect(getTransactionSize(composeV1({ feePayer: wallet, lifetime, instructions, computeUnitLimit: 1_400_000 }))).toBeLessThan(TX_V1_MAX_BYTES - 300);
        });
      }
    }

    it('the account budgets leave the swap more room than a trade that also crosses a pool here', () => {
      expect(OUTSIDE_ACCOUNTS.fromPublic).toBeGreaterThan(OUTSIDE_ACCOUNTS.fromPrivate);
      expect(OUTSIDE_ACCOUNTS.fromPrivate).toBeGreaterThanOrEqual(40);
      expect(OUTSIDE_ACCOUNTS.fromPublic).toBeLessThanOrEqual(64);
      expect(OUTSIDE_ACCOUNTS.smallest).toBe(14);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Public sends of a Token-2022 token                                  */
/* ------------------------------------------------------------------ */

describe('an ordinary transfer of a Token-2022 token', () => {
  const from = key() as Address;
  const to = key() as Address;
  const mint = key() as Address;

  it('uses the accounts that program gives, and names the mint and its decimals', () => {
    const [open, transfer] = publicSendInstructions(from, { asset: mint, amount: 1_500n, recipient: to, token2022: { decimals: 6 } }) as [Instruction, Instruction];
    const source = tokenAccount(from, mint, TOKEN_2022_PROGRAM_ID);
    const destination = tokenAccount(to, mint, TOKEN_2022_PROGRAM_ID);
    expect(open.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect((open.accounts ?? []).map((entry) => entry.address)).toEqual([from, destination, to, mint, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
    // Opened only if it is missing.
    expect([...(open.data ?? [])]).toEqual([1]);
    expect(transfer.programAddress).toBe(TOKEN_2022_PROGRAM_ID);
    expect((transfer.accounts ?? []).map((entry) => entry.address)).toEqual([source, mint, destination, from]);
    // TransferChecked: its tag, the amount, then the decimals.
    const data = Buffer.from(transfer.data ?? []);
    expect(data[0]).toBe(12);
    expect(data.readBigUInt64LE(1)).toBe(1_500n);
    expect(data[9]).toBe(6);
  });

  it('an SPL Token transfer is built exactly as before', () => {
    const [open, transfer] = publicSendInstructions(from, { asset: mint, amount: 1_500n, recipient: to }) as [Instruction, Instruction];
    expect((open.accounts ?? []).at(-1)?.address).toBe(TOKEN_PROGRAM_ID);
    expect(transfer.programAddress).toBe(TOKEN_PROGRAM_ID);
    expect((transfer.accounts ?? []).map((entry) => entry.address)).toEqual([tokenAccount(from, mint), tokenAccount(to, mint), from]);
    expect(Buffer.from(transfer.data ?? [])[0]).toBe(3);
  });

  it('is not built on decimals that could not be read', () => {
    expect(() => publicSendInstructions(from, { asset: mint, amount: 1n, recipient: to, token2022: { decimals: Number.NaN } })).toThrow(TransferError);
    expect(() => publicSendInstructions(from, { asset: mint, amount: 1n, recipient: to, token2022: { decimals: 300 } })).toThrow(TransferError);
  });

  it('a Token-2022 token account costs a little more rent than an SPL Token one', () => {
    // (128 bytes of overhead + the account) at 6,960 lamports a byte: 165 bytes, and 170.
    expect(TOKEN_ACCOUNT_RENT_LAMPORTS).toBe(BigInt((128 + 165) * 6960));
    expect(TOKEN_2022_ACCOUNT_RENT_LAMPORTS).toBe(BigInt((128 + 170) * 6960));
    // The registry entry and the vault a first deposit creates, rounded up.
    expect(RINGS_INTERFACE_RENT_LAMPORTS).toBeGreaterThanOrEqual(BigInt((128 + 48) * 6960) + TOKEN_2022_ACCOUNT_RENT_LAMPORTS);
    expect(RINGS_INTERFACE_RENT_LAMPORTS).toBeLessThan(3_400_000n);
  });
});
