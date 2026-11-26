/**
 * Platform fees, and the creators' share of them.
 *
 *   npm run fees:status              what can be claimed, per token, and what each claim would pay the creator
 *   npm run fees:claim yes           claim it (needs PARTNER_KEY, the fee claimer's key)
 *
 * Two sources per token.
 *
 * On the curve, each fee is split on chain: the creator claims their own share
 * from the site, and this script claims the platform's.
 *
 * After graduation all liquidity is locked in one position that belongs to the
 * platform, so that position collects every pool fee. The platform passes
 * CREATOR_POOL_PAYOUT_PCT percent of what it collects on to the token's
 * creator. This script does both in one transaction: it claims a position's
 * fees and sends the creator's part to the creator's wallet. A claim never
 * lands without its payout, so nothing is ever owed afterwards. A position
 * whose creator part is still below the smallest payout is left unclaimed and
 * keeps accruing.
 *
 * That payout is the platform's doing. Nothing on chain forces it: it happens
 * when you run this.
 *
 * Every amount is in the token's pair token. A token priced in SOL earns and
 * pays SOL. A token priced in USDC earns USDC, and its creator is paid USDC
 * into their ordinary token account, which this script opens (and pays the
 * rent of) if the creator has none. Totals are kept per pair token: they are
 * never added across pairs.
 *
 * Run it on your own computer, with the same settings the server has for
 * PARTNER_WALLET, the DBC_CONFIG_* addresses and the CURVE_* values. The
 * partner key never needs to be on the server. When this machine has no token
 * list of its own, the pools are found on chain.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Connection, PublicKey, Transaction } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { MIN_CREATOR_PAYOUT_LAMPORTS } from '../shared/src/constants.js';
import { formatUnits } from '../shared/src/units.js';
import { type PoolClaimPlan, planPoolClaim } from '../shared/src/tiers.js';
import {
  type AllowedConfig,
  type GraduatedPool,
  type Market,
  MarketError,
  type PositionFees,
  claimPartnerFeeInstructions,
  claimPositionFeeInstructions,
  graduatedPositionFees,
  loadGraduatedPool,
  loadMarket,
} from '../shared/src/meteora.js';
import { type TradingPair, fromSolLamports } from '../shared/src/quotes.js';
import { Store } from '../server/src/db.js';
import type { AppEnv } from '../server/src/env.js';
import { pairRate } from '../server/src/pairs.js';
import { redact } from '../server/src/redact.js';
import { payoutInstructions } from './pairs.js';
import {
  allowedConfigsOf,
  assertNetwork,
  confirmed,
  connect,
  coverageLines,
  explorerTx,
  fail,
  heading,
  keypairFromEnv,
  line,
  liveDifferenceLines,
  livePairIds,
  liveSettings,
  loadEnv,
  parseArgs,
  simulateSendConfirm,
} from './lib.js';

/** Below this a claim is not worth its network fee. In SOL terms; other pair tokens use the same value at their rate. */
const MIN_CLAIM_LAMPORTS = 2_000_000n;
/**
 * The smallest payout to a creator in a pair token other than SOL, in SOL
 * terms. Higher than for SOL: the first one may have to open the creator's
 * token account, which costs the platform that account's rent.
 */
const MIN_TOKEN_PAYOUT_LAMPORTS = 10_000_000n;
const RECORD_DIR = resolve(import.meta.dirname, 'records');
const PAYOUT_LOG = resolve(RECORD_DIR, 'mainnet-creator-payouts.jsonl');

/** An amount of a pair token, with its ticker: "0.5 SOL", "12.25 USDC". */
const show = (units: bigint, pair: TradingPair): string => `${formatUnits(units, pair.decimals, Math.min(pair.decimals, 6))} ${pair.symbol}`;

/** The two thresholds for one pair, in that pair token's base units. */
interface Minimums {
  readonly claim: bigint;
  readonly payout: bigint;
}

function minimumsFor(pair: TradingPair, env: AppEnv): Minimums {
  if (pair.native) return { claim: MIN_CLAIM_LAMPORTS, payout: MIN_CREATOR_PAYOUT_LAMPORTS };
  const entry = env.pairs.find((candidate) => candidate.token.id === pair.id);
  const rate = entry ? pairRate(entry, env.economics) : 0;
  if (!(rate > 0)) throw new Error(`The ${pair.symbol} pair has no curve size in this environment, so its thresholds cannot be worked out.`);
  return { claim: fromSolLamports(MIN_CLAIM_LAMPORTS, pair, rate), payout: fromSolLamports(MIN_TOKEN_PAYOUT_LAMPORTS, pair, rate) };
}

interface PositionClaim {
  readonly fees: PositionFees;
  readonly plan: PoolClaimPlan;
}

interface Claimable {
  readonly market: Market;
  readonly symbol: string;
  /** The platform's unclaimed share of curve fees, in the pair token's base units. */
  readonly curve: bigint;
  readonly pool: GraduatedPool | null;
  readonly positions: readonly PositionClaim[];
  readonly minimums: Minimums;
}

function waiting(wait: NonNullable<PoolClaimPlan['wait']>, row: Claimable): string {
  if (wait === 'nothing') return 'nothing yet';
  if (wait === 'too-small') return `left in the pool until it reaches ${show(row.minimums.claim, row.market.pair)}`;
  return `left in the pool until the creator's part reaches ${show(row.minimums.payout, row.market.pair)}`;
}

async function survey(
  connection: Connection,
  dbc: DynamicBondingCurveClient,
  partner: PublicKey,
  env: AppEnv,
  configs: ReadonlyMap<string, AllowedConfig>,
): Promise<Claimable[]> {
  const creatorPoolPayoutPct = env.creatorPoolPayoutPct;
  const store = new Store(env.dataDir);
  const rows: Claimable[] = [];
  // Every token the database knows under the configs in this environment, not only the newest.
  let tokens: Array<{ mint: string; symbol: string }> = store.allTokens().filter((token) => configs.has(token.config));
  if (tokens.length === 0) {
    // The token list lives with the server. Away from it (on your own computer, where the partner
    // key belongs), the pools of these configs are read from the chain itself.
    console.log('  This machine has no token list, so the pools of your configs are being read from chain. This can take a minute.');
    for (const configAddress of configs.keys()) {
      const pools = await dbc.state.getPoolsByConfig(configAddress);
      tokens = tokens.concat(pools.map(({ account }) => ({ mint: account.poolState.baseMint.toBase58(), symbol: '' })));
    }
    console.log(`  Found ${tokens.length} token(s) on chain.`);
  }
  for (const token of tokens) {
    try {
      const market = await loadMarket(dbc, new PublicKey(token.mint), configs);
      const minimums = minimumsFor(market.pair, env);
      const curve = BigInt(market.state.poolState.partnerQuoteFee.toString());
      let pool: GraduatedPool | null = null;
      let positions: PositionClaim[] = [];
      if (market.stage === 'graduated') {
        pool = await loadGraduatedPool(connection, market);
        positions = (await graduatedPositionFees(connection, market, pool, partner)).map((fees) => ({
          fees,
          plan: planPoolClaim({
            lamports: fees.quoteUnits,
            creatorPayoutPct: creatorPoolPayoutPct,
            creatorIsPlatform: market.creator.equals(partner),
            minClaimLamports: minimums.claim,
            minPayoutLamports: minimums.payout,
          }),
        }));
      }
      rows.push({ market, symbol: token.symbol || token.mint.slice(0, 6), curve, pool, positions, minimums });
    } catch (error) {
      console.log(`  ! ${token.mint}: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  }
  store.close();
  return rows;
}

function describe(row: Claimable): string {
  const { pair } = row.market;
  const parts = [`curve ${show(row.curve, pair)}`];
  if (row.market.stage === 'graduated') {
    if (row.positions.length === 0) parts.push('pool: this wallet holds no position');
    for (const { fees, plan } of row.positions) {
      if (plan.wait) parts.push(`pool ${show(fees.quoteUnits, pair)}, ${waiting(plan.wait, row)}`);
      else if (plan.creator > 0n) parts.push(`pool ${show(fees.quoteUnits, pair)} → creator ${show(plan.creator, pair)}, platform ${show(plan.platform, pair)}`);
      else parts.push(`pool ${show(fees.quoteUnits, pair)}`);
    }
  }
  return parts.join(' · ');
}

function recordPayout(entry: Record<string, string>): void {
  mkdirSync(RECORD_DIR, { recursive: true });
  appendFileSync(PAYOUT_LOG, `${JSON.stringify(entry)}\n`);
}

interface Totals {
  claimNow: bigint;
  toCreators: bigint;
  waiting: bigint;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const { command } = args;
  if (command !== 'status' && command !== 'claim') throw new Error('Usage: fees.ts status | claim [yes]');
  const connection = connect(env);
  await assertNetwork(connection, env);
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');

  const signer = command === 'claim' && confirmed(args) ? keypairFromEnv('PARTNER_KEY') : undefined;
  const partnerAddress = signer?.publicKey.toBase58() ?? env.partnerWallet;
  if (!partnerAddress) throw new Error('Set PARTNER_WALLET (the fee claimer of the tier configs).');
  const partner = new PublicKey(partnerAddress);
  if (signer && env.partnerWallet && env.partnerWallet !== partnerAddress) {
    throw new Error('PARTNER_KEY is not the key of PARTNER_WALLET.');
  }

  heading(`Platform fees for ${partner.toBase58()} on Solana mainnet`);
  line('creators are paid', env.creatorPoolPayoutPct > 0 ? `${env.creatorPoolPayoutPct}% of the pool fees claimed (CREATOR_POOL_PAYOUT_PCT)` : 'nothing from pool fees (CREATOR_POOL_PAYOUT_PCT is 0)');
  const configs = await allowedConfigsOf(connection, env);
  // Said before anything is listed: a pair with no settings on this machine is skipped by everything below.
  const live = await liveSettings(env);
  for (const text of coverageLines(env, configs, livePairIds(live))) console.log(`  ${text}`);
  // The lines this computer lacks are the live site's own, so they can be printed whole, ready to paste.
  const differences = liveDifferenceLines(env, live);
  if (differences.length > 0) console.log(`\n${differences.join('\n')}\n`);
  const rows = await survey(connection, dbc, partner, env, configs);
  // One set of totals per pair token. A sum of SOL and USDC would be a number of nothing.
  const totals = new Map<string, { pair: TradingPair; sums: Totals }>();
  for (const row of rows) {
    const { pair } = row.market;
    const entry = totals.get(pair.id) ?? { pair, sums: { claimNow: 0n, toCreators: 0n, waiting: 0n } };
    totals.set(pair.id, entry);
    if (row.curve >= row.minimums.claim) entry.sums.claimNow += row.curve;
    else entry.sums.waiting += row.curve;
    for (const { fees, plan } of row.positions) {
      if (plan.wait) entry.sums.waiting += fees.quoteUnits;
      else {
        entry.sums.claimNow += fees.quoteUnits;
        entry.sums.toCreators += plan.creator;
      }
    }
    line(`$${row.symbol} (${row.market.stage}, ${pair.symbol})`, describe(row));
  }
  for (const { pair, sums } of totals.values()) {
    line(`${pair.symbol}: would be claimed now`, show(sums.claimNow, pair));
    line(`${pair.symbol}: of which paid to creators`, show(sums.toCreators, pair));
    line(`${pair.symbol}: of which kept by the platform`, show(sums.claimNow - sums.toCreators, pair));
    line(`${pair.symbol}: left to accrue`, show(sums.waiting, pair));
  }
  if (command === 'status') {
    console.log('');
    return;
  }
  if (!signer) {
    console.log('\n  Dry run. Run `npm run fees:claim yes` to claim (needs PARTNER_KEY).\n');
    return;
  }

  for (const row of rows) {
    const { pair } = row.market;
    try {
      if (row.curve >= row.minimums.claim) {
        const built = await claimPartnerFeeInstructions(dbc, row.market, partner);
        const signature = await simulateSendConfirm(connection, new Transaction().add(...built.instructions), [signer], `claim curve fees $${row.symbol}`);
        line(`$${row.symbol} curve`, `${show(built.amount, pair)}  ${explorerTx(signature, env)}`);
      }
      if (!row.pool) continue;
      for (const { fees, plan } of row.positions) {
        if (plan.wait) continue;
        const built = await claimPositionFeeInstructions(connection, row.pool, partner, fees);
        const transaction = new Transaction().add(...built.instructions);
        // The creator's part leaves in the same transaction as the claim that funds it.
        if (plan.creator > 0n) transaction.add(...payoutInstructions(row.market, partner, plan.creator));
        const signature = await simulateSendConfirm(connection, transaction, [signer], `claim pool fees $${row.symbol}`);
        if (plan.creator > 0n) {
          recordPayout({
            at: new Date().toISOString(),
            mint: row.market.mint.toBase58(),
            symbol: row.symbol,
            pair: pair.id,
            pairMint: pair.mint,
            creator: row.market.creator.toBase58(),
            position: fees.position.toBase58(),
            // Base units of the pair token: lamports for SOL.
            claimed: fees.quoteUnits.toString(),
            creatorShare: plan.creator.toString(),
            creatorPoolPayoutPct: String(env.creatorPoolPayoutPct),
            signature,
          });
          line(`$${row.symbol} pool`, `${show(fees.quoteUnits, pair)}, ${show(plan.creator, pair)} of it to the creator ${row.market.creator.toBase58()}  ${explorerTx(signature, env)}`);
        } else {
          line(`$${row.symbol} pool`, `${show(fees.quoteUnits, pair)}  ${explorerTx(signature, env)}`);
        }
      }
    } catch (error) {
      const message = error instanceof MarketError || error instanceof Error ? error.message : String(error);
      console.log(`  ! $${row.symbol}: ${redact(message)}`);
    }
  }
  console.log('\n✓ Done. Payouts to creators are listed in ops/records/mainnet-creator-payouts.jsonl.\n');
}

main().catch(fail);
