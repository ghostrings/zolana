/**
 * Viewing passes: read-only access to one wallet's private side.
 *
 * WHAT A PASS HOLDS
 *   The wallet's Rings derivation signature: its Ed25519 signature over the
 *   one fixed message the Rings SDK derives a wallet's viewing key and
 *   nullifier key from. Those two keys decrypt the wallet's notes and tell
 *   which of them are spent. That is everything needed to read its private
 *   balance and history, past and future.
 *
 * WHAT A PASS CANNOT DO
 *   Move anything. A spend is authorised by the wallet's signature over the
 *   transaction itself (Solana Privacy Rings specification, "Nullifier Key":
 *   the nullifier secret "is required to spend but does not authorize a
 *   spend"). A pass holds no signing key and no secret key, and it is not the
 *   signature a prvmax vault is made from. The one thing its holder can do on
 *   chain is what the protocol lets any holder of the nullifier key do for a
 *   wallet that has consolidation switched on: merge that wallet's notes into
 *   one. That changes no balance and no owner.
 *
 * WHAT CANNOT BE UNDONE
 *   A pass cannot be taken back. A wallet's keys come from its secret key and
 *   never change, so a pass handed out keeps working for as long as the
 *   wallet is used. The only way to end it is to move to another wallet.
 *
 * A pass is sealed with a passphrase of its own (PBKDF2-SHA256, then
 * AES-256-GCM, the same construction as the wallet in this browser), so the
 * text can go by one route and the passphrase by another. Nothing here is
 * ever sent to a server.
 */

export const PASS_PREFIX = 'pcfview1.';
export const PASS_ITERATIONS = 310_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;
export const PASS_MIN_PASSPHRASE = 10;

export class PassError extends Error {
  readonly code: 'FORMAT' | 'PASSPHRASE' | 'WEAK';
  constructor(code: 'FORMAT' | 'PASSPHRASE' | 'WEAK', message: string) {
    super(message);
    this.name = 'PassError';
    this.code = code;
  }
}

export interface OpenedPass {
  /** The wallet the pass reads. */
  readonly address: string;
  /** The 64-byte derivation signature. The caller wipes it when done. */
  readonly seed: Uint8Array;
  /** When the pass was made, in milliseconds since 1970. */
  readonly created: number;
  /** What the wallet's owner called it. May be empty. */
  readonly name: string;
}

interface PassBody {
  readonly v: 1;
  readonly address: string;
  readonly name: string;
  readonly created: number;
  readonly iterations: number;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new PassError('FORMAT', 'This is not a viewing pass.');
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// No type of the browser or of Node is named here: the same lines are checked against both.
async function passKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey('raw', new Uint8Array(encoder.encode(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The part of a pass that is authenticated with the secret: a pass cannot be relabelled for another wallet. */
const bound = (address: string, created: number, iterations: number): Uint8Array => encoder.encode(`${PASS_PREFIX}${address}.${created}.${iterations}`);

/** Characters a name may keep: it is shown on somebody else's screen. */
function tidyName(name: string): string {
  let out = '';
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff) continue;
    out += character;
  }
  return [...out.trim()].slice(0, 24).join('').trim();
}

export interface SealInput {
  readonly address: string;
  /** The wallet's 64-byte derivation signature. Not kept, not changed. */
  readonly seed: Uint8Array;
  readonly passphrase: string;
  readonly created: number;
  readonly name?: string;
  /** Tests lower this. Nothing else should. */
  readonly iterations?: number;
}

/** Seals a pass. The text returned is safe to store or send: without the passphrase it reveals only the wallet's address. */
export async function sealPass(input: SealInput): Promise<string> {
  if (input.seed.length !== 64) throw new PassError('FORMAT', 'A viewing pass is made from a 64-byte signature.');
  if (input.passphrase.length < PASS_MIN_PASSPHRASE) throw new PassError('WEAK', `Use a passphrase of at least ${PASS_MIN_PASSPHRASE} characters for a viewing pass.`);
  const iterations = input.iterations ?? PASS_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passKey(input.passphrase, salt, iterations);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(bound(input.address, input.created, iterations)) }, key, new Uint8Array(input.seed)),
  );
  const body: PassBody = { v: 1, address: input.address, name: tidyName(input.name ?? ''), created: input.created, iterations, salt: toBase64Url(salt), iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
  return `${PASS_PREFIX}${toBase64Url(encoder.encode(JSON.stringify(body)))}`;
}

function readBody(text: string): PassBody {
  const compact = text.replace(/\s+/g, '');
  if (!compact.startsWith(PASS_PREFIX)) throw new PassError('FORMAT', 'This is not a viewing pass. A pass starts with "pcfview1.".');
  let parsed: Partial<PassBody> | null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(compact.slice(PASS_PREFIX.length)))) as Partial<PassBody> | null;
  } catch (error) {
    if (error instanceof PassError) throw error;
    throw new PassError('FORMAT', 'This viewing pass is damaged: part of it is missing or changed.');
  }
  const ok =
    parsed !== null &&
    typeof parsed === 'object' &&
    parsed.v === 1 &&
    typeof parsed.address === 'string' &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parsed.address) &&
    typeof parsed.created === 'number' &&
    Number.isFinite(parsed.created) &&
    typeof parsed.iterations === 'number' &&
    Number.isInteger(parsed.iterations) &&
    parsed.iterations >= MIN_ITERATIONS &&
    parsed.iterations <= MAX_ITERATIONS &&
    typeof parsed.salt === 'string' &&
    typeof parsed.iv === 'string' &&
    typeof parsed.ciphertext === 'string';
  if (!ok) throw new PassError('FORMAT', 'This viewing pass is damaged: part of it is missing or changed.');
  const body = parsed as PassBody;
  return { ...body, name: tidyName(typeof body.name === 'string' ? body.name : '') };
}

/** The wallet a pass is for, without opening it. Throws when the text is not a pass. */
export function passAddress(text: string): string {
  return readBody(text).address;
}

/** Opens a pass. Throws `PassError` with `PASSPHRASE` when the passphrase is wrong, or the pass was changed. */
export async function openPass(text: string, passphrase: string): Promise<OpenedPass> {
  const body = readBody(text);
  const salt = fromBase64Url(body.salt);
  const iv = fromBase64Url(body.iv);
  const ciphertext = fromBase64Url(body.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length !== 64 + 16) throw new PassError('FORMAT', 'This viewing pass is damaged: part of it is missing or changed.');
  let seed: Uint8Array;
  try {
    const key = await passKey(passphrase, salt, body.iterations);
    seed = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(bound(body.address, body.created, body.iterations)) }, key, new Uint8Array(ciphertext)),
    );
  } catch {
    throw new PassError('PASSPHRASE', 'Wrong passphrase for this viewing pass.');
  }
  if (seed.length !== 64) throw new PassError('FORMAT', 'This viewing pass is damaged: part of it is missing or changed.');
  return { address: body.address, seed, created: body.created, name: body.name };
}
