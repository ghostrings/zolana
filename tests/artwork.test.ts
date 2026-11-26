import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { Artwork, FALLBACK_GATEWAYS, MAX_ARTWORK_BYTES, displayImage, gatewaysFor, sniffImage } from '../server/src/artwork.js';
import { Store } from '../server/src/db.js';
import { EnvError, PUBLIC_PINATA_GATEWAY, readEnv } from '../server/src/env.js';
import { Uploads, metadataBytes } from '../server/src/uploads.js';
import { cidOfUrl, isCid } from '../shared/src/ipfs.js';

// The identifier in the operator's report, and two more of the right shape.
const PRV = 'QmRDRTNf8PLwBbNtLSCPFmkndh8xVP5xt3pRQ1umyRYKsU';
const OTHER = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const THIRD = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';
const V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

const MAIN = 'https://privacycash.fun';
const HOSTED = 'https://privacycash.onrender.com';

const png = (size = 64): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const html = new TextEncoder().encode('<!doctype html><title>Gateway error</title>');

const dirs: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pcf-artwork-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the network: answers by gateway host, and counts what it was asked. */
function gateways(answers: Record<string, () => Response | Promise<Response>>): { fetcher: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    asked.push(url.toString());
    const answer = answers[url.host];
    if (!answer) throw new TypeError('fetch failed');
    return answer();
  }) as typeof fetch;
  return { fetcher, asked };
}

describe('IPFS identifiers', () => {
  it('tells an identifier from other text', () => {
    expect(isCid(PRV)).toBe(true);
    expect(isCid(V1)).toBe(true);
    expect(isCid('')).toBe(false);
    expect(isCid('Qm123')).toBe(false);
    expect(isCid(`${PRV}x`)).toBe(false);
    // Base58 has no 0, O, I or l.
    expect(isCid(`Qm${'0'.repeat(44)}`)).toBe(false);
    expect(isCid('../../etc/passwd')).toBe(false);
    expect(isCid(`${PRV}/../x`)).toBe(false);
  });

  it('finds the identifier in every form of gateway address', () => {
    expect(cidOfUrl(`https://gateway.pinata.cloud/ipfs/${PRV}`)).toBe(PRV);
    expect(cidOfUrl(`https://example.mypinata.cloud/ipfs/${PRV}/`)).toBe(PRV);
    expect(cidOfUrl(`https://ipfs.io/ipfs/${PRV}?filename=logo.png`)).toBe(PRV);
    expect(cidOfUrl(`${MAIN}/ipfs/${PRV}`)).toBe(PRV);
    expect(cidOfUrl(`https://${V1}.ipfs.dweb.link/`)).toBe(V1);
    expect(cidOfUrl(`ipfs://${PRV}`)).toBe(PRV);
    expect(cidOfUrl(`ipfs://ipfs/${V1}`)).toBe(V1);
  });

  it('does not take anything else for one', () => {
    expect(cidOfUrl('')).toBeNull();
    expect(cidOfUrl('not an address')).toBeNull();
    expect(cidOfUrl(`${MAIN}/u/${'a'.repeat(40)}.png`)).toBeNull();
    expect(cidOfUrl(`https://gateway.pinata.cloud/ipfs/${PRV}/logo.png`)).toBeNull();
    expect(cidOfUrl('https://gateway.pinata.cloud/ipfs/notacid')).toBeNull();
    expect(cidOfUrl(`https://gateway.pinata.cloud/ipns/${PRV}`)).toBeNull();
    expect(cidOfUrl(`javascript:alert('${PRV}')`)).toBeNull();
    expect(cidOfUrl(`https://example.com/?next=/ipfs/${PRV}`)).toBeNull();
  });
});

describe('where a page loads artwork from', () => {
  it('uses this site for anything pinned, whichever gateway the token names', () => {
    expect(displayImage(`https://gateway.pinata.cloud/ipfs/${PRV}`, [HOSTED])).toBe(`/ipfs/${PRV}`);
    expect(displayImage(`https://example.mypinata.cloud/ipfs/${PRV}`, [MAIN, HOSTED])).toBe(`/ipfs/${PRV}`);
    expect(displayImage(`${MAIN}/ipfs/${PRV}`, [MAIN])).toBe(`/ipfs/${PRV}`);
  });

  it('uses a path for files this server stored itself, so either address of the site works', () => {
    const file = `/u/${'ab'.repeat(20)}.png`;
    expect(displayImage(`${HOSTED}${file}`, [MAIN, HOSTED])).toBe(file);
    // The same path on a host that is not this site is somebody else's file.
    expect(displayImage(`https://elsewhere.example${file}`, [MAIN, HOSTED])).toBe(`https://elsewhere.example${file}`);
  });

  it('leaves other addresses alone, and gives none for artwork that was taken down', () => {
    expect(displayImage('', [MAIN])).toBe('');
    expect(displayImage('https://cdn.example/logo.png', [MAIN])).toBe('https://cdn.example/logo.png');
    expect(displayImage(`https://gateway.pinata.cloud/ipfs/${PRV}`, [MAIN], new Set([PRV]))).toBe('');
  });

  it('fetches a missing file from the configured gateway first, and never from itself', () => {
    expect(gatewaysFor(PUBLIC_PINATA_GATEWAY, [MAIN])).toEqual([...FALLBACK_GATEWAYS]);
    expect(gatewaysFor('https://example.mypinata.cloud/ipfs', [MAIN])).toEqual(['https://example.mypinata.cloud/ipfs', ...FALLBACK_GATEWAYS]);
    expect(gatewaysFor(`${MAIN}/ipfs`, [MAIN, HOSTED])).toEqual([...FALLBACK_GATEWAYS]);
  });
});

describe("this server's copies of pinned files", () => {
  it('keeps a file under its identifier and finds it again after a restart', () => {
    const dir = folder();
    const first = new Artwork({ dir, budgetBytes: 1_000_000, gateways: [] });
    expect(first.file(PRV)).toBeUndefined();
    const stored = first.put(PRV, png(100), 'png');
    expect(stored).toMatchObject({ cid: PRV, kind: 'png', mime: 'image/png', bytes: 100 });
    expect(readFileSync(stored?.path ?? '').length).toBe(100);
    first.put(OTHER, new TextEncoder().encode('{"name":"x"}\n'), 'json');
    expect(first.file(OTHER)?.mime).toBe('application/json; charset=utf-8');

    const second = new Artwork({ dir, budgetBytes: 1_000_000, gateways: [] });
    expect(second.count).toBe(2);
    expect(second.totalBytes).toBe(113);
    expect(second.file(PRV)?.bytes).toBe(100);
  });

  it('does not rewrite a file it already has, and refuses a name that is not an identifier', () => {
    const artwork = new Artwork({ dir: folder(), budgetBytes: 1_000_000, gateways: [] });
    artwork.put(PRV, png(100), 'png');
    expect(artwork.put(PRV, png(900), 'png')?.bytes).toBe(100);
    expect(artwork.totalBytes).toBe(100);
    expect(() => artwork.put('../escape', png(), 'png')).toThrow();
    expect(() => artwork.put('', png(), 'png')).toThrow();
  });

  it('clears out unfinished writes and ignores files that are not its own', () => {
    const dir = folder();
    writeFileSync(join(dir, '.tmp-0123456789abcdef'), 'partial');
    writeFileSync(join(dir, 'notes.txt'), 'not ours');
    writeFileSync(join(dir, `${PRV}.exe`), 'not a kind this serves');
    const artwork = new Artwork({ dir, budgetBytes: 1_000_000, gateways: [] });
    expect(artwork.count).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([`${PRV}.exe`, 'notes.txt']);
  });

  it('removes the oldest copies when the budget is passed, and says so', () => {
    const lines: string[] = [];
    let clock = 1_000;
    const artwork = new Artwork({ dir: folder(), budgetBytes: 250, gateways: [], log: (line) => lines.push(line), now: () => (clock += 1) });
    artwork.put(PRV, png(100), 'png');
    artwork.put(OTHER, png(100), 'png');
    expect(lines).toEqual([]);
    artwork.put(THIRD, png(100), 'png');
    expect(artwork.file(PRV)).toBeUndefined();
    expect(artwork.file(OTHER)).toBeDefined();
    expect(artwork.file(THIRD)).toBeDefined();
    expect(artwork.totalBytes).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ARTWORK_CACHE_MB');
    // A single file larger than the whole budget is still kept: it is the newest.
    artwork.put(V1, png(900), 'png');
    expect(artwork.file(V1)).toBeDefined();
    expect(artwork.count).toBe(1);
  });

  it('never stores, serves or fetches artwork the operator took down', async () => {
    const dir = folder();
    new Artwork({ dir, budgetBytes: 1_000_000, gateways: [] }).put(PRV, png(), 'png');
    const network = gateways({ 'gateway.pinata.cloud': () => new Response(png()) });
    const artwork = new Artwork({ dir, budgetBytes: 1_000_000, gateways: [PUBLIC_PINATA_GATEWAY], blocked: new Set([PRV]), fetcher: network.fetcher });
    expect(artwork.isBlocked(PRV)).toBe(true);
    expect(artwork.file(PRV)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    expect(artwork.put(PRV, png(), 'png')).toBeUndefined();
    expect(await artwork.pull(PRV)).toBeUndefined();
    expect(network.asked).toEqual([]);
  });
});

describe('fetching a missing file back from IPFS', () => {
  it('takes it from the first gateway that returns an image, and keeps it', async () => {
    const network = gateways({
      'gateway.pinata.cloud': () => new Response('rate limited', { status: 429 }),
      'ipfs.io': () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      'dweb.link': () => new Response(png(300), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      'w3s.link': () => new Response(png(300)),
    });
    const artwork = new Artwork({ dir: folder(), budgetBytes: 1_000_000, gateways: [...FALLBACK_GATEWAYS], fetcher: network.fetcher });
    const file = await artwork.pull(PRV);
    expect(file).toMatchObject({ cid: PRV, kind: 'png', bytes: 300 });
    expect(network.asked).toEqual([`https://gateway.pinata.cloud/ipfs/${PRV}`, `https://ipfs.io/ipfs/${PRV}`, `https://dweb.link/ipfs/${PRV}`]);
    // Now it is on disk: nothing is asked again.
    expect((await artwork.pull(PRV))?.bytes).toBe(300);
    expect(network.asked).toHaveLength(3);
  });

  it('shares one fetch between requests that arrive together', async () => {
    let release: (response: Response) => void = () => undefined;
    const network = gateways({ 'gateway.pinata.cloud': () => new Promise<Response>((resolve) => (release = resolve)) });
    const artwork = new Artwork({ dir: folder(), budgetBytes: 1_000_000, gateways: [PUBLIC_PINATA_GATEWAY], fetcher: network.fetcher });
    const both = Promise.all([artwork.pull(PRV), artwork.pull(PRV), artwork.pull(PRV)]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release(new Response(png(200)));
    const files = await both;
    expect(files.map((file) => file?.bytes)).toEqual([200, 200, 200]);
    expect(network.asked).toHaveLength(1);
  });

  it('accepts only an image, of a size artwork may have', async () => {
    const big = () => new Response(png(MAX_ARTWORK_BYTES + 1));
    const declaredBig = () => new Response(png(10), { headers: { 'content-length': String(MAX_ARTWORK_BYTES + 1) } });
    for (const answer of [() => new Response(html), () => new Response('<svg onload="alert(1)"/>'), () => new Response(new Uint8Array(0)), big, declaredBig]) {
      const network = gateways({ 'gateway.pinata.cloud': answer });
      const artwork = new Artwork({ dir: folder(), budgetBytes: 100_000_000, gateways: [PUBLIC_PINATA_GATEWAY], fetcher: network.fetcher });
      expect(await artwork.pull(PRV)).toBeUndefined();
      expect(artwork.count).toBe(0);
    }
  });

  it('waits before asking again for a file no gateway returned, and says what happened once', async () => {
    const lines: string[] = [];
    let clock = 0;
    let up = false;
    const network = gateways({ 'gateway.pinata.cloud': () => (up ? new Response(png(50)) : new Response('', { status: 504 })) });
    const artwork = new Artwork({ dir: folder(), budgetBytes: 1_000_000, gateways: [PUBLIC_PINATA_GATEWAY], fetcher: network.fetcher, log: (line) => lines.push(line), now: () => clock });
    expect(await artwork.pull(PRV)).toBeUndefined();
    expect(await artwork.pull(PRV)).toBeUndefined();
    expect(network.asked).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(PRV);
    up = true;
    clock = 4 * 60_000;
    expect(await artwork.pull(PRV)).toBeUndefined();
    clock = 5 * 60_000 + 1;
    expect((await artwork.pull(PRV))?.bytes).toBe(50);
    expect(network.asked).toHaveLength(2);
  });

  it('gives up cleanly when no gateway can be reached at all', async () => {
    const network = gateways({});
    const artwork = new Artwork({ dir: folder(), budgetBytes: 1_000_000, gateways: [...FALLBACK_GATEWAYS], fetcher: network.fetcher });
    expect(await artwork.pull(PRV)).toBeUndefined();
    expect(network.asked).toHaveLength(FALLBACK_GATEWAYS.length);
    expect(await artwork.pull('not-a-cid')).toBeUndefined();
  });
});

describe('an upload that is pinned', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Pinata's answer to a pin request, and a record of what was sent to it. */
  const pinning = (cids: string[]): { calls: string[] } => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      const cid = cids.shift();
      return cid ? Response.json({ IpfsHash: cid }) : new Response('nope', { status: 500 });
    });
    return { calls };
  };

  it('is also kept on this disk, under the identifier Pinata returned', async () => {
    const dir = folder();
    const env = readEnv({ PINATA_JWT: 'test-jwt', DATA_DIR: dir, PUBLIC_ORIGIN: MAIN });
    const store = new Store(dir);
    const artwork = new Artwork({ dir: join(dir, 'ipfs'), budgetBytes: 10_000_000, gateways: [] });
    const uploads = new Uploads(env, store, artwork);
    const sent = pinning([PRV, OTHER]);

    const image = png(2_000);
    const url = await uploads.image(image, '203.0.113.7', MAIN);
    expect(url).toBe(`${PUBLIC_PINATA_GATEWAY}/${PRV}`);
    expect(Buffer.from(readFileSync(artwork.file(PRV)?.path ?? '')).equals(Buffer.from(image))).toBe(true);

    const { uri, metadata } = await uploads.metadata({ name: 'privacyCASH', symbol: 'prv', image: url }, '203.0.113.7', MAIN);
    expect(uri).toBe(`${PUBLIC_PINATA_GATEWAY}/${OTHER}`);
    expect(artwork.file(OTHER)?.kind).toBe('json');
    expect(readFileSync(artwork.file(OTHER)?.path ?? '', 'utf8')).toBe(new TextDecoder().decode(metadataBytes(metadata)));
    expect(JSON.parse(readFileSync(artwork.file(OTHER)?.path ?? '', 'utf8'))).toMatchObject({ name: 'privacyCASH', symbol: 'PRV', image: url });
    expect(sent.calls).toEqual(['POST https://api.pinata.cloud/pinning/pinFileToIPFS', 'POST https://api.pinata.cloud/pinning/pinFileToIPFS']);
    // What the listing hands to pages for this token: this site, not the gateway.
    expect(displayImage(store.metadataByUri(uri)?.image ?? '', [MAIN])).toBe(`/ipfs/${PRV}`);
    store.close();
  });

  it('carries the configured gateway in its permanent address, the site itself included', async () => {
    const dir = folder();
    const env = readEnv({ PINATA_JWT: 'test-jwt', DATA_DIR: dir, PUBLIC_ORIGIN: MAIN, PINATA_GATEWAY_URL: `${MAIN}/ipfs` });
    const store = new Store(dir);
    const artwork = new Artwork({ dir: join(dir, 'ipfs'), budgetBytes: 10_000_000, gateways: gatewaysFor(env.pinataGateway, env.allowedOrigins) });
    pinning([PRV]);
    expect(await new Uploads(env, store, artwork).image(png(), '203.0.113.7', MAIN)).toBe(`${MAIN}/ipfs/${PRV}`);
    expect(artwork.file(PRV)).toBeDefined();
    store.close();
  });

  it('still succeeds when the copy cannot be written, and says so', async () => {
    const dir = folder();
    const env = readEnv({ PINATA_JWT: 'test-jwt', DATA_DIR: dir, PUBLIC_ORIGIN: MAIN });
    const store = new Store(dir);
    const lines: string[] = [];
    const broken = { put: () => { throw new Error('ENOSPC: no space left on device'); } } as unknown as Artwork;
    pinning([PRV]);
    expect(await new Uploads(env, store, broken, (line) => lines.push(line)).image(png(), '203.0.113.7', MAIN)).toBe(`${PUBLIC_PINATA_GATEWAY}/${PRV}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ENOSPC');
    store.close();
  });

  it('fails as before when the pin itself fails, and keeps nothing', async () => {
    const dir = folder();
    const env = readEnv({ PINATA_JWT: 'test-jwt', DATA_DIR: dir, PUBLIC_ORIGIN: MAIN });
    const store = new Store(dir);
    const artwork = new Artwork({ dir: join(dir, 'ipfs'), budgetBytes: 10_000_000, gateways: [] });
    pinning([]);
    await expect(new Uploads(env, store, artwork).image(png(), '203.0.113.7', MAIN)).rejects.toThrow(/could not be pinned/);
    expect(artwork.count).toBe(0);
    store.close();
  });
});

describe('what the server recorded about artwork', () => {
  it('finds the upload an identifier belongs to, exactly', () => {
    const store = new Store(folder());
    const row = { name: 'Privacy', symbol: 'PRV', description: '', website: '', twitter: '', created_at: 1 };
    store.saveMetadata({ ...row, id: 'a'.repeat(32), uri: `${PUBLIC_PINATA_GATEWAY}/${OTHER}`, image: `${PUBLIC_PINATA_GATEWAY}/${PRV}` });
    expect(store.imagesMentioning(PRV).filter((image) => cidOfUrl(image) === PRV)).toEqual([`${PUBLIC_PINATA_GATEWAY}/${PRV}`]);
    expect(store.metadataMentioning(OTHER).find((found) => cidOfUrl(found.uri) === OTHER)?.symbol).toBe('PRV');
    // SQLite's LIKE ignores case; an identifier does not. The exact comparison is what decides.
    const lower = PRV.toLowerCase();
    expect(store.imagesMentioning(lower).filter((image) => cidOfUrl(image) === lower)).toEqual([]);
    expect(store.imagesMentioning(THIRD)).toEqual([]);
    expect(store.metadataMentioning(PRV).find((found) => cidOfUrl(found.uri) === PRV)).toBeUndefined();
    store.close();
  });
});

describe('artwork settings', () => {
  it('defaults to the public gateway, a 500 MB budget and no blocklist', () => {
    const env = readEnv({});
    expect(env.pinataGateway).toBe(PUBLIC_PINATA_GATEWAY);
    expect(env.artworkCacheBytes).toBe(500 * 1024 * 1024);
    expect(env.artworkBlocklist).toEqual([]);
  });

  it('accepts a dedicated gateway or the site itself, tidied', () => {
    expect(readEnv({ PINATA_GATEWAY_URL: 'https://Example.mypinata.cloud/ipfs/' }).pinataGateway).toBe('https://example.mypinata.cloud/ipfs');
    expect(readEnv({ PINATA_GATEWAY_URL: `${MAIN}/ipfs` }).pinataGateway).toBe(`${MAIN}/ipfs`);
    expect(readEnv({ PINATA_GATEWAY_URL: 'http://localhost:8080/ipfs' }).pinataGateway).toBe('http://localhost:8080/ipfs');
  });

  it('refuses a gateway address that would write dead addresses into tokens', () => {
    for (const value of ['example.mypinata.cloud/ipfs', 'https://example.mypinata.cloud', 'https://example.mypinata.cloud/files', 'http://example.mypinata.cloud/ipfs', 'https://example.mypinata.cloud/ipfs?x=1', 'https://example.mypinata.cloud/gateway/ipfs']) {
      expect(() => readEnv({ PINATA_GATEWAY_URL: value }), value).toThrow(EnvError);
    }
  });

  it('reads the budget and the blocklist', () => {
    expect(readEnv({ ARTWORK_CACHE_MB: '64' }).artworkCacheBytes).toBe(64 * 1024 * 1024);
    expect(() => readEnv({ ARTWORK_CACHE_MB: '1' })).toThrow(EnvError);
    expect(readEnv({ ARTWORK_BLOCKLIST: ` ${PRV}, ${V1} ${PRV}` }).artworkBlocklist).toEqual([PRV, V1]);
    expect(() => readEnv({ ARTWORK_BLOCKLIST: `https://gateway.pinata.cloud/ipfs/${PRV}` })).toThrow(/IPFS identifiers/);
  });
});

describe('recognising an image', () => {
  it('goes by the first bytes', () => {
    expect(sniffImage(png())?.extension).toBe('png');
    expect(sniffImage(html)).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});
