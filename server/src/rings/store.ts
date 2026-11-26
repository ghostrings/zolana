/**
 * What the Rings explorer has read from chain, in a database of its own.
 *
 * It is derived data: every row can be read from chain again. Keeping it apart
 * from the site's own database means it can be deleted to start over, and that
 * nothing here can touch a token listing or the desk's ledger.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RingCounterparty, RingKind, RingLeg, RingRow } from '../../../shared/src/rings-api.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ring_tx (
  signature TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payer TEXT NOT NULL,
  senders TEXT NOT NULL,
  recipients TEXT NOT NULL,
  legs TEXT NOT NULL,
  via TEXT NOT NULL,
  ring TEXT,
  partial INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ring_tx_at ON ring_tx (at DESC, signature DESC);
CREATE INDEX IF NOT EXISTS ring_tx_kind ON ring_tx (kind, at DESC);
CREATE INDEX IF NOT EXISTS ring_tx_partial ON ring_tx (partial, tries);

CREATE TABLE IF NOT EXISTS ring_party (
  address TEXT NOT NULL,
  signature TEXT NOT NULL,
  role TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (address, signature, role)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ring_party_at ON ring_party (address, at DESC);
CREATE INDEX IF NOT EXISTS ring_party_recent ON ring_party (at);
CREATE INDEX IF NOT EXISTS ring_party_signature ON ring_party (signature);

CREATE TABLE IF NOT EXISTS ring_leg (
  signature TEXT NOT NULL,
  mint TEXT NOT NULL,
  dir TEXT NOT NULL,
  amount TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (signature, mint, dir)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ring_leg_mint ON ring_leg (mint, at DESC);
CREATE INDEX IF NOT EXISTS ring_leg_at ON ring_leg (at);

CREATE TABLE IF NOT EXISTS ring_asset (
  mint TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 0,
  supply TEXT NOT NULL DEFAULT '',
  shielded TEXT NOT NULL DEFAULT '0',
  symbol TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  named INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  read_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ring_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

export interface RingTxInput {
  readonly signature: string;
  readonly slot: number;
  readonly at: number;
  readonly kind: RingKind;
  readonly payer: string;
  readonly senders: readonly string[];
  readonly recipients: readonly string[];
  readonly legs: readonly RingLeg[];
  readonly via: readonly string[];
  readonly ring: string | null;
  readonly partial: boolean;
}

export interface RingAssetRow {
  mint: string;
  asset_id: string;
  vault: string;
  decimals: number;
  supply: string;
  shielded: string;
  symbol: string;
  name: string;
  named: number;
  first_seen: number;
  read_at: number;
}

interface TxRecord {
  signature: string;
  slot: number;
  at: number;
  kind: string;
  payer: string;
  senders: string;
  recipients: string;
  legs: string;
  via: string;
  ring: string | null;
}

function list(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function legsOf(text: string): RingLeg[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const legs: RingLeg[] = [];
    for (const entry of parsed as Array<Partial<RingLeg>>) {
      if (typeof entry?.mint === 'string' && typeof entry.amount === 'string' && (entry.dir === 'in' || entry.dir === 'out')) {
        legs.push({ mint: entry.mint, amount: entry.amount, dir: entry.dir });
      }
    }
    return legs;
  } catch {
    return [];
  }
}

function toRow(record: TxRecord): RingRow {
  return {
    signature: record.signature,
    slot: Number(record.slot),
    at: Number(record.at),
    kind: record.kind as RingKind,
    payer: record.payer,
    senders: list(record.senders),
    recipients: list(record.recipients),
    legs: legsOf(record.legs),
    via: list(record.via),
    ring: record.ring,
  };
}

/** `at:signature`, the position of a row in the newest-first order. */
export function cursorOf(row: { at: number; signature: string }): string {
  return `${row.at}:${row.signature}`;
}

export function readCursor(text: unknown): { at: number; signature: string } | null {
  if (typeof text !== 'string') return null;
  const match = /^(\d{1,16}):([1-9A-HJ-NP-Za-km-z]{32,90})$/.exec(text);
  if (!match) return null;
  return { at: Number(match[1]), signature: match[2] as string };
}

const FEED_KINDS = "('shield','unshield','trade','transfer','swap','self','private','token')";

/**
 * Which way of reading a transaction the stored rows were made with. It goes
 * up whenever this code reads a transaction differently from the release
 * before it. Version 1 (release v21) wrote the wallets a private transfer paid
 * as lists of numbers instead of addresses.
 */
export const RING_READER = 2;

export class RingStore {
  readonly #db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#db = new DatabaseSync(resolve(dataDir, 'rings.sqlite'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  #transaction<T>(work: () => T): T {
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

  /* ---------------- meta ---------------- */

  meta(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM ring_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT INTO ring_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /**
   * Makes sure every stored row was read the way this code reads. Rows kept
   * by an older reader are dropped, with the marks of how far history had
   * been read, so that all of it is read again: a row is never left as an
   * older release understood it. What is known about tokens (vault balances,
   * names) does not depend on the reader and is kept. Returns true when rows
   * were dropped.
   */
  startOver(reader: number = RING_READER): boolean {
    if (this.meta('reader') === String(reader)) return false;
    const had = this.count() > 0;
    this.#transaction(() => {
      this.#db.exec("DELETE FROM ring_leg; DELETE FROM ring_party; DELETE FROM ring_tx; DELETE FROM ring_meta WHERE key IN ('head', 'tail', 'tailDone');");
      this.setMeta('reader', String(reader));
    });
    return had;
  }

  /* ---------------- transactions ---------------- */

  has(signature: string): boolean {
    return this.#db.prepare('SELECT 1 AS found FROM ring_tx WHERE signature = ?').get(signature) !== undefined;
  }

  /** Stores a transaction with the wallets and public movements in it. Storing it again replaces what was there. */
  save(input: RingTxInput): void {
    this.#transaction(() => {
      const previous = this.#db.prepare('SELECT tries FROM ring_tx WHERE signature = ?').get(input.signature) as { tries: number } | undefined;
      if (previous) {
        // Read again (its receiving side has arrived): what was stored for it is replaced whole.
        this.#db.prepare('DELETE FROM ring_party WHERE signature = ?').run(input.signature);
        this.#db.prepare('DELETE FROM ring_leg WHERE signature = ?').run(input.signature);
      }
      this.#db
        .prepare(
          `INSERT INTO ring_tx (signature, slot, at, kind, payer, senders, recipients, legs, via, ring, partial, tries)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(signature) DO UPDATE SET slot = excluded.slot, at = excluded.at, kind = excluded.kind, payer = excluded.payer,
             senders = excluded.senders, recipients = excluded.recipients, legs = excluded.legs, via = excluded.via, ring = excluded.ring,
             partial = excluded.partial, tries = excluded.tries`,
        )
        .run(
          input.signature,
          input.slot,
          input.at,
          input.kind,
          input.payer,
          JSON.stringify(input.senders),
          JSON.stringify(input.recipients),
          JSON.stringify(input.legs),
          JSON.stringify(input.via),
          input.ring,
          input.partial ? 1 : 0,
          (previous?.tries ?? -1) + 1,
        );
      const party = this.#db.prepare('INSERT OR IGNORE INTO ring_party (address, signature, role, at) VALUES (?, ?, ?, ?)');
      // The protocol's own housekeeping has a fee payer and nobody else; it is no wallet's activity.
      if (input.kind !== 'upkeep' && input.kind !== 'other') {
        for (const address of input.senders) party.run(address, input.signature, 'from', input.at);
        for (const address of input.recipients) party.run(address, input.signature, 'to', input.at);
        if (!input.senders.includes(input.payer)) party.run(input.payer, input.signature, 'payer', input.at);
      }
      const leg = this.#db.prepare('INSERT OR REPLACE INTO ring_leg (signature, mint, dir, amount, at) VALUES (?, ?, ?, ?, ?)');
      for (const entry of input.legs) leg.run(input.signature, entry.mint, entry.dir, entry.amount, input.at);
    });
  }

  /** Rows whose receiving side has not been read yet, oldest first, that have not been tried too often. */
  partial(limit: number, maxTries: number): Array<{ signature: string; slot: number; at: number }> {
    return this.#db
      .prepare('SELECT signature, slot, at FROM ring_tx WHERE partial = 1 AND tries < ? ORDER BY at ASC LIMIT ?')
      .all(maxTries, limit) as Array<{ signature: string; slot: number; at: number }>;
  }

  count(): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM ring_tx').get() as { n: number }).n);
  }

  span(): { since: number | null; through: number | null } {
    const row = this.#db.prepare('SELECT MIN(at) AS since, MAX(at) AS through FROM ring_tx WHERE at > 0').get() as { since: number | null; through: number | null };
    return { since: row.since === null ? null : Number(row.since), through: row.through === null ? null : Number(row.through) };
  }

  /** How many transactions of each kind since `since`. */
  kinds(since: number): Map<string, number> {
    const rows = this.#db.prepare('SELECT kind, COUNT(*) AS n FROM ring_tx WHERE at >= ? GROUP BY kind').all(since) as Array<{ kind: string; n: number }>;
    return new Map(rows.map((row) => [row.kind, Number(row.n)]));
  }

  /** Wallets that sent or were paid since `since`. */
  active(since: number): number {
    const row = this.#db.prepare("SELECT COUNT(DISTINCT address) AS n FROM ring_party WHERE at >= ? AND role IN ('from', 'to')").get(since) as { n: number };
    return Number(row.n);
  }

  feed(input: { limit: number; before?: { at: number; signature: string } | null; kind?: RingKind; mint?: string }): RingRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (input.kind === 'transfer') {
      // Asked for transfers, a reader means every private payment: one way, both ways, and those still being read.
      where.push("t.kind IN ('transfer','swap','private')");
    } else if (input.kind) {
      where.push('t.kind = ?');
      args.push(input.kind);
    } else {
      where.push(`t.kind IN ${FEED_KINDS}`);
    }
    if (input.mint) {
      where.push('EXISTS (SELECT 1 FROM ring_leg l WHERE l.signature = t.signature AND l.mint = ?)');
      args.push(input.mint);
    }
    if (input.before) {
      where.push('(t.at < ? OR (t.at = ? AND t.signature < ?))');
      args.push(input.before.at, input.before.at, input.before.signature);
    }
    const rows = this.#db
      .prepare(`SELECT t.* FROM ring_tx t WHERE ${where.join(' AND ')} ORDER BY t.at DESC, t.signature DESC LIMIT ?`)
      .all(...args, input.limit) as unknown as TxRecord[];
    return rows.map(toRow);
  }

  /** One wallet's rows, newest first. */
  addressRows(address: string, limit: number, before?: { at: number; signature: string } | null): RingRow[] {
    const args: Array<string | number> = [address];
    let cursor = '';
    if (before) {
      cursor = 'AND (t.at < ? OR (t.at = ? AND t.signature < ?))';
      args.push(before.at, before.at, before.signature);
    }
    const rows = this.#db
      .prepare(
        `SELECT t.* FROM ring_tx t WHERE t.signature IN (SELECT signature FROM ring_party WHERE address = ?) ${cursor}
         ORDER BY t.at DESC, t.signature DESC LIMIT ?`,
      )
      .all(...args, limit) as unknown as TxRecord[];
    return rows.map(toRow);
  }

  /** Everything needed to sum up one wallet: its newest `cap` rows. */
  addressSummary(address: string, cap = 5_000): {
    first: number | null;
    last: number | null;
    counts: { shields: number; unshields: number; trades: number; sent: number; received: number; own: number };
    counterparties: RingCounterparty[];
  } {
    const rows = this.addressRows(address, cap);
    const counts = { shields: 0, unshields: 0, trades: 0, sent: 0, received: 0, own: 0 };
    const others = new Map<string, { sent: number; received: number; last: number }>();
    const touch = (other: string, field: 'sent' | 'received', at: number): void => {
      if (other === address) return;
      const entry = others.get(other) ?? { sent: 0, received: 0, last: 0 };
      entry[field] += 1;
      entry.last = Math.max(entry.last, at);
      others.set(other, entry);
    };
    for (const row of rows) {
      const from = row.senders.includes(address);
      const to = row.recipients.includes(address);
      if (row.kind === 'shield') {
        if (from) counts.shields += 1;
        // A shield into somebody else's private balance is a payment to them, with a public amount.
        if (from) for (const other of row.recipients) touch(other, 'sent', row.at);
        if (to) {
          counts.received += 1;
          for (const other of row.senders) touch(other, 'received', row.at);
        }
      } else if (row.kind === 'unshield') {
        if (from) counts.unshields += 1;
        if (from) for (const other of row.recipients) touch(other, 'sent', row.at);
        if (to) {
          counts.received += 1;
          for (const other of row.senders) touch(other, 'received', row.at);
        }
      } else if (row.kind === 'trade') {
        if (from) counts.trades += 1;
      } else if (row.kind === 'self') {
        if (from) counts.own += 1;
      } else if (row.kind === 'swap') {
        if (from) {
          counts.sent += 1;
          counts.received += 1;
          for (const other of row.senders) {
            touch(other, 'sent', row.at);
            touch(other, 'received', row.at);
          }
        }
      } else if (row.kind === 'transfer' || row.kind === 'private') {
        if (from) {
          counts.sent += 1;
          for (const other of row.recipients) touch(other, 'sent', row.at);
        }
        if (to) {
          counts.received += 1;
          for (const other of row.senders) touch(other, 'received', row.at);
        }
      }
    }
    const counterparties = [...others.entries()]
      .map(([other, entry]) => ({ address: other, ...entry }))
      .sort((a, b) => b.sent + b.received - (a.sent + a.received) || b.last - a.last)
      .slice(0, 25);
    const bounds = this.#db.prepare('SELECT MIN(at) AS first, MAX(at) AS last FROM ring_party WHERE address = ?').get(address) as { first: number | null; last: number | null };
    return {
      first: bounds.first === null ? null : Number(bounds.first),
      last: bounds.last === null ? null : Number(bounds.last),
      counts,
      counterparties,
    };
  }

  /* ---------------- public movements ---------------- */

  /** Every public movement since `since`, oldest first. */
  legsSince(since: number): Array<{ mint: string; dir: 'in' | 'out'; amount: string; at: number }> {
    return this.#db.prepare('SELECT mint, dir, amount, at FROM ring_leg WHERE at >= ? ORDER BY at ASC').all(since) as Array<{
      mint: string;
      dir: 'in' | 'out';
      amount: string;
      at: number;
    }>;
  }

  /** Wallets that have moved a token into Rings, and out of it, in what has been read. */
  movers(mint: string): { shielders: number; unshielders: number } {
    const count = (dir: 'in' | 'out'): number =>
      Number(
        (
          this.#db
            .prepare(
              `SELECT COUNT(DISTINCT p.address) AS n FROM ring_leg l JOIN ring_party p ON p.signature = l.signature AND p.role = 'from'
               WHERE l.mint = ? AND l.dir = ?`,
            )
            .get(mint, dir) as { n: number }
        ).n,
      );
    return { shielders: count('in'), unshielders: count('out') };
  }

  /* ---------------- tokens ---------------- */

  assets(): RingAssetRow[] {
    return this.#db.prepare('SELECT * FROM ring_asset').all() as unknown as RingAssetRow[];
  }

  asset(mint: string): RingAssetRow | undefined {
    return this.#db.prepare('SELECT * FROM ring_asset WHERE mint = ?').get(mint) as RingAssetRow | undefined;
  }

  /** Adds tokens that are not known yet. Returns how many were new. */
  addAssets(entries: ReadonlyArray<{ mint: string; assetId: string; vault: string; symbol?: string; decimals?: number }>, now: number): number {
    let added = 0;
    this.#transaction(() => {
      const insert = this.#db.prepare(
        'INSERT OR IGNORE INTO ring_asset (mint, asset_id, vault, symbol, name, named, decimals, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const entry of entries) {
        const result = insert.run(entry.mint, entry.assetId, entry.vault, entry.symbol ?? '', entry.symbol ?? '', entry.symbol ? 1 : 0, entry.decimals ?? 0, now);
        added += Number(result.changes);
      }
    });
    return added;
  }

  setBalance(mint: string, values: { shielded: string; supply?: string; decimals?: number }, now: number): void {
    this.#db
      .prepare('UPDATE ring_asset SET shielded = ?, supply = COALESCE(?, supply), decimals = COALESCE(?, decimals), read_at = ? WHERE mint = ?')
      .run(values.shielded, values.supply ?? null, values.decimals ?? null, now, mint);
  }

  setName(mint: string, symbol: string, name: string): void {
    this.#db.prepare('UPDATE ring_asset SET symbol = ?, name = ?, named = 1 WHERE mint = ?').run(symbol, name, mint);
  }

  /** Tokens whose name has not been looked up, those held privately first. */
  unnamed(limit: number): string[] {
    const rows = this.#db
      .prepare("SELECT mint FROM ring_asset WHERE named = 0 ORDER BY (shielded != '0') DESC, first_seen DESC LIMIT ?")
      .all(limit) as Array<{ mint: string }>;
    return rows.map((row) => row.mint);
  }
}
