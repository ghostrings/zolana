/**
 * What the browser keeps for the wallet extras, against a stand-in for
 * localStorage. Nothing here may ever throw: these records are conveniences,
 * and a browser that refuses to store them must cost the wallet nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { alertSettings, setAlertSettings } from '../web/src/alert-settings.js';
import { RECORD_PREFIXES, dropRequest, forgetSeen, keepMemo, keepRequest, keepSeen, noteOwnSlot, ownSlots, readMemos, readRequests, readSeen } from '../web/src/local-records.js';
import { keepPayRun, readPayRun } from '../web/src/pay-records.js';
import { newRun } from '../shared/src/paymany.js';

const WALLET = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';
const OTHER = 'GwCXyJ8AesaucFMTUSZmiFVMhVngpeBxaBC7mQJiZct3';
const HOUR = 60 * 60_000;

function fakeStorage(): Storage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  };
}

let local: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  local = fakeStorage();
  vi.stubGlobal('localStorage', local);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what is kept for a wallet', () => {
  it('is kept under that wallet’s address and no other', () => {
    keepMemo(WALLET, { signature: 'sig', at: 1, note: 'rent' });
    keepRequest(WALLET, { id: 'r1', at: 1, afterSlot: '5', token: 'SOL', amount: '1', units: '1000000000', note: '' });
    setAlertSettings(WALLET, { on: true, system: false });
    noteOwnSlot(WALLET, 77n, 1_000);
    keepSeen(WALLET, { v: 1, keys: ['a:0'], floor: '0' });
    const run = newRun({ id: 'abc123', wallet: WALLET, mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, now: 1_800_000_000_000, entries: [{ line: 1, to: OTHER, units: 5n, note: '' }] });
    expect(keepPayRun(run)).toBe(true);
    expect([...local.data.keys()].sort()).toEqual(RECORD_PREFIXES.map((prefix) => prefix + WALLET).sort());
    expect(readPayRun(WALLET)).toEqual(run);
    expect(readPayRun(OTHER)).toBeNull();
    expect(readMemos(OTHER).items).toEqual([]);
    expect(readRequests(OTHER).items).toEqual([]);
    expect(alertSettings(OTHER)).toEqual({ on: false, system: false });
    expect(ownSlots(OTHER, 1_000).size).toBe(0);
    expect(readSeen(OTHER)).toBeNull();
  });

  it('comes back as it was kept', () => {
    keepMemo(WALLET, { signature: 'sig', at: 1, to: OTHER, note: 'rent' });
    expect(readMemos(WALLET).items).toEqual([{ signature: 'sig', at: 1, to: OTHER, note: 'rent' }]);
    keepRequest(WALLET, { id: 'r1', at: 1, afterSlot: '5', token: 'SOL', amount: '1', units: '1000000000', note: 'n' });
    keepRequest(WALLET, { id: 'r2', at: 2, afterSlot: '6', token: 'SOL', amount: null, units: null, note: '' });
    dropRequest(WALLET, 'r1');
    expect(readRequests(WALLET).items.map((item) => item.id)).toEqual(['r2']);
    keepSeen(WALLET, { v: 1, keys: ['a:0', 'b:1'], floor: '12' });
    expect(readSeen(WALLET)).toEqual({ v: 1, keys: ['a:0', 'b:1'], floor: '12' });
    forgetSeen(WALLET);
    expect(readSeen(WALLET)).toBeNull();
  });

  it('writes nothing for a memo with nothing in it', () => {
    keepMemo(WALLET, { signature: 'sig', at: 1 });
    expect(local.data.size).toBe(0);
  });
});

describe('alert settings', () => {
  it('are off until somebody turns them on', () => {
    expect(alertSettings(WALLET)).toEqual({ on: false, system: false });
    expect(setAlertSettings(WALLET, { on: true, system: true })).toBe(true);
    expect(alertSettings(WALLET)).toEqual({ on: true, system: true });
  });

  it('read anything else in the store as off', () => {
    for (const raw of ['', 'x', '[]', '{"on":"yes"}', '{"on":1,"system":1}', 'null']) {
      local.setItem(`pcf.alerts.v1.${WALLET}`, raw);
      expect(alertSettings(WALLET), raw).toEqual({ on: false, system: false });
    }
  });
});

describe('the slots this browser sent in', () => {
  it('are remembered for six hours, and each once', () => {
    noteOwnSlot(WALLET, 100n, 0);
    noteOwnSlot(WALLET, 100n, 10);
    noteOwnSlot(WALLET, 101n, 2 * HOUR);
    expect([...ownSlots(WALLET, 2 * HOUR)].sort()).toEqual(['100', '101']);
    expect([...ownSlots(WALLET, 6 * HOUR + 11)]).toEqual(['101']);
    expect(ownSlots(WALLET, 9 * HOUR).size).toBe(0);
  });

  it('never grow without end', () => {
    for (let slot = 0; slot < 260; slot += 1) noteOwnSlot(WALLET, BigInt(slot), slot);
    const kept = ownSlots(WALLET, 300);
    expect(kept.size).toBe(200);
    expect(kept.has('259')).toBe(true);
    expect(kept.has('59')).toBe(false);
  });

  it('read a damaged store as empty', () => {
    for (const raw of ['x', '{}', '[1,2]', '[{"slot":5,"at":1}]', '[{"slot":"-1","at":1}]']) {
      local.setItem(`pcf.ownslots.v1.${WALLET}`, raw);
      expect(ownSlots(WALLET, 2).size, raw).toBe(0);
    }
  });
});

describe('a browser that will not store', () => {
  it('costs nothing: every read is empty and no write throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => keepMemo(WALLET, { signature: 's', at: 1, note: 'n' })).not.toThrow();
    expect(keepRequest(WALLET, { id: 'r', at: 1, afterSlot: '0', token: 'SOL', amount: null, units: null, note: '' })).toBe(false);
    expect(() => dropRequest(WALLET, 'r')).not.toThrow();
    expect(setAlertSettings(WALLET, { on: true, system: false })).toBe(false);
    expect(() => noteOwnSlot(WALLET, 5n)).not.toThrow();
    expect(() => keepSeen(WALLET, { v: 1, keys: [], floor: '0' })).not.toThrow();
    expect(() => forgetSeen(WALLET)).not.toThrow();
    expect(readMemos(WALLET).items).toEqual([]);
    expect(readRequests(WALLET).items).toEqual([]);
    expect(alertSettings(WALLET)).toEqual({ on: false, system: false });
    expect(ownSlots(WALLET).size).toBe(0);
    expect(readSeen(WALLET)).toBeNull();
  });

  it('costs nothing when there is no storage at all', () => {
    vi.unstubAllGlobals();
    expect(() => keepMemo(WALLET, { signature: 's', at: 1, note: 'n' })).not.toThrow();
    expect(readMemos(WALLET).items).toEqual([]);
    expect(alertSettings(WALLET)).toEqual({ on: false, system: false });
  });
});
