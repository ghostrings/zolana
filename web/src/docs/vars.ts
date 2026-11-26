/**
 * The live numbers the docs quote: fee shares, curve sizes, limits and
 * addresses. They come from this server's own status, so a page of the docs
 * never states a setting the site is not running with.
 */

import type { StatusResponse } from '../../../shared/src/api.js';
import {
  DAMM_V2_PROGRAM_ID,
  DBC_PROGRAM_ID,
  GAS_RESERVE_LAMPORTS,
  MIN_CREATOR_PAYOUT_LAMPORTS,
  SOL_DECIMALS,
  SPP_DEFAULT_TREE,
  SPP_PROGRAM_ID,
  USER_REGISTRY_PROGRAM_ID,
} from '../../../shared/src/constants.js';
import { MARKET_PAGE_SIZE } from '../../../shared/src/api.js';
import { PAIR_TOKENS, pairSymbol } from '../../../shared/src/quotes.js';
import { feeSplit } from '../../../shared/src/tiers.js';
import { formatUnits, groupDigits } from '../../../shared/src/units.js';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const solText = (lamports: bigint | string, places = 4): string => groupDigits(formatUnits(BigInt(lamports), SOL_DECIMALS, places));

/** An address as a link to an explorer, written in the docs' own Markdown. Anything that is not an address is shown as `missing`. */
export function addressLink(value: string | null | undefined, missing = 'Not live yet'): string {
  return value && ADDRESS.test(value) ? `[${value}](https://orbmarkets.io/address/${value})` : missing;
}

/** A cell of a Markdown table: one line, and no character that would end the cell early. */
const cell = (text: string): string => text.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();

/**
 * The pair tokens as a Markdown table: what each is, where its curve starts
 * and graduates, and whether tokens can be launched against it right now.
 * Without the server's status only the list itself is known.
 */
export function pairsTable(status: StatusResponse | null): string {
  const head = '| Pair token | What it is | Curve, start → graduation | Launches |\n| --- | --- | --- | --- |';
  if (!status) {
    return `${head}\n${PAIR_TOKENS.map((token) => `| **${pairSymbol(token)}** | ${cell(token.name)} | — | — |`).join('\n')}`;
  }
  const rows = status.pairs.map((pair) => {
    const curve = pair.curve
      ? `${groupDigits(String(pair.curve.initialMarketCap))} → ${groupDigits(String(pair.curve.migrationMarketCap))} ${pair.symbol} of market cap`
      : 'Not set';
    const state = pair.live ? '==Live==' : pair.curve ? 'Not live yet' : 'Not set up';
    return `| **${cell(pair.symbol)}** | ${cell(pair.name)} | ${cell(curve)} | ${state} |`;
  });
  return `${head}\n${rows.join('\n')}`;
}

export function docVars(status: StatusResponse | null): Record<string, string> {
  const vars: Record<string, string> = {
    pairs_table: pairsTable(status),
    pairs_live: 'SOL',
    convert_sentence: 'Whether this site converts right now is shown on each token page: the choice appears there when it does.',
    swap_sentence: 'Whether this is switched on right now is shown on the Swap page itself.',
    modules_sentence: 'Whether this site runs them right now is shown on the Launch page: the choice appears there when it does.',
    modules_schedule: 'The server looks at every token with modules on a fixed schedule.',
    page_size: String(MARKET_PAGE_SIZE),
    gas_reserve: solText(GAS_RESERVE_LAMPORTS, 3),
    min_claim: '0.001',
    min_payout: solText(MIN_CREATOR_PAYOUT_LAMPORTS, 3),
    rings_program: addressLink(SPP_PROGRAM_ID),
    rings_registry: addressLink(USER_REGISTRY_PROGRAM_ID),
    rings_tree: addressLink(SPP_DEFAULT_TREE),
    dbc_program: addressLink(DBC_PROGRAM_ID),
    damm_program: addressLink(DAMM_V2_PROGRAM_ID),
  };
  if (!status) return vars;

  const split = feeSplit(status.economics);
  const payout = status.creatorPoolPayoutPct;
  const cap = BigInt(status.limits.maxTradeLamports || '0');
  const tier = (feeBps: number): string => addressLink(status.tiers.find((candidate) => candidate.feeBps === feeBps)?.config);
  const live = status.pairs.filter((pair) => pair.live).map((pair) => pair.symbol);
  Object.assign(vars, {
    pairs_live: live.length > 0 ? live.join(', ') : 'none right now',
    convert_sentence: status.convert?.enabled
      ? 'Converting is switched on here right now.'
      : 'Converting is switched off on this site right now, so each token is paid for in its own pair token. The rest of this page describes what it does when it is on.',
    swap_sentence:
      status.convert?.enabled && status.convert.anyToken
        ? 'It is switched on here right now.'
        : 'It is switched off on this site right now, so only tokens launched here are traded. The rest of this page describes what it does when it is on.',
    modules_sentence: status.modules?.enabled
      ? 'Fee modules are switched on here right now.'
      : 'Fee modules are switched off on this site right now, so creators claim their fees by hand. The rest of this page describes what they do when they are on.',
    modules_schedule: status.modules
      ? `The server looks at every token with modules every ${status.modules.everyMinutes} minutes. It acts once at least ${solText(status.modules.minLamports, 4)} SOL of the creator's fees is waiting, or about as much in another pair token, and one buyback spends at most ${solText(status.modules.maxBuyLamports, 4)} SOL.`
      : 'The server looks at every token with modules on a fixed schedule.',
    creator_pct: String(split.creatorPct),
    platform_pct: String(split.platformPct),
    protocol_pct: String(split.protocolPct),
    payout_sentence:
      payout > 0
        ? `the platform pays the creator ${payout}% of the pool fees it collects`
        : 'the pool fees go to the platform, and the creator is paid nothing further',
    start_cap: groupDigits(String(status.economics.initialMarketCapSol)),
    grad_cap: groupDigits(String(status.economics.migrationMarketCapSol)),
    slippage_default: String(status.slippage.defaultBps / 100),
    slippage_max: String(status.slippage.maxBps / 100),
    desk_sentence: status.desk.enabled
      ? `The desk is switched on here right now. Its spread is ${(status.desk.spreadBps / 100).toFixed(2)}% and it fills up to ${solText(status.desk.maxOrderLamports, 2)} SOL per trade.`
      : 'Ghost fill is switched off on this site right now, so trades go through the Shielded route or Public entry.',
    desk_address: addressLink(status.desk.address, 'The desk is off, so it has no published wallet right now.'),
    trade_cap_sentence:
      cap > 0n
        ? `Right now trades and first buys through this site are limited to ${solText(cap, 2)} SOL each, or about as much in another pair token.`
        : 'No per-trade limit is set right now.',
    pause_sentence:
      status.limits.launchesPaused && status.limits.tradingPaused
        ? 'Right now both launches and trading through this site are paused.'
        : status.limits.launchesPaused
          ? 'Right now new launches are paused.'
          : status.limits.tradingPaused
            ? 'Right now trading through this site is paused.'
            : 'Nothing is paused right now.',
    image_limit: `${Math.round(status.uploads.maxImageBytes / 1_048_576)} MB`,
    metadata_home: status.uploads.pinned
      ? 'pinned to IPFS, so it does not depend on this site staying online'
      : 'kept on this site’s own server',
    config_200: tier(200),
    config_300: tier(300),
    config_400: tier(400),
  });
  return vars;
}

/** Every name a page of the docs may use. `tests/docs.test.ts` holds the pages to this list. */
export const DOC_VAR_NAMES: readonly string[] = Object.freeze([
  'pairs_table',
  'pairs_live',
  'convert_sentence',
  'swap_sentence',
  'modules_sentence',
  'modules_schedule',
  'page_size',
  'gas_reserve',
  'min_claim',
  'min_payout',
  'rings_program',
  'rings_registry',
  'rings_tree',
  'dbc_program',
  'damm_program',
  'creator_pct',
  'platform_pct',
  'protocol_pct',
  'payout_sentence',
  'start_cap',
  'grad_cap',
  'slippage_default',
  'slippage_max',
  'desk_sentence',
  'desk_address',
  'trade_cap_sentence',
  'pause_sentence',
  'image_limit',
  'metadata_home',
  'config_200',
  'config_300',
  'config_400',
]);
