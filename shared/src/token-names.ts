/**
 * What a token calls itself, read from chain.
 *
 * A token's name and ticker are text its creator wrote. Anybody can create a
 * token called anything, so a name identifies nothing: the mint address does.
 * These readers exist so a person can recognise what they pasted, never so
 * that the page can vouch for it.
 *
 * Two places hold the text. An SPL Token mint has a Metaplex metadata account
 * next to it. A Token-2022 mint may carry it inside the mint itself. Both are
 * read with bounds on every length, and the text is cleaned before it is
 * shown: nothing invisible, nothing that reorders what stands around it.
 */

import { PublicKey } from '@solana/web3.js';

/** Metaplex Token Metadata, where an SPL Token mint's name and ticker are kept. */
export const METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

export const NAME_MAX = 40;
export const TICKER_MAX = 16;

export interface TokenName {
  readonly name: string;
  readonly symbol: string;
}

/** The address of the Metaplex metadata account of a mint. */
export function metadataAddress(mint: string): string {
  const program = new PublicKey(METADATA_PROGRAM_ID);
  return PublicKey.findProgramAddressSync([new TextEncoder().encode('metadata'), program.toBytes(), new PublicKey(mint).toBytes()], program)[0].toBase58();
}

/** A character that is some kind of space, and is written as an ordinary one. */
function spaceLike(point: number): boolean {
  return point === 0x09 || point === 0x0a || point === 0x0d || point === 0x20 || point === 0xa0 || point === 0x1680 || (point >= 0x2000 && point <= 0x200a) || point === 0x202f || point === 0x205f || point === 0x3000;
}

/** A character that draws nothing, or changes the direction of the text around it. */
function unseen(point: number): boolean {
  return (
    point < 0x20 ||
    (point >= 0x7f && point <= 0x9f) ||
    point === 0xad ||
    point === 0x34f ||
    point === 0x61c ||
    (point >= 0x115f && point <= 0x1160) ||
    (point >= 0x17b4 && point <= 0x17b5) ||
    (point >= 0x180b && point <= 0x180f) ||
    (point >= 0x200b && point <= 0x200f) ||
    (point >= 0x2028 && point <= 0x202e) ||
    (point >= 0x2060 && point <= 0x206f) ||
    point === 0x3164 ||
    (point >= 0xfe00 && point <= 0xfe0f) ||
    point === 0xfeff ||
    point === 0xffa0 ||
    (point >= 0xfff0 && point <= 0xfffb) ||
    (point >= 0x1bca0 && point <= 0x1bca3) ||
    (point >= 0x1d173 && point <= 0x1d17a) ||
    (point >= 0xe0000 && point <= 0xe0fff)
  );
}

/** Somebody else's text, made safe to put in a sentence: visible characters only, single spaces, at most `max` of them. */
export function tidyTokenText(text: string, max: number): string {
  let out = '';
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (spaceLike(point)) out += ' ';
    else if (!unseen(point) && point !== 0xfffd) out += char;
  }
  return [...out.replace(/ {2,}/g, ' ').trim()].slice(0, max).join('').trim();
}

/** Reads `count` length-prefixed strings from `data` at `offset`. Null when any of them does not fit. */
function strings(data: Uint8Array, offset: number, count: number, longest: number): string[] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const found: string[] = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 4 > data.length) return null;
    const length = view.getUint32(at, true);
    at += 4;
    if (length > longest || at + length > data.length) return null;
    found.push(decoder.decode(data.subarray(at, at + length)));
    at += length;
  }
  return found;
}

function named(mint: string, data: Uint8Array, mintAt: number, textAt: number): TokenName | null {
  if (data.length < textAt) return null;
  let stated: string;
  try {
    stated = new PublicKey(data.subarray(mintAt, mintAt + 32)).toBase58();
  } catch {
    return null;
  }
  // Text kept for another mint says nothing about this one.
  if (stated !== mint) return null;
  const read = strings(data, textAt, 2, 512);
  if (!read) return null;
  const name = tidyTokenText(read[0] ?? '', NAME_MAX);
  const symbol = tidyTokenText(read[1] ?? '', TICKER_MAX);
  return name === '' && symbol === '' ? null : { name, symbol };
}

/**
 * The name and ticker in a mint's Metaplex metadata account, or null when
 * there is none to read. `account` is the account at `metadataAddress(mint)`.
 *
 * Layout: key (1 byte, 4 for a metadata account), update authority (32), mint
 * (32), then name, ticker and address of the artwork, each a length and bytes.
 */
export function readMetaplexName(mint: string, account: { readonly owner: string; readonly data: Uint8Array } | null): TokenName | null {
  if (!account || account.owner !== METADATA_PROGRAM_ID) return null;
  if (account.data.length < 65 || account.data[0] !== 4) return null;
  return named(mint, account.data, 33, 65);
}

/**
 * The name and ticker a Token-2022 mint carries in itself, or null. `extension`
 * is the content of the mint's TokenMetadata extension.
 *
 * Layout: update authority (32), mint (32), then name, ticker and address of
 * the artwork, each a length and bytes.
 */
export function readMintName(mint: string, extension: Uint8Array | null): TokenName | null {
  if (!extension) return null;
  return named(mint, extension, 32, 64);
}
