/**
 * This site's own copy of token artwork and metadata.
 *
 * Artwork uploaded here is pinned to IPFS, and its address in a token's
 * metadata names an IPFS gateway. Whether a visitor can reach that gateway is
 * not something this site controls: public gateways are throttled, and some
 * networks refuse connections to them. So every file pinned through this
 * server is also kept on its own disk and served from its own origin, under
 * the same path a gateway uses: `/ipfs/<cid>`.
 *
 * The disk holds a copy, not the only one. A file that is missing (a new disk,
 * an eviction) is fetched back from IPFS the first time it is asked for. That
 * happens only for identifiers the caller vouches for, which the server does
 * for artwork it recorded itself: this is not an open gateway.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cidOfUrl, isCid } from '../../shared/src/ipfs.js';

/** The largest artwork file accepted, uploaded or fetched. */
export const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;

export type FileKind = 'png' | 'jpg' | 'gif' | 'webp' | 'json';

const MIME: Record<FileKind, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  json: 'application/json; charset=utf-8',
};

const KINDS = new Set<string>(Object.keys(MIME));

type ImageKind = { extension: 'png' | 'jpg' | 'gif' | 'webp'; mime: string };

/** What an image is, from its leading bytes. Never from a name or a declared type. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { extension: 'png', mime: 'image/png' };
  if (starts(0xff, 0xd8, 0xff)) return { extension: 'jpg', mime: 'image/jpeg' };
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { extension: 'gif', mime: 'image/gif' };
  }
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { extension: 'webp', mime: 'image/webp' };
  }
  return null;
}

/** Public gateways tried, after the configured one, when a file has to be fetched back. */
export const FALLBACK_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs',
  'https://ipfs.io/ipfs',
  'https://dweb.link/ipfs',
  'https://w3s.link/ipfs',
] as const;

/**
 * Where to fetch a missing file from, in order. The configured gateway comes
 * first. This site's own addresses are left out: it cannot fetch from itself
 * a file it does not have.
 */
export function gatewaysFor(configured: string, ownOrigins: readonly string[]): string[] {
  const usable = [configured, ...FALLBACK_GATEWAYS].filter((base) => {
    try {
      return !ownOrigins.includes(new URL(base).origin);
    } catch {
      return false;
    }
  });
  return [...new Set(usable)];
}

/**
 * The address a page should load a token's artwork from.
 *
 * A gateway address becomes this site's own `/ipfs/<cid>`, and a file this
 * server stored itself becomes its path, so neither depends on which of the
 * site's addresses the page was opened at. Anything else is left as it is.
 * Artwork on the operator's blocklist has no address.
 */
export function displayImage(image: string, ownOrigins: readonly string[], blocked: ReadonlySet<string> = new Set()): string {
  if (!image) return '';
  const cid = cidOfUrl(image);
  if (cid) return blocked.has(cid) ? '' : `/ipfs/${cid}`;
  try {
    const url = new URL(image);
    if (ownOrigins.includes(url.origin) && /^\/u\/[a-f0-9]{40}\.(png|jpg|gif|webp)$/.test(url.pathname)) return url.pathname;
  } catch {
    // Not an absolute address: left as stored.
  }
  return image;
}

export interface StoredFile {
  readonly cid: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly mime: string;
  readonly bytes: number;
}

export interface ArtworkOptions {
  readonly dir: string;
  /** Disk space the copies may take. The oldest are removed first; they can be fetched again. */
  readonly budgetBytes: number;
  /** Gateway bases to fetch a missing file from, in order, each ending in `/ipfs`. */
  readonly gateways: readonly string[];
  /** Identifiers the operator has taken down: never stored, never served, never fetched. */
  readonly blocked?: ReadonlySet<string>;
  readonly log?: (message: string) => void;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** How long to wait before asking the gateways again for a file none of them returned. */
const RETRY_MS = 5 * 60_000;

export class Artwork {
  readonly #dir: string;
  readonly #budget: number;
  readonly #gateways: readonly string[];
  readonly #blocked: ReadonlySet<string>;
  readonly #log: (message: string) => void;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #index = new Map<string, { kind: FileKind; bytes: number; at: number }>();
  readonly #inflight = new Map<string, Promise<StoredFile | undefined>>();
  readonly #retryAfter = new Map<string, number>();
  #total = 0;

  constructor(options: ArtworkOptions) {
    this.#dir = resolve(options.dir);
    this.#budget = options.budgetBytes;
    this.#gateways = options.gateways;
    this.#blocked = options.blocked ?? new Set();
    this.#log = options.log ?? (() => undefined);
    this.#fetch = options.fetcher ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#now = options.now ?? Date.now;
    mkdirSync(this.#dir, { recursive: true });
    for (const name of readdirSync(this.#dir)) {
      const path = resolve(this.#dir, name);
      const match = /^([A-Za-z0-9]+)\.([a-z]+)$/.exec(name);
      const cid = match?.[1];
      const kind = match?.[2];
      // Anything else here is an unfinished write, or not ours.
      if (cid === undefined || kind === undefined || !isCid(cid) || !KINDS.has(kind) || this.#blocked.has(cid)) {
        if (name.startsWith('.tmp-') || (cid !== undefined && this.#blocked.has(cid))) rmSync(path, { force: true });
        continue;
      }
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      this.#index.set(cid, { kind: kind as FileKind, bytes: stat.size, at: stat.mtimeMs });
      this.#total += stat.size;
    }
  }

  get directory(): string {
    return this.#dir;
  }

  get count(): number {
    return this.#index.size;
  }

  get totalBytes(): number {
    return this.#total;
  }

  isBlocked(cid: string): boolean {
    return this.#blocked.has(cid);
  }

  file(cid: string): StoredFile | undefined {
    const entry = this.#index.get(cid);
    if (!entry) return undefined;
    return { cid, path: resolve(this.#dir, `${cid}.${entry.kind}`), kind: entry.kind, mime: MIME[entry.kind], bytes: entry.bytes };
  }

  /**
   * Keeps a copy. The identifier is the content's own, so a file that is
   * already here is the same file and is left alone.
   */
  put(cid: string, bytes: Uint8Array, kind: FileKind): StoredFile | undefined {
    if (!isCid(cid)) throw new Error('Not an IPFS identifier.');
    if (this.#blocked.has(cid)) return undefined;
    const existing = this.file(cid);
    if (existing) return existing;
    const path = resolve(this.#dir, `${cid}.${kind}`);
    const temporary = resolve(this.#dir, `.tmp-${randomBytes(8).toString('hex')}`);
    writeFileSync(temporary, bytes, { mode: 0o644 });
    renameSync(temporary, path);
    this.#index.set(cid, { kind, bytes: bytes.length, at: this.#now() });
    this.#total += bytes.length;
    this.#makeRoom(cid);
    return this.file(cid);
  }

  /** Removes the oldest copies until the rest fit the budget. The newest one always stays. */
  #makeRoom(keep: string): void {
    if (this.#total <= this.#budget) return;
    const oldestFirst = [...this.#index.entries()].filter(([cid]) => cid !== keep).sort((a, b) => a[1].at - b[1].at);
    let removed = 0;
    for (const [cid, entry] of oldestFirst) {
      if (this.#total <= this.#budget) break;
      rmSync(resolve(this.#dir, `${cid}.${entry.kind}`), { force: true });
      this.#index.delete(cid);
      this.#total -= entry.bytes;
      removed += 1;
    }
    if (removed > 0) {
      this.#log(`artwork: the copies on disk passed ${Math.round(this.#budget / 1_048_576)} MB, so the ${removed} oldest were removed. They are fetched from IPFS again when asked for. Raise ARTWORK_CACHE_MB, with a disk to match, to keep more.`);
    }
  }

  /**
   * The copy of `cid`, fetched from IPFS first if it is not on disk. The
   * caller must already know the identifier is artwork this site vouches for.
   * Only an image is accepted, whatever a gateway sends back. Requests for the
   * same file share one fetch, and a file no gateway returned is not asked for
   * again for a few minutes.
   */
  pull(cid: string): Promise<StoredFile | undefined> {
    if (!isCid(cid) || this.#blocked.has(cid)) return Promise.resolve(undefined);
    const have = this.file(cid);
    if (have) return Promise.resolve(have);
    if ((this.#retryAfter.get(cid) ?? 0) > this.#now()) return Promise.resolve(undefined);
    let pending = this.#inflight.get(cid);
    if (!pending) {
      pending = this.#download(cid).finally(() => this.#inflight.delete(cid));
      this.#inflight.set(cid, pending);
    }
    return pending;
  }

  async #download(cid: string): Promise<StoredFile | undefined> {
    for (const gateway of this.#gateways) {
      try {
        const bytes = await this.#fetchCapped(`${gateway}/${cid}`);
        if (!bytes) continue;
        const kind = sniffImage(bytes);
        // A gateway's error page, or a file that is not artwork: try the next gateway.
        if (!kind) continue;
        return this.put(cid, bytes, kind.extension);
      } catch {
        // Unreachable, slow, or cut off: try the next gateway.
      }
    }
    if (this.#retryAfter.size > 5_000) this.#retryAfter.clear();
    this.#retryAfter.set(cid, this.#now() + RETRY_MS);
    this.#log(`artwork: ${cid} could not be fetched as an image from any of ${this.#gateways.length} gateway(s). Pages show the token's pixel mark meanwhile; the next try is in five minutes at the earliest.`);
    return undefined;
  }

  async #fetchCapped(url: string): Promise<Uint8Array | null> {
    const response = await this.#fetch(url, {
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: 'follow',
      headers: { accept: 'image/png,image/jpeg,image/gif,image/webp,*/*;q=0.1' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_ARTWORK_BYTES) {
      await response.body.cancel().catch(() => undefined);
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ARTWORK_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    if (total === 0) return null;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}
