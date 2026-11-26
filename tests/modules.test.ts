/**
 * Fee modules: the settings and their text form, the arithmetic, the wallets
 * derived from the seed, and the transactions a pass builds. Nothing here
 * touches the network: a payout is replayed against a small ledger to check
 * where every lamport goes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { address as kitAddress, getTransactionSize } from '@solana/kit';
import { type AccountInfo, Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DynamicBondingCurveClient, deriveDammV1MigrationMetadataAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_UNITS, DBC_PROGRAM_ID, TOKEN_ACCOUNT_RENT_LAMPORTS, WSOL_MINT } from '../shared/src/constants.js';
import { type Market, creatorClaimInstruction, transferCreatorInstruction } from '../shared/src/meteora.js';
import {
  MEMO_PROGRAM_ID,
  MIN_SOL_PAYMENT_LAMPORTS,
  ModuleError,
  type ModuleSettings,
  checkModuleSettings,
  checkModuleShares,
  describeModule,
  encodeModuleMemo,
  moduleMemoInstruction,
  parseModuleMemo,
  planBuyback,
  planSweep,
  splitAmounts,
} from '../shared/src/modules.js';
import { SOL_PAIR } from '../shared/src/quotes.js';
import { moduleActivationInstructions } from '../shared/src/routes.js';
import { composeV1, requiredSigners } from '../shared/src/tx.js';
import { choiceText, moduleHtml, moduleTag } from '../web/src/modules.js';
import { Store } from '../server/src/db.js';
import { EnvError, readEnv } from '../server/src/env.js';
import {
  type ModuleAccounts,
  Modules,
  ModulesError,
  accountsPayoutOpens,
  buybackInstructions,
  gasTankOf,
  heldForBuyback,
  heldForPayout,
  memosIn,
  moduleAccountAddresses,
  moduleAccountsFrom,
  moduleSeedBytes,
  moduleWallets,
  newModuleSeed,
  payoutInstructions,
  setupInstructions,
} from '../server/src/modules.js';
import { fixedPriority } from '../server/src/priority.js';
import { ADDRESSES, USDC } from './fixtures.js';

const key = (): string => Keypair.generate().publicKey.toBase58();
const RENT = TOKEN_ACCOUNT_RENT_LAMPORTS;

/**
 * Databases in temp folders for one group of tests, each closed and removed
 * after the test that opened it. The closing matters: Windows does not delete
 * a file that is still open, so a database left open makes the removal fail
 * there, and only there.
 */
function tempStores(prefix: string): () => Store {
  const opened: Array<{ dir: string; store: Store }> = [];
  afterEach(() => {
    for (const { dir, store } of opened.splice(0)) {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const store = new Store(dir);
    opened.push({ dir, store });
    return store;
  };
}
const ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'confirmed');

function settingsOf(burnBps: number, shares: number[], mint = key(), dev = key()): ModuleSettings {
  return checkModuleSettings({ mint, dev, burnBps, wallets: shares.map((bps) => ({ address: key(), bps })) });
}

describe('module settings', () => {
  it('accepts shares that add up to exactly 100% and keeps their order', () => {
    const mint = key();
    const dev = key();
    const a = key();
    const b = key();
    const settings = checkModuleSettings({ mint, dev, burnBps: 5000, wallets: [{ address: a, bps: 3000 }, { address: b, bps: 2000 }] });
    expect(settings).toEqual({ mint, dev, burnBps: 5000, wallets: [{ address: a, bps: 3000 }, { address: b, bps: 2000 }] });
    expect(describeModule(settings, (address) => address.slice(0, 4))).toBe(`50% buyback and burn · 30% to ${a.slice(0, 4)} · 20% to ${b.slice(0, 4)}`);
  });

  it('accepts everything burned, and everything shared', () => {
    expect(settingsOf(10_000, []).wallets).toEqual([]);
    expect(settingsOf(0, [10_000]).burnBps).toBe(0);
    expect(settingsOf(0, [2500, 2500, 2500, 2500]).wallets).toHaveLength(4);
  });

  it('refuses shares that do not add up', () => {
    expect(() => settingsOf(5000, [4000])).toThrow(/add up to 90%/);
    expect(() => settingsOf(5000, [6000])).toThrow(/add up to 110%/);
    expect(() => settingsOf(0, [])).toThrow(/add up to 0%/);
  });

  it('refuses a share under 1%, a fifth wallet, a wallet listed twice, and things that are not addresses', () => {
    expect(() => settingsOf(9950, [50])).toThrow(/between 1% and 100%/);
    expect(() => settingsOf(50, [9950])).toThrow(/between 1% and 100%/);
    expect(() => settingsOf(0, [2000, 2000, 2000, 2000, 2000])).toThrow(/at most 4 wallets/);
    const twice = key();
    expect(() => checkModuleSettings({ mint: key(), dev: key(), burnBps: 0, wallets: [{ address: twice, bps: 5000 }, { address: twice, bps: 5000 }] })).toThrow(/listed twice/);
    expect(() => checkModuleSettings({ mint: key(), dev: key(), burnBps: 0, wallets: [{ address: 'not-an-address', bps: 10_000 }] })).toThrow(ModuleError);
    expect(() => checkModuleSettings({ mint: key(), dev: key(), burnBps: 0, wallets: [{ address: key(), bps: 99.5 }] })).toThrow(/whole number/);
    expect(() => checkModuleSettings({ mint: 'x', dev: key(), burnBps: 10_000, wallets: [] })).toThrow(/token is not a Solana address/);
    const mint = key();
    expect(() => checkModuleSettings({ mint, dev: key(), burnBps: 0, wallets: [{ address: mint, bps: 10_000 }] })).toThrow(/token's own address/);
  });

  it('writes one text form and reads exactly that form back', () => {
    const settings = settingsOf(2500, [5000, 2500]);
    const memo = encodeModuleMemo(settings);
    expect(memo).toBe(`pcf:modules:1|mint=${settings.mint}|dev=${settings.dev}|burn=2500|${settings.wallets[0]?.address}=5000|${settings.wallets[1]?.address}=2500`);
    expect(parseModuleMemo(memo)).toEqual(settings);
    // The longest memo there can be still fits comfortably in a transaction.
    expect(encodeModuleMemo(settingsOf(100, [2475, 2475, 2475, 2475])).length).toBeLessThan(400);
  });

  it('refuses any text that is not the canonical form of valid settings', () => {
    const settings = settingsOf(2500, [7500]);
    const memo = encodeModuleMemo(settings);
    for (const bad of [
      memo.replace('pcf:modules:1', 'pcf:modules:2'),
      memo.replace('burn=2500', 'burn=02500'),
      memo.replace('burn=2500', 'burn=2500.0'),
      memo.replace('=7500', '=7400'),
      `${memo}|`,
      ` ${memo}`,
      memo.replace('|dev=', '|DEV='),
      memo.replace(`mint=${settings.mint}|dev=${settings.dev}`, `dev=${settings.dev}|mint=${settings.mint}`),
      '',
      'hello',
    ]) {
      expect(() => parseModuleMemo(bad), bad).toThrow(ModuleError);
    }
  });

  it('checks the shares on their own, before there is a token', () => {
    const a = key();
    expect(checkModuleShares({ burnBps: 2500, wallets: [{ address: a, bps: 7500 }] })).toEqual({ burnBps: 2500, wallets: [{ address: a, bps: 7500 }] });
    expect(checkModuleShares({ burnBps: 10_000, wallets: [] })).toEqual({ burnBps: 10_000, wallets: [] });
    expect(() => checkModuleShares({ burnBps: 2500, wallets: [{ address: a, bps: 7000 }] })).toThrow(/add up to 95%/);
    expect(() => checkModuleShares({ burnBps: 0, wallets: [{ address: a, bps: 5000 }, { address: a, bps: 5000 }] })).toThrow(/listed twice/);
    expect(() => checkModuleShares({ burnBps: 9950, wallets: [{ address: a, bps: 50 }] })).toThrow(/between 1% and 100%/);
    expect(() => checkModuleShares({})).toThrow(/list of wallets is missing/);
  });

  it('carries the memo in an instruction the creator signs', () => {
    const signer = Keypair.generate().publicKey;
    const instruction = moduleMemoInstruction('pcf:modules:1|x', signer);
    expect(instruction.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    expect(instruction.keys).toEqual([{ pubkey: signer, isSigner: true, isWritable: false }]);
    expect(instruction.data.toString('utf8')).toBe('pcf:modules:1|x');
  });
});

describe('dividing an amount', () => {
  it('always hands out exactly what it was given', () => {
    const cases: Array<[number, number[]]> = [
      [5000, [3000, 2000]],
      [0, [3333, 3333, 3334]],
      [100, [9900]],
      [10_000, []],
      [0, [10_000]],
      [1234, [4321, 4445]],
    ];
    for (const [burnBps, shares] of cases) {
      const settings = settingsOf(burnBps, shares);
      for (const total of [0n, 1n, 7n, 999n, 1_000_003n, 123_456_789_012n, 2n ** 62n]) {
        const split = splitAmounts(total, settings);
        expect(split.wallets.reduce((sum, amount) => sum + amount, 0n) + split.burn).toBe(total);
        expect(split.wallets.every((amount) => amount >= 0n) && split.burn >= 0n).toBe(true);
        if (burnBps === 0) expect(split.burn).toBe(0n);
      }
    }
  });

  it('gives each wallet its percentage, and what rounding leaves to the buyback', () => {
    const settings = settingsOf(5000, [3000, 2000]);
    expect(splitAmounts(1_000_000_001n, settings)).toEqual({ wallets: [300_000_000n, 200_000_000n], burn: 500_000_001n });
    // With no buyback the leftover unit goes to the first wallet.
    expect(splitAmounts(100n, settingsOf(0, [3333, 3333, 3334]))).toEqual({ wallets: [34n, 33n, 33n], burn: 0n });
  });
});

describe('deciding a payout', () => {
  const settings = settingsOf(5000, [3000, 2000]);
  const base = { native: true, claimable: 0n, held: 0n, minimum: 20_000_000n, rentToOpen: 0n };

  it('waits while there is nothing, or less than the smallest amount worth acting on', () => {
    expect(planSweep(base, settings)).toMatchObject({ action: 'wait', total: 0n });
    expect(planSweep({ ...base, claimable: 19_999_999n }, settings)).toMatchObject({ action: 'wait' });
  });

  it('pays everything it has, claim and holdings together', () => {
    const plan = planSweep({ ...base, claimable: 30_000_000n, held: 10_000_000n }, settings);
    expect(plan).toEqual({ action: 'pay', total: 40_000_000n, claim: 30_000_000n, split: { wallets: [12_000_000n, 8_000_000n], burn: 20_000_000n } });
  });

  it('pays what is held even when there is nothing to claim', () => {
    expect(planSweep({ ...base, held: 50_000_000n }, settings)).toMatchObject({ action: 'pay', claim: 0n, total: 50_000_000n });
  });

  it('for SOL, waits until the smallest share can be sent to a wallet that holds nothing', () => {
    const small = settingsOf(0, [9900, 100]);
    // 1% of 0.05 SOL is 0.0005 SOL: below what an empty wallet can receive.
    expect(planSweep({ ...base, claimable: 50_000_000n }, small)).toMatchObject({ action: 'wait', reason: expect.stringMatching(/smallest share/) });
    expect(planSweep({ ...base, claimable: 100_000_000n }, small)).toMatchObject({ action: 'pay' });
    expect(MIN_SOL_PAYMENT_LAMPORTS).toBeGreaterThan(890_880n);
  });

  it('for another pair token, any share of at least one unit can be sent', () => {
    const small = settingsOf(0, [9900, 100]);
    expect(planSweep({ native: false, claimable: 50n, held: 0n, minimum: 1n, rentToOpen: 0n }, small)).toMatchObject({ action: 'wait' });
    expect(planSweep({ native: false, claimable: 100n, held: 0n, minimum: 1n, rentToOpen: 0n }, small)).toMatchObject({ action: 'pay' });
  });

  it('opens accounts only when the fees are worth four times their rent', () => {
    const rent = 2_039_280n;
    expect(planSweep({ ...base, minimum: 1n, claimable: 4n * rent - 1n, rentToOpen: rent }, settings)).toMatchObject({ action: 'wait' });
    expect(planSweep({ ...base, minimum: 1n, claimable: 4n * rent, rentToOpen: rent }, settings)).toMatchObject({ action: 'pay' });
  });
});

describe('deciding a buyback', () => {
  const base = { native: true, held: 0n, minimum: 5_000_000n, maximum: 1_000_000_000n, rentToOpen: 0n };

  it('waits while the pot is empty or below the smallest buy', () => {
    expect(planBuyback(base)).toMatchObject({ action: 'wait' });
    expect(planBuyback({ ...base, held: 4_999_999n })).toMatchObject({ action: 'wait' });
    expect(planBuyback({ ...base, held: 50_000_000n, maximum: 0n })).toMatchObject({ action: 'wait' });
  });

  it('spends everything up to the cap', () => {
    expect(planBuyback({ ...base, held: 5_000_000n })).toEqual({ action: 'buy', spend: 5_000_000n });
    expect(planBuyback({ ...base, held: 1_000_000_000n })).toEqual({ action: 'buy', spend: 1_000_000_000n });
    expect(planBuyback({ ...base, held: 3_000_000_000n })).toEqual({ action: 'buy', spend: 1_000_000_000n });
  });

  it('for SOL, never leaves the pot with a remainder too small to exist', () => {
    // 1.0005 SOL in the pot and a 1 SOL cap: 0.0005 SOL could not stay behind, so it is spent too.
    expect(planBuyback({ ...base, held: 1_000_500_000n })).toEqual({ action: 'buy', spend: 1_000_500_000n });
    expect(planBuyback({ ...base, held: 1_001_000_000n })).toEqual({ action: 'buy', spend: 1_000_000_000n });
    // A token balance can be any size.
    expect(planBuyback({ ...base, native: false, held: 1_000_500_000n })).toEqual({ action: 'buy', spend: 1_000_000_000n });
  });

  it('opens the pot\'s token account only for a buy worth four times its rent', () => {
    expect(planBuyback({ ...base, held: 8_000_000n, rentToOpen: 2_039_280n })).toMatchObject({ action: 'wait' });
    expect(planBuyback({ ...base, held: 8_157_120n, rentToOpen: 2_039_280n })).toMatchObject({ action: 'buy' });
  });
});

describe('the wallets behind a module', () => {
  const seed = moduleSeedBytes(newModuleSeed());
  const memo = encodeModuleMemo(settingsOf(5000, [5000]));

  it('are the same every time for the same seed and settings', () => {
    expect(moduleWallets(seed, memo).wallet.publicKey.toBase58()).toBe(moduleWallets(seed, memo).wallet.publicKey.toBase58());
    expect(moduleWallets(seed, memo).pot.publicKey.toBase58()).toBe(moduleWallets(seed, memo).pot.publicKey.toBase58());
    expect(gasTankOf(seed).publicKey.toBase58()).toBe(gasTankOf(seed).publicKey.toBase58());
  });

  it('differ for the wallet, the pot and the gas tank, for other settings, and for another seed', () => {
    const one = moduleWallets(seed, memo);
    const other = moduleWallets(seed, encodeModuleMemo(settingsOf(5000, [5000])));
    const elsewhere = moduleWallets(moduleSeedBytes(newModuleSeed()), memo);
    const addresses = [one.wallet, one.pot, other.wallet, other.pot, elsewhere.wallet, elsewhere.pot, gasTankOf(seed)].map((pair) => pair.publicKey.toBase58());
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('changing a single share changes the wallet', () => {
    const settings = settingsOf(5000, [5000]);
    const shifted = { ...settings, burnBps: 4900, wallets: [{ address: settings.wallets[0]?.address as string, bps: 5100 }] };
    expect(moduleWallets(seed, encodeModuleMemo(settings)).wallet.publicKey.equals(moduleWallets(seed, encodeModuleMemo(shifted)).wallet.publicKey)).toBe(false);
  });

  it('refuses a seed that is not 32 bytes of base58', () => {
    expect(() => moduleSeedBytes('abc')).toThrow(EnvError);
    expect(() => moduleSeedBytes('0OIl')).toThrow(EnvError);
    expect(moduleSeedBytes(newModuleSeed())).toHaveLength(32);
  });
});

/* ---------------- the Meteora instructions ---------------- */

function fakeMarket(pair = SOL_PAIR): Pick<Market, 'pool' | 'mint' | 'state' | 'pair'> {
  const poolState = { baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey, creatorQuoteFee: new BN(0) };
  return { pool: Keypair.generate().publicKey, mint: Keypair.generate().publicKey, pair, state: { poolState } as unknown as Market['state'] };
}

describe('handing over the creator role', () => {
  it('names the pool, its config, the signer and the new creator, in the order the program reads them', async () => {
    const pool = Keypair.generate().publicKey;
    const config = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const newCreator = Keypair.generate().publicKey;
    const instruction = await transferCreatorInstruction(dbc, { pool, config, creator, newCreator });
    expect(instruction.programId.toBase58()).toBe(DBC_PROGRAM_ID);
    expect([...instruction.data]).toEqual([20, 7, 169, 33, 58, 147, 166, 33]);
    expect(instruction.keys.slice(0, 4).map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable])).toEqual([
      [pool.toBase58(), false, true],
      [config.toBase58(), false, false],
      [creator.toBase58(), true, false],
      [newCreator.toBase58(), false, false],
    ]);
    // Event authority, the program itself, then the account Meteora's own builder always adds.
    expect(instruction.keys).toHaveLength(7);
    expect(instruction.keys[5]?.pubkey.toBase58()).toBe(DBC_PROGRAM_ID);
    expect(instruction.keys[6]?.pubkey.equals(deriveDammV1MigrationMetadataAddress(pool))).toBe(true);
    expect(instruction.keys.filter((meta) => meta.isSigner)).toHaveLength(1);
  });

  it('refuses to hand the role to the wallet that already holds it', async () => {
    const same = Keypair.generate().publicKey;
    await expect(transferCreatorInstruction(dbc, { pool: same, config: same, creator: same, newCreator: same })).rejects.toThrow(/different address/);
  });
});

describe('claiming creator fees', () => {
  it('claims exactly the amount named, none of it in the token, into the creator\'s own accounts', async () => {
    const market = fakeMarket();
    const creator = Keypair.generate().publicKey;
    const instruction = await creatorClaimInstruction(dbc, market, creator, 123_456_789n);
    expect(instruction.programId.toBase58()).toBe(DBC_PROGRAM_ID);
    expect([...instruction.data.subarray(0, 8)]).toEqual([82, 220, 250, 189, 3, 85, 107, 45]);
    expect(instruction.data.readBigUInt64LE(8)).toBe(0n);
    expect(instruction.data.readBigUInt64LE(16)).toBe(123_456_789n);
    const wsol = new PublicKey(WSOL_MINT);
    expect(instruction.keys.map((meta) => meta.pubkey.toBase58()).slice(1, 11)).toEqual([
      market.pool.toBase58(),
      getAssociatedTokenAddressSync(market.mint, creator, true).toBase58(),
      getAssociatedTokenAddressSync(wsol, creator, true).toBase58(),
      (market.state.poolState.baseVault as PublicKey).toBase58(),
      (market.state.poolState.quoteVault as PublicKey).toBase58(),
      market.mint.toBase58(),
      WSOL_MINT,
      creator.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
    expect(instruction.keys).toHaveLength(13);
    expect(instruction.keys.filter((meta) => meta.isSigner).map((meta) => meta.pubkey.toBase58())).toEqual([creator.toBase58()]);
  });

  it('refuses to build a claim of nothing', async () => {
    await expect(creatorClaimInstruction(dbc, fakeMarket(), Keypair.generate().publicKey, 0n)).rejects.toThrow(/no creator fees/);
  });
});

/* ---------------- a payout, replayed ---------------- */

const empty: ModuleAccounts = { walletLamports: 0n, walletQuote: null, walletBase: null, potLamports: 0n, potQuote: null, potBase: null, recipients: [] };

/**
 * Applies a payout's instructions to a ledger of lamports, the way the chain
 * would for a SOL pair: the claim puts wrapped SOL in the wallet's wrapped
 * account, closing that account pays all of it to the wallet, and every
 * system transfer must be covered by what its sender holds at that point.
 */
function replaySol(instructions: readonly TransactionInstruction[], start: Record<string, bigint>, claim: bigint, wrapped: PublicKey): Map<string, bigint> {
  const ledger = new Map<string, bigint>(Object.entries(start));
  const get = (address: PublicKey): bigint => ledger.get(address.toBase58()) ?? 0n;
  const move = (from: PublicKey, to: PublicKey, lamports: bigint): void => {
    if (get(from) < lamports) throw new Error(`${from.toBase58()} cannot pay ${lamports}`);
    ledger.set(from.toBase58(), get(from) - lamports);
    ledger.set(to.toBase58(), get(to) + lamports);
  };
  for (const instruction of instructions) {
    if (instruction.programId.equals(SystemProgram.programId)) {
      const transfer = SystemInstruction.decodeTransfer(instruction);
      move(transfer.fromPubkey, transfer.toPubkey, BigInt(transfer.lamports));
    } else if (instruction.programId.equals(ATA_PROGRAM)) {
      const [payer, account] = instruction.keys.map((meta) => meta.pubkey) as [PublicKey, PublicKey];
      if (get(account) === 0n) move(payer, account, RENT);
    } else if (instruction.programId.toBase58() === DBC_PROGRAM_ID) {
      ledger.set(wrapped.toBase58(), get(wrapped) + claim);
    } else if (instruction.programId.equals(TOKEN_PROGRAM_ID)) {
      // CloseAccount: everything the account holds goes to the destination.
      expect(instruction.data[0]).toBe(9);
      const [account, destination] = instruction.keys.map((meta) => meta.pubkey) as [PublicKey, PublicKey];
      move(account, destination, get(account));
    } else {
      throw new Error(`unexpected program ${instruction.programId.toBase58()}`);
    }
  }
  return ledger;
}

/** The size of the transaction a pass would send: gas tank as fee payer, the two budget instructions in front. */
function sizeOf(instructions: readonly TransactionInstruction[], gas: Keypair, signers: Keypair[]): number {
  const transaction = new Transaction({ feePayer: gas.publicKey, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 });
  const budget = new PublicKey('ComputeBudget111111111111111111111111111111');
  transaction.add({ programId: budget, keys: [], data: Buffer.from([2, 0, 0, 0, 0]) }, { programId: budget, keys: [], data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]) }, ...instructions);
  transaction.sign(gas, ...signers);
  return transaction.serialize().length;
}

describe('a payout in SOL', () => {
  const gas = Keypair.generate();
  const wallet = Keypair.generate();
  const pot = Keypair.generate();
  const market = fakeMarket();
  const wrapped = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), wallet.publicKey, true);
  const settings = settingsOf(5000, [2000, 1500, 1000, 500], market.mint.toBase58());
  const gasStart = 1_000_000_000n;

  async function run(accounts: ModuleAccounts, claim: bigint) {
    const plan = planSweep({ native: true, claimable: claim, held: heldForPayout(SOL_PAIR, accounts), minimum: 1n, rentToOpen: 0n }, settings);
    if (plan.action !== 'pay') throw new Error('expected a payout');
    const built = await payoutInstructions({ dbc, market, settings, accounts, gasTank: gas.publicKey, wallet: wallet.publicKey, pot: pot.publicKey, claim: plan.claim, split: plan.split });
    const start: Record<string, bigint> = { [gas.publicKey.toBase58()]: gasStart, [wallet.publicKey.toBase58()]: accounts.walletLamports };
    if (accounts.walletQuote) start[wrapped.toBase58()] = accounts.walletQuote.lamports;
    if (accounts.walletBase) start[getAssociatedTokenAddressSync(market.mint, wallet.publicKey, true).toBase58()] = accounts.walletBase.lamports;
    return { plan, built, ledger: replaySol(built.instructions, start, claim, wrapped) };
  }

  it('claims, unwraps and divides everything, leaving the wallet empty and the gas tank out only the rent of the account that stays', async () => {
    const claim = 1_000_000_003n;
    const { plan, built, ledger } = await run(empty, claim);
    const at = (address: PublicKey | string): bigint => ledger.get(typeof address === 'string' ? address : address.toBase58()) ?? 0n;
    expect(at(wallet.publicKey)).toBe(0n);
    expect(at(wrapped)).toBe(0n);
    settings.wallets.forEach((entry, index) => expect(at(entry.address)).toBe(plan.split.wallets[index]));
    expect(at(pot.publicKey)).toBe(plan.split.burn);
    expect(plan.split.wallets.reduce((sum, amount) => sum + amount, 0n) + plan.split.burn).toBe(claim);
    // The wallet's account for the token stays open, on the gas tank's rent. The wrapped account's rent came back.
    expect(at(gas.publicKey)).toBe(gasStart - RENT);
    expect(built.rentOutlay).toBe(2n * RENT);
    expect(sizeOf(built.instructions, gas, [wallet])).toBeLessThanOrEqual(1232);
  });

  it('adds what the wallet already holds, such as a payout of pool fees after graduation', async () => {
    const accounts = { ...empty, walletLamports: 250_000_000n, walletBase: { amount: 0n, lamports: RENT } };
    const { plan, built, ledger } = await run(accounts, 50_000_000n);
    expect(plan.total).toBe(300_000_000n);
    expect(ledger.get(wallet.publicKey.toBase58())).toBe(0n);
    expect(ledger.get(pot.publicKey.toBase58())).toBe(150_000_000n);
    // Nothing is left open this time, so the gas tank is out nothing at all.
    expect(ledger.get(gas.publicKey.toBase58())).toBe(gasStart);
    expect(built.rentOutlay).toBe(RENT);
  });

  it('with nothing to claim, sends no claim and opens nothing', async () => {
    const { built, ledger } = await run({ ...empty, walletLamports: 80_000_000n }, 0n);
    expect(built.instructions.every((instruction) => instruction.programId.equals(SystemProgram.programId))).toBe(true);
    expect(built.rentOutlay).toBe(0n);
    expect(ledger.get(wallet.publicKey.toBase58())).toBe(0n);
    expect(ledger.get(gas.publicKey.toBase58())).toBe(gasStart);
  });

  it('sweeps up a wrapped account somebody left behind, and takes no rent back for it', async () => {
    const stale = { amount: 5_000n, lamports: RENT + 5_000n };
    const accounts = { ...empty, walletQuote: stale, walletBase: { amount: 0n, lamports: RENT } };
    const { plan, built, ledger } = await run(accounts, 40_000_000n);
    expect(plan.total).toBe(40_000_000n + RENT + 5_000n);
    expect(ledger.get(wallet.publicKey.toBase58())).toBe(0n);
    expect(ledger.get(gas.publicKey.toBase58())).toBe(gasStart);
    expect(built.rentOutlay).toBe(0n);
    expect(built.instructions.filter((instruction) => instruction.programId.equals(ATA_PROGRAM))).toHaveLength(0);
  });

  it('is signed by the wallet for everything that leaves it, and by nobody else but the gas tank', async () => {
    const { built } = await run(empty, 500_000_000n);
    const signers = new Set(built.instructions.flatMap((instruction) => instruction.keys.filter((meta) => meta.isSigner).map((meta) => meta.pubkey.toBase58())));
    expect(signers).toEqual(new Set([gas.publicKey.toBase58(), wallet.publicKey.toBase58()]));
  });

  it('counts only the accounts that stay open', () => {
    expect(accountsPayoutOpens(SOL_PAIR, settings, empty, 1n)).toBe(1);
    expect(accountsPayoutOpens(SOL_PAIR, settings, empty, 0n)).toBe(0);
    expect(accountsPayoutOpens(SOL_PAIR, settings, { ...empty, walletBase: { amount: 0n, lamports: RENT } }, 1n)).toBe(0);
  });
});

describe('a payout in another pair token', () => {
  const gas = Keypair.generate();
  const wallet = Keypair.generate();
  const pot = Keypair.generate();
  const market = fakeMarket(USDC);
  const settings = settingsOf(4000, [3000, 1500, 1000, 500], market.mint.toBase58());
  const mint = new PublicKey(USDC.mint);
  const open = { amount: 0n, lamports: RENT };

  it('moves the pair token only, between token accounts, in amounts that add up', async () => {
    const accounts: ModuleAccounts = { ...empty, recipients: [open, open, open, open] };
    const plan = planSweep({ native: false, claimable: 987_654_321n, held: 0n, minimum: 1n, rentToOpen: 0n }, settings);
    if (plan.action !== 'pay') throw new Error('expected a payout');
    const built = await payoutInstructions({ dbc, market, settings, accounts, gasTank: gas.publicKey, wallet: wallet.publicKey, pot: pot.publicKey, claim: plan.claim, split: plan.split });
    const transfers = built.instructions.filter((instruction) => instruction.programId.equals(TOKEN_PROGRAM_ID));
    // TransferChecked: source, mint, destination, authority; amount then decimals.
    expect(transfers.every((instruction) => instruction.data[0] === 12 && instruction.keys[1]?.pubkey.equals(mint) && instruction.data[9] === USDC.decimals)).toBe(true);
    const source = getAssociatedTokenAddressSync(mint, wallet.publicKey, true);
    expect(transfers.every((instruction) => instruction.keys[0]?.pubkey.equals(source) && instruction.keys[3]?.pubkey.equals(wallet.publicKey))).toBe(true);
    const amounts = transfers.map((instruction) => instruction.data.readBigUInt64LE(1));
    expect(amounts.reduce((sum, amount) => sum + amount, 0n)).toBe(987_654_321n);
    expect(transfers.map((instruction) => instruction.keys[2]?.pubkey.toBase58())).toEqual([
      ...settings.wallets.map((entry) => getAssociatedTokenAddressSync(mint, new PublicKey(entry.address), true).toBase58()),
      getAssociatedTokenAddressSync(mint, pot.publicKey, true).toBase58(),
    ]);
    // No SOL moves at all, and three accounts are opened: the wallet's two and the pot's.
    expect(built.instructions.some((instruction) => instruction.programId.equals(SystemProgram.programId))).toBe(false);
    expect(built.rentOutlay).toBe(3n * RENT);
    expect(accountsPayoutOpens(USDC, settings, accounts, plan.claim)).toBe(3);
    expect(sizeOf(built.instructions, gas, [wallet])).toBeLessThanOrEqual(1232);
  });

  it('opens the sharing wallets\' token accounts in a transaction of its own', () => {
    const accounts: ModuleAccounts = { ...empty, recipients: [open, null, null, open] };
    const setup = setupInstructions(USDC, settings, accounts, gas.publicKey);
    expect(setup.instructions).toHaveLength(2);
    expect(setup.rentOutlay).toBe(2n * RENT);
    expect(setup.instructions.map((instruction) => instruction.keys[2]?.pubkey.toBase58())).toEqual([settings.wallets[1]?.address, settings.wallets[2]?.address]);
    expect(setup.instructions.every((instruction) => instruction.programId.equals(ATA_PROGRAM) && instruction.data[0] === 1 && instruction.keys[0]?.pubkey.equals(gas.publicKey))).toBe(true);
    expect(accountsPayoutOpens(USDC, settings, accounts, 0n)).toBe(3);
    expect(sizeOf(setupInstructions(USDC, settings, { ...empty, recipients: [null, null, null, null] }, gas.publicKey).instructions, gas, [])).toBeLessThanOrEqual(1232);
  });

  it('reads what is held from the token account, never from the SOL beside it', () => {
    expect(heldForPayout(USDC, { ...empty, walletLamports: 5_000_000n, walletQuote: { amount: 77n, lamports: RENT } })).toBe(77n);
    expect(heldForBuyback(USDC, { ...empty, potLamports: 5_000_000n, potQuote: { amount: 12n, lamports: RENT } })).toBe(12n);
    expect(heldForBuyback(SOL_PAIR, { ...empty, potLamports: 5_000_000n })).toBe(5_000_000n);
  });
});

describe('a buyback', () => {
  const gas = Keypair.generate().publicKey;
  const pot = Keypair.generate().publicKey;
  const market = fakeMarket();
  const wsol = new PublicKey(WSOL_MINT);
  const potWrapped = getAssociatedTokenAddressSync(wsol, pot, true);
  const potBase = getAssociatedTokenAddressSync(market.mint, pot, true);
  const marker: TransactionInstruction = { programId: new PublicKey(DBC_PROGRAM_ID), keys: [], data: Buffer.from([1]) };

  it('passes the temporary account\'s rent back to the gas tank and burns what the buy guarantees', () => {
    const swap = [createAssociatedTokenAccountIdempotentInstruction(gas, potWrapped, pot, wsol), createAssociatedTokenAccountIdempotentInstruction(gas, potBase, pot, market.mint), marker];
    const built = buybackInstructions({ swap, market, accounts: empty, gasTank: gas, pot, minimumOut: 990_000n });
    expect(built.rentOutlay).toBe(2n * RENT);
    expect(built.burn).toBe(990_000n);
    const refund = SystemInstruction.decodeTransfer(built.instructions[3] as TransactionInstruction);
    expect([refund.fromPubkey.toBase58(), refund.toPubkey.toBase58(), BigInt(refund.lamports)]).toEqual([pot.toBase58(), gas.toBase58(), RENT]);
    const burn = built.instructions[4] as TransactionInstruction;
    // BurnChecked: account, mint, authority; amount then decimals.
    expect(burn.programId.equals(TOKEN_PROGRAM_ID) && burn.data[0] === 15 && burn.data[9] === 6).toBe(true);
    expect(burn.keys.map((meta) => meta.pubkey.toBase58())).toEqual([potBase.toBase58(), market.mint.toBase58(), pot.toBase58()]);
    expect(burn.data.readBigUInt64LE(1)).toBe(990_000n);
  });

  it('burns what an earlier buy left behind as well, and takes no rent back when it opened nothing', () => {
    const built = buybackInstructions({ swap: [marker], market, accounts: { ...empty, potBase: { amount: 4_321n, lamports: RENT } }, gasTank: gas, pot, minimumOut: 1_000_000n });
    expect(built.rentOutlay).toBe(0n);
    expect(built.instructions).toHaveLength(2);
    expect((built.instructions[1] as TransactionInstruction).data.readBigUInt64LE(1)).toBe(1_004_321n);
  });

  it('takes no rent back for an account that was already there, even when the swap names it', () => {
    // The graduated pool's builder always names both accounts; the chain says the wrapped one exists.
    const swap = [createAssociatedTokenAccountIdempotentInstruction(gas, potWrapped, pot, wsol), createAssociatedTokenAccountIdempotentInstruction(gas, potBase, pot, market.mint), marker];
    const existing = { amount: 0n, lamports: RENT };
    const built = buybackInstructions({ swap, market, accounts: { ...empty, potQuote: existing, potBase: existing }, gasTank: gas, pot, minimumOut: 10n });
    expect(built.rentOutlay).toBe(0n);
    expect(built.instructions.some((instruction) => instruction.programId.equals(SystemProgram.programId))).toBe(false);
    expect(built.instructions).toHaveLength(4);
  });

  it('for another pair token, takes no SOL from the pot', () => {
    const usdcMarket = fakeMarket(USDC);
    const base = getAssociatedTokenAddressSync(usdcMarket.mint, pot, true);
    const built = buybackInstructions({ swap: [createAssociatedTokenAccountIdempotentInstruction(gas, base, pot, usdcMarket.mint), marker], market: usdcMarket, accounts: empty, gasTank: gas, pot, minimumOut: 5n });
    expect(built.rentOutlay).toBe(RENT);
    expect(built.instructions.some((instruction) => instruction.programId.equals(SystemProgram.programId))).toBe(false);
  });
});

describe('reading a module\'s accounts', () => {
  const wallet = Keypair.generate().publicKey;
  const pot = Keypair.generate().publicKey;
  const market = fakeMarket(USDC);
  const settings = settingsOf(5000, [3000, 2000], market.mint.toBase58());
  const quote = new PublicKey(USDC.mint);

  function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, programOwner: PublicKey = TOKEN_PROGRAM_ID): AccountInfo<Buffer> {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      { mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default },
      data,
    );
    return { owner: programOwner, data, lamports: Number(RENT), executable: false, rentEpoch: 0 };
  }
  const system = (lamports: number): AccountInfo<Buffer> => ({ owner: SystemProgram.programId, data: Buffer.alloc(0), lamports, executable: false, rentEpoch: 0 });

  it('asks for the wallet, the pot, their token accounts and each sharing wallet\'s account', () => {
    const addresses = moduleAccountAddresses(market, settings, wallet, pot);
    expect(addresses).toHaveLength(8);
    expect(addresses[1]?.equals(getAssociatedTokenAddressSync(quote, wallet, true))).toBe(true);
    expect(addresses[7]?.equals(getAssociatedTokenAddressSync(quote, new PublicKey(settings.wallets[1]?.address as string), true))).toBe(true);
    expect(moduleAccountAddresses(fakeMarket(), settings, wallet, pot)).toHaveLength(6);
  });

  it('takes a token account for what it is only when it is that owner\'s account for that mint', () => {
    const first = new PublicKey(settings.wallets[0]?.address as string);
    const infos = [
      system(1_000_000),
      tokenAccount(quote, wallet, 55n),
      // An account for the right mint that belongs to somebody else is not the wallet's.
      tokenAccount(market.mint, pot, 9n),
      null,
      tokenAccount(quote, pot, 7n),
      null,
      tokenAccount(quote, first, 0n),
      // Not a token account at all.
      system(5),
    ];
    const accounts = moduleAccountsFrom(market, settings, wallet, pot, infos);
    expect(accounts.walletLamports).toBe(1_000_000n);
    expect(accounts.walletQuote).toEqual({ amount: 55n, lamports: RENT });
    expect(accounts.walletBase).toBeNull();
    expect(accounts.potLamports).toBe(0n);
    expect(accounts.potQuote?.amount).toBe(7n);
    expect(accounts.potBase).toBeNull();
    expect(accounts.recipients).toEqual([{ amount: 0n, lamports: RENT }, null]);
  });
});

describe('finding a memo in a transaction list', () => {
  it('reads module memos out of the field the RPC returns, and nothing else', () => {
    const memo = encodeModuleMemo(settingsOf(5000, [5000]));
    expect(memosIn(`[${memo.length}] ${memo}`)).toEqual([memo]);
    expect(memosIn(`[5] hello; [${memo.length}] ${memo}`)).toEqual([memo]);
    expect(memosIn('[5] hello')).toEqual([]);
    expect(memosIn(null)).toEqual([]);
  });
});

/* ---------------- the service, against a chain that is not there ---------------- */

describe('switching modules on', () => {
  const openStore = tempStores('pcf-modules-');

  function setup(options: { accountInfo?: (address: PublicKey) => AccountInfo<Buffer> | null } = {}) {
    const seedText = newModuleSeed();
    const gasTank = gasTankOf(moduleSeedBytes(seedText)).publicKey.toBase58();
    const env = readEnv({ MODULES_ENABLED: 'YES', MODULES_MAINNET_ACK: 'YES', MODULES_SEED: seedText, MODULES_GAS_TANK: gasTank, DBC_CONFIG_300: ADDRESSES[1] });
    const store = openStore();
    const creators = new Map<string, string>();
    /** What this server last read for a token and still reuses, when that differs from the chain. */
    const remembered = new Map<string, string>();
    const reads: Array<{ mint: string; fresh: boolean }> = [];
    const chain = {
      connection: { getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map((address) => options.accountInfo?.(address) ?? null) },
      assertNetwork: async () => undefined,
      market: async (mint: string, fresh = false) => {
        reads.push({ mint, fresh });
        if (fresh) remembered.delete(mint);
        const creator = remembered.get(mint) ?? creators.get(mint);
        if (!creator) throw new Error('not listed');
        return { market: { creator: new PublicKey(creator) }, graduated: undefined };
      },
    };
    const logs: string[] = [];
    const modules = new Modules(env, chain as never, store, (line) => logs.push(line), fixedPriority(0));
    const list = (mint: string, creator: string): void => {
      store.upsertToken(
        { mint, pool: key(), config: ADDRESSES[1], fee_bps: 300, creator, name: 'T', symbol: 'T', uri: '', stage: 'curve', price_sol: '0', market_cap_sol: '0', progress: 0, reserve_lamports: '0', threshold_lamports: '0', fee_lamports: '0' },
        Date.now(),
      );
      creators.set(mint, creator);
    };
    return { env, store, modules, creators, remembered, reads, list, logs, seed: moduleSeedBytes(seedText), gasTank };
  }

  it('refuses to start with a seed that is not the one the gas tank address belongs to', () => {
    const env = readEnv({ MODULES_ENABLED: 'YES', MODULES_MAINNET_ACK: 'YES', MODULES_SEED: newModuleSeed(), MODULES_GAS_TANK: key() });
    expect(() => new Modules(env, {} as never, openStore(), () => undefined, fixedPriority(0))).toThrow(/not the seed MODULES_GAS_TANK belongs to/);
  });

  it('tells a creator where the role must go, and that address follows from the settings', async () => {
    const { modules, seed, store, list } = setup();
    const request = { mint: key(), dev: key(), burnBps: 5000, wallets: [{ address: key(), bps: 5000 }] };
    list(request.mint, request.dev);
    const prepared = await modules.prepare(request);
    expect(prepared.memo).toBe(encodeModuleMemo(checkModuleSettings(request)));
    expect(prepared.wallet).toBe(moduleWallets(seed, prepared.memo).wallet.publicKey.toBase58());
    expect(store.moduleOffer(prepared.wallet)).toMatchObject({ mint: request.mint, memo: prepared.memo });
    // Asking again gives the same answer; other settings give another wallet.
    expect((await modules.prepare(request)).wallet).toBe(prepared.wallet);
    expect((await modules.prepare({ ...request, burnBps: 4000, wallets: [{ address: request.wallets[0]?.address as string, bps: 6000 }] })).wallet).not.toBe(prepared.wallet);
  });

  it('refuses settings that do not add up, with the reason', async () => {
    const { modules } = setup();
    await expect(modules.prepare({ mint: key(), dev: key(), burnBps: 5000, wallets: [] })).rejects.toMatchObject({ status: 400, code: 'BAD_TOTAL' });
    await expect(modules.prepare({})).rejects.toBeInstanceOf(ModulesError);
  });

  it('refuses a sharing wallet that is a token account or a program\'s account', async () => {
    const tokenAccount = key();
    const funded = key();
    const { modules, list, gasTank } = setup({
      accountInfo: (address) =>
        address.toBase58() === tokenAccount
          ? { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165), lamports: 2_039_280, executable: false, rentEpoch: 0 }
          : address.toBase58() === funded
            ? { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 5_000_000, executable: false, rentEpoch: 0 }
            : null,
    });
    const mint = key();
    const dev = key();
    list(mint, dev);
    await expect(modules.prepare({ mint, dev, burnBps: 0, wallets: [{ address: tokenAccount, bps: 10_000 }] })).rejects.toMatchObject({ status: 400, code: 'BAD_WALLET' });
    await expect(modules.prepare({ mint, dev, burnBps: 0, wallets: [{ address: gasTank, bps: 10_000 }] })).rejects.toMatchObject({ status: 400, code: 'BAD_WALLET' });
    // A wallet that holds nothing yet, and one that holds SOL, are both fine.
    await expect(modules.prepare({ mint, dev, burnBps: 0, wallets: [{ address: key(), bps: 5000 }, { address: funded, bps: 5000 }] })).resolves.toBeTruthy();
  });

  it('offers a wallet only for a token it lists', async () => {
    const { modules, store } = setup();
    const request = { mint: key(), dev: key(), burnBps: 10_000, wallets: [] };
    await expect(modules.prepare(request)).rejects.toMatchObject({ status: 404, code: 'NOT_LISTED' });
    // Nothing was offered, so nothing can be claimed for that token later.
    expect(await modules.adopt(request.mint).catch(() => 'not listed')).toBe('not listed');
    expect(store.modules()).toEqual([]);
  });

  it('looks settings over before a token exists, and keeps nothing', async () => {
    const tokenAccount = key();
    const { modules, store } = setup({
      accountInfo: (address) => (address.toBase58() === tokenAccount ? { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165), lamports: 2_039_280, executable: false, rentEpoch: 0 } : null),
    });
    await expect(modules.check({ burnBps: 5000, wallets: [{ address: key(), bps: 5000 }] })).resolves.toEqual({ ok: true });
    await expect(modules.check({ burnBps: 10_000, wallets: [] })).resolves.toEqual({ ok: true });
    await expect(modules.check({ burnBps: 5000, wallets: [{ address: key(), bps: 4000 }] })).rejects.toMatchObject({ status: 400, code: 'BAD_TOTAL' });
    await expect(modules.check({ burnBps: 0, wallets: [{ address: tokenAccount, bps: 10_000 }] })).rejects.toMatchObject({ status: 400, code: 'BAD_WALLET' });
    await expect(modules.check({})).rejects.toMatchObject({ status: 400 });
    expect(store.moduleOffer(tokenAccount)).toBeUndefined();
  });

  it('for a listed token, takes settings only from the wallet that holds its creator role', async () => {
    const { modules, list } = setup();
    const mint = key();
    const dev = key();
    list(mint, dev);
    await expect(modules.prepare({ mint, dev: key(), burnBps: 10_000, wallets: [] })).rejects.toMatchObject({ status: 403, code: 'NOT_CREATOR' });
    await expect(modules.prepare({ mint, dev, burnBps: 10_000, wallets: [] })).resolves.toBeTruthy();
  });

  it('records a token\'s modules only once the chain shows the role in the wallet derived from them', async () => {
    const { modules, store, list, creators } = setup();
    const mint = key();
    const dev = key();
    list(mint, dev);
    const prepared = await modules.prepare({ mint, dev, burnBps: 2500, wallets: [{ address: key(), bps: 7500 }] });
    // Offered, but the creator has not handed the role over: nothing is on.
    expect(await modules.adopt(mint)).toBeUndefined();
    expect(modules.view(mint)).toBeNull();
    expect(modules.summary(mint)).toBeNull();
    creators.set(mint, prepared.wallet);
    const row = await modules.adopt(mint);
    expect(row).toMatchObject({ mint, dev, wallet: prepared.wallet, memo: prepared.memo, burn_bps: 2500 });
    expect(modules.summary(mint)).toEqual({ burnBps: 2500, wallets: 1 });
    expect(modules.view(mint)).toMatchObject({ dev, wallet: prepared.wallet, burnBps: 2500, totals: { paid: '0', spent: '0', burned: '0' }, stalled: false });
    expect(modules.view(mint)?.pot).toBe(row?.pot);
    // The token still shows the wallet that launched it as its creator, and is found under it.
    expect(store.token(mint)?.creator).toBe(dev);
    expect(store.tokensByCreator(dev).map((token) => token.mint)).toEqual([mint]);
    // Permanent: nothing more can be offered for it.
    await expect(modules.prepare({ mint, dev, burnBps: 10_000, wallets: [] })).rejects.toMatchObject({ status: 409, code: 'ALREADY_ON' });
  });

  it('shows the launching wallet as creator even when the listing is rebuilt after the hand-over', async () => {
    const { modules, store, list, creators } = setup();
    const mint = key();
    const dev = key();
    list(mint, dev);
    const prepared = await modules.prepare({ mint, dev, burnBps: 10_000, wallets: [] });
    creators.set(mint, prepared.wallet);
    // The listing was lost and read again from chain: the first thing it sees now is the module's wallet.
    store.setTokenCreator(mint, prepared.wallet);
    expect(store.token(mint)?.creator).toBe(prepared.wallet);
    expect(modules.offered(mint, prepared.wallet)).toBe(true);
    expect(modules.offered(mint, dev)).toBe(false);
    await modules.adopt(mint);
    expect(store.token(mint)?.creator).toBe(dev);
    expect(modules.view(mint)?.pot).not.toBeNull();
    expect(modules.offered(mint, prepared.wallet)).toBe(false);
  });

  it('cannot be talked into other settings: a memo counts only if its own wallet holds the role', async () => {
    const { modules, list, creators, seed } = setup();
    const mint = key();
    const dev = key();
    list(mint, dev);
    const real = await modules.prepare({ mint, dev, burnBps: 10_000, wallets: [] });
    creators.set(mint, real.wallet);
    const thief = key();
    const forged = encodeModuleMemo(checkModuleSettings({ mint, dev, burnBps: 0, wallets: [{ address: thief, bps: 10_000 }] }));
    expect(moduleWallets(seed, forged).wallet.publicKey.toBase58()).not.toBe(real.wallet);
    // The forged memo is handed in first; the true one is found among the offers.
    const row = await modules.adopt(mint, forged);
    expect(row?.memo).toBe(real.memo);
    expect(row?.wallets).toBe('[]');
  });

  it('accepts the true memo from anyone when the offer was forgotten, and a memo for another token never', async () => {
    const { modules, store, list, creators } = setup();
    const mint = key();
    const dev = key();
    list(mint, dev);
    const real = await modules.prepare({ mint, dev, burnBps: 10_000, wallets: [] });
    creators.set(mint, real.wallet);
    // Push the offer out with eight newer ones for the same token.
    for (let index = 0; index < 8; index += 1) store.saveModuleOffer({ wallet: key(), mint, memo: 'x' }, Date.now() + 1 + index);
    expect(store.moduleOffer(real.wallet)).toBeUndefined();
    expect(await modules.adopt(mint)).toBeUndefined();
    const other = key();
    list(other, real.wallet);
    expect(await modules.adopt(other, real.memo)).toBeUndefined();
    expect((await modules.adopt(mint, real.memo))?.wallet).toBe(real.wallet);
  });

  it('asks the chain again when a memo arrives before its own read has caught up with the hand-over', async () => {
    const { modules, store, creators, remembered, reads, list } = setup();
    const mint = key();
    const dev = key();
    list(mint, dev);
    const prepared = await modules.prepare({ mint, dev, burnBps: 10_000, wallets: [] });
    // The hand-over has confirmed, and this server still reuses the read it made a second before it.
    creators.set(mint, prepared.wallet);
    remembered.set(mint, dev);
    reads.length = 0;
    expect(await modules.adopt(mint, prepared.memo)).toMatchObject({ mint, dev, wallet: prepared.wallet });
    expect(reads).toEqual([{ mint, fresh: false }, { mint, fresh: true }]);
    expect(store.module(mint)?.memo).toBe(prepared.memo);
  });

  it('does not ask the chain again for a memo that could not be the one just signed', async () => {
    const { modules, reads, list, seed } = setup();
    const mint = key();
    const dev = key();
    list(mint, dev);
    // No memo, a memo for another token, a memo naming another wallet as the one that switched it on, and noise.
    const other = encodeModuleMemo(checkModuleSettings({ mint: key(), dev, burnBps: 10_000, wallets: [] }));
    const stranger = encodeModuleMemo(checkModuleSettings({ mint, dev: key(), burnBps: 10_000, wallets: [] }));
    for (const memo of [undefined, other, stranger, 'pcf:modules:1|nonsense', 'x'.repeat(500)]) {
      reads.length = 0;
      expect(await modules.adopt(mint, memo)).toBeUndefined();
      expect(reads).toEqual([{ mint, fresh: false }]);
    }
    // The true settings, before the hand-over: the chain is asked, still says the launcher, and nothing is recorded.
    const real = encodeModuleMemo(checkModuleSettings({ mint, dev, burnBps: 10_000, wallets: [] }));
    reads.length = 0;
    expect(await modules.adopt(mint, real)).toBeUndefined();
    expect(reads).toEqual([{ mint, fresh: false }, { mint, fresh: true }]);
    expect(moduleWallets(seed, real).wallet.publicKey.toBase58()).not.toBe(dev);
  });
});

describe('the modules ledger in the database', () => {
  const store = tempStores('pcf-modules-db-');

  it('keeps at most eight offers per token, the newest ones', () => {
    const db = store();
    const mint = key();
    const wallets = Array.from({ length: 12 }, () => key());
    wallets.forEach((wallet, index) => db.saveModuleOffer({ wallet, mint, memo: `m${index}` }, 1_000 + index));
    expect(wallets.map((wallet) => db.moduleOffer(wallet) !== undefined)).toEqual([false, false, false, false, true, true, true, true, true, true, true, true]);
    // Another token's offers are not touched by this one's.
    const elsewhere = key();
    db.saveModuleOffer({ wallet: elsewhere, mint: key(), memo: 'z' }, 1);
    for (let index = 0; index < 9; index += 1) db.saveModuleOffer({ wallet: key(), mint, memo: 'n' }, 5_000 + index);
    expect(db.moduleOffer(elsewhere)).toBeDefined();
  });

  it('adds every event to the running totals and lists the newest first', () => {
    const db = store();
    const mint = key();
    expect(db.saveModule({ mint, dev: key(), wallet: key(), pot: key(), memo: 'm', burn_bps: 5000, wallets: '[]', activated_at: 1 })).toBe(true);
    // A second record for the same token never replaces the first.
    expect(db.saveModule({ mint, dev: key(), wallet: key(), pot: key(), memo: 'other', burn_bps: 0, wallets: '[]', activated_at: 2 })).toBe(false);
    expect(db.module(mint)?.memo).toBe('m');
    db.addModuleEvent({ mint, kind: 'payout', signature: 's1', quote: '1000', tokens: '0', at: 10 }, { paid: 600n });
    db.addModuleEvent({ mint, kind: 'buyback', signature: 's2', quote: '400', tokens: '9000', at: 20 }, { spent: 400n, burned: 9000n });
    db.addModuleEvent({ mint, kind: 'payout', signature: 's3', quote: '50', tokens: '0', at: 30 }, { paid: 30n });
    expect(db.module(mint)).toMatchObject({ paid: '630', spent: '400', burned: '9000' });
    expect(db.moduleEvents(mint).map((event) => event.signature)).toEqual(['s3', 's2', 's1']);
    db.noteModulePass(mint, 99, 'it would fail');
    expect(db.module(mint)).toMatchObject({ last_pass_at: 99, last_error: 'it would fail' });
    db.noteModulePass(mint, 100, '');
    expect(db.module(mint)?.last_error).toBe('');
    expect(db.modules().map((row) => row.mint)).toEqual([mint]);
  });

  it('remembers which creator a token had when no module memo was found for it', () => {
    const db = store();
    const mint = key();
    expect(db.moduleExamined(mint)).toBeUndefined();
    db.markModuleExamined(mint, 'a', 5);
    db.markModuleExamined(mint, 'b', 6);
    expect(db.moduleExamined(mint)).toEqual({ creator: 'b', at: 6 });
  });
});

describe('module settings in the environment', () => {
  const seed = newModuleSeed();
  const gasTank = gasTankOf(moduleSeedBytes(seed)).publicKey.toBase58();

  it('is off by default, with the documented limits', () => {
    const env = readEnv({});
    expect(env.modules).toMatchObject({ enabled: false, seed: undefined, gasTank: undefined, everyMinutes: 15, minLamports: 20_000_000n, maxBuyLamports: 1_000_000_000n, slippageBps: 100, dryRun: false });
  });

  it('needs the seed, the gas tank address and the acknowledgement to be switched on', () => {
    expect(() => readEnv({ MODULES_ENABLED: 'YES' })).toThrow(/needs MODULES_SEED/);
    expect(() => readEnv({ MODULES_ENABLED: 'YES', MODULES_SEED: seed })).toThrow(/MODULES_MAINNET_ACK/);
    expect(() => readEnv({ MODULES_ENABLED: 'YES', MODULES_SEED: seed, MODULES_MAINNET_ACK: 'YES' })).toThrow(/needs MODULES_GAS_TANK/);
    expect(() => readEnv({ MODULES_ENABLED: 'YES', MODULES_SEED: 'not base58 !', MODULES_MAINNET_ACK: 'YES', MODULES_GAS_TANK: gasTank })).toThrow(/MODULES_SEED does not look like/);
    const env = readEnv({ MODULES_ENABLED: 'YES', MODULES_SEED: seed, MODULES_MAINNET_ACK: 'YES', MODULES_GAS_TANK: gasTank, MODULES_DRY_RUN: 'YES', MODULES_EVERY_MINUTES: '30' });
    expect(env.modules).toMatchObject({ enabled: true, seed, gasTank, dryRun: true, everyMinutes: 30 });
  });
});

/* ---------------- what the creator signs, and what the pages say ---------------- */

describe('the transaction that switches modules on', () => {
  const mint = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const wallet = Keypair.generate().publicKey;
  const memo = encodeModuleMemo(checkModuleSettings({ mint: mint.toBase58(), dev: creator.toBase58(), burnBps: 100, wallets: [2475, 2475, 2475, 2475].map((bps) => ({ address: key(), bps })) }));

  it('hands the role to the module wallet and carries the settings, both signed by the creator alone', async () => {
    const instructions = await moduleActivationInstructions(dbc, { mint, pool, config, creator, modules: { wallet, memo } });
    expect(instructions).toHaveLength(2);
    const [transfer, note] = instructions;
    expect(transfer?.programAddress).toBe(DBC_PROGRAM_ID);
    expect(transfer?.accounts?.[0]?.address).toBe(pool.toBase58());
    expect(transfer?.accounts?.[3]?.address).toBe(wallet.toBase58());
    expect(note?.programAddress).toBe(MEMO_PROGRAM_ID);
    expect(new TextDecoder().decode(note?.data)).toBe(memo);
    expect(requiredSigners(kitAddress(creator.toBase58()), instructions)).toEqual([creator.toBase58()]);
  });

  it('fits a version 1 transaction many times over, even with four wallets', async () => {
    const instructions = await moduleActivationInstructions(dbc, { mint, pool, config, creator, modules: { wallet, memo } });
    const transaction = composeV1({
      feePayer: kitAddress(creator.toBase58()),
      lifetime: { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 1n },
      instructions,
      computeUnitLimit: COMPUTE_UNITS.moduleActivation,
    });
    expect(getTransactionSize(transaction)).toBeLessThan(900);
  });

  it('refuses settings written for another token, or for another creator', async () => {
    await expect(moduleActivationInstructions(dbc, { mint: Keypair.generate().publicKey, pool, config, creator, modules: { wallet, memo } })).rejects.toThrow(/another token or another creator/);
    await expect(moduleActivationInstructions(dbc, { mint, pool, config, creator: Keypair.generate().publicKey, modules: { wallet, memo } })).rejects.toThrow(/another token or another creator/);
    await expect(moduleActivationInstructions(dbc, { mint, pool, config, creator, modules: { wallet, memo: 'pcf:modules:1|nonsense' } })).rejects.toThrow(/not a fee module memo/);
  });
});

describe('what the pages say about a token\'s modules', () => {
  it('labels a token in a list by what happens to its creator fees', () => {
    expect(moduleTag({ modules: null })).toBe('');
    expect(moduleTag({ modules: { burnBps: 10_000, wallets: 0 } })).toBe('FEES BURN');
    expect(moduleTag({ modules: { burnBps: 2500, wallets: 2 } })).toBe('BURN 25%');
    expect(moduleTag({ modules: { burnBps: 0, wallets: 3 } })).toBe('FEES SHARED');
  });

  it('puts a choice in one line', () => {
    expect(choiceText({ burnBps: 5000, wallets: [{ address: 'So11111111111111111111111111111111111111112', bps: 5000 }] })).toMatch(/^50% buyback and burn · 50% to So11…1112$/);
    expect(choiceText({ burnBps: 10_000, wallets: [] })).toBe('100% buyback and burn');
  });

  it('shows the settings, the totals in the pair token, and each event with its transaction', () => {
    const dev = key();
    const other = key();
    const html = moduleHtml(
      {
        dev,
        wallet: key(),
        pot: key(),
        burnBps: 2500,
        wallets: [{ address: dev, bps: 5000 }, { address: other, bps: 2500 }],
        memo: 'm',
        since: Date.now() - 60_000,
        totals: { paid: '1500000000', spent: '500000000', burned: '123000000' },
        events: [
          { kind: 'buyback', signature: 'sigB', at: Date.now(), quote: '500000000', tokens: '123000000' },
          { kind: 'payout', signature: 'sigA<script>', at: Date.now(), quote: '2000000000', tokens: '0' },
        ],
        lastPassAt: Date.now(),
        stalled: true,
        needsAccounts: false,
      },
      { id: 'SOL', symbol: 'SOL', mint: WSOL_MINT, decimals: 9 },
      null,
    );
    expect(html).toContain('<dt>Bought back and burned</dt><dd>25%</dd>');
    expect(html).toMatch(/\(the creator\)<\/dt><dd>50%<\/dd>/);
    expect(html).toContain('<dt>Paid to wallets so far</dt><dd>1.5 SOL</dd>');
    expect(html).toContain('<dt>Spent on buybacks so far</dt><dd>0.5 SOL</dd>');
    expect(html).toContain('123 tokens');
    expect(html).toContain('0.5 SOL spent · 123 tokens burned');
    expect(html).toContain('2 SOL divided');
    expect(html).toContain('could not finish');
    // Whatever a signature holds, it reaches the page as text and nothing else.
    expect(html).not.toContain('<script>');
    expect(html).toContain('sigA%3Cscript%3E');
  });

  it('says what a payout is waiting for when a sharing wallet has no account for the pair token', () => {
    const html = moduleHtml(
      { dev: key(), wallet: key(), pot: null, burnBps: 0, wallets: [{ address: key(), bps: 10_000 }], memo: 'm', since: Date.now(), totals: { paid: '0', spent: '0', burned: '0' }, events: [], lastPassAt: Date.now(), stalled: true, needsAccounts: true },
      { id: 'USDC', symbol: 'USDC', mint: USDC.mint, decimals: 6 },
      null,
    );
    expect(html).toContain('The payout is waiting: a wallet it pays has no USDC account. The server opens one for each wallet once');
    expect(html).toContain('sending a wallet any amount of USDC opens one');
    expect(html).not.toContain('could not finish');
  });

  it('says so when nothing has happened yet, and leaves the pot out when nothing is burned', () => {
    const html = moduleHtml(
      { dev: key(), wallet: key(), pot: null, burnBps: 0, wallets: [{ address: key(), bps: 10_000 }], memo: 'm', since: Date.now(), totals: { paid: '0', spent: '0', burned: '0' }, events: [], lastPassAt: 0, stalled: false, needsAccounts: false },
      { id: 'USDC', symbol: 'USDC', mint: USDC.mint, decimals: 6 },
      null,
    );
    expect(html).toContain('NOTHING YET');
    expect(html).not.toContain('Buyback pot');
    expect(html).not.toContain('Spent on buybacks');
    expect(html).toContain('Not looked at yet.');
  });
});

/* ---------------- a whole pass, against a chain that answers from a script ---------------- */

describe('a pass of the keeper', () => {
  const openStore = tempStores('pcf-keeper-');

  /**
   * A token priced in SOL whose fees are shared 60/40 between two wallets, on
   * a chain that holds `fee` lamports of unclaimed creator fees and gives the
   * gas tank `gas` lamports. `simulation` is what the chain answers when a
   * transaction is run against it.
   */
  async function world(options: {
    fee: bigint;
    gas?: number;
    dryRun?: boolean;
    simulation?: { err: unknown; logs?: string[] };
    /** How many of the first sends the RPC rejects. */
    sendsRefused?: number;
    /** What the RPC answers, in order, when asked whether the transaction confirmed. After these: confirmed. */
    statuses?: Array<'unreachable' | 'unseen' | 'failed'>;
    /** The chain's block height. The blockhash handed out is good up to 1,000. */
    blockHeight?: number;
    /** The pair token the token is priced in. SOL unless given; any other counts 100 of its tokens as one SOL. */
    pair?: typeof USDC;
  }) {
    const seedText = newModuleSeed();
    const seed = moduleSeedBytes(seedText);
    const gasTank = gasTankOf(seed).publicKey;
    const env = readEnv({
      MODULES_ENABLED: 'YES',
      MODULES_MAINNET_ACK: 'YES',
      MODULES_SEED: seedText,
      MODULES_GAS_TANK: gasTank.toBase58(),
      MODULES_DRY_RUN: options.dryRun ? 'YES' : 'NO',
      DBC_CONFIG_300: ADDRESSES[1],
    });
    const store = openStore();
    const mint = Keypair.generate().publicKey;
    const dev = key();
    const first = key();
    const second = key();
    const lamports = new Map<string, number>([[gasTank.toBase58(), options.gas ?? 100_000_000]]);
    /** Token accounts that exist on this chain, by address. */
    const tokenAccounts = new Map<string, AccountInfo<Buffer>>();
    const sent: Buffer[] = [];
    const logs: string[] = [];
    const statuses = [...(options.statuses ?? [])];
    let attempts = 0;
    let creator = dev;
    const market = { ...fakeMarket(options.pair ?? SOL_PAIR), mint, stage: 'curve' as const };
    (market.state.poolState as { creatorQuoteFee: BN }).creatorQuoteFee = new BN(options.fee.toString());
    const chain = {
      dbc,
      connection: {
        getBalance: async (address: PublicKey) => lamports.get(address.toBase58()) ?? 0,
        getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
          addresses.map((address) => {
            const account = tokenAccounts.get(address.toBase58());
            if (account) return account;
            const held = lamports.get(address.toBase58());
            return held ? { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: held, executable: false, rentEpoch: 0 } : null;
          }),
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
        simulateTransaction: async () => ({ value: { err: options.simulation?.err ?? null, logs: options.simulation?.logs ?? [], unitsConsumed: 80_000 } }),
        sendRawTransaction: async (raw: Uint8Array) => {
          attempts += 1;
          if (attempts <= (options.sendsRefused ?? 0)) throw new Error('503 Service Unavailable');
          sent.push(Buffer.from(raw));
          return 'sent';
        },
        getSignatureStatuses: async () => {
          const next = statuses.shift();
          if (next === 'unreachable') throw new Error('fetch failed');
          if (next === 'unseen') return { value: [null] };
          if (next === 'failed') return { value: [{ err: { InstructionError: [2, 'Custom'] }, confirmationStatus: 'confirmed' }] };
          return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
        },
        getBlockHeight: async () => options.blockHeight ?? 1,
      },
      assertNetwork: async () => undefined,
      rate: () => (options.pair ? 100 : 1),
      market: async () => ({ market: { ...market, creator: new PublicKey(creator) }, graduated: undefined }),
    };
    // The waits between looks at a sent transaction are skipped: the scripted chain answers at once.
    const modules = new Modules(env, chain as never, store, (line) => logs.push(line), fixedPriority(0), async () => undefined);
    store.upsertToken(
      { mint: mint.toBase58(), pool: market.pool.toBase58(), config: ADDRESSES[1], fee_bps: 300, creator: dev, name: 'T', symbol: 'TKN', uri: '', stage: 'curve', price_sol: '0', market_cap_sol: '0', progress: 0, reserve_lamports: '0', threshold_lamports: '0', fee_lamports: '0' },
      Date.now(),
    );
    const prepared = await modules.prepare({ mint: mint.toBase58(), dev, burnBps: 0, wallets: [{ address: first, bps: 6000 }, { address: second, bps: 4000 }] });
    creator = prepared.wallet;
    await modules.adopt(mint.toBase58());
    /** Opens `owner`'s account for the pair token on this chain, as the owner or anyone else could. */
    const openAccount = (owner: string): void => {
      const quoteMint = new PublicKey((options.pair ?? SOL_PAIR).mint);
      const data = Buffer.alloc(ACCOUNT_SIZE);
      AccountLayout.encode(
        { mint: quoteMint, owner: new PublicKey(owner), amount: 0n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default },
        data,
      );
      tokenAccounts.set(getAssociatedTokenAddressSync(quoteMint, new PublicKey(owner), true).toBase58(), { owner: TOKEN_PROGRAM_ID, data, lamports: Number(RENT), executable: false, rentEpoch: 0 });
    };
    return { modules, store, mint: mint.toBase58(), sent, logs, gasTank, wallet: new PublicKey(prepared.wallet), first, second, lamports, openAccount };
  }

  const systemTransfers = (transaction: Transaction) =>
    transaction.instructions
      .filter((instruction) => instruction.programId.equals(SystemProgram.programId))
      .map((instruction) => SystemInstruction.decodeTransfer(instruction))
      .map((transfer) => [transfer.fromPubkey.toBase58(), transfer.toPubkey.toBase58(), BigInt(transfer.lamports)] as const);

  it('claims the fees and pays each wallet its share in one transaction the gas tank pays for', async () => {
    const { modules, store, mint, sent, gasTank, wallet, first, second, logs } = await world({ fee: 100_000_003n });
    await modules.pass();
    expect(sent).toHaveLength(1);
    const transaction = Transaction.from(sent[0] as Buffer);
    expect(transaction.feePayer?.equals(gasTank)).toBe(true);
    expect(transaction.verifySignatures()).toBe(true);
    expect(transaction.signatures.map((entry) => entry.publicKey.toBase58())).toEqual([gasTank.toBase58(), wallet.toBase58()]);
    // The budget first, sized from the run against the chain: 80,000 used, a quarter more, and 20,000.
    const [budget] = transaction.instructions;
    expect(budget?.programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
    expect(budget?.data[0]).toBe(2);
    expect(budget?.data.readUInt32LE(1)).toBe(120_000);
    expect(transaction.instructions.map((instruction) => instruction.programId.toBase58()).slice(1)).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      DBC_PROGRAM_ID,
      TOKEN_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
      SystemProgram.programId.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    // The temporary account's rent back to the gas tank, then 60% and 40%, each rounded down, and the
    // one unit rounding left over to the first wallet. Together: every lamport that was claimed.
    expect(systemTransfers(transaction)).toEqual([
      [wallet.toBase58(), gasTank.toBase58(), RENT],
      [wallet.toBase58(), first, 60_000_002n],
      [wallet.toBase58(), second, 40_000_001n],
    ]);
    expect(store.moduleEvents(mint)).toMatchObject([{ kind: 'payout', quote: '100000003', tokens: '0' }]);
    expect(store.module(mint)).toMatchObject({ paid: '100000003', spent: '0', burned: '0', last_error: '' });
    expect(store.module(mint)?.last_pass_at).toBeGreaterThan(0);
    expect(modules.view(mint)).toMatchObject({ stalled: false, totals: { paid: '100000003' } });
    expect(logs.some((line) => /TKN: paying out 0\.100000003 SOL/.test(line))).toBe(true);
  });

  it('adds what the fee wallet already holds, and claims nothing when there is nothing to claim', async () => {
    const built = await world({ fee: 0n });
    built.lamports.set(built.wallet.toBase58(), 50_000_000);
    await built.modules.pass();
    expect(built.sent).toHaveLength(1);
    const transaction = Transaction.from(built.sent[0] as Buffer);
    expect(transaction.instructions.some((instruction) => instruction.programId.toBase58() === DBC_PROGRAM_ID)).toBe(false);
    expect(systemTransfers(transaction)).toEqual([
      [built.wallet.toBase58(), built.first, 30_000_000n],
      [built.wallet.toBase58(), built.second, 20_000_000n],
    ]);
  });

  it('waits while the fees are below what a pass acts on, without calling that a problem', async () => {
    const { modules, store, mint, sent } = await world({ fee: 19_999_999n });
    await modules.pass();
    expect(sent).toHaveLength(0);
    expect(store.moduleEvents(mint)).toEqual([]);
    expect(store.module(mint)).toMatchObject({ last_error: '' });
    expect(store.module(mint)?.last_pass_at).toBeGreaterThan(0);
  });

  it('in a dry run, runs the payout against the chain and sends nothing', async () => {
    const { modules, store, mint, sent, logs } = await world({ fee: 100_000_000n, dryRun: true });
    await modules.pass();
    expect(sent).toHaveLength(0);
    expect(store.moduleEvents(mint)).toEqual([]);
    expect(store.module(mint)).toMatchObject({ paid: '0', last_error: '' });
    expect(logs.some((line) => /DRY RUN, not sent: TKN: paying out 0\.1 SOL .* It passed its run against the chain/.test(line))).toBe(true);
  });

  it('sends nothing when the run against the chain fails, and says why', async () => {
    const { modules, store, mint, sent, logs } = await world({ fee: 100_000_000n, simulation: { err: { InstructionError: [3, 'Custom'] }, logs: ['Program log: no'] } });
    await modules.pass();
    expect(sent).toHaveLength(0);
    expect(store.module(mint)?.last_error).toMatch(/it would fail, so it was not sent: .*InstructionError.*Program log: no/);
    expect(modules.view(mint)?.stalled).toBe(true);
    expect(logs.some((line) => /this pass did not finish and will be tried again/.test(line))).toBe(true);
    expect((await modules.overview()).modules).toMatchObject([{ mint, stalled: true, symbol: 'TKN', settings: expect.stringMatching(/^60% to .* · 40% to /) }]);
  });

  it('keeps asking when the RPC does not answer, and records the payout once the chain confirms it', async () => {
    const { modules, store, mint, sent } = await world({ fee: 100_000_000n, statuses: ['unreachable', 'unseen'] });
    await modules.pass();
    // Sent, then sent again after each look that did not find it: the same signed bytes every time.
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((raw) => raw.toString('base64'))).size).toBe(1);
    expect(store.moduleEvents(mint)).toMatchObject([{ kind: 'payout', quote: '100000000' }]);
    expect(store.module(mint)).toMatchObject({ paid: '100000000', last_error: '' });
  });

  it('goes on to look for a transaction whose first send the RPC refused', async () => {
    const { modules, store, mint, sent } = await world({ fee: 100_000_000n, sendsRefused: 1, statuses: ['unseen'] });
    await modules.pass();
    expect(sent).toHaveLength(1);
    expect(store.moduleEvents(mint)).toMatchObject([{ kind: 'payout', quote: '100000000' }]);
    expect(store.module(mint)).toMatchObject({ paid: '100000000', last_error: '' });
  });

  it('records nothing for a transaction that failed on chain, and says so', async () => {
    const { modules, store, mint } = await world({ fee: 100_000_000n, statuses: ['failed'] });
    await modules.pass();
    expect(store.moduleEvents(mint)).toEqual([]);
    expect(store.module(mint)).toMatchObject({ paid: '0' });
    expect(store.module(mint)?.last_error).toMatch(/failed on chain: .*InstructionError/);
  });

  it('records nothing for a transaction that expired, and says that nothing moved', async () => {
    const { modules, store, mint } = await world({ fee: 100_000_000n, sendsRefused: 99, statuses: ['unseen', 'unseen'], blockHeight: 1_001 });
    await modules.pass();
    expect(store.moduleEvents(mint)).toEqual([]);
    expect(store.module(mint)?.last_error).toMatch(/expired before it confirmed\. The RPC refused it: 503 Service Unavailable\. Nothing moved/);
  });

  it('does not claim to know what happened when the RPC stays silent past the expiry', async () => {
    const { modules, store, mint } = await world({ fee: 100_000_000n, statuses: ['unseen', 'unreachable'], blockHeight: 1_001 });
    await modules.pass();
    expect(store.moduleEvents(mint)).toEqual([]);
    expect(store.module(mint)?.last_error).toMatch(/it is not known whether transaction \S+ confirmed/);
  });

  it("opens each sharing wallet's token account once, and waits when one is closed again", async () => {
    // 10 USDC of fees, shared 60/40. Neither wallet has a USDC account, and on this chain an account
    // the server opens is gone again by the next pass: its owner closed it and kept the rent.
    const { modules, store, mint, sent, gasTank, first, second, openAccount } = await world({ fee: 10_000_000n, pair: USDC });
    const programsOf = (raw: Buffer): string[] => Transaction.from(raw).instructions.slice(1).map((instruction) => instruction.programId.toBase58());
    await modules.pass();
    expect(sent).toHaveLength(1);
    expect(programsOf(sent[0] as Buffer)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID]);
    // The gas tank pays, and nobody else signs.
    expect(Transaction.from(sent[0] as Buffer).signatures.map((entry) => entry.publicKey.toBase58())).toEqual([gasTank.toBase58()]);
    expect(store.moduleEvents(mint).map((event) => event.kind)).toEqual(['setup']);
    expect([...store.moduleOpened(mint)].sort()).toEqual([first, second].sort());
    expect(modules.view(mint)).toMatchObject({ stalled: false, needsAccounts: false });

    // It does not pay for them a second time, on this pass or any later one. The page is told why.
    await modules.pass();
    await modules.pass();
    expect(sent).toHaveLength(1);
    expect(store.module(mint)?.last_error).toMatch(/^payout waiting on token accounts: 2 sharing wallets have no USDC account/);
    expect(modules.view(mint)).toMatchObject({ stalled: true, needsAccounts: true });

    // One wallet's account is not enough.
    openAccount(first);
    await modules.pass();
    expect(sent).toHaveLength(1);
    expect(store.module(mint)?.last_error).toMatch(/^payout waiting on token accounts: 1 sharing wallet has no USDC account/);

    // With both there, the payout goes ahead, and the fees were waiting all along.
    openAccount(second);
    await modules.pass();
    expect(sent).toHaveLength(2);
    expect(programsOf(sent[1] as Buffer)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, DBC_PROGRAM_ID, TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58()]);
    expect(store.moduleEvents(mint).map((event) => event.kind)).toEqual(['payout', 'setup']);
    expect(store.module(mint)).toMatchObject({ paid: '10000000', last_error: '' });
    expect(modules.view(mint)).toMatchObject({ stalled: false, needsAccounts: false });
  });

  it('opens the account of a wallet it has not opened one for, while another wallet is waited for', async () => {
    const { modules, store, mint, sent, first, second } = await world({ fee: 10_000_000n, pair: USDC });
    // The first wallet's account was opened by this server before, and closed since.
    store.markModuleOpened(mint, [first], Date.now());
    await modules.pass();
    expect(sent).toHaveLength(1);
    const creates = Transaction.from(sent[0] as Buffer).instructions.slice(1);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.keys[2]?.pubkey.toBase58()).toBe(second);
    expect([...store.moduleOpened(mint)].sort()).toEqual([first, second].sort());
    await modules.pass();
    expect(sent).toHaveLength(1);
    expect(modules.view(mint)).toMatchObject({ needsAccounts: true });
  });

  it('sends nothing while the gas tank is nearly empty, and asks for SOL', async () => {
    const { modules, sent, logs, gasTank } = await world({ fee: 100_000_000n, gas: 1_000_000 });
    await modules.pass();
    expect(sent).toHaveLength(0);
    expect(logs.some((line) => line.includes(`the gas tank ${gasTank.toBase58()} holds 0.001 SOL`))).toBe(true);
    expect((await modules.overview()).gasTank).toEqual({ address: gasTank.toBase58(), lamports: '1000000' });
  });
});
