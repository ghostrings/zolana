import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';

import { INITIAL_SUPPLY_UNITS } from '../shared/src/constants.js';
import { mintAuthorityOf, mintSupply } from '../shared/src/meteora.js';
import { percentOf } from '../shared/src/units.js';
import { marketCapText } from '../web/src/format.js';
import {
  BURN_WORD,
  RECIPIENT_HINTS,
  type RecipientKind,
  RecipientChecker,
  SEND_VISIBILITY,
  burnConfirmed,
  burnEffect,
  burnVisibility,
  classifyRecipient,
  recipientUsable,
} from '../web/src/moves.js';
import { MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const me = Keypair.generate().publicKey.toBase58();
const them = Keypair.generate().publicKey.toBase58();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('who a private transfer can go to', () => {
  it('reads what the text alone says', () => {
    expect(classifyRecipient('', me)).toBe('empty');
    expect(classifyRecipient('   ', me)).toBe('empty');
    expect(classifyRecipient('not an address', me)).toBe('invalid');
    expect(classifyRecipient(them.slice(0, 20), me)).toBe('invalid');
    expect(classifyRecipient(`  ${me} `, me)).toBe('self');
    expect(classifyRecipient(` ${them}\n`, me)).toBe('candidate');
    // Before a wallet is unlocked there is no "own" address to compare with.
    expect(classifyRecipient(them, '')).toBe('candidate');
  });

  it('asks the chain only about a real address that is not the sender’s own', async () => {
    const asked: string[] = [];
    const checker = new RecipientChecker(async (address) => {
      asked.push(address);
      return true;
    });
    const answers: RecipientKind[] = [];
    expect(checker.look('', me, (kind) => answers.push(kind))).toBe('empty');
    expect(checker.look('nonsense', me, (kind) => answers.push(kind))).toBe('invalid');
    expect(checker.look(me, me, (kind) => answers.push(kind))).toBe('self');
    expect(asked).toEqual([]);
    expect(checker.look(them, me, (kind) => answers.push(kind))).toBe('checking');
    await tick();
    expect(asked).toEqual([them]);
    expect(answers).toEqual(['registered']);
  });

  it('remembers a registered address and asks again about one that is not', async () => {
    let registered = false;
    let asks = 0;
    const checker = new RecipientChecker(async () => {
      asks += 1;
      return registered;
    });
    const answers: RecipientKind[] = [];
    expect(checker.look(them, me, (kind) => answers.push(kind))).toBe('checking');
    await tick();
    expect(answers).toEqual(['unregistered']);
    // Its owner registers in the meantime: the next look finds out.
    registered = true;
    expect(checker.look(them, me, (kind) => answers.push(kind))).toBe('checking');
    await tick();
    expect(answers).toEqual(['unregistered', 'registered']);
    // Registration is permanent, so it is not asked about a third time.
    expect(checker.look(them, me, (kind) => answers.push(kind))).toBe('registered');
    expect(asks).toBe(2);
  });

  it('drops an answer that arrives after something newer was typed', async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const waiting: Array<(value: boolean) => void> = [];
    const checker = new RecipientChecker(() => new Promise<boolean>((resolve) => waiting.push(resolve)));
    const answers: RecipientKind[] = [];
    checker.look(them, me, (kind) => answers.push(kind));
    checker.look(other, me, (kind) => answers.push(kind));
    // The first address answers late, and says "registered". The field holds the second.
    (waiting[0] as (value: boolean) => void)(true);
    await tick();
    expect(answers).toEqual([]);
    (waiting[1] as (value: boolean) => void)(false);
    await tick();
    expect(answers).toEqual(['unregistered']);
  });

  it('does not take a failed check for a no', async () => {
    const checker = new RecipientChecker(() => Promise.reject(new Error('network')));
    const answers: RecipientKind[] = [];
    expect(checker.look(them, me, (kind) => answers.push(kind))).toBe('checking');
    await tick();
    expect(answers).toEqual(['unknown']);
    expect(recipientUsable('unknown')).toBe(true);
    expect(recipientUsable('registered')).toBe(true);
    for (const kind of ['empty', 'invalid', 'self', 'checking', 'unregistered'] as const) expect(recipientUsable(kind)).toBe(false);
  });

  it('has something to say in every state', () => {
    for (const kind of ['empty', 'invalid', 'self', 'checking', 'registered', 'unregistered', 'unknown'] as const) {
      expect(RECIPIENT_HINTS[kind].length).toBeGreaterThan(10);
    }
    // The way round an unregistered address is named, and named as public.
    expect(RECIPIENT_HINTS.unregistered).toMatch(/Register/);
    expect(RECIPIENT_HINTS.unregistered).toMatch(/withdraw.*public/i);
  });
});

describe('what an observer sees', () => {
  it('of a private transfer: the wallets, and nothing about what moved', () => {
    const hidden = SEND_VISIBILITY.filter(([, , isHidden]) => isHidden).map(([label]) => label);
    expect(hidden).toEqual(['Which token', 'How much']);
    expect(SEND_VISIBILITY.filter(([, , isHidden]) => !isHidden).map(([, value]) => value)).toEqual(['PUBLIC', 'PUBLIC']);
  });

  it('of a burn: everything about the burn, whichever balance it came from', () => {
    for (const source of ['private', 'public'] as const) {
      const rows = burnVisibility(source);
      expect(rows.slice(0, 3).every(([, value, hidden]) => value === 'PUBLIC' && !hidden)).toBe(true);
      expect(rows[1]?.[0]).toMatch(/how much was burned/);
    }
    // Only a burn from the private balance leaves something hidden: what is still held there.
    expect(burnVisibility('private').filter(([, , hidden]) => hidden)).toHaveLength(1);
    expect(burnVisibility('public').filter(([, , hidden]) => hidden)).toHaveLength(0);
  });
});

describe('what a burn does to the supply', () => {
  const million = 1_000_000n * 1_000_000n;

  it('takes exactly the amount off, and counts it as burned', () => {
    const effect = burnEffect(INITIAL_SUPPLY_UNITS, million);
    expect(effect).toEqual({ after: INITIAL_SUPPLY_UNITS - million, sharePct: '0.1', burnedAfter: million, burnedPct: '0.1' });
  });

  it('adds to what was burned before', () => {
    const supply = INITIAL_SUPPLY_UNITS - 250n * million;
    const effect = burnEffect(supply, 250n * million);
    expect(effect?.after).toBe(INITIAL_SUPPLY_UNITS - 500n * million);
    expect(effect?.burnedAfter).toBe(500n * million);
    expect(effect?.burnedPct).toBe('50');
    // A share is of the supply now, not of the launch supply.
    expect(effect?.sharePct).toBe('33.3333');
  });

  it('never rounds a share up, and never calls a real burn zero', () => {
    expect(burnEffect(INITIAL_SUPPLY_UNITS, 1n)?.sharePct).toBe('<0.0001');
    expect(burnEffect(3n, 2n)?.sharePct).toBe('66.6666');
    expect(burnEffect(INITIAL_SUPPLY_UNITS, INITIAL_SUPPLY_UNITS)).toEqual({ after: 0n, sharePct: '100', burnedAfter: INITIAL_SUPPLY_UNITS, burnedPct: '100' });
  });

  it('has nothing to say about an amount that cannot be burned', () => {
    expect(burnEffect(INITIAL_SUPPLY_UNITS, 0n)).toBeNull();
    expect(burnEffect(INITIAL_SUPPLY_UNITS, -5n)).toBeNull();
    expect(burnEffect(100n, 101n)).toBeNull();
    expect(burnEffect(0n, 1n)).toBeNull();
  });

  it('is confirmed by the word, and by nothing else', () => {
    expect(BURN_WORD).toBe('BURN');
    for (const text of ['BURN', 'burn', ' Burn ']) expect(burnConfirmed(text)).toBe(true);
    for (const text of ['', 'BURN IT', 'BUR', 'yes', 'B U R N']) expect(burnConfirmed(text)).toBe(false);
  });
});

describe('percentages for display', () => {
  it('cuts off and never rounds up', () => {
    expect(percentOf(1n, 3n)).toBe('33.33');
    expect(percentOf(2n, 3n)).toBe('66.66');
    expect(percentOf(999n, 1000n, 0)).toBe('99');
    expect(percentOf(1n, 1n)).toBe('100');
    expect(percentOf(1n, 8n, 4)).toBe('12.5');
  });

  it('says "less than" for a share too small to show, and zero only for nothing', () => {
    expect(percentOf(1n, 1_000_000n)).toBe('<0.01');
    expect(percentOf(1n, 1_000_000n, 4)).toBe('0.0001');
    expect(percentOf(0n, 10n)).toBe('0');
    expect(percentOf(5n, 0n)).toBe('0');
    expect(percentOf(-1n, 10n)).toBe('0');
  });
});

describe('a mint account, as read from chain', () => {
  function mintAccount(supply: bigint, authority: Keypair | null) {
    const data = Buffer.alloc(MintLayout.span);
    MintLayout.encode(
      {
        mintAuthorityOption: authority ? 1 : 0,
        mintAuthority: authority?.publicKey ?? Keypair.generate().publicKey,
        supply,
        decimals: 6,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: Keypair.generate().publicKey,
      },
      data,
    );
    return { owner: TOKEN_PROGRAM_ID, data };
  }

  it('gives the supply, and says nobody can mint when the authority is gone', () => {
    const info = mintAccount(INITIAL_SUPPLY_UNITS - 42n, null);
    expect(mintSupply(info)).toBe(INITIAL_SUPPLY_UNITS - 42n);
    // The address bytes of a revoked authority are left in the account; only the flag says whether they count.
    expect(mintAuthorityOf(info)).toBeNull();
  });

  it('names the authority when there is one', () => {
    const authority = Keypair.generate();
    expect(mintAuthorityOf(mintAccount(1n, authority))?.equals(authority.publicKey)).toBe(true);
  });

  it('answers nothing for an account that is not a token mint', () => {
    const info = mintAccount(1n, null);
    expect(mintAuthorityOf(null)).toBeUndefined();
    expect(mintAuthorityOf({ owner: Keypair.generate().publicKey, data: info.data })).toBeUndefined();
    expect(mintAuthorityOf({ owner: TOKEN_PROGRAM_ID, data: info.data.subarray(0, 40) })).toBeUndefined();
  });
});

describe('market cap from a price and a supply', () => {
  it('is the price times the tokens that exist now', () => {
    expect(Number(marketCapText('0.00000003', INITIAL_SUPPLY_UNITS))).toBeCloseTo(30, 9);
    // Half the supply burned: half the market cap at the same price.
    expect(Number(marketCapText('0.00000003', INITIAL_SUPPLY_UNITS / 2n))).toBeCloseTo(15, 9);
    expect(marketCapText('0', INITIAL_SUPPLY_UNITS)).toBe('0');
    expect(marketCapText('not a number', INITIAL_SUPPLY_UNITS)).toBe('0');
  });
});
