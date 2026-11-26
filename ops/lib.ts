/**
 * Shared helpers for the operator scripts. These run on your machine with your
 * keys; nothing here is reachable from the web server.
 */

import bs58 from 'bs58';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, type Transaction, type TransactionInstruction } from '@solana/web3.js';

import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { MAINNET_GENESIS_HASH } from '../shared/src/constants.js';
import { previousConfigMismatches } from '../shared/src/curve.js';
import { type AllowedConfig, allowedConfigMap, configFeeBps, loadPoolConfigs } from '../shared/src/meteora.js';
import { type TradingPair, configEnvKey, curveEnvKeys, pairSymbol } from '../shared/src/quotes.js';
import { FEE_TIERS, tierByFeeBps } from '../shared/src/tiers.js';
import { type AppEnv, EnvError, parseSecretKey, readEnv, requireRpc } from '../server/src/env.js';
import { resolvePairs } from '../server/src/pairs.js';
import { clampPriority, estimatePriority } from '../server/src/priority.js';
import { redact } from '../server/src/redact.js';

export function loadEnv(): AppEnv {
  return readEnv(process.env);
}

/** A config kept from an earlier set, as the chain describes it. */
export interface KeptConfig {
  readonly address: string;
  readonly pair: TradingPair;
  readonly feeBps: number;
  /** The creator's share (0-100) of what is left of each curve fee after Meteora's cut. */
  readonly creatorFeeSharePct: number;
}

/**
 * Reads every config in DBC_CONFIGS_PREVIOUS and sorts them into the ones that
 * are the platform's own (`kept`) and the ones that are not (`refused`, each
 * with the reason). `pairs` are the pair tokens the chain has confirmed here.
 */
export async function readKeptConfigs(
  connection: Connection,
  env: AppEnv,
  pairs: readonly TradingPair[],
): Promise<{ kept: KeptConfig[]; refused: Array<{ address: string; why: string }> }> {
  const kept: KeptConfig[] = [];
  const refused: Array<{ address: string; why: string }> = [];
  if (env.previousConfigs.length === 0) return { kept, refused };
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const partner = env.partnerWallet ? new PublicKey(env.partnerWallet) : undefined;
  const accounts = await loadPoolConfigs(dbc, connection, env.previousConfigs.map((address) => new PublicKey(address)));
  for (const [index, address] of env.previousConfigs.entries()) {
    const account = accounts[index] ?? null;
    if (!account) {
      refused.push({ address, why: 'no config account exists at that address' });
      continue;
    }
    const record = account as unknown as Record<string, unknown>;
    const quoteMint = (record.quoteMint as PublicKey).toBase58();
    const pair = pairs.find((candidate) => candidate.mint === quoteMint);
    const size = env.pairs.find((entry) => entry.token.mint === quoteMint)?.size;
    if (!pair || !size) {
      const known = env.pairs.find((entry) => entry.token.mint === quoteMint);
      refused.push({ address, why: known ? `it is priced in ${pairSymbol(known.token)}, and that pair is off in this environment` : `it is priced in ${quoteMint}, which is not a pair token this build knows` });
      continue;
    }
    const tier = tierByFeeBps(configFeeBps(account));
    if (!tier) {
      refused.push({ address, why: `it charges ${configFeeBps(account)} bps, which is not one of the tiers` });
      continue;
    }
    const problems = previousConfigMismatches(tier, env.economics, { pair, size }, record, partner);
    if (problems.length > 0) {
      refused.push({ address, why: `it is not one of this platform's configs: ${problems.join('; ')}` });
      continue;
    }
    kept.push({ address, pair, feeBps: tier.feeBps, creatorFeeSharePct: Number(record.creatorTradingFeePercentage) });
  }
  return { kept, refused };
}

/**
 * The platform's configs that tokens can be found under, for every pair in
 * use: SOL, and each other pair whose token the chain confirms can be used,
 * plus every config kept from an earlier set (DBC_CONFIGS_PREVIOUS). A pair or
 * a kept config that cannot be used is named on screen and left out, so its
 * tokens are simply not found by the script that asked.
 */
export async function allowedConfigsOf(connection: Connection, env: AppEnv): Promise<Map<string, AllowedConfig>> {
  const resolved = await resolvePairs(connection, env.pairs.filter((entry) => entry.size !== undefined));
  const entries: Array<{ address: string | undefined; feeBps: number; pair: TradingPair; previous?: boolean }> = [];
  const pairs: TradingPair[] = [];
  for (const result of resolved) {
    if (!result.pair) {
      console.log(`  ! The ${pairSymbol(result.env.token)} pair is off here: ${result.problems.join(' ')}`);
      continue;
    }
    pairs.push(result.pair);
    for (const tier of FEE_TIERS) entries.push({ address: result.env.configs[tier.feeBps], feeBps: tier.feeBps, pair: result.pair });
  }
  const { kept, refused } = await readKeptConfigs(connection, env, pairs);
  for (const config of kept) entries.push({ address: config.address, feeBps: config.feeBps, pair: config.pair, previous: true });
  for (const { address, why } of refused) console.log(`  ! DBC_CONFIGS_PREVIOUS: ${address} is left out: ${why}.`);
  return allowedConfigMap(entries);
}

/**
 * What a script that walks the platform's tokens is, and is not, looking at
 * in this environment. A pair with no settings here is skipped without a word
 * by everything else, which is how a token priced in it goes missing from a
 * list: this says so by name.
 */
export function coverageLines(env: AppEnv, configs: ReadonlyMap<string, AllowedConfig>, live: ReadonlySet<string> | null = null): string[] {
  const lines: string[] = [];
  const covered = new Map<string, { symbol: string; current: number; previous: number }>();
  for (const { pair, previous } of configs.values()) {
    const entry = covered.get(pair.id) ?? { symbol: pair.symbol, current: 0, previous: 0 };
    if (previous) entry.previous += 1;
    else entry.current += 1;
    covered.set(pair.id, entry);
  }
  const looked = [...covered.values()].map((entry) => `${entry.symbol} (${entry.current + entry.previous} config${entry.current + entry.previous === 1 ? '' : 's'}${entry.previous > 0 ? `, ${entry.previous} kept from before` : ''})`);
  lines.push(looked.length > 0 ? `Looking at: ${looked.join(', ')}.` : 'No config is set in this environment, so there is nothing to look at.');
  const uncovered = env.pairs.filter((entry) => !covered.has(entry.token.id));
  // With the live site's own list in hand, only the pairs it really has are worth a warning.
  const missing = (live ? uncovered.filter((entry) => live.has(entry.token.id)) : uncovered).map((entry) => pairSymbol(entry.token));
  if (missing.length > 0) {
    const them = missing.length === 1 ? 'it' : 'them';
    lines.push(
      `NOT looking at: ${missing.join(', ')}. This .env has no CURVE_* and DBC_CONFIG_* lines for ${them}, so tokens priced in ${them} are not shown or claimed here.`,
      live
        ? `${env.publicOrigin ?? 'The live site'} has ${them} switched on. Add the lines for ${them} to this .env and run this again.`
        : "If the live site has them switched on, copy those lines from the server's settings into this .env and run this again.",
    );
  }
  return lines;
}

/**
 * What the live site (PUBLIC_ORIGIN) says about its pair tokens and configs:
 * the sizes its curves have and the address of every config it uses or keeps.
 * All of it is public; the site shows it to every visitor.
 */
export interface LiveSettings {
  readonly origin: string;
  readonly pairs: ReadonlyArray<{
    readonly id: string;
    /** The size of its curves, in whole pair tokens. Null for a pair the site has not sized. */
    readonly curve: { readonly initialMarketCap: number; readonly migrationMarketCap: number } | null;
    /** The configs new launches use there, by tier. */
    readonly configs: ReadonlyArray<{ readonly feeBps: number; readonly address: string }>;
  }>;
  /** Configs it keeps from earlier sets. Empty for a version that has no such thing. */
  readonly previous: ReadonlyArray<{ readonly address: string; readonly pairId: string }>;
}

const isConfigAddress = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};

/** Reads the answer of `/api/status`. Anything that is not what a site of this project sends is left out. Pure. */
export function parseLiveSettings(origin: string, body: unknown): LiveSettings | null {
  const pairsIn = (body as { pairs?: unknown } | null)?.pairs;
  if (!Array.isArray(pairsIn)) return null;
  const pairs: Array<LiveSettings['pairs'][number]> = [];
  for (const raw of pairsIn as Array<Record<string, unknown> | null>) {
    if (!raw || typeof raw.id !== 'string' || !/^[A-Z0-9]{1,12}$/.test(raw.id)) continue;
    const curveIn = raw.curve as { initialMarketCap?: unknown; migrationMarketCap?: unknown } | null | undefined;
    const sized = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const curve = curveIn && sized(curveIn.initialMarketCap) && sized(curveIn.migrationMarketCap) ? { initialMarketCap: curveIn.initialMarketCap, migrationMarketCap: curveIn.migrationMarketCap } : null;
    const configs: Array<{ feeBps: number; address: string }> = [];
    for (const tier of Array.isArray(raw.tiers) ? (raw.tiers as Array<Record<string, unknown> | null>) : []) {
      if (tier && typeof tier.feeBps === 'number' && tierByFeeBps(tier.feeBps) && isConfigAddress(tier.config)) configs.push({ feeBps: tier.feeBps, address: tier.config });
    }
    pairs.push({ id: raw.id, curve, configs });
  }
  const previous: Array<{ address: string; pairId: string }> = [];
  const previousIn = (body as { previousConfigs?: unknown }).previousConfigs;
  for (const raw of Array.isArray(previousIn) ? (previousIn as Array<Record<string, unknown> | null>) : []) {
    if (raw && isConfigAddress(raw.address) && typeof raw.pairId === 'string') previous.push({ address: raw.address, pairId: raw.pairId });
  }
  return { origin, pairs, previous };
}

/**
 * Asks the live site for those settings. Null when there is no address to ask
 * or it did not answer: this is for warnings and for lines to copy, never
 * something a script relies on.
 */
export async function liveSettings(env: AppEnv): Promise<LiveSettings | null> {
  if (!env.publicOrigin || env.localOrigin) return null;
  try {
    const response = await fetch(`${env.publicOrigin}/api/status`, { signal: AbortSignal.timeout(6_000), headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return parseLiveSettings(env.publicOrigin, await response.json());
  } catch {
    return null;
  }
}

/** The ids of the pair tokens the live site has tokens on: every pair it has a config for, in use or kept. */
export function livePairIds(live: LiveSettings | null): Set<string> | null {
  if (!live) return null;
  return new Set([...live.pairs.filter((pair) => pair.configs.length > 0).map((pair) => pair.id), ...live.previous.map((config) => config.pairId)]);
}

/**
 * What this `.env` lacks, or says differently, compared with the live site.
 *
 *  - `add`: whole lines to put in `.env`, as the live site has them: a
 *    pair's curve sizes and config addresses that are not set here at all.
 *  - `differs`: sentences about what is set here to something else.
 *
 * A config the live site uses and this `.env` already keeps in
 * DBC_CONFIGS_PREVIOUS is neither: that is the middle of a change of split,
 * where this computer is one step ahead of the server.
 *
 * Pure.
 */
export function compareWithLive(env: AppEnv, live: LiveSettings): { add: string[]; differs: string[] } {
  const add: string[] = [];
  const differs: string[] = [];
  const here = new Set<string>(env.previousConfigs);
  for (const entry of env.pairs) for (const tier of FEE_TIERS) if (entry.configs[tier.feeBps]) here.add(entry.configs[tier.feeBps] as string);
  for (const pair of live.pairs) {
    if (pair.configs.length === 0) continue;
    const entry = env.pairs.find((candidate) => candidate.token.id === pair.id);
    if (!entry) {
      differs.push(`The live site has tokens priced in ${pair.id}, a pair token this version of the code does not know.`);
      continue;
    }
    const keys = curveEnvKeys(pair.id);
    if (pair.curve) {
      if (!entry.size) {
        add.push(`${keys.initial}=${pair.curve.initialMarketCap}`, `${keys.migration}=${pair.curve.migrationMarketCap}`);
      } else if (entry.size.initialMarketCap !== pair.curve.initialMarketCap || entry.size.migrationMarketCap !== pair.curve.migrationMarketCap) {
        differs.push(
          `${keys.initial} / ${keys.migration} are ${entry.size.initialMarketCap} / ${entry.size.migrationMarketCap} here and ${pair.curve.initialMarketCap} / ${pair.curve.migrationMarketCap} on the live site. A config made with one size is refused by a server set to the other.`,
        );
      }
    }
    for (const config of pair.configs) {
      const tier = tierByFeeBps(config.feeBps);
      if (!tier || here.has(config.address)) continue;
      const key = configEnvKey(tier, pair.id);
      const local = entry.configs[tier.feeBps];
      if (!local) add.push(`${key}=${config.address}`);
      else differs.push(`${key} is ${local} here. The live site uses ${config.address}, which this .env neither uses nor keeps.`);
    }
  }
  const unkept = live.previous.map((config) => config.address).filter((address) => !here.has(address));
  if (unkept.length > 0) {
    differs.push(
      `The live site keeps ${unkept.length} config${unkept.length === 1 ? '' : 's'} from an earlier set that this .env does not. DBC_CONFIGS_PREVIOUS here must hold ${unkept.length === 1 ? 'it' : 'them'} too: ${unkept.join(',')}`,
    );
  }
  return { add, differs };
}

/**
 * The pairs among `pairIds` whose curves are sized differently here than on
 * the live site, one sentence each. A config is created with the sizes on
 * this computer, and a server set to other sizes refuses launches on it, so
 * this is worth knowing before any rent is paid. Pure.
 */
export function curveSizeClashes(env: AppEnv, live: LiveSettings, pairIds: readonly string[]): string[] {
  const clashes: string[] = [];
  for (const id of pairIds) {
    const size = env.pairs.find((entry) => entry.token.id === id)?.size;
    const there = live.pairs.find((pair) => pair.id === id)?.curve;
    if (!size || !there) continue;
    if (size.initialMarketCap === there.initialMarketCap && size.migrationMarketCap === there.migrationMarketCap) continue;
    const keys = curveEnvKeys(id);
    clashes.push(`${id}: ${keys.initial} / ${keys.migration} are ${size.initialMarketCap} / ${size.migrationMarketCap} here and ${there.initialMarketCap} / ${there.migrationMarketCap} on ${live.origin}.`);
  }
  return clashes;
}

/**
 * That comparison as lines to print, ready as they are: sentences indented,
 * and the settings to copy flush left so that a selection of them pastes into
 * `.env` cleanly. Empty when this `.env` and the live site agree, and when the
 * site could not be asked.
 */
export function liveDifferenceLines(env: AppEnv, live: LiveSettings | null): string[] {
  if (!live) return [];
  const { add, differs } = compareWithLive(env, live);
  const lines: string[] = [];
  if (add.length > 0) {
    lines.push(
      `  ${live.origin} uses ${add.length} setting${add.length === 1 ? '' : 's'} that the .env on this computer does not have.`,
      "  Add these lines to .env exactly as they are. They are the live site's own, and none of them is a secret:",
      '',
      ...add,
      '',
    );
  }
  for (const text of differs) lines.push(`  ! ${text}`);
  return lines;
}

/**
 * The text of a `.env` after its config addresses have been retired: every
 * `DBC_CONFIG_<fee>[_<PAIR>]` line that holds an address becomes a comment, and
 * one `DBC_CONFIGS_PREVIOUS` line holding `kept` is put at the end in place of
 * any that was there. With `split`, `CREATOR_FEE_SHARE_PCT` is set to the new
 * share, and `CREATOR_POOL_PAYOUT_PCT` is written down as it is today unless
 * the file already states it. Everything else, line endings included, is left
 * as it was. `retired` names the lines that were turned into comments.
 *
 * Pure: it takes text and returns text.
 */
export function retiredEnvText(
  text: string,
  kept: readonly string[],
  split?: { readonly creatorFeeSharePct: number; readonly creatorPoolPayoutPct: number },
): { text: string; retired: string[] } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const tierKeys = FEE_TIERS.map((tier) => tier.envKey).join('|');
  const configLine = new RegExp(`^\\s*(?:export\\s+)?((?:${tierKeys})(?:_[A-Z0-9]+)?)\\s*=\\s*(\\S.*)$`);
  const setting = (name: string): RegExp => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const retired: string[] = [];
  const out: string[] = [];
  let shareSet = false;
  let payoutSet = false;
  for (const line of text.split(/\r?\n/)) {
    const match = configLine.exec(line);
    if (match) {
      retired.push(match[1] as string);
      out.push(`# kept in DBC_CONFIGS_PREVIOUS: ${line.trim()}`);
      continue;
    }
    // An earlier DBC_CONFIGS_PREVIOUS line is replaced by the one added below, which holds its addresses too.
    if (setting('DBC_CONFIGS_PREVIOUS').test(line)) continue;
    if (split && setting('CREATOR_FEE_SHARE_PCT').test(line)) {
      // The new split, in the place the old one stood.
      if (!shareSet) out.push(`CREATOR_FEE_SHARE_PCT=${split.creatorFeeSharePct}`);
      shareSet = true;
      continue;
    }
    // A payout that is already written down is the operator's own choice and is left alone.
    if (setting('CREATOR_POOL_PAYOUT_PCT').test(line) && line.slice(line.indexOf('=') + 1).trim() !== '') payoutSet = true;
    out.push(line);
  }
  while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop();
  if (split && !shareSet) out.push('', "# The creator's share of what is left of each curve fee after Meteora's 20%.", `CREATOR_FEE_SHARE_PCT=${split.creatorFeeSharePct}`);
  if (split && !payoutSet) {
    // Unset, the payout would follow the new curve share. Written down, it stays what it was.
    out.push('', '# What creators are paid of the pool fees after graduation. Left out, it follows CREATOR_FEE_SHARE_PCT.', `CREATOR_POOL_PAYOUT_PCT=${split.creatorPoolPayoutPct}`);
  }
  out.push('', '# Configs kept from before the fee split changed. Their tokens stay listed; nothing new launches on them.', `DBC_CONFIGS_PREVIOUS=${kept.join(',')}`, '');
  return { text: out.join(eol), retired };
}

export function connect(env: AppEnv): Connection {
  return new Connection(requireRpc(env).rpcUrl, 'confirmed');
}

/** Refuses any RPC that is not Solana mainnet-beta. Every script calls this before it reads or sends. */
export async function assertNetwork(connection: Connection, _env?: AppEnv): Promise<void> {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new EnvError(`The RPC reports genesis ${genesis}, which is not Solana mainnet. This project runs on mainnet only; check the RPC URL.`);
  }
}

export function keypairFromEnv(key: string): Keypair {
  const raw = process.env[key]?.trim();
  if (!raw) throw new EnvError(`${key} is not set. Set it in this shell only, for this command (docs/MAINNET_RUNBOOK.md shows how in bash and in PowerShell). Do not put it in a file.`);
  const bytes = parseSecretKey(raw, (text) => bs58.decode(text));
  return bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
}

/**
 * A new Solana keypair for a hot wallet: its address, and its secret key in
 * the base58 form that wallets, and this project's settings, accept.
 */
export function newWalletKey(): { address: string; secret: string } {
  const keypair = Keypair.generate();
  return { address: keypair.publicKey.toBase58(), secret: bs58.encode(keypair.secretKey) };
}

export function publicKeyArg(value: string | undefined, label: string): PublicKey {
  if (!value) throw new EnvError(`${label} is required.`);
  try {
    return new PublicKey(value);
  } catch {
    throw new EnvError(`${label} is not a Solana address.`);
  }
}

/** Parses `--name value` and bare flags. */
export function parseArgs(argv: readonly string[]): { command: string | undefined; options: Record<string, string>; rest: string[] } {
  const [command, ...tail] = argv;
  const options: Record<string, string> = {};
  const rest: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const item = tail[index] as string;
    if (item.startsWith('--')) {
      const next = tail[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[item.slice(2)] = next;
        index += 1;
      } else {
        options[item.slice(2)] = 'true';
      }
    } else {
      rest.push(item);
    }
  }
  return { command, options, rest };
}

/**
 * Whether the operator confirmed a command that sends something.
 *
 * Accepted as plain words (`yes`, or `yes mainnet`) and as a flag (`--yes`,
 * `--yes mainnet`). The plain words are the documented form: Windows
 * PowerShell's npm wrapper drops flags written after `--`, so there
 * `npm run x -- --yes` reaches the script without its flag, while words are
 * passed through by npm in every shell.
 */
export function confirmed(args: { options: Record<string, string>; rest: readonly string[] }, word?: string): boolean {
  if (args.options.yes === (word ?? 'true')) return true;
  const at = args.rest.indexOf('yes');
  if (at === -1) return false;
  return word === undefined || args.rest[at + 1] === word;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ComputeBudget instruction tags. */
const SET_UNIT_LIMIT = 2;
const SET_UNIT_PRICE = 3;

/**
 * Simulates, then sends and confirms. A failed simulation never reaches the
 * network. The transaction is given a compute limit sized from the simulation
 * and a priority fee from the live estimate, and is re-sent every two seconds
 * until it confirms or its blockhash expires, because mainnet drops
 * transactions that are sent once.
 */
export async function simulateSendConfirm(
  connection: Connection,
  transaction: Transaction,
  signers: readonly Keypair[],
  label: string,
): Promise<string> {
  const payer = signers[0];
  if (!payer) throw new Error('At least one signer is required.');
  const env = loadEnv();
  const latest = await connection.getLatestBlockhash('confirmed');
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(...signers);
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    const logs = (simulation.value.logs ?? []).slice(-12).join('\n  ');
    throw new Error(`${label}: simulation failed: ${JSON.stringify(simulation.value.err)}\n  ${logs}`);
  }

  // Add whichever budget instructions the builder did not already include, then sign what will be sent.
  const tagOf = (instruction: TransactionInstruction): number | undefined =>
    instruction.programId.equals(ComputeBudgetProgram.programId) ? instruction.data[0] : undefined;
  const tags = new Set(transaction.instructions.map(tagOf));
  const budget: TransactionInstruction[] = [];
  if (!tags.has(SET_UNIT_LIMIT)) {
    const used = simulation.value.unitsConsumed ?? 400_000;
    budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, Math.ceil(used * 1.25) + 20_000) }));
  }
  if (!tags.has(SET_UNIT_PRICE)) {
    const price = clampPriority(await estimatePriority(requireRpc(env).rpcUrl), env.priorityMinMicroLamports, env.priorityMaxMicroLamports);
    if (price > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  }
  if (budget.length > 0) {
    transaction.instructions.unshift(...budget);
    transaction.sign(...signers);
  }

  const raw = transaction.serialize();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const settled = async (searchHistory: boolean): Promise<boolean> => {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: searchHistory })).value[0];
    if (status?.err) throw new Error(`${label}: transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    return status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
  };
  for (;;) {
    await sleep(2_000);
    if (await settled(false)) return signature;
    if ((await connection.getBlockHeight('confirmed')) > latest.lastValidBlockHeight) {
      // Look once more, properly, before saying it did not land.
      await sleep(4_000);
      if (await settled(true)) return signature;
      throw new Error(`${label}: transaction ${signature} expired before it confirmed. Check that signature on an explorer before running this again.`);
    }
    await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
  }
}

export function explorerTx(signature: string, _env?: AppEnv): string {
  return `https://orbmarkets.io/tx/${signature}`;
}

export function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(34)} ${String(value)}`);
}

export function heading(text: string): void {
  console.log(`\n${text}\n${'─'.repeat(Math.max(8, text.length))}`);
}

export function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✗ ${redact(message)}\n`);
  process.exit(1);
}

export type { TransactionInstruction };
