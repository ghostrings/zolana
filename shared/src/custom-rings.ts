/**
 * Custom rings, as anyone can read them off the chain.
 *
 * A custom ring is a program of its own. It registers one account with the
 * Solana Privacy Program, its ring configuration, and that account says in
 * the open: which program the ring is, who may change the entry, and three
 * switches. `activated` belongs to Rings governance: nothing moves in a ring
 * that is not activated. `paused` belongs to the ring's own operator: nothing
 * moves while it is set. The third opens the rail on which the ring moves
 * notes without their owners' signatures, and belongs to governance too.
 *
 * Nothing here needs a key, and nothing here says who uses a ring or what
 * they hold. It is the public register of rings, read and checked: an account
 * is listed only when it sits at the one address the program it names can
 * sign for, so an account that merely looks like a registration is not.
 */

import { type Address, address, getProgramDerivedAddress, isAddress } from '@solana/kit';
import { decodeRingConfig } from '@heliuslabs/spr/interface';

/**
 * How registrations are found among the Privacy Program's accounts: by their
 * size and their first byte. `tests/custom-rings.test.ts` holds both to what
 * the pinned SDK decodes.
 */
export const RING_CONFIG_SCAN = Object.freeze({ dataSize: 69, type: 4 });

/** The seed of the address a ring program signs its registration with (Rings specification, "Ring Accounts"). */
const RING_AUTH_SEED = new TextEncoder().encode('ring_auth');

/** The address nobody holds a key of. An authority set to it has been given up for good. */
export const NO_AUTHORITY = '11111111111111111111111111111111';

/** One ring's registration, exactly as its account reads. */
export interface RingRegistration {
  /** The ring's program. Every transaction of the ring runs through it. */
  readonly program: string;
  /** The account the ring registered with Rings. */
  readonly config: string;
  /** Who may change the registration. Empty when that right has been given up. */
  readonly authority: string;
  /** Set by Rings governance. Nothing moves in a ring that is not activated. */
  readonly activated: boolean;
  /** Set by the ring's operator. Nothing moves in the ring while it is paused. */
  readonly paused: boolean;
  /** Set by Rings governance. Whether the ring may move notes without their owners' signatures. */
  readonly authorityRail: boolean;
}

/** Where a ring's registration has to sit, and the bump that makes it so. */
export async function ringConfigAddress(program: string): Promise<{ address: string; bump: number }> {
  const [derived, bump] = await getProgramDerivedAddress({ programAddress: address(program), seeds: [RING_AUTH_SEED] });
  return { address: String(derived), bump: Number(bump) };
}

/**
 * Reads one account as a ring's registration. Returns null for anything that
 * is not one: the wrong size or type, or an account that is not at the
 * address its own contents call for.
 */
export async function readRingRegistration(config: string, data: Uint8Array): Promise<RingRegistration | null> {
  if (!isAddress(config) || data.length !== RING_CONFIG_SCAN.dataSize || data[0] !== RING_CONFIG_SCAN.type) return null;
  let decoded: ReturnType<typeof decodeRingConfig>;
  try {
    decoded = decodeRingConfig(data);
  } catch {
    return null;
  }
  const program = String(decoded.programId as Address);
  let expected: { address: string; bump: number };
  try {
    expected = await ringConfigAddress(program);
  } catch {
    // A program id with no address of this kind: not a registration this code can stand behind.
    return null;
  }
  if (expected.address !== config || expected.bump !== decoded.bump) return null;
  const authority = String(decoded.authority as Address);
  return {
    program,
    config,
    authority: authority === NO_AUTHORITY ? '' : authority,
    activated: decoded.activated,
    paused: decoded.paused,
    authorityRail: decoded.ringAuthorityTransactIsEnabled,
  };
}

/** Whether anything can move in the ring right now, and if not, whose switch stops it. */
export type RingState = 'active' | 'paused' | 'waiting';

export function ringStateOf(ring: Pick<RingRegistration, 'activated' | 'paused'>): RingState {
  if (!ring.activated) return 'waiting';
  return ring.paused ? 'paused' : 'active';
}

/** How a new ring starts out on this network: active at once, or only when Rings governance activates it. */
export type RingActivation = 'open' | 'governance';

/** The register as this server last read it. */
export interface RingRegister {
  /** When it was read, in milliseconds since 1970. */
  readonly at: number;
  /** Null when the network's setting could not be read. */
  readonly activation: RingActivation | null;
  readonly rings: ReadonlyArray<RingRegistration & { readonly firstSeen: number }>;
}

const ORDER: Readonly<Record<RingState, number>> = { active: 0, paused: 1, waiting: 2 };

/**
 * A fresh read, joined with what was known before: a ring keeps the moment it
 * was first seen, and a setting that could not be read this time keeps its
 * last known value. Rings that can be used come first, then the oldest.
 */
export function mergeRegister(previous: RingRegister | null, read: readonly RingRegistration[], activation: RingActivation | null, now: number): RingRegister {
  const known = new Map((previous?.rings ?? []).map((ring) => [ring.config, ring.firstSeen]));
  const seen = new Set<string>();
  const rings = read
    .filter((ring) => {
      if (seen.has(ring.config)) return false;
      seen.add(ring.config);
      return true;
    })
    .map((ring) => ({ ...ring, firstSeen: known.get(ring.config) ?? now }))
    .sort((a, b) => ORDER[ringStateOf(a)] - ORDER[ringStateOf(b)] || a.firstSeen - b.firstSeen || (a.program < b.program ? -1 : a.program > b.program ? 1 : 0));
  return { at: now, activation: activation ?? previous?.activation ?? null, rings };
}

function isRing(value: unknown): value is RingRegistration & { firstSeen: number } {
  if (typeof value !== 'object' || value === null) return false;
  const ring = value as Record<string, unknown>;
  return (
    typeof ring.program === 'string' &&
    isAddress(ring.program) &&
    typeof ring.config === 'string' &&
    isAddress(ring.config) &&
    typeof ring.authority === 'string' &&
    (ring.authority === '' || isAddress(ring.authority)) &&
    typeof ring.activated === 'boolean' &&
    typeof ring.paused === 'boolean' &&
    typeof ring.authorityRail === 'boolean' &&
    typeof ring.firstSeen === 'number' &&
    Number.isFinite(ring.firstSeen) &&
    ring.firstSeen > 0
  );
}

/** Reads a stored register back. Anything that is not one reads as nothing known. */
export function parseRegister(text: string | undefined): RingRegister | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { at?: unknown; activation?: unknown; rings?: unknown } | null;
    if (!parsed || typeof parsed.at !== 'number' || !Number.isFinite(parsed.at) || parsed.at <= 0 || !Array.isArray(parsed.rings)) return null;
    const activation = parsed.activation === 'open' || parsed.activation === 'governance' ? parsed.activation : null;
    return { at: parsed.at, activation, rings: parsed.rings.filter(isRing) };
  } catch {
    return null;
  }
}
