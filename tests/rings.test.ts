import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountRole, type Address, type Blockhash, type Instruction, getAddressDecoder, getBase64EncodedWireTransaction } from '@solana/kit';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { AccountLayout, MintLayout } from '@solana/spl-token';
import bs58 from 'bs58';
import { SOL_MINT, ShieldedKeypair } from '@heliuslabs/spr';
import { getSolInterfaceAddress, getSplAssetVaultAddress } from '@heliuslabs/spr/addresses';
import { InstructionTag, transactInstruction, type TransactInstructionData } from '@heliuslabs/spr/interface';
import { AssetRegistry } from '@heliuslabs/spr/transaction';

import { DBC_PROGRAM_ID, SPP_PROGRAM_ID, WSOL_MINT } from '../shared/src/constants.js';
import { NO_AUTHORITY, RING_CONFIG_SCAN, ringConfigAddress } from '../shared/src/custom-rings.js';
import { addSignature } from '../shared/src/signing.js';
import { composeV1 } from '../shared/src/tx.js';
import { type DecodeContext, type RawMeta, type RawTransaction, type RingEvent, UnreadableTransaction, decodeRing, readMessage } from '../server/src/rings/decode.js';
import { type RingChain, RingIndexer, type RingSignature, cleanLabel, mintFacts, tokenAccountAmount, trailOf } from '../server/src/rings/indexer.js';
import { RingStore, cursorOf, readCursor } from '../server/src/rings/store.js';
import { buildLeg, setup } from './helpers.js';

const SPP = SPP_PROGRAM_ID as Address;
const TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address; // any real mint address does
const SOL_VAULT = String(getSolInterfaceAddress()) as Address;
const lifetime = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 100n };
const FEE = 5_000;

type Party = { keypair: ShieldedKeypair; address: Address; signer: ReturnType<ShieldedKeypair['toSolanaSigner']> };
function party(): Party {
  const keypair = ShieldedKeypair.generate();
  const signer = keypair.toSolanaSigner();
  return { keypair, address: signer.address, signer };
}

let tree: Address;
let tokenVault: Address;
let alice: Party;
let bob: Party;
let relay: Party;
let context: DecodeContext;

beforeAll(async () => {
  ({ tree } = await setup());
  tokenVault = (await getSplAssetVaultAddress(TOKEN)) as Address;
  alice = party();
  bob = party();
  relay = party();
  context = { solVault: SOL_VAULT, vaultOf: (mint) => (mint === TOKEN ? tokenVault : undefined) };
});

/** A real confidential transfer, as the SDK encodes it, with a placeholder proof. */
async function transfer(from: Party, to: Party, payer: Party, asset: Address = SOL_MINT as Address): Promise<{ data: TransactInstructionData; instruction: Instruction }> {
  const registry = new AssetRegistry([[7n, TOKEN]]);
  const data = buildLeg({ from: from.keypair, to: to.keypair, feePayer: payer.address, asset, noteAmount: 5_000_000_000n, sendAmount: 2_000_000_000n, registry });
  const instruction = await transactInstruction({ payer: payer.address, ownerSigners: [from.address], inputTree: tree, outputTree: tree, data });
  return { data, instruction };
}

/** The event the indexer reports for a transfer: one tag per output, which on the Default Ring is the owner's address. */
function eventOf(data: TransactInstructionData, instruction: Instruction): RingEvent {
  const decoder = getAddressDecoder();
  const tags = data.outputs.map((output) => {
    if (output.ownerTag.kind === 'inline') return String(decoder.decode(output.ownerTag.value));
    return String((instruction.accounts ?? [])[output.ownerTag.index]?.address);
  });
  return { tags, nullifiers: data.inputs.length, proofless: false, ring: null };
}

/** An instruction of the Rings program that only carries its kind: the decoder reads nothing else of the data. */
function bare(tag: number, accounts: Array<[Address, AccountRole]>): Instruction {
  return { programAddress: SPP, accounts: accounts.map(([address, role]) => ({ address, role })), data: Uint8Array.of(tag, 1, 2, 3) };
}

interface Changes {
  lamports?: Array<[string, number]>;
  tokens?: Array<{ account: string; mint: string; owner: string; pre: string; post: string }>;
}

/** A version 1 transaction as `getTransaction` returns it, with the balance changes given. */
async function raw(payer: Party, instructions: Instruction[], signers: Party[], changes: Changes = {}): Promise<RawTransaction> {
  let transaction = composeV1({ feePayer: payer.address, lifetime, instructions, computeUnitLimit: 900_000 });
  for (const signer of signers) transaction = await addSignature(signer.signer, transaction);
  const bare: RawTransaction = { slot: 1, blockTime: 1_800_000_000, transaction: [getBase64EncodedWireTransaction(transaction), 'base64'], meta: null };
  const keys = readMessage({ ...bare, meta: { err: null, fee: FEE, preBalances: [], postBalances: [] } }).keys;
  const pre = keys.map(() => 1_000_000_000);
  const post = keys.map((_key, index) => (index === 0 ? 1_000_000_000 - FEE : 1_000_000_000));
  for (const [key, delta] of changes.lamports ?? []) {
    const index = keys.indexOf(key);
    if (index < 0) throw new Error(`fixture: ${key} is not in the transaction`);
    post[index] = (post[index] ?? 0) + delta;
  }
  const tokens = (changes.tokens ?? []).map((entry) => {
    const accountIndex = keys.indexOf(entry.account);
    if (accountIndex < 0) throw new Error(`fixture: ${entry.account} is not in the transaction`);
    return { accountIndex, entry };
  });
  const meta: RawMeta = {
    err: null,
    fee: FEE,
    preBalances: pre,
    postBalances: post,
    preTokenBalances: tokens.map(({ accountIndex, entry }) => ({ accountIndex, mint: entry.mint, owner: entry.owner, uiTokenAmount: { amount: entry.pre } })),
    postTokenBalances: tokens.map(({ accountIndex, entry }) => ({ accountIndex, mint: entry.mint, owner: entry.owner, uiTokenAmount: { amount: entry.post } })),
    innerInstructions: [],
  };
  return { ...bare, meta };
}

describe('reading a Rings transaction from public data', () => {
  it('reads a private transfer: the two wallets, and nothing of the token or the amount', async () => {
    const { data, instruction } = await transfer(alice, bob, alice);
    const tx = await raw(alice, [instruction], [alice]);
    const decoded = decodeRing(tx, [eventOf(data, instruction)], context);
    expect(decoded.kind).toBe('transfer');
    expect(decoded.payer).toBe(alice.address);
    expect(decoded.senders).toEqual([alice.address]);
    expect(decoded.recipients).toEqual([bob.address]);
    expect(decoded.legs).toEqual([]);
    expect(decoded.partial).toBe(false);
    // The amount that moved (2 SOL out of a 5 SOL note) is nowhere in what was decoded.
    expect(JSON.stringify(decoded)).not.toMatch(/2000000000|5000000000/);
  });

  it('names the wallet whose funds moved, not the one that paid the fee for it', async () => {
    const { data, instruction } = await transfer(alice, bob, relay);
    const tx = await raw(relay, [instruction], [relay, alice]);
    const decoded = decodeRing(tx, [eventOf(data, instruction)], context);
    expect(decoded.kind).toBe('transfer');
    expect(decoded.payer).toBe(relay.address);
    expect(decoded.senders).toEqual([alice.address]);
    expect(decoded.recipients).toEqual([bob.address]);
  });

  it('reads two wallets paying each other in one transaction as a swap between them', async () => {
    const first = await transfer(alice, relay, relay);
    const second = await transfer(relay, alice, relay, TOKEN);
    const tx = await raw(relay, [first.instruction, second.instruction], [relay, alice]);
    const decoded = decodeRing(tx, [eventOf(first.data, first.instruction), eventOf(second.data, second.instruction)], context);
    expect(decoded.kind).toBe('swap');
    expect([...decoded.senders].sort()).toEqual([alice.address, relay.address].sort());
    expect(decoded.recipients).toEqual([]);
    expect(decoded.legs).toEqual([]);
  });

  it('marks a private move as unfinished while the indexer has no events for it, and guesses nothing', async () => {
    const { instruction } = await transfer(alice, bob, alice);
    const decoded = decodeRing(await raw(alice, [instruction], [alice]), null, context);
    expect(decoded.kind).toBe('private');
    expect(decoded.partial).toBe(true);
    expect(decoded.senders).toEqual([alice.address]);
    expect(decoded.recipients).toEqual([]);
  });

  it('reads a wallet moving its own balance as its own business', async () => {
    const { data, instruction } = await transfer(alice, alice, alice);
    const decoded = decodeRing(await raw(alice, [instruction], [alice]), [eventOf(data, instruction)], context);
    expect(decoded.kind).toBe('self');
    expect(decoded.recipients).toEqual([]);
    const merge = bare(InstructionTag.mergeTransact, [[alice.address, AccountRole.WRITABLE_SIGNER]]);
    const merged = decodeRing(await raw(alice, [merge], [alice]), [{ tags: [alice.address], nullifiers: 4, proofless: false, ring: null }], context);
    expect(merged.kind).toBe('self');
  });

  it('reads a shield of SOL from the vault’s balance: wallet, token and amount', async () => {
    const deposit = bare(InstructionTag.deposit, [[alice.address, AccountRole.WRITABLE_SIGNER], [SOL_VAULT, AccountRole.WRITABLE]]);
    const tx = await raw(alice, [deposit], [alice], { lamports: [[SOL_VAULT, 1_500_000_000], [alice.address, -1_500_000_000]] });
    const decoded = decodeRing(tx, [{ tags: [alice.address], nullifiers: 0, proofless: true, ring: null }], context);
    expect(decoded.kind).toBe('shield');
    expect(decoded.legs).toEqual([{ mint: WSOL_MINT, amount: '1500000000', dir: 'in' }]);
    expect(decoded.senders).toEqual([alice.address]);
    expect(decoded.recipients).toEqual([]);
    expect(decoded.touched).toEqual([WSOL_MINT]);
  });

  it('reads a shield into somebody else’s private balance as a payment to them', async () => {
    const deposit = bare(InstructionTag.deposit, [[alice.address, AccountRole.WRITABLE_SIGNER], [SOL_VAULT, AccountRole.WRITABLE]]);
    const tx = await raw(alice, [deposit], [alice], { lamports: [[SOL_VAULT, 700], [alice.address, -700]] });
    const decoded = decodeRing(tx, [{ tags: [bob.address], nullifiers: 0, proofless: true, ring: null }], context);
    expect(decoded.kind).toBe('shield');
    expect(decoded.senders).toEqual([alice.address]);
    expect(decoded.recipients).toEqual([bob.address]);
    // The amount is exact even before the indexer has the event; only the receiving side waits.
    const early = decodeRing(tx, null, context);
    expect(early.legs).toEqual([{ mint: WSOL_MINT, amount: '700', dir: 'in' }]);
    expect(early.partial).toBe(true);
  });

  it('reads an unshield of a token, and who it was paid out to', async () => {
    const account = Keypair.generate().publicKey.toBase58() as Address;
    const { instruction } = await transfer(alice, alice, alice, TOKEN);
    const withdraw: Instruction = { ...instruction, accounts: [...(instruction.accounts ?? []), { address: tokenVault, role: AccountRole.WRITABLE }, { address: account, role: AccountRole.WRITABLE }] };
    const tx = await raw(alice, [withdraw], [alice], {
      tokens: [
        { account: tokenVault, mint: TOKEN, owner: 'vault-authority', pre: '900000', post: '400000' },
        { account, mint: TOKEN, owner: bob.address, pre: '0', post: '500000' },
      ],
    });
    const decoded = decodeRing(tx, null, context);
    expect(decoded.kind).toBe('unshield');
    expect(decoded.legs).toEqual([{ mint: TOKEN, amount: '500000', dir: 'out' }]);
    expect(decoded.senders).toEqual([alice.address]);
    expect(decoded.recipients).toEqual([bob.address]);
    expect(decoded.partial).toBe(false);
  });

  it('lists nobody as paid when a wallet unshields to itself', async () => {
    const { instruction } = await transfer(alice, alice, alice);
    const withdraw: Instruction = { ...instruction, accounts: [...(instruction.accounts ?? []), { address: SOL_VAULT, role: AccountRole.WRITABLE }] };
    const tx = await raw(alice, [withdraw], [alice], { lamports: [[SOL_VAULT, -250_000_000], [alice.address, 250_000_000]] });
    const decoded = decodeRing(tx, null, context);
    expect(decoded.kind).toBe('unshield');
    expect(decoded.legs).toEqual([{ mint: WSOL_MINT, amount: '250000000', dir: 'out' }]);
    expect(decoded.recipients).toEqual([]);
  });

  it('reads a trade through a pool: out of one vault, into another, and which venue', async () => {
    const { instruction } = await transfer(alice, alice, alice);
    const withdraw: Instruction = { ...instruction, accounts: [...(instruction.accounts ?? []), { address: SOL_VAULT, role: AccountRole.WRITABLE }] };
    const swap: Instruction = { programAddress: DBC_PROGRAM_ID as Address, accounts: [{ address: alice.address, role: AccountRole.WRITABLE_SIGNER }], data: Uint8Array.of(9) };
    const deposit = bare(InstructionTag.deposit, [[alice.address, AccountRole.WRITABLE_SIGNER], [tokenVault, AccountRole.WRITABLE]]);
    const tx = await raw(alice, [withdraw, swap, deposit], [alice], {
      lamports: [[SOL_VAULT, -1_000_000_000]],
      tokens: [{ account: tokenVault, mint: TOKEN, owner: 'vault-authority', pre: '10', post: '33000010' }],
    });
    const decoded = decodeRing(tx, null, context);
    expect(decoded.kind).toBe('trade');
    expect(decoded.legs).toEqual([
      { mint: WSOL_MINT, amount: '1000000000', dir: 'out' },
      { mint: TOKEN, amount: '33000000', dir: 'in' },
    ]);
    expect(decoded.via).toEqual(['Meteora curve']);
    expect(decoded.senders).toEqual([alice.address]);
    expect(decoded.recipients).toEqual([]);
    expect(decoded.partial).toBe(false);
  });

  it('does not take a token account for a vault because of its mint', async () => {
    const other = Keypair.generate().publicKey.toBase58() as Address;
    const { data, instruction } = await transfer(alice, bob, alice);
    const padded: Instruction = { ...instruction, accounts: [...(instruction.accounts ?? []), { address: other, role: AccountRole.WRITABLE }] };
    const tx = await raw(alice, [padded], [alice], { tokens: [{ account: other, mint: TOKEN, owner: bob.address, pre: '0', post: '777' }] });
    const decoded = decodeRing(tx, [eventOf(data, instruction)], context);
    expect(decoded.kind).toBe('transfer');
    expect(decoded.legs).toEqual([]);
  });

  it('tells a token registration and the protocol’s housekeeping from anybody’s funds moving', async () => {
    const register = bare(InstructionTag.createSplInterface, [[alice.address, AccountRole.WRITABLE_SIGNER]]);
    expect(decodeRing(await raw(alice, [register], [alice]), null, context).kind).toBe('token');
    const upkeep = bare(InstructionTag.batchUpdateNullifierTree, [[relay.address, AccountRole.WRITABLE_SIGNER]]);
    const decoded = decodeRing(await raw(relay, [upkeep], [relay]), null, context);
    expect(decoded.kind).toBe('upkeep');
    expect(decoded.senders).toEqual([]);
    expect(decoded.partial).toBe(false);
  });

  it('does not guess a sender when a relayer paid for an owner who signed inside the proof', async () => {
    // Nobody but the fee payer signs, and neither output is the fee payer's.
    const relayed = bare(InstructionTag.transact, [[relay.address, AccountRole.WRITABLE_SIGNER], [tree, AccountRole.WRITABLE]]);
    const decoded = decodeRing(await raw(relay, [relayed], [relay]), [{ tags: [alice.address, bob.address], nullifiers: 2, proofless: false, ring: null }], context);
    expect(decoded.kind).toBe('transfer');
    expect(decoded.payer).toBe(relay.address);
    expect(decoded.senders).toEqual([]);
    expect([...decoded.recipients].sort()).toEqual([alice.address, bob.address].sort());
  });

  it('does not read the outputs of another ring as wallet addresses', async () => {
    const { instruction } = await transfer(alice, bob, alice);
    const decoded = decodeRing(await raw(alice, [instruction], [alice]), [{ tags: ['3'.repeat(44), '4'.repeat(44)], nullifiers: 1, proofless: false, ring: 'RingProgram1111111111111111111111111111111' }], context);
    expect(decoded.kind).toBe('private');
    expect(decoded.ring).toBe('RingProgram1111111111111111111111111111111');
    expect(decoded.recipients).toEqual([]);
    expect(decoded.partial).toBe(false);
  });

  it('falls back to the whole transaction when events and instructions do not pair up', async () => {
    const first = await transfer(alice, bob, alice);
    const second = await transfer(alice, relay, alice);
    const tx = await raw(alice, [first.instruction, second.instruction], [alice]);
    const decoded = decodeRing(tx, [{ tags: [alice.address, bob.address, relay.address], nullifiers: 2, proofless: false, ring: null }], context);
    expect(decoded.kind).toBe('transfer');
    expect(decoded.senders).toEqual([alice.address]);
    expect([...decoded.recipients].sort()).toEqual([bob.address, relay.address].sort());
  });
});

describe('reading older transaction formats', () => {
  it('finds a Rings instruction that another program called, in a legacy transaction', () => {
    const payer = Keypair.generate();
    const app = Keypair.generate().publicKey;
    const spp = new PublicKey(SPP_PROGRAM_ID);
    const vault = new PublicKey(SOL_VAULT);
    const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: '11111111111111111111111111111111' }).add(
      new TransactionInstruction({
        programId: app,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: spp, isSigner: false, isWritable: false },
          { pubkey: vault, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([1]),
      }),
    );
    transaction.sign(payer);
    const wire = transaction.serialize().toString('base64');
    const keys = readMessage({ slot: 1, transaction: [wire, 'base64'], meta: { err: null, fee: FEE, preBalances: [], postBalances: [] } }).keys;
    const index = (key: PublicKey): number => keys.indexOf(key.toBase58());
    const pre = keys.map(() => 2_000_000_000);
    const post = keys.map((_key, at) => (at === index(vault) ? 2_000_000_000 + 400 : at === 0 ? 2_000_000_000 - 400 - FEE : 2_000_000_000));
    const tx: RawTransaction = {
      slot: 9,
      blockTime: 1_800_000_000,
      transaction: [wire, 'base64'],
      meta: {
        err: null,
        fee: FEE,
        preBalances: pre,
        postBalances: post,
        innerInstructions: [{ index: 0, instructions: [{ programIdIndex: index(spp), accounts: [0, index(vault)], data: bs58.encode(Uint8Array.of(InstructionTag.deposit, 7)) }] }],
      },
    };
    const decoded = decodeRing(tx, [{ tags: [payer.publicKey.toBase58()], nullifiers: 0, proofless: true, ring: null }], context);
    expect(decoded.kind).toBe('shield');
    expect(decoded.legs).toEqual([{ mint: WSOL_MINT, amount: '400', dir: 'in' }]);
    expect(decoded.senders).toEqual([payer.publicKey.toBase58()]);
    expect(decoded.via).toEqual([app.toBase58()]);
  });

  it('counts accounts a version 0 transaction loads from a lookup table', () => {
    const payer = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: PublicKey.default, lamports: 1 })],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([payer]);
    const tx: RawTransaction = {
      slot: 3,
      transaction: [Buffer.from(transaction.serialize()).toString('base64'), 'base64'],
      meta: { err: null, fee: FEE, preBalances: [1, 1, 1], postBalances: [1, 1, 1], loadedAddresses: { writable: [SOL_VAULT], readonly: [] } },
    };
    const read = readMessage(tx);
    expect(read.keys[read.keys.length - 1]).toBe(SOL_VAULT);
    expect(read.payer).toBe(payer.publicKey.toBase58());
    expect(read.signers).toEqual([payer.publicKey.toBase58()]);
    // No Rings instruction in it at all: it is listed as "other" and moves nothing.
    expect(decodeRing(tx, null, context)).toMatchObject({ kind: 'other', legs: [], senders: [] });
  });

  it('refuses what it cannot read instead of producing a row', async () => {
    const good = await raw(alice, [bare(InstructionTag.deposit, [[alice.address, AccountRole.WRITABLE_SIGNER]])], [alice]);
    expect(() => decodeRing({ ...good, transaction: ['not base64 !!', 'base64'] }, null, context)).toThrow(UnreadableTransaction);
    expect(() => decodeRing({ ...good, transaction: ['AAAA', 'base64'] }, null, context)).toThrow(UnreadableTransaction);
    expect(() => decodeRing({ ...good, meta: null }, null, context)).toThrow(UnreadableTransaction);
    expect(() => decodeRing({ ...good, meta: { ...(good.meta as RawMeta), postBalances: [1] } }, null, context)).toThrow(UnreadableTransaction);
    const pointing = { ...good, meta: { ...(good.meta as RawMeta), innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 99, accounts: [0], data: '' }] }] } };
    expect(() => decodeRing(pointing, null, context)).toThrow(UnreadableTransaction);
  });
});

describe('small readers', () => {
  it('read a token account’s amount and a mint’s supply from their bytes, as the token programs lay them out', () => {
    const account = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      { mint: PublicKey.default, owner: PublicKey.default, amount: 123_456_789_012n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default },
      account,
    );
    expect(tokenAccountAmount(new Uint8Array(account))).toBe(123_456_789_012n);
    expect(tokenAccountAmount(new Uint8Array(10))).toBeNull();
    const mint = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 999_999_999_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mint);
    expect(mintFacts(new Uint8Array(mint))).toEqual({ supply: 999_999_999_000_000n, decimals: 6 });
    // Token-2022 puts its extensions after the same first 82 bytes.
    expect(mintFacts(new Uint8Array(Buffer.concat([mint, Buffer.alloc(120, 7)])))).toEqual({ supply: 999_999_999_000_000n, decimals: 6 });
    expect(mintFacts(new Uint8Array(40))).toBeNull();
  });

  it('draw the shielded amount backwards from where it stands and what moved', () => {
    // 100 now. In the last bucket 40 came in; two buckets earlier 10 left.
    expect(trailOf(100n, [0n, -10n, 0n, 40n])).toEqual([0.7, 0.6, 0.6, 1]);
    expect(trailOf(100n, [0n, 0n, 0n])).toEqual([]);
    expect(trailOf(0n, [5n, -5n])).toEqual([1, 0]);
    // A reading that would go below zero (history not all read) is held at zero.
    expect(trailOf(10n, [0n, 50n])).toEqual([0, 1]);
  });

  it('clean a name somebody else wrote before it is kept', () => {
    expect(cleanLabel('  PRV  ', 16)).toBe('PRV');
    expect(cleanLabel('A'.repeat(40), 16)).toBe('A'.repeat(16));
    expect(cleanLabel(`GOOD${String.fromCharCode(0x202e)}EVIL${String.fromCharCode(0)}${String.fromCharCode(0x200b)}`, 16)).toBe('GOODEVIL');
    expect(cleanLabel(undefined, 16)).toBe('');
    expect(cleanLabel(42, 16)).toBe('');
  });

  it('read back only positions they gave out', () => {
    const signature = '5'.repeat(88);
    expect(readCursor(cursorOf({ at: 1_800_000_000_000, signature }))).toEqual({ at: 1_800_000_000_000, signature });
    for (const bad of ['', 'x', '1:', ':abc', '1;DROP TABLE ring_tx', '-1:' + signature, 5, null, undefined]) expect(readCursor(bad)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The indexer against a scripted chain                                */
/* ------------------------------------------------------------------ */

const NOW = 1_800_000_500_000;
const HOUR = 3_600_000;

interface Scripted {
  /** Newest first. */
  list: RingSignature[];
  txs: Map<string, RawTransaction>;
  events: Map<string, RingEvent[]>;
  registry: Array<{ mint: string; assetId: string }>;
  accounts: Map<string, { lamports: bigint; data: Uint8Array }>;
  names: Map<string, { symbol: string; name: string }> | 'throw';
  /** Accounts of the program with the size and type of a custom ring's registration. `throw` makes the scan fail. */
  rings: Array<{ address: string; data: Uint8Array }> | 'throw';
  /** Whether a new ring is active from the moment it registers. `throw` makes that read fail. */
  activationOpen: boolean | 'throw';
  calls: { signatures: number; transaction: number; events: number; registry: number; accounts: number; names: number; wallets: number; rings: number };
}

function scripted(): Scripted {
  return { list: [], txs: new Map(), events: new Map(), registry: [], accounts: new Map(), names: new Map(), rings: [], activationOpen: false, calls: { signatures: 0, transaction: 0, events: 0, registry: 0, accounts: 0, names: 0, wallets: 0, rings: 0 } };
}

function chainOf(script: Scripted): RingChain {
  return {
    solVault: SOL_VAULT,
    async signatures({ before, until, limit }) {
      script.calls.signatures += 1;
      let list = script.list;
      if (before) list = list.slice(list.findIndex((entry) => entry.signature === before) + 1);
      if (until) {
        const stop = list.findIndex((entry) => entry.signature === until);
        if (stop >= 0) list = list.slice(0, stop);
      }
      return list.slice(0, limit);
    },
    async transaction(signature) {
      script.calls.transaction += 1;
      return script.txs.get(signature) ?? null;
    },
    async events(signature) {
      script.calls.events += 1;
      return script.events.get(signature) ?? null;
    },
    async registry() {
      script.calls.registry += 1;
      return script.registry;
    },
    async accounts(addresses) {
      script.calls.accounts += 1;
      return addresses.map((address) => script.accounts.get(address) ?? null);
    },
    async walletCount() {
      script.calls.wallets += 1;
      return 321;
    },
    async ringConfigs() {
      script.calls.rings += 1;
      if (script.rings === 'throw') throw new Error('scan refused');
      return script.rings;
    },
    async ringActivationOpen() {
      if (script.activationOpen === 'throw') throw new Error('settings not served');
      return script.activationOpen;
    },
    async names(mints) {
      script.calls.names += 1;
      if (script.names === 'throw') throw new Error('Method not found');
      const found = new Map<string, { symbol: string; name: string }>();
      for (const mint of mints) {
        const entry = script.names.get(mint);
        if (entry) found.set(mint, entry);
      }
      return found;
    },
    async vaultOf(mint) {
      return String(await getSplAssetVaultAddress(mint as Address));
    },
    async rentFor() {
      return 890_880n;
    },
  };
}

function tokenAccount(amount: bigint): { lamports: bigint; data: Uint8Array } {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { lamports: 2_039_280n, data };
}

function mintAccount(supply: bigint, decimals: number): { lamports: bigint; data: Uint8Array } {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setBigUint64(36, supply, true);
  data[44] = decimals;
  return { lamports: 1_461_600n, data };
}

async function world() {
  const directory = mkdtempSync(join(tmpdir(), 'pcf-rings-'));
  const store = new RingStore(directory);
  const script = scripted();
  const logs: string[] = [];
  let clock = NOW;
  const indexer = new RingIndexer(chainOf(script), store, {
    pollSeconds: 45,
    backfillDays: 30,
    wellKnown: new Map([[WSOL_MINT, { symbol: 'SOL', name: 'Solana' }]]),
    listed: (mints) => new Map(mints.filter((mint) => mint === TOKEN).map((mint) => [mint, { symbol: 'USDC', name: 'Listed here', image: '/ipfs/x' }])),
    log: (message) => logs.push(message),
    now: () => clock,
  });
  let counter = 0;
  /** Puts a transaction at the newest end of the program's history. */
  const land = (tx: RawTransaction, events: RingEvent[] | null, agoMs: number, options: { failed?: boolean; unserved?: boolean } = {}): string => {
    counter += 1;
    const signature = bs58.encode(Uint8Array.from({ length: 64 }, (_value, index) => (index === 0 ? counter : 7)));
    const blockTime = Math.floor((clock - agoMs) / 1000);
    script.list.unshift({ signature, slot: counter, blockTime, failed: options.failed === true });
    if (!options.unserved) script.txs.set(signature, { ...tx, slot: counter, blockTime });
    if (events) script.events.set(signature, events);
    return signature;
  };
  return {
    store,
    script,
    indexer,
    logs,
    land,
    advance: (ms: number) => {
      clock += ms;
    },
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('the Rings indexer', () => {
  it('reads tokens, vaults, transactions and wallets into what the pages are served', async () => {
    const w = await world();
    try {
      w.script.registry = [{ mint: TOKEN, assetId: '2' }];
      w.script.accounts.set(tokenVault, tokenAccount(250_000_000n));
      w.script.accounts.set(TOKEN, mintAccount(1_000_000_000n, 6));
      w.script.accounts.set(SOL_VAULT, { lamports: 5_000_890_880n, data: new Uint8Array(0) });

      const shield = bare(InstructionTag.deposit, [[alice.address, AccountRole.WRITABLE_SIGNER], [tokenVault, AccountRole.WRITABLE]]);
      const shieldTx = await raw(alice, [shield], [alice], { tokens: [{ account: tokenVault, mint: TOKEN, owner: 'vault-authority', pre: '50000000', post: '250000000' }] });
      const shieldSig = w.land(shieldTx, [{ tags: [alice.address], nullifiers: 0, proofless: true, ring: null }], 2 * HOUR);
      const pay = await transfer(alice, bob, alice);
      const paySig = w.land(await raw(alice, [pay.instruction], [alice]), [eventOf(pay.data, pay.instruction)], HOUR);
      w.land(await raw(relay, [bare(InstructionTag.batchUpdateNullifierTree, [[relay.address, AccountRole.WRITABLE_SIGNER]])], [relay]), null, HOUR / 2);
      w.land(shieldTx, null, HOUR / 4, { failed: true });

      await w.indexer.pass();

      const overview = w.indexer.overview();
      expect(overview).toMatchObject({ enabled: true, tokens: 2, wallets: 321, tx24h: 2, shields24h: 1, transfers24h: 1, unshields24h: 0, active24h: 2, solShielded: '5000000000' });
      expect(overview.txAll).toBe(3); // the failed one changed nothing and is not kept

      const page = w.indexer.assetPage({ sort: 'share', page: 1, size: 25 });
      expect(page.total).toBe(2);
      expect(page.assets.map((asset) => asset.symbol)).toEqual(['SOL', 'USDC']);
      const token = w.indexer.asset(TOKEN);
      expect(token).toMatchObject({ shielded: '250000000', supply: '1000000000', decimals: 6, shareBps: 2500, flow24h: '200000000', flow7d: '200000000', moves24h: 1, listed: true, name: 'Listed here', image: '/ipfs/x' });
      // Seven days ago it held 50; the last value is where it stands now.
      expect(token?.trail[0]).toBeCloseTo(0.2, 3);
      expect(token?.trail[token.trail.length - 1]).toBe(1);

      const feed = w.store.feed({ limit: 10 });
      expect(feed.map((row) => row.kind)).toEqual(['transfer', 'shield']); // housekeeping is not in the feed
      expect(feed[0]).toMatchObject({ signature: paySig, senders: [alice.address], recipients: [bob.address], legs: [] });
      expect(w.store.feed({ limit: 10, mint: TOKEN }).map((row) => row.signature)).toEqual([shieldSig]);
      expect(w.store.feed({ limit: 10, kind: 'upkeep' })).toHaveLength(1);
      expect(w.store.feed({ limit: 10, kind: 'transfer' }).map((row) => row.kind)).toEqual(['transfer']);
      expect(w.store.feed({ limit: 10, kind: 'shield' }).map((row) => row.kind)).toEqual(['shield']);

      const summary = w.store.addressSummary(alice.address);
      expect(summary.counts).toEqual({ shields: 1, unshields: 0, trades: 0, sent: 1, received: 0, own: 0 });
      expect(summary.counterparties).toEqual([{ address: bob.address, sent: 1, received: 0, last: feed[0]?.at }]);
      expect(w.store.addressSummary(bob.address).counts).toMatchObject({ received: 1, sent: 0 });
      expect(w.store.addressRows(relay.address, 10)).toEqual([]); // housekeeping is no wallet's activity
      expect(w.store.movers(TOKEN)).toEqual({ shielders: 1, unshielders: 0 });

      // The public transactions needed no call to the indexer; the private one did.
      expect(w.script.calls.events).toBe(2);
    } finally {
      w.close();
    }
  });

  it('reads only what is new on a later pass, in order, and re-reads a vault a transaction touched', async () => {
    const w = await world();
    try {
      w.script.registry = [{ mint: TOKEN, assetId: '2' }];
      w.script.accounts.set(tokenVault, tokenAccount(10n));
      w.script.accounts.set(TOKEN, mintAccount(1_000n, 0));
      const first = await transfer(alice, bob, alice);
      w.land(await raw(alice, [first.instruction], [alice]), [eventOf(first.data, first.instruction)], HOUR);
      await w.indexer.pass();
      const before = { ...w.script.calls };

      await w.indexer.pass();
      expect(w.script.calls.transaction).toBe(before.transaction); // nothing new, nothing fetched
      expect(w.script.calls.registry).toBe(before.registry); // the registry is read every ten minutes, not every pass

      w.advance(60_000);
      const unshield = bare(InstructionTag.transact, [[bob.address, AccountRole.WRITABLE_SIGNER], [tokenVault, AccountRole.WRITABLE]]);
      w.land(await raw(bob, [unshield], [bob], { tokens: [{ account: tokenVault, mint: TOKEN, owner: 'vault-authority', pre: '10', post: '4' }] }), null, 1_000);
      w.script.accounts.set(tokenVault, tokenAccount(4n));
      await w.indexer.pass();
      expect(w.script.calls.transaction).toBe(before.transaction + 1);
      expect(w.indexer.asset(TOKEN)).toMatchObject({ shielded: '4', flow24h: '-6', shareBps: 40 });
      expect(w.store.feed({ limit: 5 }).map((row) => row.kind)).toEqual(['unshield', 'transfer']);
    } finally {
      w.close();
    }
  });

  it('fills in who was paid once the indexer has caught up with a transfer', async () => {
    const w = await world();
    try {
      const pay = await transfer(alice, bob, alice);
      const signature = w.land(await raw(alice, [pay.instruction], [alice]), null, HOUR);
      await w.indexer.pass();
      expect(w.store.feed({ limit: 5 })[0]).toMatchObject({ kind: 'private', senders: [alice.address], recipients: [] });
      // A reader who asks for transfers sees it already, before the receiving side has been read.
      expect(w.store.feed({ limit: 5, kind: 'transfer' })).toHaveLength(1);
      expect(w.store.addressRows(bob.address, 5)).toEqual([]);

      w.script.events.set(signature, [eventOf(pay.data, pay.instruction)]);
      await w.indexer.pass();
      expect(w.store.feed({ limit: 5 })[0]).toMatchObject({ kind: 'transfer', recipients: [bob.address] });
      expect(w.store.addressRows(bob.address, 5)).toHaveLength(1);
      expect(w.store.count()).toBe(1);
    } finally {
      w.close();
    }
  });

  it('gives up asking for the receiving side after a few passes', async () => {
    const w = await world();
    try {
      const pay = await transfer(alice, bob, alice);
      w.land(await raw(alice, [pay.instruction], [alice]), null, HOUR);
      for (let pass = 0; pass < 12; pass += 1) await w.indexer.pass();
      expect(w.script.calls.events).toBeLessThanOrEqual(7);
      expect(w.store.feed({ limit: 5 })[0]?.kind).toBe('private');
    } finally {
      w.close();
    }
  });

  it('waits, in order, for a transaction the RPC lists and cannot serve yet, then moves past it', async () => {
    const w = await world();
    try {
      const pay = await transfer(alice, bob, alice);
      const tx = await raw(alice, [pay.instruction], [alice]);
      w.land(tx, [eventOf(pay.data, pay.instruction)], 3 * HOUR);
      await w.indexer.pass();
      const stuck = w.land(tx, null, 2 * HOUR, { unserved: true });
      const after = w.land(tx, [eventOf(pay.data, pay.instruction)], HOUR);
      await w.indexer.pass();
      expect(w.store.has(after)).toBe(false); // nothing is read past a gap
      w.script.txs.set(stuck, { ...tx, slot: 2, blockTime: 1 });
      await w.indexer.pass();
      expect(w.store.has(stuck)).toBe(true);
      expect(w.store.has(after)).toBe(true);

      const never = w.land(tx, null, 1_000, { unserved: true });
      const later = w.land(tx, [eventOf(pay.data, pay.instruction)], 500);
      for (let pass = 0; pass < 6; pass += 1) await w.indexer.pass();
      expect(w.store.has(never)).toBe(false);
      expect(w.store.has(later)).toBe(true);
      expect(w.logs.some((line) => line.includes('passed over'))).toBe(true);
    } finally {
      w.close();
    }
  });

  it('reads history back a batch at a time, and stops where it was told to', async () => {
    const w = await world();
    try {
      const pay = await transfer(alice, bob, alice);
      const tx = await raw(alice, [pay.instruction], [alice]);
      const event = [eventOf(pay.data, pay.instruction)];
      const DAY = 24 * HOUR;
      // 300 transactions three hours apart: the newest a day old, the oldest 38 days and nine hours.
      for (let index = 299; index >= 0; index -= 1) w.land(tx, event, DAY + index * 3 * HOUR);
      await w.indexer.pass();
      expect(w.store.count()).toBe(100 + 60); // the newest hundred, and the first batch of history
      expect(w.indexer.overview().complete).toBe(false);
      await w.indexer.pass();
      expect(w.store.count()).toBe(100 + 120);
      expect(w.indexer.overview().complete).toBe(false);
      await w.indexer.pass();
      expect(w.indexer.overview().complete).toBe(true);
      // A day plus three hours times k is within 30 days for k up to 232.
      expect(w.store.count()).toBe(233);
      expect(w.logs.some((line) => line.includes('30 day(s)'))).toBe(true);
      const span = w.store.span();
      // Told to read back 30 days: nothing older than that was kept, and everything newer was.
      expect(span.since).not.toBeNull();
      expect(NOW - (span.since as number)).toBeLessThanOrEqual(30 * DAY);
      expect(NOW - (span.since as number)).toBeGreaterThan(29 * DAY);
      const calls = w.script.calls.transaction;
      await w.indexer.pass();
      expect(w.script.calls.transaction).toBe(calls); // history is read once
    } finally {
      w.close();
    }
  });

  it('names tokens from this site, from fixed knowledge, then from the RPC, and lives without names', async () => {
    const w = await world();
    try {
      const outside = Keypair.generate().publicKey.toBase58();
      const nameless = Keypair.generate().publicKey.toBase58();
      w.script.registry = [{ mint: TOKEN, assetId: '2' }, { mint: outside, assetId: '3' }, { mint: nameless, assetId: '4' }];
      w.script.names = new Map([[outside, { symbol: ` RING${String.fromCharCode(0x202e)}S `, name: 'x'.repeat(200) }]]);
      await w.indexer.pass();
      expect(w.indexer.asset(WSOL_MINT)).toMatchObject({ symbol: 'SOL', listed: false });
      expect(w.indexer.asset(TOKEN)).toMatchObject({ symbol: 'USDC', listed: true });
      expect(w.indexer.asset(outside)).toMatchObject({ symbol: 'RINGS', listed: false });
      expect(w.indexer.asset(outside)?.name).toHaveLength(48);
      expect(w.indexer.asset(nameless)).toMatchObject({ symbol: '', name: '' });
      const asked = w.script.calls.names;
      await w.indexer.pass();
      expect(w.script.calls.names).toBe(asked); // a token is asked about once

      const second = await world();
      try {
        second.script.registry = [{ mint: outside, assetId: '3' }];
        second.script.names = 'throw';
        await second.indexer.pass();
        await second.indexer.pass();
        expect(second.script.calls.names).toBe(1);
        expect(second.indexer.asset(outside)).toMatchObject({ symbol: '' });
        expect(second.logs.some((line) => line.includes('shown by address'))).toBe(true);
      } finally {
        second.close();
      }
    } finally {
      w.close();
    }
  });

  it('keeps going when a part of a pass fails, and says so once', async () => {
    const w = await world();
    try {
      const chain = chainOf(w.script);
      let broken = true;
      const flaky: RingChain = {
        ...chain,
        async registry() {
          if (broken) throw new Error('rpc: 503');
          return chain.registry();
        },
      };
      const directory = mkdtempSync(join(tmpdir(), 'pcf-rings-'));
      const store = new RingStore(directory);
      const logs: string[] = [];
      try {
        const indexer = new RingIndexer(flaky, store, { pollSeconds: 45, backfillDays: 1, wellKnown: new Map(), listed: () => new Map(), log: (message) => logs.push(message), now: () => NOW });
        const pay = await transfer(alice, bob, alice);
        w.land(await raw(alice, [pay.instruction], [alice]), [eventOf(pay.data, pay.instruction)], HOUR);
        await indexer.pass();
        await indexer.pass();
        expect(store.count()).toBe(1); // transactions were read although the registry could not be
        expect(logs.filter((line) => line.includes('token registry'))).toHaveLength(1);
        broken = false;
        w.script.registry = [{ mint: TOKEN, assetId: '2' }];
        await indexer.pass();
        expect(indexer.overview().tokens).toBe(2);
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    } finally {
      w.close();
    }
  });

  it('orders the screener with tokens nobody holds privately last, and finds a token by name or address', async () => {
    const w = await world();
    try {
      const mints = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
      w.script.registry = mints.map((mint, index) => ({ mint, assetId: String(index + 2) }));
      w.script.names = new Map(mints.map((mint, index) => [mint, { symbol: `T${index}`, name: `Token ${index}` }]));
      w.script.accounts.set(SOL_VAULT, { lamports: 1_000_000_000n, data: new Uint8Array(0) });
      const held = [0n, 500n, 20n, 0n];
      for (const [index, mint] of mints.entries()) {
        w.script.accounts.set(String(await getSplAssetVaultAddress(mint as Address)), tokenAccount(held[index] ?? 0n));
        w.script.accounts.set(mint, mintAccount(1_000n, 0));
      }
      await w.indexer.pass();
      const symbols = (sort: 'share' | 'shielded' | 'new'): string[] => w.indexer.assetPage({ sort, page: 1, size: 25 }).assets.map((asset) => asset.symbol);
      expect(symbols('share').slice(0, 3)).toEqual(['SOL', 'T1', 'T2']);
      expect(symbols('share').slice(3).sort()).toEqual(['T0', 'T3']);
      expect(w.indexer.assetPage({ sort: 'share', page: 1, size: 25, held: true }).total).toBe(3); // SOL and the two held tokens
      expect(w.indexer.assetPage({ sort: 'share', page: 1, size: 25, query: 'token 2' }).assets.map((asset) => asset.symbol)).toEqual(['T2']);
      expect(w.indexer.assetPage({ sort: 'share', page: 1, size: 25, query: (mints[3] as string).slice(0, 12) }).assets.map((asset) => asset.symbol)).toEqual(['T3']);
      expect(w.indexer.assetPage({ sort: 'share', page: 2, size: 2 }).assets).toHaveLength(2);
      expect(w.indexer.assetPage({ sort: 'share', page: 9, size: 2 }).assets).toEqual([]);
    } finally {
      w.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* The register of custom rings                                        */
/* ------------------------------------------------------------------ */

/** A ring's registration account, as the program lays it out: type, authority, program, three switches, bump. */
async function ringAccount(
  program: string,
  flags: { activated?: boolean; paused?: boolean; rail?: boolean; authority?: string } = {},
): Promise<{ address: string; data: Uint8Array }> {
  const { address, bump } = await ringConfigAddress(program);
  const data = new Uint8Array(RING_CONFIG_SCAN.dataSize);
  data[0] = RING_CONFIG_SCAN.type;
  data.set(bs58.decode(flags.authority ?? Keypair.generate().publicKey.toBase58()), 1);
  data.set(bs58.decode(program), 33);
  data[65] = flags.rail ? 1 : 0;
  data[66] = flags.paused ? 1 : 0;
  data[67] = flags.activated ? 1 : 0;
  data[68] = bump;
  return { address, data };
}

describe('the register of custom rings', () => {
  it('lists every ring that checks out, usable ones first, and says how new rings start out', async () => {
    const w = await world();
    try {
      const [waiting, active, paused] = [0, 1, 2].map(() => Keypair.generate().publicKey.toBase58()) as [string, string, string];
      expect(w.indexer.customRings()).toEqual({ enabled: true, readAt: null, activation: null, rings: [] });
      w.script.rings = [
        await ringAccount(waiting),
        await ringAccount(active, { activated: true, rail: true, authority: NO_AUTHORITY }),
        await ringAccount(paused, { activated: true, paused: true }),
      ];
      await w.indexer.pass();
      const view = w.indexer.customRings();
      expect(view.activation).toBe('governance');
      expect(view.readAt).toBe(NOW);
      expect(view.rings.map((ring) => ring.program)).toEqual([active, paused, waiting]);
      expect(view.rings[0]).toMatchObject({ activated: true, paused: false, authorityRail: true, authority: '', moves: 0, firstSeen: NOW });
      expect(view.rings[0]?.config).toBe((await ringConfigAddress(active)).address);
      expect(view.rings[2]).toMatchObject({ activated: false, paused: false, authorityRail: false });
      expect(w.logs.filter((line) => line.includes('custom ring'))).toEqual([]); // the first read announces nothing
    } finally {
      w.close();
    }
  });

  it('leaves out an account that only looks like a registration, and says so once', async () => {
    const w = await world();
    try {
      const real = Keypair.generate().publicKey.toBase58();
      const good = await ringAccount(real, { activated: true });
      // The right size and type, at an address its own contents do not call for.
      const stray = { address: Keypair.generate().publicKey.toBase58(), data: good.data };
      // The right address, with a bump that is not the one the address was made with.
      const forged = await ringAccount(Keypair.generate().publicKey.toBase58());
      forged.data[68] = (forged.data[68] ?? 0) === 255 ? 254 : (forged.data[68] ?? 0) + 1;
      w.script.rings = [stray, good, forged];
      await w.indexer.pass();
      expect(w.indexer.customRings().rings.map((ring) => ring.program)).toEqual([real]);
      expect(w.logs.filter((line) => line.includes('do not check out'))).toHaveLength(1);
    } finally {
      w.close();
    }
  });

  it('reads the register every fifteen minutes, and at once when a transaction changes a registration', async () => {
    const w = await world();
    try {
      const first = Keypair.generate().publicKey.toBase58();
      w.script.rings = [await ringAccount(first)];
      await w.indexer.pass();
      expect(w.script.calls.rings).toBe(1);
      w.advance(60_000);
      await w.indexer.pass();
      expect(w.script.calls.rings).toBe(1);

      // Governance activates it: the transaction carries the instruction, and the register is read again on that pass.
      w.script.rings = [await ringAccount(first, { activated: true })];
      w.script.activationOpen = true;
      w.land(await raw(relay, [bare(InstructionTag.setRingActivation, [[relay.address, AccountRole.WRITABLE_SIGNER]])], [relay]), null, 1_000);
      w.advance(60_000);
      await w.indexer.pass();
      expect(w.script.calls.rings).toBe(2);
      let view = w.indexer.customRings();
      expect(view.rings[0]).toMatchObject({ program: first, activated: true, firstSeen: NOW }); // first seen is kept
      expect(view.activation).toBe('open');

      // A second ring registers: it is announced, and the first keeps its place.
      const second = Keypair.generate().publicKey.toBase58();
      w.script.rings = [await ringAccount(second), await ringAccount(first, { activated: true })];
      w.land(await raw(relay, [bare(InstructionTag.createRingConfig, [[relay.address, AccountRole.WRITABLE_SIGNER]])], [relay]), null, 1_000);
      w.advance(60_000);
      await w.indexer.pass();
      view = w.indexer.customRings();
      expect(view.rings.map((ring) => ring.program)).toEqual([first, second]);
      expect(view.rings[1]?.firstSeen).toBe(NOW + 180_000);
      expect(w.logs.filter((line) => line.includes(`a custom ring was registered: program ${second}`))).toHaveLength(1);

      w.advance(16 * 60_000);
      await w.indexer.pass();
      expect(w.script.calls.rings).toBe(4);
    } finally {
      w.close();
    }
  });

  it('keeps the last register when the scan fails, and the last known setting when only that read fails', async () => {
    const w = await world();
    try {
      const program = Keypair.generate().publicKey.toBase58();
      w.script.rings = [await ringAccount(program, { activated: true })];
      w.script.activationOpen = true;
      await w.indexer.pass();
      expect(w.indexer.customRings()).toMatchObject({ activation: 'open', readAt: NOW });

      w.advance(16 * 60_000);
      w.script.activationOpen = 'throw';
      await w.indexer.pass();
      expect(w.indexer.customRings()).toMatchObject({ activation: 'open', readAt: NOW + 16 * 60_000 });
      expect(w.indexer.customRings().rings).toHaveLength(1);

      w.advance(16 * 60_000);
      w.script.rings = 'throw';
      await w.indexer.pass();
      const view = w.indexer.customRings();
      expect(view.readAt).toBe(NOW + 16 * 60_000); // not read this time: the date says so
      expect(view.rings.map((ring) => ring.program)).toEqual([program]);
      expect(w.logs.filter((line) => line.includes('register of custom rings did not finish'))).toHaveLength(1);
    } finally {
      w.close();
    }
  });

  it('counts the transactions it has read of each ring', async () => {
    const w = await world();
    try {
      const program = Keypair.generate().publicKey.toBase58();
      w.script.rings = [await ringAccount(program, { activated: true })];
      const move = bare(InstructionTag.ringTransact, [[alice.address, AccountRole.WRITABLE_SIGNER]]);
      w.land(await raw(alice, [move], [alice]), [{ tags: [], nullifiers: 1, proofless: false, ring: program }], 2_000);
      w.land(await raw(alice, [move], [alice]), [{ tags: [], nullifiers: 1, proofless: false, ring: program }], 1_000);
      // The indexer may name the ring by its registration instead of its program: it is the same ring.
      const config = (await ringConfigAddress(program)).address;
      w.land(await raw(alice, [move], [alice]), [{ tags: [], nullifiers: 1, proofless: false, ring: config }], 500);
      // A transaction of some other ring is not counted for this one.
      w.land(await raw(alice, [move], [alice]), [{ tags: [], nullifiers: 1, proofless: false, ring: Keypair.generate().publicKey.toBase58() }], 400);
      await w.indexer.pass();
      expect(w.indexer.customRings().rings[0]).toMatchObject({ program, moves: 3 });
    } finally {
      w.close();
    }
  });
});

