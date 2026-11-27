/**
 * The order a payout run happens in, held to its promises with a stand-in
 * for the wallet, the prover and the network: a payment is on record before
 * it is sent, a payment on record is never built again, and "not paid" is
 * only said of a payment that can no longer land.
 */

import { describe, expect, it } from 'vitest';
import { AccountRole, type Address, type Blockhash, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { Keypair } from '@solana/web3.js';

import type { Outcome } from '../shared/src/desk-rules.js';
import { type PayItem, type PayRun, newRun, parseRun, retryFailed, runFinished } from '../shared/src/paymany.js';
import { PAY_EXPIRED, PAY_NOT_KEPT, PAY_REJECTED, type PayHooks, type PayPorts, payNext, settleSent } from '../shared/src/payrun.js';
import { ShieldedKeypair } from '@heliuslabs/spr';
import { type RingsContext, lookUpSent, sendAndSettleFinal } from '../shared/src/privacy.js';
import { addSignature } from '../shared/src/signing.js';
import { carriedLastValid, composeV1 } from '../shared/src/tx.js';

const fresh = (): string => Keypair.generate().publicKey.toBase58();
const ME = fresh();
const SOL = 'So11111111111111111111111111111111111111112';
const NOW = 1_800_000_000_000;
const sigOf = (n: number): string => String((n % 9) + 1).repeat(88);

type Tx = { readonly to: string; readonly n: number; readonly signed: boolean };

interface World {
  ports: PayPorts<Tx>;
  hooks: PayHooks;
  /** Everything that happened, in order. */
  log: string[];
  /** What is in "storage": the last run that was kept. */
  kept: PayRun | null;
  /** How many transactions were built for each wallet. */
  built: Map<string, number>;
  released: number;
  /** Scripted behaviour, changed by a test between steps. */
  script: {
    ready?: Error;
    build?: Error;
    sign?: Error;
    saves: boolean;
    send: Outcome | Error;
    neverLeft: boolean;
    lookUp: Outcome | Error;
  };
}

function world(): World {
  let counter = 0;
  const w: World = {
    log: [],
    kept: null,
    built: new Map(),
    released: 0,
    script: { saves: true, send: { kind: 'landed', slot: 77n }, neverLeft: false, lookUp: { kind: 'pending' } },
    hooks: {
      save(run) {
        if (!w.script.saves) {
          w.log.push('save refused');
          return false;
        }
        w.kept = run;
        w.log.push(`save ${run.items.map((item) => item.state[0]).join('')}`);
        return true;
      },
      stage() {},
      now: () => NOW,
    },
    ports: {
      wallet: ME,
      async ready() {
        w.log.push('ready');
        if (w.script.ready) throw w.script.ready;
      },
      mark() {
        w.log.push('mark');
        return { release: () => void (w.released += 1) };
      },
      async build(_run: PayRun, item: PayItem) {
        w.log.push('build');
        if (w.script.build) throw w.script.build;
        w.built.set(item.to, (w.built.get(item.to) ?? 0) + 1);
        counter += 1;
        return { transaction: { to: item.to, n: counter, signed: false }, lastValid: 1_000n + BigInt(counter) };
      },
      async sign(transaction: Tx) {
        w.log.push('sign');
        if (w.script.sign) throw w.script.sign;
        return { signed: { ...transaction, signed: true }, signature: sigOf(transaction.n) };
      },
      async send(signed: Tx) {
        w.log.push(`send ${signed.signed ? 'signed' : 'UNSIGNED'}`);
        if (w.script.send instanceof Error) throw w.script.send;
        return w.script.send;
      },
      neverLeft: () => w.script.neverLeft,
      async lookUp(signature: string) {
        w.log.push(`look ${signature.slice(0, 1)}`);
        if (w.script.lookUp instanceof Error) throw w.script.lookUp;
        return w.script.lookUp;
      },
      async landed(item: PayItem, signature: string, slot: bigint) {
        w.log.push(`landed ${signature.slice(0, 1)}@${slot}`);
        void item;
      },
      explain: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    },
  };
  return w;
}

function runOf(count: number): PayRun {
  return newRun({
    id: 'abcdef012345',
    wallet: ME,
    mint: SOL,
    symbol: 'SOL',
    decimals: 9,
    now: NOW,
    entries: Array.from({ length: count }, (_value, index) => ({ line: index + 1, to: fresh(), units: BigInt(index + 1), note: '' })),
  });
}

const states = (run: PayRun): string => run.items.map((item) => item.state).join(',');

describe('paying the next line of a run', () => {
  it('writes the signature down before it sends, and the landing after', async () => {
    const w = world();
    const step = await payNext(w.ports, runOf(2), w.hooks);
    expect(step.stop).toBeNull();
    expect(states(step.run)).toBe('paid,todo');
    expect(w.log).toEqual(['ready', 'mark', 'build', 'sign', 'save st', 'send signed', 'save pt', 'landed 2@77']);
    expect(w.kept).toEqual(step.run);
    expect(step.run.items[0]).toMatchObject({ signature: sigOf(1), at: NOW });
    expect(w.released).toBe(0);
  });

  it('pays a whole list one line at a time, each exactly once', async () => {
    const w = world();
    let run = runOf(4);
    for (let round = 0; round < 10 && !runFinished(run); round += 1) {
      const step = await payNext(w.ports, run, w.hooks);
      expect(step.stop).toBeNull();
      run = step.run;
    }
    expect(states(run)).toBe('paid,paid,paid,paid');
    expect([...w.built.values()]).toEqual([1, 1, 1, 1]);
    expect(w.log.filter((entry) => entry.startsWith('send'))).toHaveLength(4);
    // Asked again, a finished run sends nothing.
    const after = await payNext(w.ports, run, w.hooks);
    expect(after).toEqual({ run, stop: null });
    expect(w.log.filter((entry) => entry.startsWith('send'))).toHaveLength(4);
  });

  it('builds nothing when the payment cannot be afforded', async () => {
    const w = world();
    w.script.ready = new Error('Keep at least 0.015 public SOL in the wallet for fees.');
    const run = runOf(2);
    const step = await payNext(w.ports, run, w.hooks);
    expect(step.run).toBe(run);
    expect(step.stop).toBe('Payment 1 of 2 was not sent. Keep at least 0.015 public SOL in the wallet for fees.');
    expect(w.log).toEqual(['ready']);
    expect(w.kept).toBeNull();
  });

  it('leaves the line as it was when the proof or the signature does not come', async () => {
    for (const failing of ['build', 'sign'] as const) {
      const w = world();
      w.script[failing] = new Error(failing === 'build' ? 'The prover did not answer.' : 'You declined in your wallet.');
      const run = runOf(1);
      const step = await payNext(w.ports, run, w.hooks);
      expect(step.run).toBe(run);
      expect(states(step.run)).toBe('todo');
      expect(step.stop).toContain('Payment 1 of 1 was not sent.');
      expect(w.released).toBe(1); // what the unsent attempt set aside is free again
      expect(w.log.some((entry) => entry.startsWith('send') || entry.startsWith('save'))).toBe(false);
    }
  });

  it('does not send a payment it could not first write down', async () => {
    const w = world();
    w.script.saves = false;
    const run = runOf(1);
    const step = await payNext(w.ports, run, w.hooks);
    expect(step.stop).toBe(PAY_NOT_KEPT);
    expect(step.run).toBe(run);
    expect(states(step.run)).toBe('todo');
    expect(w.log).toEqual(['ready', 'mark', 'build', 'sign', 'save refused']);
    expect(w.released).toBe(1);
  });

  it('calls a payment not paid when the RPC refused it before it left', async () => {
    const w = world();
    w.script.send = new Error('Simulation failed: insufficient funds');
    w.script.neverLeft = true;
    const step = await payNext(w.ports, runOf(2), w.hooks);
    expect(states(step.run)).toBe('failed,todo');
    expect(step.run.items[0]?.reason).toBe('Refused before it was sent. Simulation failed: insufficient funds');
    expect(step.stop).toContain('was refused before it was sent, so nothing moved');
    expect(w.released).toBe(1);
    expect(w.kept).toEqual(step.run);
  });

  it('keeps a payment as sent when the send failed any other way, and sends nothing more until it is known', async () => {
    const w = world();
    w.script.send = new Error('fetch failed');
    const first = await payNext(w.ports, runOf(3), w.hooks);
    expect(states(first.run)).toBe('sent,todo,todo');
    expect(first.stop).toContain('It is not known yet whether payment 1 of 3 went through');
    expect(w.released).toBe(0); // it may be on its way: nothing it spends is freed
    expect(w.kept).toEqual(first.run);

    // Pressing Continue now must not build anything, for this line or the next.
    w.script.send = { kind: 'landed', slot: 78n };
    const calls = w.log.length;
    const again = await payNext(w.ports, first.run, w.hooks);
    expect(again.run).toBe(first.run);
    expect(again.stop).toContain('outcome is not known yet');
    expect(w.log).toHaveLength(calls);
  });

  it('keeps a payment as sent when the network gave no answer for the whole wait', async () => {
    const w = world();
    w.script.send = { kind: 'pending' };
    const step = await payNext(w.ports, runOf(1), w.hooks);
    expect(states(step.run)).toBe('sent');
    expect(step.stop).toContain('It is not known yet');
    expect(w.log.some((entry) => entry.startsWith('landed'))).toBe(false);
  });

  it('calls a payment not paid when the chain rejected it or it grew too old, and stops there', async () => {
    for (const [kind, reason] of [
      ['rejected', PAY_REJECTED],
      ['expired', PAY_EXPIRED],
    ] as const) {
      const w = world();
      w.script.send = { kind };
      const step = await payNext(w.ports, runOf(2), w.hooks);
      expect(states(step.run)).toBe('failed,todo');
      expect(step.run.items[0]).toMatchObject({ reason, signature: sigOf(1) });
      expect(step.stop).toContain('did not go through');
      // Continuing goes on with the next line. The failed one waits until it is asked for again.
      w.script.send = { kind: 'landed', slot: 80n };
      const next = await payNext(w.ports, step.run, w.hooks);
      expect(states(next.run)).toBe('failed,paid');
      const done = await payNext(w.ports, next.run, w.hooks);
      expect(done).toEqual({ run: next.run, stop: null });
      const retried = await payNext(w.ports, retryFailed(next.run), w.hooks);
      expect(states(retried.run)).toBe('paid,paid');
      expect(retried.run.items[0]?.signature).toBe(sigOf(3)); // a new transaction: the old one can never land
    }
  });

  it('pays nothing from a run that belongs to another wallet', async () => {
    const w = world();
    const other = { ...runOf(1), wallet: fresh() };
    const step = await payNext(w.ports, other, w.hooks);
    expect(step.stop).toContain('belongs to another wallet');
    expect(w.log).toEqual([]);
  });
});

describe('finding out what became of a payment that was sent', () => {
  async function interrupted(): Promise<{ w: World; run: PayRun }> {
    const w = world();
    w.script.send = new Error('fetch failed');
    const { run } = await payNext(w.ports, runOf(3), w.hooks);
    w.log.length = 0;
    return { w, run };
  }

  it('marks it paid when the chain has it, and the run goes on from the next line', async () => {
    const { w, run } = await interrupted();
    w.script.lookUp = { kind: 'landed', slot: 91n };
    const settled = await settleSent(w.ports, run, w.hooks);
    expect(settled).toMatchObject({ unknown: 0, problem: null });
    expect(states(settled.run)).toBe('paid,todo,todo');
    expect(w.log).toEqual(['look 2', 'save ptt', 'landed 2@91']);
    w.script.send = { kind: 'landed', slot: 92n };
    const next = await payNext(w.ports, settled.run, w.hooks);
    expect(states(next.run)).toBe('paid,paid,todo');
    // The line that was interrupted was built once, ever.
    expect(w.built.get(run.items[0]?.to ?? '')).toBe(1);
  });

  it('marks it not paid when it was rejected or can no longer land', async () => {
    for (const [kind, reason] of [
      ['rejected', PAY_REJECTED],
      ['expired', PAY_EXPIRED],
    ] as const) {
      const { w, run } = await interrupted();
      w.script.lookUp = { kind };
      const settled = await settleSent(w.ports, run, w.hooks);
      expect(states(settled.run)).toBe('failed,todo,todo');
      expect(settled.run.items[0]?.reason).toBe(reason);
      expect(settled.unknown).toBe(0);
      expect(w.log.some((entry) => entry.startsWith('landed'))).toBe(false);
    }
  });

  it('changes nothing while the chain has not decided, or cannot be asked', async () => {
    const { w, run } = await interrupted();
    const waiting = await settleSent(w.ports, run, w.hooks);
    expect(waiting).toEqual({ run, unknown: 1, problem: null });
    w.script.lookUp = new Error('fetch failed');
    const silent = await settleSent(w.ports, run, w.hooks);
    expect(silent.run).toBe(run);
    expect(silent.unknown).toBe(1);
    expect(silent.problem).toContain('The network did not answer');
    expect(w.log.every((entry) => entry.startsWith('look'))).toBe(true); // it only ever looks
  });

  it('picks a run up from the browser’s record after the page was closed mid-payment', async () => {
    const { w, run } = await interrupted();
    // What a reloaded page starts from is what was written down, nothing else.
    const reopened = parseRun(JSON.stringify(w.kept), ME);
    expect(reopened).toEqual(run);
    const blocked = await payNext(w.ports, reopened as PayRun, w.hooks);
    expect(blocked.stop).toContain('outcome is not known yet');
    w.script.lookUp = { kind: 'landed', slot: 95n };
    const settled = await settleSent(w.ports, reopened as PayRun, w.hooks);
    w.script.send = { kind: 'landed', slot: 96n };
    let current = settled.run;
    for (let round = 0; round < 5 && !runFinished(current); round += 1) current = (await payNext(w.ports, current, w.hooks)).run;
    expect(states(current)).toBe('paid,paid,paid');
    expect([...w.built.values()]).toEqual([1, 1, 1]);
  });
});

describe('the last block a payment can land in', () => {
  it('is carried by a transaction that was just compiled, and is not made up for one that was not', () => {
    const payer = fresh() as Address;
    const transaction = composeV1({
      feePayer: payer,
      lifetime: { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 312_456_789n },
      instructions: [{ programAddress: fresh() as Address, accounts: [{ address: payer, role: AccountRole.WRITABLE_SIGNER }], data: Uint8Array.of(1) }],
      computeUnitLimit: 450_000,
    });
    expect(carriedLastValid(transaction)).toBe(312_456_789n);
    // Rebuilt from its bytes, as a wallet extension may hand it back, the height is gone: the caller asks the network instead.
    const rebuilt = getTransactionDecoder().decode(getTransactionEncoder().encode(transaction));
    expect(carriedLastValid(rebuilt as never)).toBeNull();
    expect(carriedLastValid({ ...transaction, lifetimeConstraint: { blockhash: 'x', lastValidBlockHeight: 0n } } as never)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* What the chain says of a payment, against a scripted RPC            */
/* ------------------------------------------------------------------ */

type StatusAnswer = { slot: bigint; err: unknown; confirmationStatus: string } | null;

/** An RPC that answers from a script: each call takes the next entry, and the last entry repeats. */
function scriptedRpc(script: { statuses: ReadonlyArray<StatusAnswer | 'throw'>; heights: ReadonlyArray<bigint | 'throw'> }) {
  let looks = 0;
  let heightLooks = 0;
  const sends: number[] = [];
  const pick = <T,>(list: ReadonlyArray<T>, index: number): T => list[Math.min(index, list.length - 1)] as T;
  const solanaRpc = {
    sendTransaction: () => ({
      send: async () => {
        sends.push(looks);
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
  return { client: { solanaRpc } as unknown as RingsContext['client'], looks: () => looks, sends };
}

const SIGNATURE = sigOf(4) as never;
const LAST = 1_000n;

describe('one look at the chain for a payment sent earlier', () => {
  const look = (statuses: ReadonlyArray<StatusAnswer | 'throw'>, heights: ReadonlyArray<bigint | 'throw'>) => lookUpSent(scriptedRpc({ statuses, heights }).client, SIGNATURE, LAST);

  it('is landed once the chain has confirmed it', async () => {
    expect(await look([{ slot: 77n, err: null, confirmationStatus: 'confirmed' }], [900n])).toEqual({ kind: 'landed', slot: 77n });
    expect(await look([{ slot: 77n, err: null, confirmationStatus: 'finalized' }], ['throw'])).toEqual({ kind: 'landed', slot: 77n });
  });

  it('is rejected only when the failure itself is confirmed', async () => {
    expect(await look([{ slot: 77n, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }], [900n])).toEqual({ kind: 'rejected' });
    // Seen failing in a block that is not confirmed yet: that block may be dropped, and the payment may still land.
    expect(await look([{ slot: 77n, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }], [900n])).toEqual({ kind: 'pending' });
    expect(await look([{ slot: 77n, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }], [LAST + 5_000n])).toEqual({ kind: 'pending' });
  });

  it('is too old only when the chain does not know it and is well past its last block', async () => {
    expect(await look([null], [LAST + 5_000n])).toEqual({ kind: 'expired' });
    expect(await look([null], [LAST])).toEqual({ kind: 'pending' });
    expect(await look([null], [900n])).toEqual({ kind: 'pending' });
    expect(await look([null], ['throw'])).toEqual({ kind: 'pending' }); // no height: nothing is ever called too old
    expect(await look([{ slot: 77n, err: null, confirmationStatus: 'processed' }], [LAST + 5_000n])).toEqual({ kind: 'pending' });
  });

  it('throws when the network does not answer for the signature, which decides nothing', async () => {
    await expect(look(['throw'], [900n])).rejects.toThrow('rpc: 503');
  });
});

describe('sending a payment whose rejection will be acted on', () => {
  async function send(statuses: ReadonlyArray<StatusAnswer | 'throw'>, heights: ReadonlyArray<bigint | 'throw'>) {
    const signer = ShieldedKeypair.generate().toSolanaSigner();
    const unsigned = composeV1({
      feePayer: signer.address,
      lifetime: { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: LAST },
      instructions: [{ programAddress: '11111111111111111111111111111111' as Address, accounts: [], data: Uint8Array.of(1) }],
      computeUnitLimit: 1_000,
    });
    const signed = await addSignature(signer, unsigned);
    const rpc = scriptedRpc({ statuses, heights });
    let clock = 0;
    const ctx = { client: rpc.client, wallet: {}, keys: {} } as unknown as RingsContext;
    const outcome = await sendAndSettleFinal(ctx, signed, LAST, { maxWaitMs: 120_000, pollMs: 1_000, sleep: async (ms) => void (clock += ms), now: () => clock });
    return { outcome, looks: rpc.looks() };
  }
  const failing = (confirmationStatus: string): StatusAnswer => ({ slot: 77n, err: { InstructionError: [0, 'Custom'] }, confirmationStatus });

  it('reports a landing and an expiry as they are', async () => {
    expect((await send([null, { slot: 80n, err: null, confirmationStatus: 'confirmed' }], [900n])).outcome).toEqual({ kind: 'landed', slot: 80n });
    expect((await send([null], [900n, LAST + 5_000n])).outcome).toEqual({ kind: 'expired' });
  });

  it('reports a rejection once it is confirmed', async () => {
    expect((await send([failing('confirmed')], [900n])).outcome).toEqual({ kind: 'rejected' });
    // Seen failing first, confirmed a few looks later.
    const later = await send([failing('processed'), failing('processed'), failing('processed'), failing('confirmed')], [900n]);
    expect(later.outcome).toEqual({ kind: 'rejected' });
    expect(later.looks).toBe(4);
  });

  it('finds the landing when a failure it saw first was on a block that was dropped', async () => {
    const forked = await send([failing('processed'), null, null, { slot: 81n, err: null, confirmationStatus: 'confirmed' }], [900n]);
    expect(forked.outcome).toEqual({ kind: 'landed', slot: 81n });
  });

  it('says it does not know when a failure is never confirmed within the wait', async () => {
    const stuck = await send([failing('processed')], [900n]);
    expect(stuck.outcome).toEqual({ kind: 'pending' });
    expect(stuck.looks).toBeGreaterThan(20);
  });
});

