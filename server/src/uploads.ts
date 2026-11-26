/**
 * Token artwork and metadata.
 *
 * Artwork is identified by its leading bytes, not by the name or type the
 * browser claims. Metadata JSON is built here from validated fields. With
 * PINATA_JWT set both are pinned to IPFS; without it they are stored on this
 * server's disk and served from this origin.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type Artwork, type FileKind, MAX_ARTWORK_BYTES, sniffImage } from './artwork.js';
import type { Store } from './db.js';
import type { AppEnv } from './env.js';

export { sniffImage } from './artwork.js';

export const MAX_IMAGE_BYTES = MAX_ARTWORK_BYTES;

export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

function httpsUrl(value: unknown, label: string, required: boolean): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new UploadError(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > 300) throw new UploadError(`${label} is too long.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UploadError(`${label} must be a complete https:// address.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new UploadError(`${label} must be a plain https:// address.`);
  }
  return parsed.toString();
}

function isOwnUpload(value: string, ownOrigin: string): boolean {
  return value.length <= 300 && value.startsWith(`${ownOrigin}/u/`) && /^[a-f0-9]{40}\.(png|jpg|gif|webp)$/.test(value.slice(ownOrigin.length + 3));
}

export interface MetadataInput {
  name: unknown;
  symbol: unknown;
  description?: unknown;
  image?: unknown;
  website?: unknown;
  twitter?: unknown;
}

export interface CleanMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  website: string;
  twitter: string;
}

/**
 * `ownOrigin` is this server's own origin. Artwork it stored itself is accepted
 * from there even over plain http, which is what local development uses.
 */
export function cleanMetadata(input: MetadataInput, ownOrigin?: string): CleanMetadata {
  if (typeof input.name !== 'string' || !input.name.trim()) throw new UploadError('Give the token a name.');
  const name = input.name.trim();
  if (Buffer.byteLength(name, 'utf8') > 32) throw new UploadError('Token names are limited to 32 bytes.');
  if (typeof input.symbol !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(input.symbol.trim())) {
    throw new UploadError('The ticker must be 1 to 10 letters or digits.');
  }
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length > 500) throw new UploadError('Keep the description under 500 characters.');
  return {
    name,
    symbol: input.symbol.trim().toUpperCase(),
    description,
    image:
      ownOrigin !== undefined && typeof input.image === 'string' && isOwnUpload(input.image, ownOrigin)
        ? input.image
        : httpsUrl(input.image, 'The image address', false),
    website: httpsUrl(input.website, 'The website', false),
    twitter: httpsUrl(input.twitter, 'The X link', false),
  };
}

/** The JSON a wallet or explorer reads from the token's URI. */
export function metadataJson(meta: CleanMetadata): Record<string, unknown> {
  const extensions = {
    ...(meta.website ? { website: meta.website } : {}),
    ...(meta.twitter ? { twitter: meta.twitter } : {}),
  };
  return {
    name: meta.name,
    symbol: meta.symbol,
    description: meta.description,
    ...(meta.image ? { image: meta.image } : {}),
    ...(meta.website ? { external_url: meta.website } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
}

/** The exact bytes pinned for a token's metadata. */
export function metadataBytes(meta: CleanMetadata): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(metadataJson(meta), null, 2)}\n`);
}

/** Pins a file to IPFS and returns its content identifier. */
async function pinFile(env: AppEnv, bytes: Uint8Array, filename: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(bytes)], { type: mime }), filename);
  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.pinataJwt ?? ''}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new UploadError('The file could not be pinned. Try again.', 502);
  const result = (await response.json()) as { IpfsHash?: unknown };
  if (typeof result.IpfsHash !== 'string' || !/^[A-Za-z0-9]{20,100}$/.test(result.IpfsHash)) {
    throw new UploadError('The pinning service returned an unexpected answer.', 502);
  }
  return result.IpfsHash;
}

export class Uploads {
  readonly #env: AppEnv;
  readonly #store: Store;
  readonly #dir: string;
  readonly #artwork: Artwork | undefined;
  readonly #log: (message: string) => void;

  /**
   * `artwork` is this site's own copy of what it pins. With it, a pinned file
   * is on this server's disk the moment it is uploaded, and pages never wait
   * for an IPFS gateway to show it.
   */
  constructor(env: AppEnv, store: Store, artwork?: Artwork, log: (message: string) => void = () => undefined) {
    this.#env = env;
    this.#store = store;
    this.#artwork = artwork;
    this.#log = log;
    this.#dir = resolve(env.dataDir, 'uploads');
    mkdirSync(this.#dir, { recursive: true });
  }

  /** The file is pinned whether or not the copy can be written, so a full disk does not stop a launch. */
  #keep(cid: string, bytes: Uint8Array, kind: FileKind): void {
    try {
      this.#artwork?.put(cid, bytes, kind);
    } catch (error) {
      this.#log(`artwork: ${cid} was pinned, but no copy could be written to disk (${error instanceof Error ? error.message : String(error)}). It will be fetched from IPFS when first shown.`);
    }
  }

  get directory(): string {
    return this.#dir;
  }

  /**
   * A token's metadata address is written on mainnet permanently. One that
   * points at this machine would never open for anyone else, so a server that
   * is connected to mainnet but only reachable as localhost takes no uploads
   * unless it pins them to IPFS.
   */
  #refuseUnreachable(): void {
    if (this.#env.heliusRpcUrl && this.#env.localOrigin && !this.#env.pinataJwt) {
      throw new UploadError(
        'This server is running on localhost without IPFS pinning. A token launched now would carry a metadata address nobody else could ever open. Set PINATA_JWT, or launch from the deployed https site.',
        409,
      );
    }
  }

  #checkLimits(ip: string): void {
    const now = Date.now();
    if (this.#store.uploadsSince(now - 60_000, ip) >= 8) throw new UploadError('Too many uploads. Wait a minute.', 429);
    if (this.#store.uploadsSince(now - 86_400_000, ip) >= 60) throw new UploadError('Daily upload limit reached.', 429);
    if (this.#store.uploadsSince(now - 86_400_000) >= this.#env.uploadDailyLimit) {
      throw new UploadError('The site-wide upload limit for today has been reached.', 429);
    }
    this.#store.recordUpload(ip, now);
  }

  async image(bytes: Uint8Array, ip: string, origin: string): Promise<string> {
    if (bytes.length === 0) throw new UploadError('The file is empty.');
    if (bytes.length > MAX_IMAGE_BYTES) throw new UploadError('Artwork is limited to 4 MB.', 413);
    const kind = sniffImage(bytes);
    if (!kind) throw new UploadError('Artwork must be a PNG, JPG, GIF or WebP image.', 415);
    this.#refuseUnreachable();
    this.#checkLimits(ip);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 40);
    const filename = `${digest}.${kind.extension}`;
    if (this.#env.pinataJwt) {
      const cid = await pinFile(this.#env, bytes, filename, kind.mime);
      this.#keep(cid, bytes, kind.extension);
      return `${this.#env.pinataGateway}/${cid}`;
    }
    const path = resolve(this.#dir, filename);
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o644 });
    return `${origin}/u/${filename}`;
  }

  async metadata(input: MetadataInput, ip: string, origin: string): Promise<{ uri: string; metadata: CleanMetadata }> {
    const metadata = cleanMetadata(input, origin);
    this.#refuseUnreachable();
    this.#checkLimits(ip);
    const id = randomBytes(16).toString('hex');
    let uri = `${origin}/api/metadata/${id}.json`;
    if (this.#env.pinataJwt) {
      const body = metadataBytes(metadata);
      const cid = await pinFile(this.#env, body, `${metadata.symbol.toLowerCase()}-${id}.json`, 'application/json');
      this.#keep(cid, body, 'json');
      uri = `${this.#env.pinataGateway}/${cid}`;
    }
    if (uri.length > 200) throw new UploadError('The metadata address is too long for a token URI.', 500);
    this.#store.saveMetadata({ id, uri, ...metadata, created_at: Date.now() });
    return { uri, metadata };
  }
}
