/**
 * The desk's fills, picked out of the desk wallet's own statement.
 *
 * A Ghost fill is one transaction with two private transfers in it: the
 * trader pays the desk one token and the desk pays the trader another. In
 * the desk's private history that reads as two rows with the same signature,
 * one in and one out, in different tokens. That pairing is what makes a row
 * a fill here; a plain private transfer to or from the desk is not one.
 *
 * The statement is built from the chain and decrypted with the desk's own
 * key, so it is a record of what actually moved, not of what the server
 * meant to do.
 */

import { STATEMENT_KINDS, type StatementRow } from './statement.js';

/** The rows of a statement that are halves of a fill, in the statement's order. */
export function fillRows(rows: readonly StatementRow[]): StatementRow[] {
  return rows.filter((row) => row.type === STATEMENT_KINDS.privateTransfer && row.direction !== 'Self' && row.tradedFor !== '');
}

/** How many fills those rows are: one per transaction. */
export function fillCount(rows: readonly StatementRow[]): number {
  return new Set(fillRows(rows).map((row) => row.signature)).size;
}

/**
 * True when `file` lies inside `folder` (or is the folder). Both are absolute
 * paths, already normalised by the caller. Used to keep an export out of the
 * project folder, where the next `git add -A` would pick it up.
 */
export function isInside(file: string, folder: string, separator: string): boolean {
  const base = folder.endsWith(separator) ? folder : folder + separator;
  const insensitive = separator === '\\';
  const a = insensitive ? file.toLowerCase() : file;
  const b = insensitive ? base.toLowerCase() : base;
  return a === b.slice(0, -1) || a.startsWith(b);
}
