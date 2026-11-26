import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Address, Blockhash, Instruction, Transaction } from '@solana/kit';
import { ShieldedKeypair } from '@heliuslabs/spr';

import { Store } from '../server/src/db.js';
import {
  DECLINE_HOLD_MS,
  DESK_MAX_NOTES,
  DESK_SIGN_WINDOW_MS,
  type DeskDecline,
  EXPIRY_MARGIN_BLOCKS,
  declineCovers,
  floorAfterTolerance,
  isDeskDecline,
  mostFragmented,
  outcomeOf,
} from '../shared/src/desk-rules.js';
import { type RingsContext, sendAndSettle } from '../shared/src/privacy.js';
import { addSignature } from '../shared/src/signing.js';
import { composeV1 } from '../shared/src/tx.js';

describe('what became of a sent transaction', () => {
  const LAST = 1_000n;

  it('is landed once the RPC reports it confirmed or finalized', () => {
    expect(outcomeOf({ slot: 77n, failed: false, confirmed: true }, 900n, LAST)).toEqual({ kind: 'landed', slot: 77n });
    // A confirmed status decides even when the height could not be read, or is already past the last block.
    expect(outcomeOf({ slot: 77n, failed: false, confirmed: true }, null, LAST)).toEqual({ kind: 'landed', slot: 77n });
    expect(outcomeOf({ slot: 77n, failed: false, confirmed: true }, LAST + 500n, LAST)).toEqual({ kind: 'landed', slot: 77n });
  });

  it('is rejected when it reached the chain and failed there', () => {
    expect(outcomeOf({ slot: 77n, failed: true, confirmed: true }, 900n, LAST)).toEqual({ kind: 'rejected' });
    expect(outcomeOf({ slot: 77n, failed: true, confirmed: false }, 900n, LAST)).toEqual({ kind: 'rejected' });
  });

  it('is still pending while it is only processed, or not seen and not yet too old', () => {
    expect(outcomeOf({ slot: 77n, failed: false, confirmed: false }, 900n, LAST)).toEqual({ kind: 'pending' });
    expect(outcomeOf(null, 900n, LAST)).toEqual({ kind: 'pending' });
    expect(outcomeOf(null, LAST, LAST)).toEqual({ kind: 'pending' });
  });

  it('is not called expired at its last block, only a margin past it', () => {
    // A transaction can land in its very last block and be reported a moment later.
    expect(outcomeOf(null, LAST + 1n, LAST)).toEqual({ kind: 'pending' });
    expect(outcomeOf(null, LAST + EXPIRY_MARGIN_BLOCKS, LAST)).toEqual({ kind: 'pending' });
    expect(outcomeOf(null, LAST + EXPIRY_MARGIN_BLOCKS + 1n, LAST)).toEqual({ kind: 'expired' });
  });

  it('is never called expired when the height could not be read', () => {
    expect(outcomeOf(null, null, LAST)).toEqual({ kind: 'pending' });
  });
});

describe('the least a trader takes', () => {
  it('is the quote less the limit, rounded down', () => {
    expect(floorAfterTolerance(1_000_000n, 100)).toBe(990_000n);
    expect(floorAfterTolerance(1_000_000n, 0)).toBe(1_000_000n);
    expect(floorAfterTolerance(999n, 50)).toBe(994n);
    expect(floorAfterTolerance(10n ** 30n, 1)).toBe((10n ** 30n * 9_999n) / 10_000n);
  });

  it('never goes negative or above the quote, whatever the limit is', () => {
    expect(floorAfterTolerance(1_000n, 10_000)).toBe(0n);
    expect(floorAfterTolerance(1_000n, 25_000)).toBe(0n);
    expect(floorAfterTolerance(1_000n, -5)).toBe(1_000n);
    expect(floorAfterTolerance(1_000n, Number.NaN)).toBe(1_000n);
    expect(floorAfterTolerance(0n, 100)).toBe(0n);
    expect(floorAfterTolerance(-5n, 100)).toBe(0n);
  });
});

describe('answers that send an order to the pool instead', () => {
  it('are the desk passing on the order, not something going wrong', () => {
    for (const code of ['TOO_LARGE', 'NO_INVENTORY', 'NO_CAPACITY', 'NO_INTERFACE', 'PAIR_UNSUPPORTED', 'DUST', 'DESK_OFF', 'DESK_UNAVAILABLE', 'BUSY', 'COOLDOWN']) {
      expect(isDeskDecline(code)).toBe(true);
    }
  });

  it('do not include errors the pool would hit too, or anything unknown', () => {
    for (const code of ['MIGRATING', 'NOT_LISTED', 'RATE_LIMITED', 'TRADING_PAUSED', 'BAD_REQUEST', 'INTERNAL', 'OFFLINE', '', undefined, null, 42]) {
      expect(isDeskDecline(code)).toBe(false);
    }
  });
});

describe('how long a refusal keeps an order on the pool', () => {
  const at = 1_000_000;
  const refusal = (code: string, amount: bigint, side: 'buy' | 'sell' = 'buy'): DeskDecline => ({ side, code, reason: 'because', amount, at });

  it('covers the size that was too large and anything larger, and lets a smaller one back to the desk', () => {
    const decline = refusal('TOO_LARGE', 200_000_000n);
    expect(declineCovers(decline, 'buy', 200_000_000n, at)).toBe(true);
    expect(declineCovers(decline, 'buy', 900_000_000n, at + 10 * DECLINE_HOLD_MS)).toBe(true);
    expect(declineCovers(decline, 'buy', 199_999_999n, at)).toBe(false);
  });

  it('covers the size that was too small and anything smaller', () => {
    const decline = refusal('DUST', 10n);
    expect(declineCovers(decline, 'buy', 10n, at)).toBe(true);
    expect(declineCovers(decline, 'buy', 3n, at)).toBe(true);
    expect(declineCovers(decline, 'buy', 11n, at)).toBe(false);
  });

  it('holds any other refusal for half a minute, whatever the amount, then asks the desk again', () => {
    for (const code of ['NO_INVENTORY', 'NO_CAPACITY', 'BUSY', 'COOLDOWN', 'DESK_OFF', 'DESK_UNAVAILABLE']) {
      const decline = refusal(code, 30_000_000n);
      expect(declineCovers(decline, 'buy', 1n, at)).toBe(true);
      expect(declineCovers(decline, 'buy', 10n ** 12n, at + DECLINE_HOLD_MS - 1)).toBe(true);
      expect(declineCovers(decline, 'buy', 30_000_000n, at + DECLINE_HOLD_MS)).toBe(false);
    }
  });

  it('never covers the other side of the market, and covers nothing when nothing was refused', () => {
    expect(declineCovers(refusal('NO_INVENTORY', 5n, 'buy'), 'sell', 5n, at)).toBe(false);
    expect(declineCovers(refusal('TOO_LARGE', 5n, 'sell'), 'buy', 50n, at)).toBe(false);
    expect(declineCovers(null, 'buy', 5n, at)).toBe(false);
  });

  it('does not hold a size refusal against an amount it cannot read', () => {
    expect(declineCovers(refusal('TOO_LARGE', 5n), 'buy', null, at)).toBe(false);
    // The refusal that was just recorded always covers the order it was recorded for: the page cannot loop on it.
    for (const code of ['TOO_LARGE', 'DUST', 'NO_INVENTORY']) expect(declineCovers(refusal(code, 77n), 'buy', 77n, at)).toBe(true);
  });
});

describe('a balance split across notes', () => {
  it('is reported only past what one fill can be sure to spend', () => {
    expect(mostFragmented([])).toBeNull();
    expect(mostFragmented([{ mint: 'a', notes: DESK_MAX_NOTES }])).toBeNull();
    expect(mostFragmented([{ mint: 'a', notes: DESK_MAX_NOTES + 1 }])).toEqual({ mint: 'a', notes: DESK_MAX_NOTES + 1 });
  });

  it('names the most split one', () => {
    expect(mostFragmented([{ mint: 'a', notes: 6 }, { mint: 'b', notes: 9 }, { mint: 'c', notes: 2 }])).toEqual({ mint: 'b', notes: 9 });
  });
});

/* ------------------------------------------------------------------ */
/* sendAndSettle against a scripted RPC                                */
/* ------------------------------------------------------------------ */

type StatusAnswer = { slot: bigint; err: unknown; confirmationStatus: string } | null;

interface Script {
  /** What `getSignatureStatuses` answers on each look; the last entry repeats. `'throw'` is an RPC that does not answer. */
  readonly statuses: ReadonlyArray<StatusAnswer | 'throw'>;
  /** What `getBlockHeight` answers on each look; the last entry repeats. */
  readonly heights: ReadonlyArray<bigint | 'throw'>;
  /** The first send throws: the RPC's own simulation refused the transaction. */
  readonly refuse?: boolean;
}

async function run(script: Script, lastValidBlockHeight: bigint, maxWaitMs = 120_000) {
  const keypair = ShieldedKeypair.generate();
  const signer = keypair.toSolanaSigner();
  const instruction: Instruction = { programAddress: '11111111111111111111111111111111' as Address, accounts: [], data: new Uint8Array([1]) };
  const unsigned = composeV1({
    feePayer: signer.address,
    lifetime: { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight },
    instructions: [instruction],
    computeUnitLimit: 1_000,
  });
  const signed: Transaction = await addSignature(signer, unsigned);

  let clock = 0;
  let looks = 0;
  let heightLooks = 0;
  const sends: Array<{ skipPreflight: boolean }> = [];
  const pick = <T,>(list: ReadonlyArray<T>, index: number): T => list[Math.min(index, list.length - 1)] as T;
  const solanaRpc = {
    sendTransaction: (_wire: string, config: { skipPreflight?: boolean }) => ({
      send: async () => {
        if (script.refuse && sends.length === 0) throw new Error('Transaction simulation failed: custom program error 0x1');
        sends.push({ skipPreflight: config.skipPreflight === true });
        return 'signature';
      },
    }),
    getBlockHeight: () => ({
      send: async () => {
        const answer = pick(script.heights, heightLooks);
        heightLooks += 1;
        if (answer === 'throw') throw new Error('rpc: 503');
        return answer;
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        const answer = pick(script.statuses, looks);
        looks += 1;
        if (answer === 'throw') throw new Error('rpc: 503');
        return { value: [answer] };
      },
    }),
  };
  // Only the RPC is used before a transaction lands; after it, the wallet read fails on this stub and is ignored, as on a slow indexer.
  const ctx = { client: { solanaRpc }, wallet: {}, keys: {} } as unknown as RingsContext;
  const outcome = await sendAndSettle(ctx, signed, lastValidBlockHeight, {
    maxWaitMs,
    pollMs: 1_000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return { outcome, sends, looks: () => looks, elapsedMs: () => clock };
}

const confirmed = (slot: bigint): StatusAnswer => ({ slot, err: null, confirmationStatus: 'confirmed' });

describe('sending a fill and staying with it', () => {
  it('reports a landing with its slot', async () => {
    const result = await run({ statuses: [null, null, confirmed(4_242n)], heights: [100n] }, 200n);
    expect(result.outcome).toEqual({ kind: 'landed', slot: 4_242n });
    // Sent once with the RPC's own check, then again without it while waiting.
    expect(result.sends[0]).toEqual({ skipPreflight: false });
    expect(result.sends.slice(1).every((send) => send.skipPreflight)).toBe(true);
  });

  it('keeps sending the same transaction until the chain has decided', async () => {
    const result = await run({ statuses: [null, null, null, null, null, null, null, confirmed(9n)], heights: [100n] }, 200n);
    expect(result.outcome.kind).toBe('landed');
    expect(result.sends.length).toBeGreaterThanOrEqual(3);
  });

  it('reports a transaction the chain rejected', async () => {
    const result = await run({ statuses: [null, { slot: 5n, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }], heights: [100n] }, 200n);
    expect(result.outcome).toEqual({ kind: 'rejected' });
  });

  it('waits out a transaction that is only processed', async () => {
    const result = await run({ statuses: [{ slot: 5n, err: null, confirmationStatus: 'processed' }, { slot: 5n, err: null, confirmationStatus: 'finalized' }], heights: [100n] }, 200n);
    expect(result.outcome).toEqual({ kind: 'landed', slot: 5n });
  });

  it('calls it expired only when the chain is well past its last block and still does not know it', async () => {
    const last = 200n;
    const result = await run({ statuses: [null], heights: [190n, 200n, 201n, last + EXPIRY_MARGIN_BLOCKS, last + EXPIRY_MARGIN_BLOCKS + 1n] }, last);
    expect(result.outcome).toEqual({ kind: 'expired' });
    expect(result.looks()).toBe(5);
  });

  it('finds a transaction that landed in its last block although the height has moved on', async () => {
    const last = 200n;
    const result = await run({ statuses: [null, null, confirmed(77n)], heights: [199n, 205n, 210n] }, last);
    expect(result.outcome).toEqual({ kind: 'landed', slot: 77n });
  });

  it('rides out an RPC that stops answering for a while', async () => {
    const result = await run({ statuses: ['throw', 'throw', 'throw', confirmed(3n)], heights: [100n] }, 200n);
    expect(result.outcome).toEqual({ kind: 'landed', slot: 3n });
    const heights = await run({ statuses: [null, null, confirmed(3n)], heights: ['throw', 'throw', 100n] }, 200n);
    expect(heights.outcome).toEqual({ kind: 'landed', slot: 3n });
  });

  it('sees a landing even while the height cannot be read at all', async () => {
    const result = await run({ statuses: [null, confirmed(8n)], heights: ['throw'] }, 200n);
    expect(result.outcome).toEqual({ kind: 'landed', slot: 8n });
  });

  it('never calls it expired while the height cannot be read', async () => {
    const result = await run({ statuses: [null], heights: ['throw'] }, 200n, 20_000);
    expect(result.outcome).toEqual({ kind: 'pending' });
  });

  it('says it does not know, never that nothing moved, when the RPC never answers', async () => {
    const result = await run({ statuses: ['throw'], heights: ['throw'] }, 200n, 30_000);
    expect(result.outcome).toEqual({ kind: 'pending' });
    expect(result.elapsedMs()).toBeGreaterThanOrEqual(30_000);
  });

  it('throws, having sent nothing, when the RPC refuses the transaction up front', async () => {
    await expect(run({ statuses: [null], heights: [100n], refuse: true }, 200n)).rejects.toThrow(/simulation failed/);
  });
});

/* ------------------------------------------------------------------ */
/* The signing window in the quote ledger                              */
/* ------------------------------------------------------------------ */

describe('a prepared fill in the quote ledger', () => {
  const quote = (id: string, expiresAt: number) => ({
    id,
    side: 'buy' as const,
    mint: 'mint',
    trader: null,
    pay_asset: 'sol',
    pay_amount: '1000',
    receive_asset: 'token',
    receive_amount: '5000',
    reference_amount: '5050',
    spread_bps: 50,
    status: 'quoted' as const,
    message: null,
    signature: null,
    expires_at: expiresAt,
    created_at: 0,
  });

  it('gets the signing window from the moment it is prepared, past the quote’s own expiry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcf-desk-'));
    const store = new Store(directory);
    try {
      // Quoted at 0 and held 20 seconds. The trader's proof arrives at 19s and the desk is done at 24s.
      store.saveQuote(quote('q1', 20_000));
      const signBy = 24_000 + DESK_SIGN_WINDOW_MS;
      expect(store.advanceQuote('q1', 'quoted', 'prepared', { trader: 'trader', message: 'msg', expires_at: signBy })).toBe(true);
      // Another visitor asks for a quote at 30s, which sweeps expired ones: this fill must survive it.
      store.expireQuotes(30_000);
      expect(store.quote('q1')?.status).toBe('prepared');
      expect(store.reservedOut(30_000).get('token')).toBe(5_000n);
      expect(store.advanceQuote('q1', 'prepared', 'submitted')).toBe(true);
      expect(store.quote('q1')?.expires_at).toBe(signBy);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('is swept, and frees what it reserved, once the signing window has passed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcf-desk-'));
    const store = new Store(directory);
    try {
      store.saveQuote(quote('q2', 20_000));
      const signBy = 24_000 + DESK_SIGN_WINDOW_MS;
      store.advanceQuote('q2', 'quoted', 'prepared', { trader: 'trader', message: 'msg', expires_at: signBy });
      expect(store.reservedOut(signBy + 1).size).toBe(0);
      store.expireQuotes(signBy + 1);
      expect(store.quote('q2')?.status).toBe('expired');
      expect(store.advanceQuote('q2', 'prepared', 'submitted')).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps its expiry when a later step does not set one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcf-desk-'));
    const store = new Store(directory);
    try {
      store.saveQuote(quote('q3', 20_000));
      store.advanceQuote('q3', 'quoted', 'prepared', { trader: 'trader', message: 'msg' });
      expect(store.quote('q3')?.expires_at).toBe(20_000);
      expect(store.quote('q3')?.trader).toBe('trader');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
