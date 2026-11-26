import { createHmac, createPrivateKey, sign as signEd25519 } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ShieldedKeypair, SigningKey } from '@heliuslabs/spr';
import { type Address, address } from '@solana/kit';
import { Keypair, PublicKey, SystemInstruction, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';

import { GAS_RESERVE_LAMPORTS, TX_V1_MAX_BYTES } from '../shared/src/constants.js';
import type { RingsContext } from '../shared/src/privacy.js';
import { decompileMessage, legacyInstructionFields, messageBytesOf, priorityFeeFor } from '../shared/src/tx.js';
import {
  type ActivityEntry,
  CLOSE_BATCH,
  CREATOR_MESSAGE,
  GHOST_TRADE_VISIBILITY,
  MAX_VAULTS,
  SIGNATURE_FEE_LAMPORTS,
  SPREAD_VISIBILITY,
  SYSTEM_RENT_EXEMPT_LAMPORTS,
  TRADE_VISIBILITY,
  VAULT_COMPUTE_UNITS,
  type VaultSetFacts,
  chooseVaultSet,
  otherVaultSet,
  VAULT_GAS_DEFAULT_LAMPORTS,
  VaultError,
  activityTotals,
  addressOfSeed,
  appendActivity,
  buildCloseAccounts,
  buildGasFunding,
  buildMoveToken,
  buildSweep,
  closeInstructions,
  creatorRefused,
  gasInstructions,
  gasTopUps,
  hasGas,
  moveTokenInstructions,
  parseActivity,
  recallVisibility,
  rootFromSeed,
  rootFromSignature,
  shareOf,
  splitEvenly,
  sweepAmount,
  vaultAddresses,
  vaultKeyMessage,
  vaultSeed,
} from '../shared/src/vaults.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const SEED = Uint8Array.from({ length: 32 }, (_unused, index) => index + 1);
const SIGNATURE = Uint8Array.from({ length: 64 }, (_unused, index) => 255 - index);
const OWNER = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';

/**
 * These addresses are where real money sits. If this list ever has to change
 * for a test to pass, the change being tested has moved every vault that
 * exists and must not ship.
 */
const VAULTS = [
  'AYwo912QH6eAEoc5ZYuQbf67kLVgU5vy61XaVfL3xJ1K',
  'GupRqE6n9ucF1hFJdvJpuziF7ERLpp5ubJkGJnLZ9adb',
  'HvSvKb6Fx17y6CbEEG2jwkjz4oSxDi5G9PSEwWKCxiZp',
  '8v1XuycoaQocFanoe6iuo23ou78s6Z5MAnb3xbf1yHmH',
  '5cJnZo1meUqnXdHXrPSjwMdoS4Rxu1Jp3Bh9ZRAEGeYe',
  'DKkCh9o6ZgiB8HJ75UERsY6xMvkKMi6fmgSip4cWnyjB',
  '3F99dQ6Tj8K8uoDCKCZSRXYkfZ5yhQJNtzEknfuxy7hR',
  'tnsjMXJkCv9s2UXuePnvjEaE4pZVoPkJgvF8hi3Ghsq',
  'HrkVNFuNEndZ9fyk1ydzDGUeicvuiiXmdePjPULaELES',
  'FyQ1ibwWLxmFP367dDsMcgM6nq29HECJ7SpjtiM5FgU1',
];

describe('vault keys', () => {
  it('lead to the same ten addresses, for good', async () => {
    expect(Keypair.fromSeed(SEED).publicKey.toBase58()).toBe(OWNER);
    const root = await rootFromSeed(SEED);
    expect(hex(root)).toBe('49a1c24e22165c79da5c6009a9a4886319a43b3be6a33fffed7612ea1008684d');
    expect(hex(await vaultSeed(root, 1))).toBe('3cbf7ea8f9c688cf990d03c7d7eef4af982c31dbdf41905d2c731818e473c61e');
    expect(await vaultAddresses(root)).toEqual(VAULTS);
    expect(VAULTS).toHaveLength(MAX_VAULTS);
    expect(new Set([...VAULTS, OWNER]).size).toBe(MAX_VAULTS + 1);
  });

  it('are plain HMAC-SHA256 under labels written out here a second time', async () => {
    const root = createHmac('sha256', Buffer.from(SEED)).update('privacycash.fun/prvmax/v1/root').digest();
    expect(hex(await rootFromSeed(SEED))).toBe(root.toString('hex'));
    for (const index of [1, 2, 10]) {
      expect(hex(await vaultSeed(new Uint8Array(root), index))).toBe(createHmac('sha256', root).update(`vault/${index}`).digest('hex'));
    }
    const fromSignature = createHmac('sha256', Buffer.from(SIGNATURE)).update('privacycash.fun/prvmax/v1/root').digest('hex');
    expect(hex(await rootFromSignature(SIGNATURE))).toBe(fromSignature);
    expect(fromSignature).toBe('783755e5b72126ce7b135c1795b257b03dcb762e2dbff364f89ba3b1a7f14bdd');
    expect((await vaultAddresses(await rootFromSignature(SIGNATURE))).slice(0, 2)).toEqual(['6GFRTW72jxDM6U1kQt8wUvGtro8u8JsvQkchQF9qMRfe', 'GtHMPEzuzSMRvpvdEqpnFnim1YxYE4J5VWjiWz4ZcX2r']);
  });

  it('give the address the Rings SDK signs with, so a vault is the wallet its key says it is', async () => {
    const root = await rootFromSeed(SEED);
    for (let index = 1; index <= MAX_VAULTS; index += 1) {
      const seed = await vaultSeed(root, index);
      const signer = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never)).toSolanaSigner();
      expect(signer.address).toBe(addressOfSeed(seed));
      expect(signer.address).toBe(VAULTS[index - 1]);
    }
  });

  it('ask a wallet to sign exactly this text', () => {
    expect(new TextDecoder().decode(vaultKeyMessage(OWNER))).toBe(
      'privacycash.fun prvmax, version 1\n\nSigning this creates the keys of the prvmax vaults of\n9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj\n\nOnly sign it on privacycash.fun. Whoever holds this signature can spend what those vaults hold.',
    );
    // Another wallet signs another message, so one wallet's signature never opens another's vaults.
    expect(hex(vaultKeyMessage(VAULTS[0] as string))).not.toBe(hex(vaultKeyMessage(OWNER)));
  });

  it('refuse a seed, a signature, a root or a number that is not one', async () => {
    await expect(async () => rootFromSeed(new Uint8Array(31))).rejects.toThrow(VaultError);
    await expect(async () => rootFromSignature(new Uint8Array(32))).rejects.toThrow(VaultError);
    const root = await rootFromSeed(SEED);
    for (const index of [0, 11, -1, 1.5, Number.NaN]) await expect(async () => vaultSeed(root, index)).rejects.toThrow(/numbered 1 to 10/);
    await expect(async () => vaultSeed(new Uint8Array(16), 1)).rejects.toThrow(VaultError);
  });
});

/**
 * The standard set of the test wallet: the vaults its signature over the vault
 * message leads to, whoever makes that signature. Like the list above, these
 * are where money sits, and they must never change.
 */
const STANDARD = [
  '4zco1MEMuXpKP8Cuw81RorWBto3LQMNCWPditQAfnTBK',
  '9MngqWRpGUzvLQBnvK2vAFHb3yxPWTihWGMT7eTbR3zg',
  '6MLiSKLGRAQbaJ8m4jZ5aD4aus2vSRjGnXwsj6XGSjdN',
  'KWL7AK7rCN7ZG6oy8FFZ1qmpzw6BjBMfCXAZ6aGLvuq',
  'GcLsN5m5EdsGjwgkC4WvzvDKTTNvhSCeeLPUwzWNrubB',
  'E7EpJLicRnERYqUSsHUnfQcTjm8ppyDyT9ttyoYxWm5T',
  'CDdmdpLnUuRyXjg9Rx3p7GRF1hLpxsk6PEqWvHoq4uWp',
  '677EWSoH5xu2amHwkH1W7RV7RdxjS1o6LwUwP1FATTW7',
  'HnuYHp2sLZ7BEbuXNqyFeCycy3JY3xznphyhK6tLQ7mu',
  'J1zRkV3BSLR1mMeHKKWc3kAcrVyULHFdiR7PiNAmuXcy',
];

describe('one key, two sets of vaults', () => {
  /** What a wallet extension holding the key returns for signMessage: the RFC 8032 signature, here from Node's own Ed25519. */
  const asAnExtensionSigns = (message: Uint8Array): Uint8Array => {
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SEED)]), format: 'der', type: 'pkcs8' });
    return new Uint8Array(signEd25519(null, message, key));
  };
  /** What the ghost wallet does with the same key: the Rings SDK's signer, as `signWithSeed` uses it. */
  const asTheGhostWalletSigns = (message: Uint8Array): Uint8Array => new Uint8Array(SigningKey.fromEd25519Bytes(new Uint8Array(SEED) as never).sign(message));

  it('a ghost wallet signs the vault message exactly as an extension holding its key does', () => {
    const message = vaultKeyMessage(OWNER);
    expect(hex(asTheGhostWalletSigns(message))).toBe(hex(asAnExtensionSigns(message)));
    expect(hex(asTheGhostWalletSigns(message))).toBe(
      '44ec3d81a790eb26fdc4344c1a3faca3a20fa5f2392adf3433efccbb693ffb10d132c7969d94ed3e9a10399b3da86662c616f2d9b630e7f75db8b8d9a6a59306',
    );
    // Signing twice gives the same bytes: nothing random goes into it.
    expect(hex(asTheGhostWalletSigns(message))).toBe(hex(asTheGhostWalletSigns(message)));
  });

  it('so both arrive at the same standard set, at fixed addresses', async () => {
    const viaExtension = await vaultAddresses(await rootFromSignature(asAnExtensionSigns(vaultKeyMessage(OWNER))));
    const viaGhostWallet = await vaultAddresses(await rootFromSignature(asTheGhostWalletSigns(vaultKeyMessage(OWNER))));
    expect(viaExtension).toEqual(STANDARD);
    expect(viaGhostWallet).toEqual(STANDARD);
  });

  it('and the ghost-only set is another ten addresses altogether', async () => {
    const ghostOnly = await vaultAddresses(await rootFromSeed(SEED));
    expect(ghostOnly).toEqual(VAULTS);
    expect(new Set([...ghostOnly, ...STANDARD]).size).toBe(20);
    // Neither set contains the wallet itself.
    expect([...ghostOnly, ...STANDARD]).not.toContain(OWNER);
  });

  const first = { seed: VAULTS[0] as string, signature: STANDARD[0] as string };
  const facts = (more: Partial<VaultSetFacts>): VaultSetFacts => ({ first, ...more });
  const used = (seed: boolean | null, signature: boolean | null) => ({ seed, signature });

  it('shows the set that has been used, whatever this browser showed before', () => {
    // The case this exists for: vaults filled through an extension, the same key then opened as a ghost wallet
    // in a browser that had already shown, and recorded, the empty ghost-only set.
    expect(chooseVaultSet(facts({ recorded: { check: first.seed, pinned: false }, used: used(false, true) }))).toEqual({ set: 'signature', reason: 'only-used', certain: true, otherUsed: false });
    expect(chooseVaultSet(facts({ used: used(false, true) }))).toMatchObject({ set: 'signature', reason: 'only-used', certain: true });
    // And the other way round: a ghost wallet whose own set holds something keeps it, on any browser.
    expect(chooseVaultSet(facts({ used: used(true, false) }))).toEqual({ set: 'seed', reason: 'only-used', certain: true, otherUsed: false });
    expect(chooseVaultSet(facts({ recorded: { check: first.signature, pinned: false }, used: used(true, false) }))).toMatchObject({ set: 'seed', reason: 'only-used' });
  });

  it('starts a wallet that has used neither on the standard set, and leaves a recorded one where it was', () => {
    expect(chooseVaultSet(facts({ used: used(false, false) }))).toEqual({ set: 'signature', reason: 'new', certain: true, otherUsed: false });
    expect(chooseVaultSet(facts({ recorded: { check: first.seed, pinned: false }, used: used(false, false) }))).toEqual({ set: 'seed', reason: 'recorded', certain: true, otherUsed: false });
    expect(chooseVaultSet(facts({ recorded: { check: first.signature, pinned: false }, used: used(false, false) }))).toMatchObject({ set: 'signature', reason: 'recorded' });
  });

  it('when both have been used, keeps the recorded one and says that the other exists', () => {
    expect(chooseVaultSet(facts({ recorded: { check: first.signature, pinned: false }, used: used(true, true) }))).toEqual({ set: 'signature', reason: 'recorded', certain: true, otherUsed: true });
    expect(chooseVaultSet(facts({ recorded: { check: first.seed, pinned: false }, used: used(true, true) }))).toEqual({ set: 'seed', reason: 'recorded', certain: true, otherUsed: true });
    // Nothing on record: the set every earlier version showed a ghost wallet.
    expect(chooseVaultSet(facts({ used: used(true, true) }))).toEqual({ set: 'seed', reason: 'legacy', certain: true, otherUsed: true });
  });

  it('never takes silence from the chain for "nothing there"', () => {
    for (const answer of [used(null, null), used(null, true), used(true, null), used(false, null), used(null, false), null, undefined]) {
      // Nothing on record: what every earlier version showed, and not put on record.
      expect(chooseVaultSet(facts({ used: answer }))).toMatchObject({ set: 'seed', reason: 'legacy', certain: false });
      // Something on record: that, unchanged.
      expect(chooseVaultSet(facts({ recorded: { check: first.signature, pinned: false }, used: answer }))).toMatchObject({ set: 'signature', reason: 'recorded', certain: false });
      expect(chooseVaultSet(facts({ recorded: { check: first.seed, pinned: false }, used: answer }))).toMatchObject({ set: 'seed', reason: 'recorded', certain: false });
    }
    // What is known of the other set is still passed on.
    expect(chooseVaultSet(facts({ used: used(null, true) })).otherUsed).toBe(true);
  });

  it('does what the person asks, and keeps a set they chose themselves', () => {
    for (const answer of [used(true, false), used(false, true), used(true, true), used(false, false), used(null, null)]) {
      expect(chooseVaultSet(facts({ asked: 'seed', used: answer, recorded: { check: first.signature, pinned: true } }))).toMatchObject({ set: 'seed', reason: 'asked', certain: true });
      expect(chooseVaultSet(facts({ asked: 'signature', used: answer }))).toMatchObject({ set: 'signature', reason: 'asked', certain: true });
      expect(chooseVaultSet(facts({ recorded: { check: first.seed, pinned: true }, used: answer }))).toMatchObject({ set: 'seed', reason: 'pinned', certain: true });
      expect(chooseVaultSet(facts({ recorded: { check: first.signature, pinned: true }, used: answer }))).toMatchObject({ set: 'signature', reason: 'pinned', certain: true });
    }
    // The page still learns that the set not shown holds something.
    expect(chooseVaultSet(facts({ recorded: { check: first.seed, pinned: true }, used: used(false, true) })).otherUsed).toBe(true);
  });

  it('ignores a record that belongs to neither set', () => {
    const stray = { check: 'So11111111111111111111111111111111111111112', pinned: true };
    expect(chooseVaultSet(facts({ recorded: stray, used: used(false, true) }))).toMatchObject({ set: 'signature', reason: 'only-used' });
    expect(chooseVaultSet(facts({ recorded: stray, used: used(false, false) }))).toMatchObject({ set: 'signature', reason: 'new' });
    expect(chooseVaultSet(facts({ recorded: stray, used: used(null, null) }))).toMatchObject({ set: 'seed', reason: 'legacy', certain: false });
  });

  it('names the other set', () => {
    expect(otherVaultSet('seed')).toBe('signature');
    expect(otherVaultSet('signature')).toBe('seed');
  });
});

describe('vault amounts', () => {
  it('split a total into shares that add up to it exactly', () => {
    expect(splitEvenly(10_000_000_000n, 10)).toEqual(Array.from({ length: 10 }, () => 1_000_000_000n));
    const uneven = splitEvenly(1_000_000_007n, 10);
    expect(uneven.reduce((sum, share) => sum + share, 0n)).toBe(1_000_000_007n);
    expect(uneven.slice(0, 7)).toEqual(Array.from({ length: 7 }, () => 100_000_001n));
    expect(uneven.slice(7)).toEqual(Array.from({ length: 3 }, () => 100_000_000n));
    expect(splitEvenly(5n, 1)).toEqual([5n]);
    expect(() => splitEvenly(5n, 10)).toThrow(/too small/);
    expect(() => splitEvenly(0n, 2)).toThrow(/greater than zero/);
    expect(() => splitEvenly(10n, 0)).toThrow(/at least one vault/);
  });

  it('take a share of a balance, rounded down, and all of it at 100', () => {
    expect(shareOf(1_000_000n, 25)).toBe(250_000n);
    expect(shareOf(3n, 50)).toBe(1n);
    expect(shareOf(999_999_999_999n, 100)).toBe(999_999_999_999n);
    for (const bad of [0, -5, 101, Number.NaN]) expect(() => shareOf(10n, bad)).toThrow(VaultError);
  });

  it('top each vault up to the target and send nothing to one that has it', () => {
    const vaults = [
      { address: VAULTS[0] as string, lamports: 0n },
      { address: VAULTS[1] as string, lamports: 30_000_000n },
      { address: VAULTS[2] as string, lamports: 12_000_000n },
      { address: VAULTS[3] as string, lamports: 90_000_000n },
    ];
    expect(gasTopUps(vaults, VAULT_GAS_DEFAULT_LAMPORTS)).toEqual([
      { index: 0, to: VAULTS[0], lamports: 30_000_000n },
      { index: 2, to: VAULTS[2], lamports: 18_000_000n },
    ]);
    expect(() => gasTopUps(vaults, 19_999_999n)).toThrow(/between 0.02 and 0.2/);
    expect(() => gasTopUps(vaults, 200_000_001n)).toThrow(VaultError);
    // The least a vault is ever set up with covers the reserve every flow asks for.
    expect(hasGas(20_000_000n)).toBe(true);
    expect(hasGas(GAS_RESERVE_LAMPORTS)).toBe(true);
    expect(hasGas(GAS_RESERVE_LAMPORTS - 1n)).toBe(false);
  });

  it('sweep everything but the fee of the sweep itself', () => {
    expect(sweepAmount(1_000_000n, 0n)).toBe(995_000n);
    expect(sweepAmount(1_000_000n, 250n)).toBe(994_750n);
    expect(sweepAmount(SIGNATURE_FEE_LAMPORTS, 0n)).toBeNull();
    expect(sweepAmount(5_100n, 100n)).toBeNull();
    expect(sweepAmount(0n, 0n)).toBeNull();
    // The fallback: leave the least an account may hold, and send the rest.
    expect(sweepAmount(1_000_000n, 250n, SYSTEM_RENT_EXEMPT_LAMPORTS)).toBe(103_870n);
    expect(sweepAmount(895_880n, 0n, SYSTEM_RENT_EXEMPT_LAMPORTS)).toBeNull();
    expect(SYSTEM_RENT_EXEMPT_LAMPORTS).toBe(128n * 3_480n * 2n);
    expect(() => sweepAmount(1_000_000n, 0n, -1n)).toThrow(VaultError);
  });
});

describe('who may use vaults with a token', () => {
  it('refuses the wallet that made it, and any of its vaults that did', () => {
    expect(creatorRefused([OWNER], OWNER, VAULTS)).toBe(true);
    expect(creatorRefused([VAULTS[4] as string], OWNER, VAULTS)).toBe(true);
    // The pool names a fee module's wallet as creator; the listing still names the wallet that launched.
    expect(creatorRefused(['ModuLeWa11et1111111111111111111111111111111', OWNER], OWNER, VAULTS)).toBe(true);
    expect(creatorRefused(['SomeoneE1se11111111111111111111111111111111'], OWNER, VAULTS)).toBe(false);
    expect(creatorRefused([], OWNER, VAULTS)).toBe(false);
    expect(creatorRefused([''], '', VAULTS)).toBe(false);
    // The other wallets kept under the same passphrase count as the creator's own.
    expect(creatorRefused(['AnotherWa11etOfMine111111111111111111111111'], OWNER, [...VAULTS, 'AnotherWa11etOfMine111111111111111111111111'])).toBe(true);
    expect(CREATOR_MESSAGE).toMatch(/created this token/);
    expect(CREATOR_MESSAGE).toMatch(/another wallet kept in this browser/);
    expect(CREATOR_MESSAGE).toMatch(/can still be recalled/);
  });
});

describe('what an observer sees of vaults', () => {
  const hidden = (rows: ReadonlyArray<readonly [string, string, boolean]>): string[] => rows.filter(([, , isHidden]) => isHidden).map(([label]) => label);

  it('says a spread hides the token and the amount, and nothing else', () => {
    expect(hidden(SPREAD_VISIBILITY)).toEqual(['Which token each vault received', 'How much each vault received']);
    expect(SPREAD_VISIBILITY.find(([label]) => /funded/.test(label))?.[1]).toBe('PUBLIC');
  });

  it('says a pool trade is public and tied to the wallet', () => {
    expect(hidden(TRADE_VISIBILITY)).toEqual(['What each vault holds before and after']);
    expect(TRADE_VISIBILITY.map(([label]) => label)).toContain('The token and the size of each trade');
    expect(TRADE_VISIBILITY.find(([label]) => /belongs to your wallet/.test(label))?.[2]).toBe(false);
  });

  it('says the desk learns the whole of a Ghost fill', () => {
    expect(hidden(GHOST_TRADE_VISIBILITY)).toEqual(['Which token', 'How much, and at what price']);
    expect(GHOST_TRADE_VISIBILITY.at(-1)).toEqual(['What the desk learns', 'THE WHOLE TRADE', false]);
  });

  it('says a public recall hides nothing, and that the SOL is public either way', () => {
    expect(hidden(recallVisibility(false))).toEqual([]);
    expect(hidden(recallVisibility(true))).toEqual(['Which tokens come back', 'How much comes back']);
    for (const privately of [true, false]) expect(recallVisibility(privately).at(-1)?.[2]).toBe(false);
  });

  it('is described in the docs as what it is', () => {
    const page = readFileSync(resolve(import.meta.dirname, '../web/src/docs/pages/prvmax.md'), 'utf8');
    expect(page).toMatch(/vaults are not a disguise/);
    expect(page).toMatch(/cannot use vaults with a token it created/);
    expect(page).toMatch(/Each vault's address \| public/);
    expect(page.toLowerCase()).not.toMatch(/untraceable|unlinkable|\bstealth\b|\bbundle/);
  });
});

describe('the list of what vaults traded', () => {
  const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({ at: 1, kind: 'buy', vault: 1, mint: 'MintA', pair: 'SOL', quote: '100', tokens: '5000', signature: 'sig', ...over });

  it('adds up buys and sells by token, newest token first', () => {
    const totals = activityTotals([
      entry({ at: 10 }),
      entry({ at: 20, vault: 2, quote: '150', tokens: '7000' }),
      entry({ at: 30, kind: 'sell', quote: '90', tokens: '4000' }),
      entry({ at: 40, mint: 'MintB', pair: 'USDC', quote: '7', tokens: '1' }),
      entry({ at: 50, quote: 'not a number' }),
    ]);
    expect(totals).toEqual([
      { mint: 'MintB', pair: 'USDC', bought: 1n, sold: 0n, spent: 7n, received: 0n, trades: 1 },
      { mint: 'MintA', pair: 'SOL', bought: 12_000n, sold: 4_000n, spent: 250n, received: 90n, trades: 3 },
    ]);
  });

  it('keeps the newest entries and reads back only what is an entry', () => {
    let log: ActivityEntry[] = [];
    for (let at = 1; at <= 6; at += 1) log = appendActivity(log, entry({ at }), 4);
    expect(log.map((line) => line.at)).toEqual([3, 4, 5, 6]);
    const stored = JSON.stringify([entry({ route: 'ghost' }), { kind: 'buy' }, null, entry({ quote: '-1' }), entry({ kind: 'swap' as never }), { ...entry({}), route: 'other' }]);
    const read = parseActivity(stored);
    expect(read).toHaveLength(2);
    expect(read[0]?.route).toBe('ghost');
    expect(read[1]).not.toHaveProperty('route');
    for (const broken of [null, undefined, '', 'not json', '{"a":1}']) expect(parseActivity(broken)).toEqual([]);
  });
});

describe('the transactions that are prvmax’s own', () => {
  const owner = address(OWNER);
  const legacy = (instruction: ReturnType<typeof gasInstructions>[number]): TransactionInstruction => {
    const fields = legacyInstructionFields(instruction);
    return new TransactionInstruction({
      programId: new PublicKey(fields.programId),
      keys: fields.keys.map((key) => ({ pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable })),
      data: Buffer.from(fields.data),
    });
  };
  /** A wallet's context, as far as these builders use it: an owner, a blockhash and a priority price. */
  const context = (who: string, microLamports = 0): RingsContext =>
    ({
      owner: address(who),
      client: { getLatestBlockhash: async () => ({ blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', lastValidBlockHeight: 1_000n }) },
      priority: () => microLamports,
    }) as unknown as RingsContext;

  it('fund each vault with a plain transfer from the wallet, and nothing else', () => {
    const transfers = gasTopUps(VAULTS.map((vault) => ({ address: vault, lamports: 0n })), VAULT_GAS_DEFAULT_LAMPORTS);
    const instructions = gasInstructions(owner, transfers);
    expect(instructions).toHaveLength(10);
    for (const [index, instruction] of instructions.entries()) {
      const decoded = SystemInstruction.decodeTransfer(legacy(instruction));
      expect(decoded.fromPubkey.toBase58()).toBe(OWNER);
      expect(decoded.toPubkey.toBase58()).toBe(VAULTS[index]);
      expect(decoded.lamports).toBe(30_000_000n);
    }
    expect(() => gasInstructions(owner, [])).toThrow(/already has its SOL/);
    expect(() => gasInstructions(owner, [{ index: 0, to: OWNER, lamports: 1n }])).toThrow(/does not fund itself/);
    expect(() => gasInstructions(owner, [{ index: 0, to: VAULTS[0] as string, lamports: 0n }])).toThrow(VaultError);
    expect(() => gasInstructions(owner, Array.from({ length: 11 }, (_unused, index) => ({ index, to: VAULTS[0] as string, lamports: 1n })))).toThrow(/at most 10/);
  });

  it('fit ten transfers into one version 1 transaction signed by the wallet alone', async () => {
    const transfers = gasTopUps(VAULTS.map((vault) => ({ address: vault, lamports: 0n })), VAULT_GAS_DEFAULT_LAMPORTS);
    const transaction = await buildGasFunding(context(OWNER, 20_000), transfers);
    const message = decompileMessage(messageBytesOf(transaction));
    expect(message.version).toBe(1);
    expect(message.feePayer).toBe(OWNER);
    expect(message.instructions).toHaveLength(10);
    expect(message.computeUnitLimit).toBe(VAULT_COMPUTE_UNITS.gas);
    expect(message.priorityFeeLamports).toBe(priorityFeeFor(20_000, VAULT_COMPUTE_UNITS.gas));
    expect(Object.keys(transaction.signatures)).toEqual([OWNER]);
    expect(messageBytesOf(transaction).length).toBeLessThan(TX_V1_MAX_BYTES);
  });

  it('sweep a vault to exactly nothing: what leaves plus what the transaction costs is the whole balance', async () => {
    const vault = VAULTS[0] as string;
    for (const [balance, price] of [
      [29_874_120n, 0],
      [29_874_120n, 23_673],
      [1_000_000n, 1_000_000],
    ] as const) {
      const sweep = await buildSweep(context(vault, price), owner, balance);
      expect(sweep).not.toBeNull();
      if (!sweep) continue;
      const message = decompileMessage(messageBytesOf(sweep.transaction));
      const priority = message.priorityFeeLamports ?? 0n;
      expect(priority).toBe(priorityFeeFor(price, VAULT_COMPUTE_UNITS.sweep));
      expect(message.instructions).toHaveLength(1);
      const decoded = SystemInstruction.decodeTransfer(legacy(message.instructions[0] as ReturnType<typeof gasInstructions>[number]));
      expect(decoded.fromPubkey.toBase58()).toBe(vault);
      expect(decoded.toPubkey.toBase58()).toBe(OWNER);
      expect(decoded.lamports).toBe(sweep.lamports);
      // One signature at 5,000 lamports, plus the priority fee the message itself names.
      expect(sweep.lamports + SIGNATURE_FEE_LAMPORTS + priority).toBe(balance);
      expect(Object.keys(sweep.transaction.signatures)).toEqual([vault]);
    }
    expect(await buildSweep(context(vault), owner, 5_000n)).toBeNull();
    const kept = await buildSweep(context(vault, 23_673), owner, 29_874_120n, SYSTEM_RENT_EXEMPT_LAMPORTS);
    const keptFee = SIGNATURE_FEE_LAMPORTS + priorityFeeFor(23_673, VAULT_COMPUTE_UNITS.sweep);
    expect(kept?.lamports).toBe(29_874_120n - keptFee - SYSTEM_RENT_EXEMPT_LAMPORTS);
    await expect(buildSweep(context(vault), address(vault), 1_000_000n)).rejects.toThrow(/into itself/);
  });

  it('close only the accounts named, returning their rent to the vault', async () => {
    const vault = address(VAULTS[1] as string);
    const accounts = [VAULTS[2] as string, VAULTS[3] as string];
    const instructions = closeInstructions(vault, accounts);
    expect(instructions).toHaveLength(2);
    for (const [index, instruction] of instructions.entries()) {
      expect(instruction.programAddress).toBe(TOKEN_PROGRAM_ID.toBase58());
      // CloseAccount: the account, where its lamports go, and the owner who signs.
      expect((instruction.accounts ?? []).map((account) => account.address)).toEqual([accounts[index], vault, vault]);
      expect([...(instruction.data ?? [])]).toEqual([9]);
    }
    expect(() => closeInstructions(vault, [])).toThrow(/no empty token account/);
    expect(() => closeInstructions(vault, Array.from({ length: CLOSE_BATCH + 1 }, () => VAULTS[2] as string))).toThrow(/at most 12/);
    const full = await buildCloseAccounts(context(vault), VAULTS.slice(0, 2).concat(VAULTS.slice(2)).slice(0, 10));
    expect(decompileMessage(messageBytesOf(full)).computeUnitLimit).toBe(VAULT_COMPUTE_UNITS.close);
  });

  it('move a token account’s whole balance to the destination’s own account, then close it', async () => {
    const vault = address(VAULTS[1] as string);
    const mint = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 7)).publicKey;
    const source = getAssociatedTokenAddressSync(mint, Keypair.fromSeed(await vaultSeed(await rootFromSeed(SEED), 2)).publicKey);
    const destination = getAssociatedTokenAddressSync(mint, Keypair.fromSeed(SEED).publicKey);
    const move = { account: source.toBase58(), mint: mint.toBase58(), amount: 123_456n };
    const [open, transfer, close] = moveTokenInstructions(vault, owner, move);
    expect(open?.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    // Idempotent: a destination that already has the account is not an error.
    expect([...(open?.data ?? [])]).toEqual([1]);
    expect((open?.accounts ?? []).slice(0, 4).map((account) => account.address)).toEqual([vault, destination.toBase58(), OWNER, mint.toBase58()]);
    expect(transfer?.programAddress).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect((transfer?.accounts ?? []).map((account) => account.address)).toEqual([source.toBase58(), destination.toBase58(), vault]);
    const data = Buffer.from(transfer?.data ?? []);
    expect(data[0]).toBe(3);
    expect(data.readBigUInt64LE(1)).toBe(123_456n);
    expect((close?.accounts ?? []).map((account) => account.address)).toEqual([source.toBase58(), vault, vault]);
    expect(() => moveTokenInstructions(vault, vault as Address, move)).toThrow(/into itself/);
    expect(() => moveTokenInstructions(vault, owner, { ...move, amount: 0n })).toThrow(/nothing in that token account/);
    expect(() => moveTokenInstructions(vault, owner, { ...move, account: destination.toBase58() })).toThrow(/already belongs to the destination/);
    const transaction = await buildMoveToken(context(vault, 10_000), owner, move);
    const message = decompileMessage(messageBytesOf(transaction));
    expect(message.feePayer).toBe(vault);
    expect(message.instructions).toHaveLength(3);
    expect(message.computeUnitLimit).toBe(VAULT_COMPUTE_UNITS.move);
    expect(Object.keys(transaction.signatures)).toEqual([vault]);
  });
});
