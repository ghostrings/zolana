import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { decodeRingConfig } from '@heliuslabs/spr/interface';

import {
  NO_AUTHORITY,
  RING_CONFIG_SCAN,
  type RingRegistration,
  mergeRegister,
  parseRegister,
  readRingRegistration,
  ringConfigAddress,
  ringStateOf,
} from '../shared/src/custom-rings.js';
import type { CustomRingsView } from '../shared/src/rings-api.js';
import { RateLimiter } from '../server/src/http.js';
import { RINGS_OFF_CUSTOM, type RingsRoutesInput, ringsRouter } from '../server/src/rings/routes.js';
import { activationWords, ringCountWords, ringStateWords } from '../web/src/rings-render.js';

const fresh = (): string => Keypair.generate().publicKey.toBase58();

/** A registration account, laid out as the Rings specification gives it: type, authority, program, three switches, bump. */
function account(program: string, bump: number, flags: { activated?: boolean; paused?: boolean; rail?: boolean; authority?: string } = {}): Uint8Array {
  const data = new Uint8Array(69);
  data[0] = 4;
  data.set(bs58.decode(flags.authority ?? fresh()), 1);
  data.set(bs58.decode(program), 33);
  data[65] = flags.rail ? 1 : 0;
  data[66] = flags.paused ? 1 : 0;
  data[67] = flags.activated ? 1 : 0;
  data[68] = bump;
  return data;
}

describe('reading a custom ring registration', () => {
  it('looks for accounts of the size and type the pinned SDK decodes as one', () => {
    expect(RING_CONFIG_SCAN).toEqual({ dataSize: 69, type: 4 });
    const program = fresh();
    const authority = fresh();
    const decoded = decodeRingConfig(account(program, 251, { activated: true, rail: true, authority }));
    expect(String(decoded.programId)).toBe(program);
    expect(String(decoded.authority)).toBe(authority);
    expect(decoded).toMatchObject({ activated: true, paused: false, ringAuthorityTransactIsEnabled: true, bump: 251 });
    // The three switches sit in this order: the rail, paused, activated.
    expect(decodeRingConfig(account(program, 1, { paused: true }))).toMatchObject({ activated: false, paused: true, ringAuthorityTransactIsEnabled: false });
    expect(() => decodeRingConfig(new Uint8Array(68))).toThrow();
    expect(() => decodeRingConfig(Uint8Array.from(account(program, 1), (byte, index) => (index === 0 ? 5 : byte)))).toThrow();
  });

  it('derives the registration address the way the program does: the seed "ring_auth" under the ring program', async () => {
    for (let round = 0; round < 5; round += 1) {
      const program = fresh();
      const [expected, bump] = PublicKey.findProgramAddressSync([Buffer.from('ring_auth')], new PublicKey(program));
      expect(await ringConfigAddress(program)).toEqual({ address: expected.toBase58(), bump });
    }
  });

  it('accepts an account at the address its own contents call for, and reads it exactly', async () => {
    const program = fresh();
    const authority = fresh();
    const { address, bump } = await ringConfigAddress(program);
    expect(await readRingRegistration(address, account(program, bump, { activated: true, authority }))).toEqual({
      program,
      config: address,
      authority,
      activated: true,
      paused: false,
      authorityRail: false,
    });
    const given = await readRingRegistration(address, account(program, bump, { paused: true, rail: true, authority: NO_AUTHORITY }));
    expect(given).toMatchObject({ authority: '', activated: false, paused: true, authorityRail: true });
  });

  it('refuses everything else', async () => {
    const program = fresh();
    const { address, bump } = await ringConfigAddress(program);
    const good = account(program, bump);
    expect(await readRingRegistration(address, good)).not.toBeNull();
    expect(await readRingRegistration(fresh(), good)).toBeNull(); // somewhere else
    expect(await readRingRegistration(address, account(fresh(), bump))).toBeNull(); // names another program
    expect(await readRingRegistration(address, account(program, bump === 255 ? 254 : bump + 1))).toBeNull(); // another bump
    expect(await readRingRegistration(address, good.slice(0, 68))).toBeNull();
    expect(await readRingRegistration(address, Uint8Array.from([...good, 0]))).toBeNull();
    expect(await readRingRegistration(address, Uint8Array.from(good, (byte, index) => (index === 0 ? 3 : byte)))).toBeNull();
    expect(await readRingRegistration('not an address', good)).toBeNull();
  });
});

describe('the register', () => {
  const ring = (flags: Partial<RingRegistration> = {}): RingRegistration => ({ program: fresh(), config: fresh(), authority: fresh(), activated: false, paused: false, authorityRail: false, ...flags });

  it('says what a ring’s two switches add up to', () => {
    expect(ringStateOf({ activated: true, paused: false })).toBe('active');
    expect(ringStateOf({ activated: true, paused: true })).toBe('paused');
    expect(ringStateOf({ activated: false, paused: false })).toBe('waiting');
    expect(ringStateOf({ activated: false, paused: true })).toBe('waiting'); // governance's switch comes first
  });

  it('keeps when a ring was first seen, drops repeats, and puts rings that can be used first', () => {
    const waiting = ring();
    const active = ring({ activated: true });
    const first = mergeRegister(null, [waiting, active, waiting], 'governance', 1_000);
    expect(first.rings.map((entry) => entry.program)).toEqual([active.program, waiting.program]);
    expect(first.rings.every((entry) => entry.firstSeen === 1_000)).toBe(true);

    const newcomer = ring({ activated: true, paused: true });
    const second = mergeRegister(first, [newcomer, { ...waiting, activated: true }, active], null, 5_000);
    expect(second.at).toBe(5_000);
    expect(second.activation).toBe('governance'); // not read this time: the last known setting stands
    // Two rings that can be used, seen at the same moment: their order is by address, so that it never changes between reads.
    expect(second.rings.slice(0, 2).map((entry) => entry.program)).toEqual([active.program, waiting.program].sort());
    expect(second.rings.slice(0, 2).every((entry) => entry.firstSeen === 1_000 && entry.activated)).toBe(true);
    expect(second.rings[2]).toMatchObject({ program: newcomer.program, firstSeen: 5_000 });
    expect(second.rings).toHaveLength(3);
    expect(mergeRegister(second, [], 'open', 9_000)).toEqual({ at: 9_000, activation: 'open', rings: [] });
  });

  it('reads a stored register back, and reads anything else as nothing known', () => {
    const register = mergeRegister(null, [ring({ activated: true }), ring()], 'open', 1_800_000_000_000);
    expect(parseRegister(JSON.stringify(register))).toEqual(register);
    expect(parseRegister(undefined)).toBeNull();
    expect(parseRegister('')).toBeNull();
    expect(parseRegister('{')).toBeNull();
    expect(parseRegister('null')).toBeNull();
    expect(parseRegister(JSON.stringify({ at: 0, activation: 'open', rings: [] }))).toBeNull();
    expect(parseRegister(JSON.stringify({ at: 5, activation: 'sometimes', rings: 'none' }))).toBeNull();
    // A row that is not a registration is left out; the rest stands.
    const mixed = { at: 5, activation: 'sometimes', rings: [register.rings[0], { program: 'x' }, { ...register.rings[1], activated: 'yes' }] };
    expect(parseRegister(JSON.stringify(mixed))).toEqual({ at: 5, activation: null, rings: [register.rings[0]] });
  });
});

describe('how the page words a custom ring', () => {
  it('says whose switch stops a ring, and claims nothing about who uses it', () => {
    expect(ringStateWords({ activated: true, paused: false })).toMatchObject({ state: 'active', label: 'Active' });
    expect(ringStateWords({ activated: true, paused: true }).note).toContain('its own operator');
    expect(ringStateWords({ activated: false, paused: false })).toMatchObject({ state: 'waiting', label: 'Not activated' });
    expect(ringStateWords({ activated: false, paused: false }).note).toContain('Rings governance');
  });

  it('says how a new ring starts out, and when that is not known', () => {
    expect(activationWords('open')).toContain('active from the moment it registers');
    expect(activationWords('governance')).toContain('until Rings governance activates it');
    expect(activationWords(null)).toContain('could not be read');
  });

  it('counts rings and how many of them can be used', () => {
    expect(ringCountWords([])).toBe('No custom ring is registered');
    expect(ringCountWords([{ activated: true, paused: false }])).toBe('1 custom ring registered, 1 active');
    expect(ringCountWords([{ activated: true, paused: true }, { activated: false, paused: false }, { activated: true, paused: false }])).toBe('3 custom rings registered, 1 active');
  });
});

describe('GET /api/rings/custom', () => {
  async function ask(rings: RingsRoutesInput['rings']): Promise<{ status: number; cache: string | null; body: unknown }> {
    const app = express();
    app.use('/api/rings', ringsRouter({ rings, limiter: new RateLimiter() }));
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rings/custom`);
      return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('serves what the follower last read, without a call to the chain', async () => {
    const view: CustomRingsView = {
      enabled: true,
      readAt: 1_800_000_000_000,
      activation: 'governance',
      rings: [{ program: fresh(), config: fresh(), authority: '', activated: true, paused: false, authorityRail: false, firstSeen: 1_800_000_000_000, moves: 3 }],
    };
    const indexer = { customRings: () => view } as unknown as NonNullable<RingsRoutesInput['rings']>['indexer'];
    const answer = await ask({ indexer, store: {} as never, isRegistered: async () => false });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(view);
    expect(answer.cache).toBe('public, max-age=30');
  });

  it('says so when this server does not follow Rings', async () => {
    const answer = await ask(undefined);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(RINGS_OFF_CUSTOM);
    expect(answer.body).toMatchObject({ enabled: false, rings: [] });
  });
});

