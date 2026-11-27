/**
 * Follows the Solana Privacy Program and keeps what an outsider can read of
 * it: the explorer's feed, each wallet's public activity, and how much of each
 * token sits in its Rings vault.
 *
 * It only ever reads. It holds no key and sends no transaction, so nothing it
 * does, right or wrong, can move anybody's funds: the worst a mistake here can
 * do is show a wrong row.
 *
 * WHAT IT COSTS
 *   Every pass asks the RPC for the program's new signatures (one request),
 *   then for each new transaction itself (one request) and, for a private
 *   transfer only, the indexer's view of it (one more). Vault balances are
 *   read in batches of a hundred. The register of custom rings is one scan
 *   of the program's accounts every fifteen minutes, and at once when a
 *   transaction changes it. RINGS_POLL_SECONDS sets how often a pass
 *   runs, RINGS_BACKFILL_DAYS how far back history is read once, and
 *   RINGS_EXPLORER=NO switches all of it off.
 */

import type { CustomRingsView, RingAsset, RingAssetSort, RingKind, RingOverview } from '../../../shared/src/rings-api.js';
import { WSOL_MINT } from '../../../shared/src/constants.js';
import { type RingRegistration, mergeRegister, parseRegister, readRingRegistration } from '../../../shared/src/custom-rings.js';
import { type DecodedRing, type RawTransaction, type RingEvent, UnreadableTransaction, decodeRing } from './decode.js';
import { type RingAssetRow, type RingStore } from './store.js';

/** One entry of a program's signature list. */
export interface RingSignature {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly failed: boolean;
}

export interface RingAccount {
  readonly lamports: bigint;
  readonly data: Uint8Array;
}

/** Everything the indexer asks of the outside world. The real one talks to the RPC; the tests script one. */
export interface RingChain {
  /** The program's signatures, newest first. `before` and `until` are exclusive, as the RPC has them. */
  signatures(options: { before?: string; until?: string; limit: number }): Promise<RingSignature[]>;
  /** Null when the RPC does not have the transaction (yet). */
  transaction(signature: string): Promise<RawTransaction | null>;
  /** The indexer's events for a transaction, in order. Null when it has none (yet). */
  events(signature: string): Promise<RingEvent[] | null>;
  /** Every token registered with Rings. */
  registry(): Promise<Array<{ mint: string; assetId: string }>>;
  accounts(addresses: readonly string[]): Promise<Array<RingAccount | null>>;
  /** Every account of the Privacy Program with the size and the type of a custom ring's registration. */
  ringConfigs(): Promise<Array<{ address: string; data: Uint8Array }>>;
  /** Whether a new ring is active from the moment it registers, as the program's own settings say. */
  ringActivationOpen(): Promise<boolean>;
  /** How many wallets have registered to receive privately. Null when it could not be counted. */
  walletCount(): Promise<number | null>;
  /** Names for tokens, where the RPC knows any. Missing mints are simply absent. */
  names(mints: readonly string[]): Promise<Map<string, { symbol: string; name: string }>>;
  vaultOf(mint: string): Promise<string>;
  readonly solVault: string;
  /** Lamports an account of this size must hold to exist; they are not anybody's shielded SOL. */
  rentFor(dataLength: number): Promise<bigint>;
}

export interface RingIndexerOptions {
  readonly pollSeconds: number;
  readonly backfillDays: number;
  /** Tokens launched on this site, by mint: their names and pictures are already known here. */
  readonly listed: (mints: readonly string[]) => Map<string, { symbol: string; name: string; image: string }>;
  /** Tokens whose names are fixed knowledge (SOL, USDC, the pair tokens). */
  readonly wellKnown: ReadonlyMap<string, { symbol: string; name: string }>;
  readonly log: (message: string) => void;
  readonly now?: () => number;
}

const DAY = 86_400_000;
const HEAD_PER_PASS = 120;
const TAIL_PER_PASS = 60;
const PARTIAL_PER_PASS = 20;
const PARTIAL_MAX_TRIES = 6;
const REGISTRY_EVERY_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 15 * 60_000;
const WALLETS_EVERY_MS = 30 * 60_000;
const CUSTOM_RINGS_EVERY_MS = 15 * 60_000;
/** Where the register of custom rings is kept between restarts. */
const CUSTOM_RINGS_KEY = 'customRings';
const NAMES_PER_PASS = 200;
const TRAIL_BUCKETS = 28;
const TRAIL_BUCKET_MS = (7 * DAY) / TRAIL_BUCKETS;

/** A token's name as somebody else wrote it: cut to size and to printable characters before it is kept. */
export function cleanLabel(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // Control characters, and the invisible ones that can hide text or turn it around.
    const hidden =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202f) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    if (!hidden) out += character;
  }
  return out.trim().slice(0, max);
}

function u64At(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(data[offset + index] ?? 0);
  return value;
}

/** The amount a token account holds: bytes 64 to 72 of its data, little-endian, in both token programs. */
export function tokenAccountAmount(data: Uint8Array): bigint | null {
  return data.length >= 165 ? u64At(data, 64) : null;
}

/** A mint's supply and decimals: bytes 36 to 44 and byte 44, in both token programs. */
export function mintFacts(data: Uint8Array): { supply: bigint; decimals: number } | null {
  const supply = data.length >= 82 ? u64At(data, 36) : null;
  const decimals = data[44];
  if (supply === null || typeof decimals !== 'number' || decimals > 18) return null;
  return { supply, decimals };
}

interface Flow {
  net24: bigint;
  net7: bigint;
  moves24: number;
  /** Net movement into Rings in each of the trail's buckets, oldest first. */
  buckets: bigint[];
}

/** Shielded amount at the end of each bucket, as a share of the largest, from where it stands now and what moved. */
export function trailOf(shieldedNow: bigint, buckets: readonly bigint[]): number[] {
  if (buckets.every((bucket) => bucket === 0n)) return [];
  const levels: bigint[] = new Array<bigint>(buckets.length).fill(0n);
  let level = shieldedNow;
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    levels[index] = level < 0n ? 0n : level;
    level -= buckets[index] ?? 0n;
  }
  const top = levels.reduce((best, value) => (value > best ? value : best), 0n);
  if (top === 0n) return [];
  return levels.map((value) => Number((value * 1000n) / top) / 1000);
}

function shareBps(shielded: bigint, supply: bigint): number | null {
  if (supply <= 0n) return null;
  return Number((shielded * 10_000n) / supply);
}

function big(text: string): bigint {
  return /^-?\d{1,60}$/.test(text) ? BigInt(text) : 0n;
}

export class RingIndexer {
  readonly #chain: RingChain;
  readonly #store: RingStore;
  readonly #options: RingIndexerOptions;
  readonly #now: () => number;
  readonly #vaults = new Map<string, string>();
  readonly #said = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;
  #registryAt = 0;
  #sweepAt = 0;
  #walletsAt = 0;
  #customRingsAt = 0;
  #namesOff = false;
  #rent = new Map<number, bigint>();
  /** Signatures listed after the last one read, oldest first, waiting their turn. */
  #queue: RingSignature[] = [];
  /** How often the RPC listed a transaction and then could not serve it. */
  readonly #misses = new Map<string, number>();
  /** What the routes serve, rebuilt after every pass. */
  #assets: RingAsset[] = [];
  #overview: RingOverview;

  constructor(chain: RingChain, store: RingStore, options: RingIndexerOptions) {
    this.#chain = chain;
    this.#store = store;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#overview = this.#emptyOverview();
    this.#rebuild();
  }

  start(): void {
    this.#options.log(`rings: following the Rings program every ${this.#options.pollSeconds}s, reading back ${this.#options.backfillDays} day(s) of history. Read-only.`);
    this.#schedule(5_000);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.pass().finally(() => this.#schedule(this.#options.pollSeconds * 1000));
    }, delay);
    this.#timer.unref();
  }

  #sayHourly(key: string, message: string): void {
    const now = this.#now();
    if (now - (this.#said.get(key) ?? -Infinity) < 3_600_000) return;
    this.#said.set(key, now);
    this.#options.log(message);
  }

  async #step(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.#sayHourly(`step:${name}`, `rings: ${name} did not finish (${error instanceof Error ? error.message : String(error)}). It is tried again on the next pass.`);
    }
  }

  /** One round of reading. Never throws: each part fails on its own and is tried again next time. */
  async pass(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const touched = new Set<string>();
      await this.#step('reading the token registry', () => this.#registry(false));
      await this.#step('reading new transactions', () => this.#head(touched));
      await this.#step('reading earlier history', () => this.#tail(touched));
      await this.#step('reading the receiving side of transfers', () => this.#partials());
      await this.#step('reading vault balances', () => this.#balances(touched));
      await this.#step('counting registered wallets', () => this.#wallets());
      await this.#step('reading the register of custom rings', () => this.#customRings());
      await this.#step('naming tokens', () => this.#names());
      this.#rebuild();
    } finally {
      this.#running = false;
    }
  }

  /* ---------------- tokens ---------------- */

  async #vault(mint: string): Promise<string> {
    if (mint === WSOL_MINT) return this.#chain.solVault;
    const known = this.#vaults.get(mint);
    if (known) return known;
    const vault = await this.#chain.vaultOf(mint);
    this.#vaults.set(mint, vault);
    return vault;
  }

  async #registry(force: boolean): Promise<void> {
    const now = this.#now();
    if (!force && now - this.#registryAt < REGISTRY_EVERY_MS && this.#registryAt !== 0) return;
    const entries = await this.#chain.registry();
    const known = new Set(this.#store.assets().map((asset) => asset.mint));
    const fresh: Array<{ mint: string; assetId: string; vault: string; symbol?: string; decimals?: number }> = [];
    if (!known.has(WSOL_MINT)) fresh.push({ mint: WSOL_MINT, assetId: '1', vault: this.#chain.solVault, symbol: 'SOL', decimals: 9 });
    for (const entry of entries) {
      if (known.has(entry.mint) || entry.mint === WSOL_MINT) continue;
      fresh.push({ mint: entry.mint, assetId: entry.assetId, vault: await this.#vault(entry.mint) });
    }
    const added = this.#store.addAssets(fresh, now);
    this.#registryAt = now;
    if (added > 0) {
      // New tokens are read at once, not at the next sweep.
      this.#sweepAt = 0;
      if (known.size > 0) this.#options.log(`rings: ${added} more token${added === 1 ? '' : 's'} registered with Rings (${known.size + added} in all)`);
    }
  }

  async #balances(touched: ReadonlySet<string>): Promise<void> {
    const now = this.#now();
    const all = this.#store.assets();
    const sweep = now - this.#sweepAt >= SWEEP_EVERY_MS;
    const wanted = sweep ? all : all.filter((asset) => touched.has(asset.mint) || asset.read_at === 0);
    if (wanted.length === 0) return;
    for (let start = 0; start < wanted.length; start += 50) {
      const chunk = wanted.slice(start, start + 50);
      const tokens = chunk.filter((asset) => asset.mint !== WSOL_MINT);
      // Each token's vault and its mint, in one request.
      const accounts = tokens.length > 0 ? await this.#chain.accounts(tokens.flatMap((asset) => [asset.vault, asset.mint])) : [];
      tokens.forEach((asset, index) => {
        const vault = accounts[index * 2] ?? null;
        const mint = accounts[index * 2 + 1] ?? null;
        const facts = mint ? mintFacts(mint.data) : null;
        // A vault that does not exist holds nothing. One that exists and cannot be read is left as it was.
        const amount = vault === null ? 0n : tokenAccountAmount(vault.data);
        if (amount === null) return;
        this.#store.setBalance(asset.mint, { shielded: amount.toString(), ...(facts ? { supply: facts.supply.toString(), decimals: facts.decimals } : {}) }, now);
      });
      if (chunk.some((asset) => asset.mint === WSOL_MINT)) {
        const [sol] = await this.#chain.accounts([this.#chain.solVault]);
        if (sol) {
          let rent = this.#rent.get(sol.data.length);
          if (rent === undefined) {
            rent = await this.#chain.rentFor(sol.data.length);
            this.#rent.set(sol.data.length, rent);
          }
          const held = sol.lamports > rent ? sol.lamports - rent : 0n;
          this.#store.setBalance(WSOL_MINT, { shielded: held.toString(), decimals: 9 }, now);
        } else {
          this.#store.setBalance(WSOL_MINT, { shielded: '0', decimals: 9 }, now);
        }
      }
    }
    if (sweep) this.#sweepAt = now;
  }

  async #wallets(): Promise<void> {
    const now = this.#now();
    if (now - this.#walletsAt < WALLETS_EVERY_MS && this.#walletsAt !== 0) return;
    const count = await this.#chain.walletCount();
    this.#walletsAt = now;
    if (count !== null) this.#store.setMeta('wallets', String(count));
  }

  /**
   * Reads every custom ring registered with the program. An account is kept
   * only when it checks out as a registration (see `readRingRegistration`).
   * The scan either answers whole or fails, so a failed read leaves the last
   * register in place and is tried again on the next pass.
   */
  async #customRings(): Promise<void> {
    const now = this.#now();
    if (now - this.#customRingsAt < CUSTOM_RINGS_EVERY_MS && this.#customRingsAt !== 0) return;
    const accounts = await this.#chain.ringConfigs();
    const read: RingRegistration[] = [];
    let refused = 0;
    for (const account of accounts) {
      const ring = await readRingRegistration(account.address, account.data);
      if (ring) read.push(ring);
      else refused += 1;
    }
    if (refused > 0) {
      this.#sayHourly('rings:refused', `rings: ${refused} account(s) have the size and type of a custom ring's registration and do not check out as one. They are not listed.`);
    }
    let activation: 'open' | 'governance' | null = null;
    try {
      activation = (await this.#chain.ringActivationOpen()) ? 'open' : 'governance';
    } catch (error) {
      // The list itself was read; the network's setting keeps its last known value.
      this.#sayHourly('rings:activation', `rings: how custom rings are activated could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
    const previous = parseRegister(this.#store.meta(CUSTOM_RINGS_KEY));
    const known = new Set((previous?.rings ?? []).map((ring) => ring.config));
    const register = mergeRegister(previous, read, activation, now);
    this.#store.setMeta(CUSTOM_RINGS_KEY, JSON.stringify(register));
    this.#customRingsAt = now;
    for (const ring of register.rings) {
      if (!known.has(ring.config) && previous !== null) this.#options.log(`rings: a custom ring was registered: program ${ring.program}`);
    }
  }

  async #names(): Promise<void> {
    const waiting = this.#store.unnamed(NAMES_PER_PASS);
    if (waiting.length === 0) return;
    const left: string[] = [];
    const own = this.#options.listed(waiting);
    for (const mint of waiting) {
      const fixed = this.#options.wellKnown.get(mint);
      const listed = own.get(mint);
      if (fixed) this.#store.setName(mint, cleanLabel(fixed.symbol, 16), cleanLabel(fixed.name, 48));
      else if (listed) this.#store.setName(mint, cleanLabel(listed.symbol, 16), cleanLabel(listed.name, 48));
      else left.push(mint);
    }
    if (left.length === 0 || this.#namesOff) {
      // Without a source of names a token is shown by its address. It is marked as looked up so it is not asked about every pass.
      if (this.#namesOff) for (const mint of left) this.#store.setName(mint, '', '');
      return;
    }
    let found: Map<string, { symbol: string; name: string }>;
    try {
      found = await this.#chain.names(left);
    } catch (error) {
      // Names are a nicety. An RPC that cannot give them is not asked again until the server restarts.
      this.#namesOff = true;
      this.#options.log(`rings: token names could not be read from the RPC (${error instanceof Error ? error.message : String(error)}). Tokens from elsewhere are shown by address.`);
      return;
    }
    for (const mint of left) {
      const entry = found.get(mint);
      this.#store.setName(mint, cleanLabel(entry?.symbol, 16), cleanLabel(entry?.name, 48));
    }
  }

  /* ---------------- transactions ---------------- */

  /** Reads one transaction and stores it. Returns false when the RPC does not have it yet. */
  async #read(entry: RingSignature, touched: Set<string>): Promise<boolean> {
    if (entry.failed) return true; // A failed transaction changed nothing; there is nothing to show for it.
    const raw = await this.#chain.transaction(entry.signature);
    if (!raw) return false;
    const at = (entry.blockTime ?? raw.blockTime ?? 0) * 1000 || this.#now();
    let decoded: DecodedRing;
    try {
      const mints = new Set<string>();
      for (const balance of [...(raw.meta?.preTokenBalances ?? []), ...(raw.meta?.postTokenBalances ?? [])]) {
        if (typeof balance?.mint === 'string') mints.add(balance.mint);
      }
      for (const mint of mints) await this.#vault(mint);
      const context = { solVault: this.#chain.solVault, vaultOf: (mint: string) => this.#vaults.get(mint) };
      decoded = decodeRing(raw, null, context);
      if (decoded.partial) {
        // Only a move that stayed private, or a deposit, needs the indexer: it says whose the outputs are.
        const events = await this.#chain.events(entry.signature).catch(() => null);
        if (events) decoded = decodeRing(raw, events, context);
      }
    } catch (error) {
      if (!(error instanceof UnreadableTransaction)) throw error;
      this.#sayHourly('unreadable', `rings: a transaction could not be read and is listed without detail (${entry.signature}: ${error.message})`);
      this.#store.save({ signature: entry.signature, slot: entry.slot, at, kind: 'other', payer: '', senders: [], recipients: [], legs: [], via: [], ring: null, partial: false });
      return true;
    }
    this.#store.save({
      signature: entry.signature,
      slot: entry.slot,
      at,
      kind: decoded.kind,
      payer: decoded.payer,
      senders: decoded.senders,
      recipients: decoded.recipients,
      legs: decoded.legs,
      via: decoded.via,
      ring: decoded.ring,
      partial: decoded.partial,
    });
    for (const mint of decoded.touched) touched.add(mint);
    if (decoded.kind === 'token') this.#registryAt = 0; // A token was registered: the list is read again on the next pass.
    if (decoded.ringAdmin) this.#customRingsAt = 0; // A ring's registration changed: the register is read again on this pass.
    return true;
  }

  /** New transactions since the last one read, oldest first, so a failure leaves no gap behind it. */
  async #head(touched: Set<string>): Promise<void> {
    // Listed since the newest signature already known: the waiting ones first, else the last one read.
    const newest = this.#queue[this.#queue.length - 1]?.signature ?? this.#store.meta('head');
    const fresh: RingSignature[] = [];
    let before: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const batch = await this.#chain.signatures({ limit: 200, ...(before ? { before } : {}), ...(newest ? { until: newest } : {}) });
      fresh.push(...batch);
      if (batch.length < 200 || !newest) break;
      before = batch[batch.length - 1]?.signature;
    }
    if (!newest) {
      // First run: start from the newest hundred and let the history pass read back from there.
      const first = fresh.slice(0, 100);
      const oldest = first[first.length - 1];
      if (oldest && !this.#store.meta('tail')) this.#store.setMeta('tail', oldest.signature);
      this.#queue.push(...first.reverse());
    } else {
      this.#queue.push(...fresh.reverse());
    }
    for (let done = 0; done < HEAD_PER_PASS; done += 1) {
      const entry = this.#queue[0];
      if (!entry) break;
      if (!(await this.#read(entry, touched))) {
        // The RPC lists it and cannot serve it yet. It is waited for, in order, for a few passes;
        // after that it is left behind rather than holding up everything after it.
        const misses = (this.#misses.get(entry.signature) ?? 0) + 1;
        if (misses < 5) {
          this.#misses.set(entry.signature, misses);
          break;
        }
        this.#sayHourly('missing', `rings: the RPC lists a transaction it does not serve; it is passed over (${entry.signature})`);
      }
      this.#misses.delete(entry.signature);
      this.#queue.shift();
      this.#store.setMeta('head', entry.signature);
    }
  }

  /** History before the first transaction read, a batch per pass, until it is as old as it was told to go. */
  async #tail(touched: Set<string>): Promise<void> {
    if (this.#store.meta('tailDone') === '1') return;
    const tail = this.#store.meta('tail');
    if (!tail) return;
    const cutoff = this.#now() - this.#options.backfillDays * DAY;
    const batch = await this.#chain.signatures({ before: tail, limit: TAIL_PER_PASS });
    if (batch.length === 0) {
      this.#store.setMeta('tailDone', '1');
      this.#options.log('rings: history has been read back to the program\'s first transaction');
      return;
    }
    for (const entry of batch) {
      if (entry.blockTime !== null && entry.blockTime * 1000 < cutoff) {
        this.#store.setMeta('tailDone', '1');
        this.#options.log(`rings: history has been read back ${this.#options.backfillDays} day(s), as set by RINGS_BACKFILL_DAYS`);
        return;
      }
      // A transaction the RPC cannot serve is passed over here: history is a best effort, the head is not.
      await this.#read(entry, touched).catch(() => false);
      this.#store.setMeta('tail', entry.signature);
    }
  }

  async #partials(): Promise<void> {
    for (const row of this.#store.partial(PARTIAL_PER_PASS, PARTIAL_MAX_TRIES)) {
      await this.#read({ signature: row.signature, slot: row.slot, blockTime: Math.floor(row.at / 1000), failed: false }, new Set());
    }
  }

  /* ---------------- what the routes serve ---------------- */

  #emptyOverview(): RingOverview {
    return {
      enabled: true,
      since: null,
      through: null,
      complete: false,
      tokens: 0,
      wallets: null,
      tx24h: 0,
      txAll: 0,
      active24h: 0,
      shields24h: 0,
      unshields24h: 0,
      transfers24h: 0,
      solShielded: '0',
      solFlow24h: '0',
    };
  }

  #rebuild(): void {
    const now = this.#now();
    const flows = new Map<string, Flow>();
    const start = now - 7 * DAY;
    for (const leg of this.#store.legsSince(start)) {
      let flow = flows.get(leg.mint);
      if (!flow) {
        flow = { net24: 0n, net7: 0n, moves24: 0, buckets: new Array<bigint>(TRAIL_BUCKETS).fill(0n) };
        flows.set(leg.mint, flow);
      }
      const signed = leg.dir === 'in' ? big(leg.amount) : -big(leg.amount);
      flow.net7 += signed;
      if (leg.at >= now - DAY) {
        flow.net24 += signed;
        flow.moves24 += 1;
      }
      const bucket = Math.min(TRAIL_BUCKETS - 1, Math.max(0, Math.floor((leg.at - start) / TRAIL_BUCKET_MS)));
      flow.buckets[bucket] = (flow.buckets[bucket] ?? 0n) + signed;
    }
    const rows = this.#store.assets();
    const own = this.#options.listed(rows.map((row) => row.mint));
    this.#assets = rows.map((row) => this.#asset(row, flows.get(row.mint), own.get(row.mint)));

    const span = this.#store.span();
    const kinds = this.#store.kinds(now - DAY);
    const of = (kind: RingKind): number => kinds.get(kind) ?? 0;
    const wallets = this.#store.meta('wallets');
    const sol = this.#assets.find((asset) => asset.mint === WSOL_MINT);
    let tx24h = 0;
    // Moves are funds moving: a token being registered, and the protocol's housekeeping, are not.
    for (const [kind, count] of kinds) if (kind !== 'upkeep' && kind !== 'other' && kind !== 'token') tx24h += count;
    this.#overview = {
      enabled: true,
      since: span.since,
      through: span.through,
      complete: this.#store.meta('tailDone') === '1',
      tokens: rows.length,
      wallets: wallets === undefined ? null : Number(wallets),
      tx24h,
      txAll: this.#store.count(),
      active24h: this.#store.active(now - DAY),
      shields24h: of('shield'),
      unshields24h: of('unshield'),
      transfers24h: of('transfer') + of('swap') + of('private'),
      solShielded: sol?.shielded ?? '0',
      solFlow24h: sol?.flow24h ?? '0',
    };
  }

  #asset(row: RingAssetRow, flow: Flow | undefined, listed: { symbol: string; name: string; image: string } | undefined): RingAsset {
    const shielded = big(row.shielded);
    const supply = row.supply ? big(row.supply) : 0n;
    return {
      mint: row.mint,
      symbol: listed?.symbol ?? row.symbol,
      name: listed?.name ?? row.name,
      image: listed?.image ?? '',
      decimals: row.decimals,
      supply: row.supply,
      shielded: row.shielded,
      shareBps: row.mint === WSOL_MINT ? null : shareBps(shielded, supply),
      flow24h: (flow?.net24 ?? 0n).toString(),
      flow7d: (flow?.net7 ?? 0n).toString(),
      moves24h: flow?.moves24 ?? 0,
      listed: listed !== undefined,
      trail: flow ? trailOf(shielded, flow.buckets) : [],
      firstSeen: row.first_seen,
    };
  }

  overview(): RingOverview {
    return this.#overview;
  }

  /** The register of custom rings as last read, with how many transactions of each have been seen. */
  customRings(): CustomRingsView {
    const register = parseRegister(this.#store.meta(CUSTOM_RINGS_KEY));
    if (!register) return { enabled: true, readAt: null, activation: null, rings: [] };
    const counts = this.#store.ringCounts();
    return {
      enabled: true,
      readAt: register.at,
      activation: register.activation,
      // The indexer names a ring by its program, or by its registration when it has no program on record for the event.
      rings: register.rings.map((ring) => ({ ...ring, moves: (counts.get(ring.program) ?? 0) + (counts.get(ring.config) ?? 0) })),
    };
  }

  asset(mint: string): RingAsset | undefined {
    return this.#assets.find((asset) => asset.mint === mint);
  }

  /** A page of the tokens registered with Rings. Those nobody holds privately come last in every order. */
  assetPage(input: { sort: RingAssetSort; page: number; size: number; query?: string; held?: boolean }): { assets: RingAsset[]; total: number } {
    const query = (input.query ?? '').trim().toLowerCase().slice(0, 64);
    let list = this.#assets;
    if (input.held) list = list.filter((asset) => asset.shielded !== '0');
    if (query) {
      list = list.filter((asset) => asset.symbol.toLowerCase().includes(query) || asset.name.toLowerCase().includes(query) || asset.mint.toLowerCase().startsWith(query));
    }
    // A movement is compared across tokens as a share of each token's own supply; an amount on its own says nothing between two tokens.
    const scaled = (asset: RingAsset, amount: string): number => {
      const supply = asset.supply ? big(asset.supply) : 0n;
      const units = big(amount);
      if (supply <= 0n) return units === 0n ? 0 : Number(units) / 10 ** asset.decimals / 1e12;
      return Number((units * 1_000_000n) / supply);
    };
    const key: Record<RingAssetSort, (asset: RingAsset) => number> = {
      shielded: (asset) => (asset.mint === WSOL_MINT ? Number.MAX_SAFE_INTEGER : scaled(asset, asset.shielded)),
      share: (asset) => (asset.mint === WSOL_MINT ? Number.MAX_SAFE_INTEGER : (asset.shareBps ?? 0)),
      flow24h: (asset) => scaled(asset, asset.flow24h),
      flow7d: (asset) => scaled(asset, asset.flow7d),
      active: (asset) => asset.moves24h,
      new: (asset) => asset.firstSeen,
    };
    const rank = key[input.sort];
    const sorted = [...list].sort((a, b) => {
      const held = Number(b.shielded !== '0') - Number(a.shielded !== '0');
      if (input.sort !== 'new' && held !== 0) return held;
      return rank(b) - rank(a) || b.firstSeen - a.firstSeen || (a.mint < b.mint ? -1 : 1);
    });
    const size = Math.max(1, Math.min(100, Math.floor(input.size)));
    const page = Math.max(1, Math.floor(input.page));
    return { assets: sorted.slice((page - 1) * size, page * size), total: sorted.length };
  }
}
