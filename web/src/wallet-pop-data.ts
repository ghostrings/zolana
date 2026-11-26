/**
 * What the header's wallet panel needs from the SDKs: unlocking, switching
 * and locking a wallet, and reading what it holds. It is fetched the first
 * time the panel has a wallet to work with, so a page that never opens the
 * panel loads none of this.
 *
 * Reading goes through a view of the wallet that is the panel's own
 * (`readerSession`). It shares the keys with the page and nothing else, so a
 * read here never moves the notes a page is building a transaction from.
 * Nothing in this file sends a transaction.
 */

import { PublicKey } from '@solana/web3.js';

import type { TokenSummary } from '../../shared/src/api.js';
import { SOL_DECIMALS, TOKEN_2022_PROGRAM_ID, TOKEN_DECIMALS, TOKEN_PROGRAM_ID } from '../../shared/src/constants.js';
import type { HistoryRow } from '../../shared/src/payrecords.js';
import { SOL_MINT, historyRowsOf, privateBalance, privateHistory, privateHoldings } from '../../shared/src/privacy.js';
import { pairSymbol, pairTokenByMint } from '../../shared/src/quotes.js';
import { formatUnits, groupDigits } from '../../shared/src/units.js';
import { api } from './api.js';
import { connection, publicLamports } from './chain.js';
import { friendlyError } from './trade.js';
import { type Session, lock, readerSession, unlockGhostWallet, useWallet } from './wallet.js';

const SOL = SOL_MINT as string;

/** One thing a wallet holds, ready to be shown. Every field is plain text. */
export interface PopAsset {
  readonly mint: string;
  /** `SOL`, `$TICKER`, a pair token's ticker, or a shortened address. */
  readonly label: string;
  readonly name: string;
  /** Artwork of a token launched here, or empty. */
  readonly image: string;
  readonly symbol: string;
  readonly amount: string;
  /** True for a token launched on this site: it has a page of its own. */
  readonly listed: boolean;
}

/** One line of a wallet's private history. */
export interface PopEvent {
  readonly title: string;
  readonly direction: 'in' | 'out' | 'self';
  readonly label: string;
  readonly amount: string;
  /** True when the amount crossed the public boundary, so everyone could see it. */
  readonly open: boolean;
}

export interface PopPublic {
  readonly sol: string;
  readonly assets: readonly PopAsset[];
}

export interface PopPrivate {
  readonly sol: string;
  readonly assets: readonly PopAsset[];
  readonly events: readonly PopEvent[];
}

const amountText = (raw: bigint, decimals: number, places = 4): string => groupDigits(formatUnits(raw, decimals, places));
const shortened = (value: string): string => (value.length <= 9 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`);

/** Tokens launched here among `mints`, by mint. The listing is a convenience: without it a token shows by its address. */
async function listings(mints: readonly string[]): Promise<Map<string, TokenSummary>> {
  const wanted = [...new Set(mints)].filter((mint) => mint !== SOL);
  const found = new Map<string, TokenSummary>();
  if (wanted.length === 0) return found;
  try {
    for (const token of await api.tokensByMints(wanted)) found.set(token.mint, token);
  } catch {
    // Shown by address instead.
  }
  return found;
}

const decimalsKnown = new Map<string, number>([[SOL, SOL_DECIMALS]]);

/**
 * A token's decimals, or null when they could not be had for certain: six for
 * a token launched here, read from the mint otherwise, and the figure pinned
 * in this build for a pair token when that read fails. A token this site has
 * never heard of whose mint could not be read has no figure, and its amounts
 * are then not written: a guess would be wrong by a factor of ten or more.
 */
async function decimalsOf(mint: string, listed: boolean): Promise<number | null> {
  const known = decimalsKnown.get(mint);
  if (known !== undefined) return known;
  let decimals: number | undefined = listed ? TOKEN_DECIMALS : undefined;
  if (!listed) {
    try {
      decimals = (await connection().getTokenSupply(new PublicKey(mint))).value.decimals;
    } catch {
      // Not remembered: asked again the next time the panel is read.
      return pairTokenByMint(mint)?.expectedDecimals ?? null;
    }
  }
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0) return null;
  decimalsKnown.set(mint, decimals);
  return decimals;
}

function asset(mint: string, raw: bigint, decimals: number | null, token: TokenSummary | undefined): PopAsset {
  if (mint === SOL) return { mint, label: 'SOL', name: 'Solana', image: '', symbol: 'SOL', amount: amountText(raw, SOL_DECIMALS), listed: false };
  const amount = decimals === null ? '—' : amountText(raw, decimals);
  if (token) return { mint, label: `$${token.symbol || '???'}`, name: token.name || 'Unnamed token', image: token.image, symbol: token.symbol || mint, amount, listed: true };
  const pair = pairTokenByMint(mint);
  const known = pair && !pair.native ? pair : undefined;
  return { mint, label: known ? pairSymbol(known) : shortened(mint), name: known?.name ?? 'Unlisted asset', image: '', symbol: known ? pairSymbol(known) : mint, amount, listed: false };
}

/** What everyone can see: the wallet's SOL and its ordinary token accounts. */
export async function readPublic(address: string): Promise<PopPublic> {
  const lamports = await publicLamports(address);
  const found: Array<{ mint: string; amount: bigint; decimals: number }> = [];
  try {
    const accounts = await connection().getParsedTokenAccountsByOwner(new PublicKey(address), { programId: new PublicKey(TOKEN_PROGRAM_ID) });
    for (const { account } of accounts.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info;
      const amount = BigInt(info?.tokenAmount?.amount ?? '0');
      if (!info?.mint || amount <= 0n) continue;
      const decimals = info.tokenAmount?.decimals ?? TOKEN_DECIMALS;
      decimalsKnown.set(info.mint, decimals);
      found.push({ mint: info.mint, amount, decimals });
    }
  } catch {
    // Public token balances are an extra here; the SOL above is what fees are paid from.
  }
  try {
    // Token-2022 tokens live under another token program, and are listed by it.
    const accounts = await connection().getParsedTokenAccountsByOwner(new PublicKey(address), { programId: new PublicKey(TOKEN_2022_PROGRAM_ID) });
    for (const { account } of accounts.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info;
      const amount = BigInt(info?.tokenAmount?.amount ?? '0');
      const decimals = info?.tokenAmount?.decimals;
      if (!info?.mint || amount <= 0n || typeof decimals !== 'number') continue;
      decimalsKnown.set(info.mint, decimals);
      found.push({ mint: info.mint, amount, decimals });
    }
  } catch {
    // The same: an extra.
  }
  const named = await listings(found.map((entry) => entry.mint));
  return { sol: amountText(lamports, SOL_DECIMALS), assets: found.map((entry) => asset(entry.mint, entry.amount, entry.decimals, named.get(entry.mint))) };
}

const EVENT_TITLES: Readonly<Record<string, string>> = Object.freeze({
  deposit: 'Shield',
  privateTransfer: 'Private transfer',
  ringEntry: 'Ring entry',
  publicWithdrawal: 'Unshield',
  split: 'Split',
  merge: 'Consolidation',
});

/** The panel's own view of the wallet in use: made on the first read, read again on each one after. */
let reader: { readonly address: string; readonly session: Session } | null = null;
/** Reads are taken one at a time: two of them never work on the same notes at once. */
let queue: Promise<unknown> = Promise.resolve();

/** The panel's view of `address`, made the first time it is asked for. */
async function readerFor(address: string, keep: boolean): Promise<Session> {
  if (!reader || reader.address !== address) {
    const session = await readerSession(keep);
    if (!session) throw new Error('No wallet is unlocked in this tab.');
    if (session.address !== address) throw new Error('The wallet in use changed. Open the panel again.');
    reader = { address: session.address, session };
  }
  return reader.session;
}

async function readNow(address: string, keep: boolean): Promise<PopPrivate> {
  const session = await readerFor(address, keep);
  await session.sync();
  const holdings = privateHoldings(session.ctx);
  const history = privateHistory(session.ctx).slice(-8).reverse();
  const named = await listings([...holdings.map((holding) => holding.mint as string), ...history.map((entry) => entry.asset as string)]);
  const assets: PopAsset[] = [];
  for (const holding of holdings) {
    if (holding.mint === SOL) continue;
    const token = named.get(holding.mint);
    assets.push(asset(holding.mint, holding.amount, await decimalsOf(holding.mint, token !== undefined), token));
  }
  const events: PopEvent[] = [];
  for (const entry of history) {
    const mint = entry.asset as string;
    const token = named.get(mint);
    const shown = asset(mint, entry.amount, await decimalsOf(mint, token !== undefined), token);
    events.push({
      title: EVENT_TITLES[entry.kind] ?? entry.kind,
      direction: entry.direction === 'inbound' ? 'in' : entry.direction === 'outbound' ? 'out' : 'self',
      label: shown.label,
      amount: shown.amount,
      open: entry.kind === 'deposit' || entry.kind === 'publicWithdrawal',
    });
  }
  return { sol: amountText(privateBalance(session.ctx, SOL_MINT), SOL_DECIMALS), assets, events };
}

/**
 * What only the wallet's keys can read: its private balances and its last few
 * private transactions. `keep` says whether this read may save its notes for
 * next time; a page that works with the wallet itself does its own saving.
 */
export function readPrivate(address: string, keep: boolean): Promise<PopPrivate> {
  const next = queue.then(
    () => readNow(address, keep),
    () => readNow(address, keep),
  );
  queue = next.catch(() => undefined);
  return next;
}

/**
 * The wallet's whole private history after a fresh read, as plain rows. The
 * alerts use it. It waits its turn in the same queue as the panel's reads.
 */
export function readRows(address: string, keep: boolean): Promise<HistoryRow[]> {
  const run = async (): Promise<HistoryRow[]> => {
    const session = await readerFor(address, keep);
    await session.sync();
    return historyRowsOf(session.ctx.wallet);
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** After the wallet in use changed, the view of the one before is dropped. */
export function forgetReader(): void {
  reader = null;
}

export async function unlock(passphrase: string): Promise<void> {
  await unlockGhostWallet(passphrase);
  forgetReader();
}

export async function switchTo(address: string): Promise<void> {
  await useWallet(address);
  forgetReader();
}

export function lockNow(): void {
  lock();
  forgetReader();
}

/** An error as something a person can act on. */
export function explain(error: unknown): string {
  return friendlyError(error);
}
