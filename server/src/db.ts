/**
 * SQLite store. It holds the public listing (which is rebuilt from chain), the
 * uploaded token artwork and metadata, and the desk's quote ledger. It never
 * holds a user's key, viewing key, balance or trade.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { TOKEN_SORTS, type TokenSort } from '../../shared/src/api.js';
import { unitsOf, volumeFromFees, volumeFromFeesNumber } from '../../shared/src/volume.js';

/**
 * One listed token. The money columns keep the names they were given when
 * every token was priced in SOL, so that an earlier build can still read this
 * database: `price_sol` and `market_cap_sol` are in the token's pair token,
 * and the `*_lamports` columns are in that pair token's base units. The
 * `*_sol` REAL columns are the same figures in SOL terms, for ordering and
 * totals across pairs.
 */
export interface TokenRow {
  mint: string;
  pool: string;
  config: string;
  fee_bps: number;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  description: string;
  image: string;
  website: string;
  twitter: string;
  stage: string;
  price_sol: string;
  market_cap_sol: string;
  progress: number;
  reserve_lamports: string;
  threshold_lamports: string;
  fee_lamports: string;
  volume_24h_lamports: string;
  /** The token's supply on chain right now, in base units. Empty until it has been read. Burns lower it. */
  supply: string;
  /** The id of the pair token it is priced in: `SOL`, `USDC`, ... */
  pair: string;
  /** Market cap, reserve, lifetime fees and 24-hour volume in SOL terms, at the pair's rate. */
  cap_sol: number;
  reserve_sol: number;
  fee_sol: number;
  volume_sol: number;
  created_at: number;
  updated_at: number;
}

export { TOKEN_SORTS, type TokenSort };

/**
 * What a token has traded since launch, in SOL terms: its lifetime fees over
 * its fee rate, which is one rate for its whole life. A rate of nothing
 * divides to NULL, which sorts last.
 */
const LIFETIME_VOLUME_SOL = '(fee_sol * 10000.0 / fee_bps)';

// Size and volume are compared in SOL terms, so tokens priced in different pair tokens share one order.
const ORDER_BY: Record<TokenSort, string> = {
  // Hot: the most traded in the last day first. Tokens that did not trade in it follow, the most traded since
  // launch first, so a quiet day still has an order worth reading; newer tokens break what ties are left.
  hot: `volume_sol DESC, ${LIFETIME_VOLUME_SOL} DESC, created_at DESC`,
  new: 'created_at DESC',
  cap: 'cap_sol DESC, created_at DESC',
  // Volume: the most traded since launch.
  volume: `${LIFETIME_VOLUME_SOL} DESC, created_at DESC`,
  graduation: 'progress DESC, created_at DESC',
};

export interface TokenPage {
  readonly rows: TokenRow[];
  /** How many listed tokens match, across all pages. */
  readonly total: number;
}

export interface MetadataRow {
  id: string;
  /** The address written into the token on chain. */
  uri: string;
  name: string;
  symbol: string;
  description: string;
  image: string;
  website: string;
  twitter: string;
  created_at: number;
}

export type QuoteStatus = 'quoted' | 'prepared' | 'submitted' | 'landed' | 'failed' | 'expired';

export interface DeskQuoteRow {
  id: string;
  side: string;
  mint: string;
  trader: string | null;
  pay_asset: string;
  pay_amount: string;
  receive_asset: string;
  receive_amount: string;
  reference_amount: string;
  spread_bps: number;
  status: QuoteStatus;
  message: string | null;
  signature: string | null;
  expires_at: number;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  pool TEXT NOT NULL,
  config TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,
  creator TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  uri TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  twitter TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'curve',
  price_sol TEXT NOT NULL DEFAULT '0',
  market_cap_sol TEXT NOT NULL DEFAULT '0',
  progress REAL NOT NULL DEFAULT 0,
  reserve_lamports TEXT NOT NULL DEFAULT '0',
  threshold_lamports TEXT NOT NULL DEFAULT '0',
  fee_lamports TEXT NOT NULL DEFAULT '0',
  volume_24h_lamports TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  mint TEXT NOT NULL,
  at INTEGER NOT NULL,
  price_sol TEXT NOT NULL,
  fee_lamports TEXT NOT NULL,
  PRIMARY KEY (mint, at)
);
CREATE TABLE IF NOT EXISTS metadata (
  id TEXT PRIMARY KEY,
  uri TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT NOT NULL,
  image TEXT NOT NULL,
  website TEXT NOT NULL,
  twitter TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_log (
  at INTEGER NOT NULL,
  ip TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_log_at ON upload_log (at);
CREATE TABLE IF NOT EXISTS desk_quotes (
  id TEXT PRIMARY KEY,
  side TEXT NOT NULL,
  mint TEXT NOT NULL,
  trader TEXT,
  pay_asset TEXT NOT NULL,
  pay_amount TEXT NOT NULL,
  receive_asset TEXT NOT NULL,
  receive_amount TEXT NOT NULL,
  reference_amount TEXT NOT NULL,
  spread_bps INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  signature TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS desk_quotes_status ON desk_quotes (status, expires_at);
CREATE TABLE IF NOT EXISTS module_offers (
  wallet TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  memo TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS module_offers_mint ON module_offers (mint, created_at);
CREATE TABLE IF NOT EXISTS modules (
  mint TEXT PRIMARY KEY,
  dev TEXT NOT NULL,
  wallet TEXT NOT NULL,
  pot TEXT NOT NULL,
  memo TEXT NOT NULL,
  burn_bps INTEGER NOT NULL,
  wallets TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  paid TEXT NOT NULL DEFAULT '0',
  spent TEXT NOT NULL DEFAULT '0',
  burned TEXT NOT NULL DEFAULT '0',
  last_pass_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS module_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '0',
  tokens TEXT NOT NULL DEFAULT '0',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS module_events_mint ON module_events (mint, id);
CREATE TABLE IF NOT EXISTS module_examined (
  mint TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS module_opened (
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (mint, wallet)
);
`;

/**
 * A token whose creator fees run through fee modules. `memo` is the settings
 * as the creator signed them; `wallet` holds the pool's creator role and `pot`
 * the buyback share until it is spent. `wallets` is JSON: `[{address, bps}]`.
 * `paid`, `spent` and `burned` are running totals in base units: pair token
 * sent to the wallets, pair token spent on buybacks, tokens burned.
 */
export interface ModuleRow {
  mint: string;
  dev: string;
  wallet: string;
  pot: string;
  memo: string;
  burn_bps: number;
  wallets: string;
  activated_at: number;
  paid: string;
  spent: string;
  burned: string;
  last_pass_at: number;
  last_error: string;
}

export type ModuleEventKind = 'payout' | 'buyback' | 'burn' | 'setup';

export interface ModuleEventRow {
  id: number;
  mint: string;
  kind: ModuleEventKind;
  signature: string;
  /** Base units of the pair token that moved. */
  quote: string;
  /** Base units of the token that were burned. */
  tokens: string;
  at: number;
}

/** How many settings one token can have on offer at once, and how many there can be in all. Older ones go first. */
const OFFERS_PER_MINT = 8;
const OFFERS_IN_ALL = 5_000;

export class Store {
  readonly #db: DatabaseSync;
  /**
   * The configs whose tokens are served. Undefined means no filter. A token
   * created under a config that is no longer one of the platform's (an earlier
   * set, a first-run set) stays in the database and is simply not listed.
   */
  #listed: readonly string[] | undefined;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#db = new DatabaseSync(resolve(dataDir, 'privacycash.sqlite'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
    this.#db.exec('CREATE INDEX IF NOT EXISTS tokens_config ON tokens (config, created_at)');
    // A database made by an earlier version gains the columns added since.
    const columns = new Set((this.#db.prepare('PRAGMA table_info(tokens)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has('supply')) this.#db.exec("ALTER TABLE tokens ADD COLUMN supply TEXT NOT NULL DEFAULT ''");
    if (!columns.has('pair')) {
      // Columns are only ever added, so the build before this one can still open the database.
      // Every token that exists so far is priced in SOL, where the SOL terms are the figures themselves.
      this.transaction(() => {
        this.#db.exec("ALTER TABLE tokens ADD COLUMN pair TEXT NOT NULL DEFAULT 'SOL'");
        for (const column of ['cap_sol', 'reserve_sol', 'fee_sol', 'volume_sol']) {
          this.#db.exec(`ALTER TABLE tokens ADD COLUMN ${column} REAL NOT NULL DEFAULT 0`);
        }
        this.#db.exec(
          `UPDATE tokens SET
             cap_sol = CAST(market_cap_sol AS REAL),
             reserve_sol = CAST(reserve_lamports AS REAL) / 1e9,
             fee_sol = CAST(fee_lamports AS REAL) / 1e9,
             volume_sol = CAST(volume_24h_lamports AS REAL) / 1e9`,
        );
      });
    }
    this.#db.exec('CREATE INDEX IF NOT EXISTS tokens_creator ON tokens (creator)');
  }

  close(): void {
    this.#db.close();
  }

  setListedConfigs(addresses: readonly string[]): void {
    this.#listed = [...addresses];
  }

  #listedClause(): { sql: string; args: string[] } {
    if (this.#listed === undefined) return { sql: '1 = 1', args: [] };
    if (this.#listed.length === 0) return { sql: '1 = 0', args: [] };
    return { sql: `config IN (${this.#listed.map(() => '?').join(', ')})`, args: [...this.#listed] };
  }

  /** Runs `work` in one database transaction: many small writes become one disk sync. */
  transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /* ---------------- tokens ---------------- */

  /**
   * `supply` may be left out when it was not read this time: the stored value
   * is then kept. `pair` and the SOL-terms figures may be left out for a token
   * priced in SOL, where they follow from the other columns.
   */
  upsertToken(
    row: Omit<
      TokenRow,
      'description' | 'image' | 'website' | 'twitter' | 'volume_24h_lamports' | 'supply' | 'pair' | 'cap_sol' | 'reserve_sol' | 'fee_sol' | 'volume_sol' | 'created_at' | 'updated_at'
    > & { supply?: string; pair?: string; cap_sol?: number; reserve_sol?: number; fee_sol?: number },
    now: number,
  ): void {
    const real = (value: number | undefined, fallback: number): number => {
      const number = value ?? fallback;
      return Number.isFinite(number) ? number : 0;
    };
    this.#db
      .prepare(
        `INSERT INTO tokens (mint, pool, config, fee_bps, creator, name, symbol, uri, stage, price_sol, market_cap_sol, progress, reserve_lamports, threshold_lamports, fee_lamports, supply, pair, cap_sol, reserve_sol, fee_sol, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET
           stage = excluded.stage, price_sol = excluded.price_sol, market_cap_sol = excluded.market_cap_sol,
           progress = excluded.progress, reserve_lamports = excluded.reserve_lamports,
           threshold_lamports = excluded.threshold_lamports, fee_lamports = excluded.fee_lamports,
           pair = excluded.pair, cap_sol = excluded.cap_sol, reserve_sol = excluded.reserve_sol, fee_sol = excluded.fee_sol,
           supply = CASE WHEN excluded.supply != '' THEN excluded.supply ELSE tokens.supply END,
           name = CASE WHEN excluded.name != '' THEN excluded.name ELSE tokens.name END,
           symbol = CASE WHEN excluded.symbol != '' THEN excluded.symbol ELSE tokens.symbol END,
           uri = CASE WHEN excluded.uri != '' THEN excluded.uri ELSE tokens.uri END,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.mint, row.pool, row.config, row.fee_bps, row.creator, row.name, row.symbol, row.uri, row.stage,
        row.price_sol, row.market_cap_sol, row.progress, row.reserve_lamports, row.threshold_lamports, row.fee_lamports, row.supply ?? '',
        row.pair ?? 'SOL',
        real(row.cap_sol, Number(row.market_cap_sol)),
        real(row.reserve_sol, Number(row.reserve_lamports) / 1e9),
        real(row.fee_sol, Number(row.fee_lamports) / 1e9),
        now, now,
      );
  }

  attachListing(mint: string, listing: Pick<TokenRow, 'description' | 'image' | 'website' | 'twitter'>): void {
    this.#db
      .prepare('UPDATE tokens SET description = ?, image = ?, website = ?, twitter = ? WHERE mint = ?')
      .run(listing.description, listing.image, listing.website, listing.twitter, mint);
  }

  /**
   * The 24-hour volume in base units of the token's pair token, and the same in
   * SOL terms. `volumeSol` may be left out for a token priced in SOL.
   */
  setVolume(mint: string, volume: string, volumeSol?: number): void {
    const inSol = volumeSol ?? Number(volume) / 1e9;
    this.#db.prepare('UPDATE tokens SET volume_24h_lamports = ?, volume_sol = ? WHERE mint = ?').run(volume, Number.isFinite(inSol) ? inSol : 0, mint);
  }

  /** A listed token, or undefined when the mint is unknown or its config is not one of the platform's. */
  token(mint: string): TokenRow | undefined {
    const clause = this.#listedClause();
    return this.#db.prepare(`SELECT * FROM tokens WHERE mint = ? AND ${clause.sql}`).get(mint, ...clause.args) as TokenRow | undefined;
  }

  /** The newest listed tokens. */
  tokens(limit = 500): TokenRow[] {
    const clause = this.#listedClause();
    return this.#db
      .prepare(`SELECT * FROM tokens WHERE ${clause.sql} ORDER BY created_at DESC LIMIT ?`)
      .all(...clause.args, limit) as unknown as TokenRow[];
  }

  /**
   * One page of the listing. `query` matches a ticker or a name anywhere in it,
   * or a mint address from its start; the match ignores case.
   */
  tokenPage(input: { page: number; size: number; sort: TokenSort; query?: string; pair?: string }): TokenPage {
    const clause = this.#listedClause();
    const where = [clause.sql];
    const args: Array<string | number> = [...clause.args];
    if (input.pair) {
      where.push('pair = ?');
      args.push(input.pair);
    }
    const query = (input.query ?? '').trim().slice(0, 64);
    if (query) {
      // LIKE's own wildcards are escaped, so a search for "100%" means those four characters.
      const like = query.replace(/[\\%_]/g, (character) => `\\${character}`);
      where.push("(symbol LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR mint LIKE ? ESCAPE '\\')");
      args.push(`%${like}%`, `%${like}%`, `${like}%`);
    }
    const filter = where.join(' AND ');
    const total = (this.#db.prepare(`SELECT COUNT(*) AS count FROM tokens WHERE ${filter}`).get(...args) as { count: number }).count;
    const size = Math.max(1, Math.min(48, Math.floor(input.size)));
    const page = Math.max(1, Math.floor(input.page));
    const rows = this.#db
      .prepare(`SELECT * FROM tokens WHERE ${filter} ORDER BY ${ORDER_BY[input.sort]} LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size) as unknown as TokenRow[];
    return { rows, total };
  }

  /** The listed tokens among `mints`, in no particular order. For a wallet that wants to name what it holds. */
  tokensByMints(mints: readonly string[]): TokenRow[] {
    if (mints.length === 0) return [];
    const clause = this.#listedClause();
    return this.#db
      .prepare(`SELECT * FROM tokens WHERE mint IN (${mints.map(() => '?').join(', ')}) AND ${clause.sql}`)
      .all(...mints, ...clause.args) as unknown as TokenRow[];
  }

  /** The listed tokens a wallet launched, newest first. */
  tokensByCreator(creator: string, limit = 100): TokenRow[] {
    const clause = this.#listedClause();
    return this.#db
      .prepare(`SELECT * FROM tokens WHERE creator = ? AND ${clause.sql} ORDER BY created_at DESC LIMIT ?`)
      .all(creator, ...clause.args, limit) as unknown as TokenRow[];
  }

  /** Every listed token, oldest first. For the indexer, which must keep all of them current. */
  allTokens(): TokenRow[] {
    const clause = this.#listedClause();
    return this.#db.prepare(`SELECT * FROM tokens WHERE ${clause.sql} ORDER BY created_at ASC`).all(...clause.args) as unknown as TokenRow[];
  }

  knownMints(): Set<string> {
    const rows = this.#db.prepare('SELECT mint FROM tokens').all() as Array<{ mint: string }>;
    return new Set(rows.map((row) => row.mint));
  }

  /**
   * Totals over every listed token, for the front page, in SOL terms
   * (lamports). A token priced in SOL counts exactly. A token priced in
   * another pair token counts at the rate its pair's curve was sized at.
   */
  totals(): { tokens: number; graduated: number; reserveLamports: string; volumeLamports: string; volume24hLamports: string; feeLamports: string } {
    const clause = this.#listedClause();
    const rows = this.#db
      .prepare(`SELECT stage, pair, fee_bps, reserve_lamports, volume_24h_lamports, fee_lamports, reserve_sol, volume_sol, fee_sol FROM tokens WHERE ${clause.sql}`)
      .all(...clause.args) as Array<{
      stage: string;
      pair: string;
      fee_bps: number;
      reserve_lamports: string;
      volume_24h_lamports: string;
      fee_lamports: string;
      reserve_sol: number;
      volume_sol: number;
      fee_sol: number;
    }>;
    const lamports = (sol: number): bigint => (Number.isFinite(sol) && sol > 0 ? BigInt(Math.round(sol * 1e9)) : 0n);
    let reserve = 0n;
    let volume = 0n;
    let lifetime = 0n;
    let fee = 0n;
    let graduated = 0;
    for (const row of rows) {
      const inSol = row.pair === 'SOL';
      if (row.stage === 'curve') reserve += inSol ? BigInt(row.reserve_lamports || '0') : lamports(row.reserve_sol);
      if (row.stage === 'graduated') graduated += 1;
      volume += inSol ? BigInt(row.volume_24h_lamports || '0') : lamports(row.volume_sol);
      fee += inSol ? BigInt(row.fee_lamports || '0') : lamports(row.fee_sol);
      // Since launch: each token's lifetime fees over its own fee rate. The rates differ, so this is summed token by token.
      lifetime += inSol ? volumeFromFees(unitsOf(row.fee_lamports), row.fee_bps) : lamports(volumeFromFeesNumber(row.fee_sol, row.fee_bps));
    }
    return {
      tokens: rows.length,
      graduated,
      reserveLamports: reserve.toString(),
      volumeLamports: lifetime.toString(),
      volume24hLamports: volume.toString(),
      feeLamports: fee.toString(),
    };
  }

  /* ---------------- snapshots ---------------- */

  /** A price point and the cumulative fee at that moment, both in the token's pair token. */
  addSnapshot(mint: string, at: number, priceSol: string, feeLamports: string): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO snapshots (mint, at, price_sol, fee_lamports) VALUES (?, ?, ?, ?)')
      .run(mint, at, priceSol, feeLamports);
  }

  snapshots(mint: string, since: number): Array<{ at: number; price_sol: string; fee_lamports: string }> {
    return this.#db
      .prepare('SELECT at, price_sol, fee_lamports FROM snapshots WHERE mint = ? AND at >= ? ORDER BY at ASC')
      .all(mint, since) as Array<{ at: number; price_sol: string; fee_lamports: string }>;
  }

  /**
   * A token's price since `since`, thinned in the database to one point per
   * `bucketMs` (the last one in each stretch), oldest first, and before them
   * the last point from before `since`, when there is one. For the small
   * chart on a card: a busy token has thousands of points in a day, and a
   * card needs a few dozen.
   */
  priceTrail(mint: string, since: number, bucketMs: number): Array<{ at: number; price: string }> {
    const bucket = Math.max(1, Math.floor(bucketMs));
    const before = this.#db
      .prepare('SELECT at, price_sol AS price FROM snapshots WHERE mint = ? AND at < ? ORDER BY at DESC LIMIT 1')
      .get(mint, since) as { at: number; price: string } | undefined;
    // With MAX(at) as the only aggregate, SQLite takes price_sol from that same row: the last point of the bucket.
    // The division is cast to a whole number: a bound number may arrive as a real, and a real quotient would
    // put every point in a bucket of its own.
    const within = this.#db
      .prepare(
        'SELECT MAX(at) AS at, price_sol AS price FROM snapshots WHERE mint = ? AND at >= ? GROUP BY CAST((at - ?) / ? AS INTEGER) ORDER BY 1 ASC',
      )
      .all(mint, since, since, bucket) as Array<{ at: number; price: string }>;
    return before ? [before, ...within] : within;
  }

  /**
   * The cumulative fee a token had 24 hours ago, for a volume delta: the
   * snapshot at or just before `at`. A token first seen after `at` had taken
   * no fees yet at that time, so its baseline is zero. A token seen earlier
   * but with no snapshot that old (history was pruned or lost) falls back to
   * its oldest snapshot.
   */
  feeAt(mint: string, at: number): string | undefined {
    const row = this.#db
      .prepare('SELECT fee_lamports FROM snapshots WHERE mint = ? AND at <= ? ORDER BY at DESC LIMIT 1')
      .get(mint, at) as { fee_lamports: string } | undefined;
    if (row) return row.fee_lamports;
    const token = this.#db.prepare('SELECT created_at FROM tokens WHERE mint = ?').get(mint) as { created_at: number } | undefined;
    if (token && token.created_at > at) return '0';
    const first = this.#db
      .prepare('SELECT fee_lamports FROM snapshots WHERE mint = ? ORDER BY at ASC LIMIT 1')
      .get(mint) as { fee_lamports: string } | undefined;
    return first?.fee_lamports;
  }

  pruneSnapshots(before: number): void {
    this.#db.prepare('DELETE FROM snapshots WHERE at < ?').run(before);
  }

  /* ---------------- metadata ---------------- */

  saveMetadata(row: MetadataRow): void {
    this.#db
      .prepare('INSERT INTO metadata (id, uri, name, symbol, description, image, website, twitter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.uri, row.name, row.symbol, row.description, row.image, row.website, row.twitter, row.created_at);
  }

  metadata(id: string): MetadataRow | undefined {
    return this.#db.prepare('SELECT * FROM metadata WHERE id = ?').get(id) as MetadataRow | undefined;
  }

  metadataByUri(uri: string): MetadataRow | undefined {
    return this.#db.prepare('SELECT * FROM metadata WHERE uri = ?').get(uri) as MetadataRow | undefined;
  }

  /**
   * Metadata rows whose address mentions `text`, oldest first. LIKE ignores
   * case and an IPFS identifier does not, so the caller compares exactly.
   */
  metadataMentioning(text: string): MetadataRow[] {
    return this.#db.prepare('SELECT * FROM metadata WHERE uri LIKE ? ORDER BY created_at LIMIT 20').all(`%${text}%`) as unknown as MetadataRow[];
  }

  /** Artwork addresses this server recorded that mention `text`: from uploads and from tokens. The caller compares exactly. */
  imagesMentioning(text: string): string[] {
    const rows = this.#db
      .prepare('SELECT image FROM metadata WHERE image LIKE ? UNION SELECT image FROM tokens WHERE image LIKE ? LIMIT 20')
      .all(`%${text}%`, `%${text}%`) as unknown as Array<{ image: string }>;
    return rows.map((row) => row.image);
  }

  /* ---------------- upload limits ---------------- */

  recordUpload(ip: string, now: number): void {
    this.#db.prepare('INSERT INTO upload_log (at, ip) VALUES (?, ?)').run(now, ip);
    this.#db.prepare('DELETE FROM upload_log WHERE at < ?').run(now - 86_400_000);
  }

  uploadsSince(since: number, ip?: string): number {
    const row = (
      ip === undefined
        ? this.#db.prepare('SELECT COUNT(*) AS n FROM upload_log WHERE at >= ?').get(since)
        : this.#db.prepare('SELECT COUNT(*) AS n FROM upload_log WHERE at >= ? AND ip = ?').get(since, ip)
    ) as { n: number };
    return Number(row.n);
  }

  /* ---------------- desk ---------------- */

  saveQuote(row: DeskQuoteRow): void {
    this.#db
      .prepare(
        `INSERT INTO desk_quotes (id, side, mint, trader, pay_asset, pay_amount, receive_asset, receive_amount, reference_amount, spread_bps, status, message, signature, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.side, row.mint, row.trader, row.pay_asset, row.pay_amount, row.receive_asset, row.receive_amount,
        row.reference_amount, row.spread_bps, row.status, row.message, row.signature, row.expires_at, row.created_at,
      );
  }

  quote(id: string): DeskQuoteRow | undefined {
    return this.#db.prepare('SELECT * FROM desk_quotes WHERE id = ?').get(id) as DeskQuoteRow | undefined;
  }

  /** Moves a quote forward only from the state the caller believes it is in. */
  advanceQuote(
    id: string,
    from: QuoteStatus,
    to: QuoteStatus,
    fields: Partial<Pick<DeskQuoteRow, 'trader' | 'message' | 'signature' | 'expires_at'>> = {},
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE desk_quotes SET status = ?, trader = COALESCE(?, trader), message = COALESCE(?, message), signature = COALESCE(?, signature),
           expires_at = COALESCE(?, expires_at)
         WHERE id = ? AND status = ?`,
      )
      .run(to, fields.trader ?? null, fields.message ?? null, fields.signature ?? null, fields.expires_at ?? null, id, from);
    return Number(result.changes) === 1;
  }

  expireQuotes(now: number): void {
    this.#db
      .prepare("UPDATE desk_quotes SET status = 'expired' WHERE status IN ('quoted', 'prepared') AND expires_at < ?")
      .run(now);
  }

  /**
   * Amounts the desk has committed but not yet settled, per asset it would pay
   * out. A bare quote reserves nothing: only a fill the trader has already
   * backed with a valid proof does, so asking for quotes cannot tie up the
   * desk's inventory.
   */
  reservedOut(now: number): Map<string, bigint> {
    const rows = this.#db
      .prepare("SELECT receive_asset, receive_amount FROM desk_quotes WHERE status IN ('prepared', 'submitted') AND expires_at >= ?")
      .all(now) as Array<{ receive_asset: string; receive_amount: string }>;
    const out = new Map<string, bigint>();
    for (const row of rows) out.set(row.receive_asset, (out.get(row.receive_asset) ?? 0n) + BigInt(row.receive_amount));
    return out;
  }

  /* ---------------- fee modules ---------------- */

  /**
   * Remembers settings a creator was offered a module wallet for, until the
   * chain shows whether the creator role was handed to it. Anyone can ask for
   * an offer, so they are capped: per token and in all, oldest dropped first.
   */
  saveModuleOffer(offer: { wallet: string; mint: string; memo: string }, now: number): void {
    this.transaction(() => {
      this.#db.prepare('INSERT INTO module_offers (wallet, mint, memo, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET created_at = excluded.created_at').run(offer.wallet, offer.mint, offer.memo, now);
      this.#db
        .prepare('DELETE FROM module_offers WHERE mint = ? AND wallet NOT IN (SELECT wallet FROM module_offers WHERE mint = ? ORDER BY created_at DESC, wallet LIMIT ?)')
        .run(offer.mint, offer.mint, OFFERS_PER_MINT);
      this.#db.prepare('DELETE FROM module_offers WHERE wallet NOT IN (SELECT wallet FROM module_offers ORDER BY created_at DESC, wallet LIMIT ?)').run(OFFERS_IN_ALL);
    });
  }

  /** The offer made for exactly this module wallet, if it is still remembered. */
  moduleOffer(wallet: string): { wallet: string; mint: string; memo: string } | undefined {
    return this.#db.prepare('SELECT wallet, mint, memo FROM module_offers WHERE wallet = ?').get(wallet) as { wallet: string; mint: string; memo: string } | undefined;
  }

  /** Records a token's modules, and shows its creator as the wallet that switched them on. One row per token, never replaced. */
  saveModule(row: Pick<ModuleRow, 'mint' | 'dev' | 'wallet' | 'pot' | 'memo' | 'burn_bps' | 'wallets' | 'activated_at'>): boolean {
    return this.transaction(() => {
      const result = this.#db
        .prepare('INSERT INTO modules (mint, dev, wallet, pot, memo, burn_bps, wallets, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mint) DO NOTHING')
        .run(row.mint, row.dev, row.wallet, row.pot, row.memo, row.burn_bps, row.wallets, row.activated_at);
      if (Number(result.changes) !== 1) return false;
      this.#db.prepare('UPDATE tokens SET creator = ? WHERE mint = ?').run(row.dev, row.mint);
      this.#db.prepare('DELETE FROM module_offers WHERE mint = ?').run(row.mint);
      this.#db.prepare('DELETE FROM module_examined WHERE mint = ?').run(row.mint);
      return true;
    });
  }

  /**
   * Shows a module token's creator as the wallet that switched its modules on.
   * A token first listed after that carries the module's wallet as its creator
   * on chain, which is not what a visitor means by the word.
   */
  setTokenCreator(mint: string, creator: string): void {
    this.#db.prepare('UPDATE tokens SET creator = ? WHERE mint = ? AND creator != ?').run(creator, mint, creator);
  }

  module(mint: string): ModuleRow | undefined {
    return this.#db.prepare('SELECT * FROM modules WHERE mint = ?').get(mint) as ModuleRow | undefined;
  }

  /** Every token with modules, oldest first. */
  modules(): ModuleRow[] {
    return this.#db.prepare('SELECT * FROM modules ORDER BY activated_at ASC').all() as unknown as ModuleRow[];
  }

  /** Notes that a pass looked at a token, and what stopped it if anything did. An empty `error` clears the last one. */
  noteModulePass(mint: string, at: number, error: string): void {
    this.#db.prepare('UPDATE modules SET last_pass_at = ?, last_error = ? WHERE mint = ?').run(at, error.slice(0, 600), mint);
  }

  /** Records something a module did and adds it to the token's running totals, in one step. */
  addModuleEvent(event: Omit<ModuleEventRow, 'id'>, totals: { paid?: bigint; spent?: bigint; burned?: bigint } = {}): void {
    this.transaction(() => {
      this.#db.prepare('INSERT INTO module_events (mint, kind, signature, quote, tokens, at) VALUES (?, ?, ?, ?, ?, ?)').run(event.mint, event.kind, event.signature, event.quote, event.tokens, event.at);
      const row = this.module(event.mint);
      if (!row) return;
      const add = (current: string, more: bigint | undefined): string => (BigInt(current || '0') + (more ?? 0n)).toString();
      this.#db
        .prepare('UPDATE modules SET paid = ?, spent = ?, burned = ? WHERE mint = ?')
        .run(add(row.paid, totals.paid), add(row.spent, totals.spent), add(row.burned, totals.burned), event.mint);
    });
  }

  /** The latest things a token's modules did, newest first. */
  moduleEvents(mint: string, limit = 20): ModuleEventRow[] {
    return this.#db.prepare('SELECT * FROM module_events WHERE mint = ? ORDER BY id DESC LIMIT ?').all(mint, limit) as unknown as ModuleEventRow[];
  }

  /**
   * The creator address a token had when the chain was last searched for a
   * module memo and none was found. While the creator is still that address
   * there is nothing new to find.
   */
  moduleExamined(mint: string): { creator: string; at: number } | undefined {
    return this.#db.prepare('SELECT creator, at FROM module_examined WHERE mint = ?').get(mint) as { creator: string; at: number } | undefined;
  }

  /**
   * The sharing wallets of a token for which this server has already opened an
   * account for the pair token. It does that once per wallet: the owner can
   * close the account and keep the rent, so a second time would be a gift.
   */
  moduleOpened(mint: string): Set<string> {
    return new Set((this.#db.prepare('SELECT wallet FROM module_opened WHERE mint = ?').all(mint) as Array<{ wallet: string }>).map((row) => row.wallet));
  }

  markModuleOpened(mint: string, wallets: readonly string[], at: number): void {
    this.transaction(() => {
      for (const wallet of wallets) this.#db.prepare('INSERT INTO module_opened (mint, wallet, at) VALUES (?, ?, ?) ON CONFLICT(mint, wallet) DO NOTHING').run(mint, wallet, at);
    });
  }

  markModuleExamined(mint: string, creator: string, at: number): void {
    this.#db.prepare('INSERT INTO module_examined (mint, creator, at) VALUES (?, ?, ?) ON CONFLICT(mint) DO UPDATE SET creator = excluded.creator, at = excluded.at').run(mint, creator, at);
  }
}
