/**
 * The Meteora DBC configs: one per fee tier (2%, 3%, 4%) for every pair token
 * in use. SOL is always in use. Another pair token is in use once its curve
 * has been sized with CURVE_INITIAL_MARKET_CAP_<ID> and
 * CURVE_MIGRATION_MARKET_CAP_<ID> (`npm run doctor` suggests sizes).
 *
 *   npm run configs:plan                      prints exactly what would be created
 *   npm run configs:apply yes mainnet         creates any config that has no address yet
 *   npm run configs:verify                    reads every config back from chain and re-checks it
 *   npm run configs:retire                    prints how to change the fee split: which lines keep
 *                                             today's configs for their tokens, and which to remove
 *                                             so that `apply` creates a new set
 *   npm run configs:retire write [share]      makes that edit in a copy, `.env.next`, and with a number
 *                                             sets CREATOR_FEE_SHARE_PCT to it; `.env` is not touched.
 *                                             It first asks the live site (PUBLIC_ORIGIN) which pairs and
 *                                             configs it uses, and writes nothing while this `.env` lacks
 *                                             any of them: it prints the missing lines instead
 *
 * Add a pair's id to work on that pair alone: `npm run configs:plan USDC`,
 * `npm run configs:apply yes mainnet USDC`.
 *
 * A config can never be edited. Changing the split (CREATOR_FEE_SHARE_PCT) or
 * a curve's size therefore means a new set of configs for new launches, while
 * the old set stays in DBC_CONFIGS_PREVIOUS so that every token launched on it
 * keeps trading, earning and being claimed exactly as before.
 *
 * A config is immutable once created. `plan` exists so the numbers are read
 * by a human before `apply` spends anything; `verify` exists so nothing is
 * trusted that was not read back. For the SOL pair `plan` is offline. For any
 * other pair it reads the token's mint from chain first, because a curve is
 * priced with the mint's own decimals and those are never taken from a list.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { address } from '@solana/kit';
import { type Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { TOKEN_PROGRAM_ID } from '../shared/src/constants.js';
import { type CurveQuote, configMismatches, planTier } from '../shared/src/curve.js';
import { createInterfaceInstruction, createRingsClient, readProtocolFacts } from '../shared/src/privacy.js';
import { SOL_PAIR, type TradingPair, configEnvKey, curveEnvKeys, pairSymbol, pairTokenById, tradingPair } from '../shared/src/quotes.js';
import { FEE_TIERS, type FeeTier, METEORA_PROTOCOL_FEE_PCT, feeSplit } from '../shared/src/tiers.js';
import { legacyInstructionFields } from '../shared/src/tx.js';
import { type AppEnv, type PairEnv, requireRpc } from '../server/src/env.js';
import { type ResolvedPair, resolvePairs } from '../server/src/pairs.js';
import {
  assertNetwork,
  connect,
  explorerTx,
  fail,
  heading,
  curveSizeClashes,
  keypairFromEnv,
  line,
  type LiveSettings,
  liveDifferenceLines,
  liveSettings,
  loadEnv,
  confirmed,
  parseArgs,
  publicKeyArg,
  readKeptConfigs,
  retiredEnvText,
  simulateSendConfirm,
} from './lib.js';

const RECORD_DIR = resolve(import.meta.dirname, 'records');

function printPlan(tier: FeeTier, plan: ReturnType<typeof planTier>['plan'], creatorPoolPayoutPct: number): void {
  const unit = plan.pairSymbol;
  heading(`${unit} pair · ${tier.label} tier (${tier.id})`);
  line('priced and traded in', `${unit}  (${plan.quoteMint}, ${plan.quoteDecimals} decimals)`);
  line('trading fee on the curve', `${plan.feeBps} bps, constant`);
  line('trading fee after graduation', `${plan.feeTerms.migratedPoolFeeBps} bps, constant`);
  line('fee schedule / dynamic fee', 'none / disabled, both phases');
  line('fees collected in', unit);

  // On the curve the split is a term of the config and is paid out by Meteora's program.
  const afterProtocol = 100 - METEORA_PROTOCOL_FEE_PCT;
  line('curve fees: Meteora', `${METEORA_PROTOCOL_FEE_PCT}% of each fee (set by Meteora)`);
  line('curve fees: creator', `${plan.summary.creatorCurveFeeSharePct}% of the rest = ${(afterProtocol * plan.summary.creatorCurveFeeSharePct) / 100}% of each fee, claimed by the creator on chain`);
  line('curve fees: platform', `${plan.summary.platformCurveFeeSharePct}% of the rest = ${(afterProtocol * plan.summary.platformCurveFeeSharePct) / 100}% of each fee`);

  line('token supply', `${plan.summary.totalSupply} (fixed, ${plan.summary.tokenDecimals} decimals)`);
  line('mint authority', 'revoked at launch (immutable)');
  line('starting market cap', `${plan.summary.initialMarketCap} ${unit}`);
  line('graduation market cap', `${plan.summary.encodedMigrationMarketCap} ${unit}`);
  line(`${unit} in the curve at graduation`, plan.summary.raisedAtGraduation);
  line('graduation', plan.summary.keeper.note);
  line('platform migration fee', `${plan.economics.migrationFeePct}% (${plan.summary.migrationFee} ${unit})`);
  line("Meteora's graduation fee", `${plan.summary.meteoraGraduationFeeBps / 100}% of the liquidity, about ${plan.summary.meteoraGraduationFee} ${unit} (set by Meteora)`);
  line(`${unit} that becomes liquidity`, `about ${plan.summary.depositedAsLiquidity}`);

  // After graduation there is one locked position and it is the platform's.
  line('liquidity locked forever', `${plan.summary.lockedLpBpsAtDayOne / 100}%`);
  line('locked liquidity held by', `the platform ${plan.summary.platformLockedLpPct}% · the creator ${plan.summary.creatorLockedLpPct}%`);
  line('pool fees after graduation', "all collected by the platform's locked position");
  line(
    'creator after graduation',
    creatorPoolPayoutPct > 0
      ? `${creatorPoolPayoutPct}% of the pool fees the platform claims, paid by \`npm run fees:claim\``
      : 'nothing: CREATOR_POOL_PAYOUT_PCT is 0',
  );
  line('', '(CREATOR_POOL_PAYOUT_PCT: a payment the platform makes, not a term of this config)');
  line('environment variable', plan.envKey);
}

/**
 * How to change the fee split, written out for this environment. It sends
 * nothing and reads nothing from chain.
 *
 * `apply` only creates a config where there is no address yet, so the old
 * addresses have to leave their DBC_CONFIG_* lines first. They go into
 * DBC_CONFIGS_PREVIOUS, which keeps every token launched on them listed.
 *
 * With `write`, the edit is made for you in a copy: `.env.next` is this
 * folder's `.env` with those lines taken out and DBC_CONFIGS_PREVIOUS added.
 * `.env` itself is never touched.
 */
function printRetire(env: AppEnv, write: boolean, share: number | undefined, live: LiveSettings | null, unchecked: boolean): void {
  const current: Array<{ key: string; address: string }> = [];
  for (const entry of env.pairs) {
    for (const tier of FEE_TIERS) {
      const configAddress = entry.configs[tier.feeBps];
      if (configAddress) current.push({ key: configEnvKey(tier, entry.token.id), address: configAddress });
    }
  }
  heading('Changing the fee split for new launches');
  if (current.length === 0) {
    console.log('  No DBC_CONFIG_* address is set in this .env, so there is nothing to keep.');
    if (env.previousConfigs.length > 0) console.log(`  DBC_CONFIGS_PREVIOUS already keeps ${env.previousConfigs.length} config(s).`);
    console.log('  Set CREATOR_FEE_SHARE_PCT, then run `npm run configs:plan` and `npm run configs:apply yes mainnet`.\n');
    return;
  }
  const kept = [...new Set([...env.previousConfigs, ...current.map((entry) => entry.address)])];
  const rent = (current.length * 0.0082).toFixed(2);

  // The edit starts from this computer's .env. If the live site uses a pair or a config that is not in
  // it, the new set would leave that pair behind, and a kept list without a config unlists its tokens.
  const differences = liveDifferenceLines(env, live);
  if (differences.length > 0) {
    console.log(`  The .env on this computer and the live site do not agree. That has to be put right first.\n`);
    console.log(`${differences.join('\n')}\n`);
    if (write) {
      console.log('  Nothing was written. Put that right in .env, run `npm run fees:status` to see every pair, and run this again.\n');
      process.exitCode = 1;
      return;
    }
  } else if (!live) {
    console.log('  ! The live site could not be asked which pairs and configs it uses: PUBLIC_ORIGIN in this .env is not');
    console.log('    the address of your site, or the site did not answer. That check is what catches a pair the server');
    console.log('    has and this .env does not. Every CURVE_* and DBC_CONFIG_* line the server has must be here too.\n');
    if (write && !unchecked) {
      console.log('  Nothing was written. Set PUBLIC_ORIGIN in this .env to the address of your site (https://...) and run');
      console.log('  this again. To go on without the check, once you have compared the two yourself, add the word');
      console.log(`  unchecked: \`npm run configs:retire write${share === undefined ? '' : ` ${share}`} unchecked\`.\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(`  Checked against ${live.origin}: this .env has every pair and config the live site uses.\n`);
  }

  if (write) {
    const source = resolve(process.cwd(), '.env');
    const target = resolve(process.cwd(), '.env.next');
    if (!existsSync(source)) throw new Error(`There is no .env in ${process.cwd()}. Run this in the project folder, where your .env is.`);
    const edited = retiredEnvText(readFileSync(source, 'utf8'), kept, share === undefined ? undefined : { creatorFeeSharePct: share, creatorPoolPayoutPct: env.creatorPoolPayoutPct });
    const missing = current.filter((entry) => !edited.retired.includes(entry.key)).map((entry) => entry.key);
    if (missing.length > 0) {
      throw new Error(`These are set, but not by a line in .env, so the copy would be incomplete: ${missing.join(', ')}. Put them in .env (they may be set in this shell instead) and run this again.`);
    }
    writeFileSync(target, edited.text);
    console.log(`  Wrote .env.next: your .env with its ${edited.retired.length} DBC_CONFIG_* lines turned into comments and one new line,`);
    console.log(`  DBC_CONFIGS_PREVIOUS, that keeps all ${kept.length} of those configs for the tokens launched on them.`);
    console.log('  Your .env was not changed, and nothing was sent anywhere.\n');
    console.log('  Next:\n');
    if (share === undefined) {
      console.log('  1. Open .env.next and set these two lines (add them if they are not there):\n');
      console.log("       CREATOR_FEE_SHARE_PCT=80     the creator's share of what is left of each curve fee after Meteora's 20%.");
      console.log('                                    80 gives creator 64%, platform 16%, Meteora 20%. (30 gave 24 / 56 / 20.)');
      console.log(`       CREATOR_POOL_PAYOUT_PCT=${env.creatorPoolPayoutPct}   what creators are paid of the pool fees after graduation.`);
      console.log('                                    Left out, it would follow CREATOR_FEE_SHARE_PCT.');
      console.log('     (`npm run configs:retire write 80` sets both for you.)\n');
    } else {
      const split = feeSplit({ creatorFeeSharePct: share });
      console.log(`  1. Open .env.next and check its last lines. It now says CREATOR_FEE_SHARE_PCT=${share}: of each curve fee,`);
      console.log(`     creator ${split.creatorPct}%, platform ${split.platformPct}%, Meteora ${split.protocolPct}%. And CREATOR_POOL_PAYOUT_PCT=${env.creatorPoolPayoutPct}: what creators`);
      console.log('     are paid of the pool fees after graduation, the same as today.\n');
    }
    console.log('  2. Keep the old file and put the new one in its place:\n');
    console.log('       Copy-Item .env .env.before-split');
    console.log('       Copy-Item .env.next .env -Force          (bash: cp .env .env.before-split && cp .env.next .env)\n');
    console.log('  3. `npm run configs:plan` and read it. Every tier must show the new split.\n');
    console.log('  4. With DEPLOYER_KEY set in this shell only: `npm run configs:apply yes mainnet`.');
    console.log(`     It creates ${current.length} configs (about ${rent} SOL of rent) and prints the lines for .env and for the server.\n`);
    console.log('  Part I of docs/MAINNET_RUNBOOK.md has every step with what you should see after it.\n');
    return;
  }

  console.log('  A config cannot be edited. The tokens already launched keep the split they have, for good.');
  console.log('  New launches get the new split once a new set of configs exists. Nothing was changed by this command.\n');
  console.log(`  This environment has ${current.length} configs in use. To keep them for their tokens and make room for a new set:\n`);
  console.log('  THE EASY WAY: `npm run configs:retire write 80`');
  console.log('     writes .env.next, a copy of your .env with the edit below already made and the creator share');
  console.log('     set to 80 (creator 64%, platform 16%, Meteora 20% of each curve fee). Your .env is not touched.\n');
  console.log('  BY HAND, in the .env on this computer:\n');
  console.log('  a. Add this one line. It keeps every token you have listed:\n');
  console.log(`DBC_CONFIGS_PREVIOUS=${kept.join(',')}\n`);
  console.log(`  b. Delete these ${current.length} lines (a config is either in use for new launches or kept, never both):\n`);
  for (const entry of current) console.log(`     ${entry.key}`);
  console.log("\n  c. Set the split, and say what creators get after graduation:\n");
  console.log("     CREATOR_FEE_SHARE_PCT=80     creator's share of what is left of each curve fee after Meteora's 20%.");
  console.log('                                  80 gives creator 64%, platform 16%, Meteora 20%.');
  console.log(`     CREATOR_POOL_PAYOUT_PCT=${env.creatorPoolPayoutPct}   left out, it would follow CREATOR_FEE_SHARE_PCT.\n`);
  console.log('     Leave every CURVE_* line as it is.\n');
  console.log('  THEN: `npm run configs:plan`, read it, and with DEPLOYER_KEY set in this shell only');
  console.log(`  \`npm run configs:apply yes mainnet\`. It creates ${current.length} configs (about ${rent} SOL of rent).\n`);
  console.log('  The server must already run this version before its settings change: an older one does not');
  console.log('  know DBC_CONFIGS_PREVIOUS and would stop listing your tokens. Part I of docs/MAINNET_RUNBOOK.md');
  console.log('  has every step in order, with what you should see after each.\n');
}

/** The pairs a command works on: the ones in use, or just the ones named on the command line. */
function pairsInScope(env: AppEnv, words: readonly string[]): PairEnv[] {
  const named = words.map((word) => pairTokenById(word)).filter((token) => token !== undefined);
  if (named.length > 0) {
    return named.map((token) => {
      const entry = env.pairs.find((candidate) => candidate.token.id === token.id) as PairEnv;
      if (!entry.size) {
        const keys = curveEnvKeys(token.id);
        throw new Error(
          `The ${pairSymbol(token)} pair has no curve size yet. Set ${keys.initial} and ${keys.migration} (in whole ${pairSymbol(token)}; \`npm run doctor\` suggests values worth what your SOL curve is), then run this again.`,
        );
      }
      return entry;
    });
  }
  return env.pairs.filter((entry) => entry.size !== undefined);
}

/**
 * What a curve of each pair in scope is priced in. SOL needs nothing read.
 * Every other pair's mint is read from chain, and a pair whose mint cannot be
 * used is reported and left out.
 */
async function quotesFor(scope: readonly PairEnv[], connection: Connection | undefined): Promise<Array<{ entry: PairEnv; quote: CurveQuote; resolved: ResolvedPair | undefined }>> {
  const out: Array<{ entry: PairEnv; quote: CurveQuote; resolved: ResolvedPair | undefined }> = [];
  const spl = scope.filter((entry) => !entry.token.native);
  const resolved = spl.length > 0 && connection ? await resolvePairs(connection, spl) : [];
  for (const entry of scope) {
    if (!entry.size) continue;
    if (entry.token.native) {
      out.push({ entry, quote: { pair: SOL_PAIR, size: entry.size }, resolved: undefined });
      continue;
    }
    const result = resolved.find((candidate) => candidate.env.token.id === entry.token.id);
    if (!result) throw new Error(`Planning the ${pairSymbol(entry.token)} pair reads its mint from chain. Set HELIUS_API_KEY first.`);
    // A missing Rings interface does not stop a plan: `apply` creates it. Anything else about the mint does.
    const blocking = result.problems.filter((problem) => !/Rings has no interface/.test(problem));
    if (blocking.length > 0 || !result.facts) {
      console.log(`\n✗ ${pairSymbol(entry.token)} pair: this token cannot be used as a pair here, so nothing is planned for it.\n    ${blocking.join('\n    ')}`);
      continue;
    }
    let pair: TradingPair;
    try {
      pair = tradingPair(entry.token, result.facts.decimals);
    } catch (error) {
      console.log(`\n✗ ${pairSymbol(entry.token)} pair: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    out.push({ entry, quote: { pair, size: entry.size }, resolved: result });
  }
  return out;
}

/** Makes sure Rings has an interface for a pair token, creating it when it is missing and anyone may. */
async function ensureInterface(env: AppEnv, connection: Connection, deployer: Keypair, result: ResolvedPair): Promise<void> {
  const ticker = pairSymbol(result.env.token);
  if (result.hasInterface) {
    console.log(`• ${ticker}: Rings already has an interface for it.`);
    return;
  }
  const { rpcUrl, sprUrl } = requireRpc(env);
  const facts = await readProtocolFacts(await createRingsClient({ rpcUrl, sprUrl }));
  if (!facts.splInterfaceCreationIsPermissionless) {
    throw new Error(`Rings has no interface for ${ticker}, and creating one is restricted right now. ${ticker} could not be held privately, so no config was created for it.`);
  }
  console.log(`• ${ticker}: creating its Rings interface, so it can be held privately …`);
  const fields = legacyInstructionFields(await createInterfaceInstruction(address(deployer.publicKey.toBase58()), address(result.env.token.mint), address(TOKEN_PROGRAM_ID)));
  const instruction = new TransactionInstruction({
    programId: new PublicKey(fields.programId),
    keys: fields.keys.map((key) => ({ pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable })),
    data: Buffer.from(fields.data),
  });
  const signature = await simulateSendConfirm(connection, new Transaction().add(instruction), [deployer], `${ticker} Rings interface`);
  console.log(`✓ ${ticker}: Rings interface created  ${explorerTx(signature, env)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { command, options } = args;
  const env = loadEnv();
  if (command === 'retire') {
    // `retire write 80`: make the edit in a copy, with the new creator share set as well.
    const number = args.rest.find((word) => /^[0-9]{1,3}$/.test(word));
    const share = number === undefined ? undefined : Number(number);
    if (share !== undefined && share > 100) throw new Error('The creator share is a percentage from 0 to 100.');
    printRetire(env, args.rest.includes('write'), share, await liveSettings(env), args.rest.includes('unchecked'));
    return;
  }
  // Words after the command that name a pair token narrow the command to it. `yes` and `mainnet` are the confirmation.
  const named = args.rest.filter((word) => word !== 'yes' && word !== 'mainnet' && word !== 'resize');
  const unknown = named.filter((word) => !pairTokenById(word));
  if (unknown.length > 0) throw new Error(`"${unknown[0]}" is not a pair token this build knows. The pair tokens are ${env.pairs.map((entry) => entry.token.id).join(', ')}.`);

  const scope = pairsInScope(env, named);
  const needsChain = scope.some((entry) => !entry.token.native);

  if (command === 'plan') {
    const partner = publicKeyArg(options.partner ?? env.partnerWallet, 'PARTNER_WALLET (or --partner)');
    let connection: Connection | undefined;
    if (needsChain) {
      connection = connect(env);
      await assertNetwork(connection, env);
    }
    console.log(`Network: Solana mainnet   Fee claimer / leftover receiver: ${partner.toBase58()}`);
    for (const { quote, resolved } of await quotesFor(scope, connection)) {
      for (const tier of FEE_TIERS) printPlan(tier, planTier(tier, env.economics, partner, quote).plan, env.creatorPoolPayoutPct);
      if (resolved) {
        console.log(`\n  ${quote.pair.symbol}: ${resolved.env.token.note}`);
        for (const note of resolved.notes) console.log(`  ${quote.pair.symbol}: ${note}`);
        console.log(
          resolved.hasInterface
            ? `  ${quote.pair.symbol}: Rings has an interface for it, so it can be held privately.`
            : `  ${quote.pair.symbol}: Rings has no interface for it yet. \`configs:apply\` creates one first, at the cost of its rent.`,
        );
      }
    }
    const idle = env.pairs.filter((entry) => !entry.size).map((entry) => pairSymbol(entry.token));
    if (idle.length > 0 && named.length === 0) {
      console.log(`\nNot in use, so not planned: ${idle.join(', ')}. A pair is switched on by sizing its curve; \`npm run doctor\` suggests sizes.`);
    }
    if (!env.creatorPoolPayoutExplicit && env.creatorPoolPayoutPct !== 30) {
      console.log(
        `\n! CREATOR_POOL_PAYOUT_PCT is not set, so it follows CREATOR_FEE_SHARE_PCT: creators would be paid ${env.creatorPoolPayoutPct}% of the pool fees\n  after graduation too. If that is not what you mean, set CREATOR_POOL_PAYOUT_PCT yourself (30, for instance).`,
      );
    }
    if (named.length === 0) {
      const differences = liveDifferenceLines(env, await liveSettings(env));
      if (differences.length > 0) console.log(`\nBefore creating anything, note where this .env and the live site differ:\n\n${differences.join('\n')}`);
    }
    console.log(
      '\nNothing was sent. These terms are permanent once created: a pool keeps the config it was\nlaunched with. Review them, then, with DEPLOYER_KEY set in this shell, run `npm run configs:apply yes mainnet`.\n',
    );
    return;
  }

  if (command === 'apply') {
    // Asked first, before any key is read or any request is made.
    if (!confirmed(args, 'mainnet')) {
      throw new Error('Creating configs on mainnet is permanent and costs rent. Once you have reviewed `npm run configs:plan`, run `npm run configs:apply yes mainnet`.');
    }
    const deployer = keypairFromEnv('DEPLOYER_KEY');
    const partner = publicKeyArg(options.partner ?? env.partnerWallet, 'PARTNER_WALLET (or --partner)');
    const connection = connect(env);
    await assertNetwork(connection, env);
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
    // A config is made with the curve sizes on this computer, and the server takes launches on it only
    // if its own sizes are the same. Asked before any rent is paid.
    const live = await liveSettings(env);
    if (live && !args.rest.includes('resize')) {
      const creating = scope.filter((entry) => entry.size && FEE_TIERS.some((tier) => !entry.configs[tier.feeBps])).map((entry) => entry.token.id);
      const clashes = curveSizeClashes(env, live, creating);
      if (clashes.length > 0) {
        throw new Error(
          `The curve sizes in this .env are not the live site's, so the server would refuse launches on the configs created now:\n  ${clashes.join('\n  ')}\nNothing was created. If the sizes here are wrong, set them to the live site's. If you mean to change a curve's size, run this again with the word resize added (\`npm run configs:apply yes mainnet resize\`), and change the same CURVE_* lines on the server together with the new addresses.`,
        );
      }
    }
    // The configs kept from the set before were made with the same partner wallet and the same pair
    // tokens as the ones about to be created. If this .env no longer recognises them as the platform's
    // own, it is not the .env to create their successors with, and the server would unlist their tokens.
    if (env.previousConfigs.length > 0) {
      const everyPair = await quotesFor(pairsInScope(env, []), connection);
      const { refused } = await readKeptConfigs(connection, env, everyPair.map(({ quote }) => quote.pair));
      if (refused.length > 0) {
        throw new Error(
          `${refused.length} of the ${env.previousConfigs.length} configs in DBC_CONFIGS_PREVIOUS are not this platform's own under the settings in this .env:\n  ${refused
            .map(({ address: kept, why }) => `${kept}: ${why}`)
            .join('\n  ')}\nNothing was created. The usual causes: PARTNER_WALLET here is not the fee claimer the earlier set was created with, or a pair's CURVE_* lines are missing from this .env. \`npm run configs:verify\` shows the same list.`,
        );
      }
    }
    const lines: string[] = [];
    for (const { entry, quote, resolved } of await quotesFor(scope, connection)) {
      const unit = quote.pair.symbol;
      const missing = FEE_TIERS.filter((tier) => !entry.configs[tier.feeBps]);
      if (missing.length > 0 && resolved) await ensureInterface(env, connection, deployer, resolved);
      for (const tier of FEE_TIERS) {
        const envKey = configEnvKey(tier, entry.token.id);
        const name = `${unit} ${tier.label}`;
        const existing = entry.configs[tier.feeBps];
        if (existing) {
          console.log(`• ${name}: ${envKey} is already set to ${existing}; skipping. Run configs:verify to check it.`);
          continue;
        }
        const { plan, config } = planTier(tier, env.economics, partner, quote);
        const configKeypair = Keypair.generate();
        const transaction = await dbc.partner.createConfig2({
          payer: deployer.publicKey,
          config: configKeypair.publicKey,
          feeClaimer: partner,
          leftoverReceiver: partner,
          quoteMint: new PublicKey(quote.pair.mint),
          ...config,
          transferFeeParameters: null,
        });
        // Named before it is sent, so the address is on screen whatever happens next.
        console.log(`• ${name}: creating config ${configKeypair.publicKey.toBase58()} …`);
        const signature = await simulateSendConfirm(connection, transaction, [deployer, configKeypair], `${name} config`);
        const account = await dbc.state.getPoolConfig(configKeypair.publicKey);
        if (!account) throw new Error(`${name}: the config account was not found after confirmation.`);
        const problems = configMismatches(tier, config, account as unknown as Record<string, unknown>, partner, quote.pair.mint);
        if (problems.length > 0) {
          throw new Error(`${name}: the created config does not match the plan. Do not use it.\n  ${problems.join('\n  ')}`);
        }
        console.log(`✓ ${name}: ${configKeypair.publicKey.toBase58()}  ${explorerTx(signature, env)}`);
        // Printed at once as well as at the end: if a later config fails, this one's line is already on screen.
        console.log(`    ${envKey}=${configKeypair.publicKey.toBase58()}`);
        lines.push(`${envKey}=${configKeypair.publicKey.toBase58()}`);
        mkdirSync(RECORD_DIR, { recursive: true });
        // One file per config ever created, so a later set never overwrites an earlier one.
        const prefix = entry.token.native ? 'mainnet' : `mainnet-${entry.token.id.toLowerCase()}`;
        const recordPath = resolve(RECORD_DIR, `${prefix}-${tier.id}-${configKeypair.publicKey.toBase58()}.json`);
        writeFileSync(
          recordPath,
          `${JSON.stringify({ network: env.network, config: configKeypair.publicKey.toBase58(), signature, partner: partner.toBase58(), createdAt: new Date().toISOString(), plan }, null, 2)}\n`,
        );
      }
      if (!entry.token.native && missing.length > 0) {
        // The curve size is part of what the server checks a config against: it belongs next to the addresses.
        const keys = curveEnvKeys(entry.token.id);
        lines.push(`${keys.initial}=${quote.size.initialMarketCap}`, `${keys.migration}=${quote.size.migrationMarketCap}`);
      }
    }
    if (lines.length > 0) {
      // After a change of split the server needs three more lines than the new addresses. One block to paste.
      if (env.previousConfigs.length > 0) {
        lines.push(`DBC_CONFIGS_PREVIOUS=${env.previousConfigs.join(',')}`, `CREATOR_FEE_SHARE_PCT=${env.economics.creatorFeeSharePct}`, `CREATOR_POOL_PAYOUT_PCT=${env.creatorPoolPayoutPct}`);
      }
      console.log(`\nAdd these to the server environment (your .env here, and the hosting platform's settings), then run \`npm run configs:verify\`:\n\n${lines.join('\n')}\n`);
      if (env.previousConfigs.length > 0) {
        console.log('The last three lines are already in your .env. They are repeated so that the whole block can go to the server in one piece:');
        console.log('the server must hold the new addresses, the kept ones and the split together, or it refuses launches.\n');
      }
    }
    return;
  }

  if (command === 'verify') {
    const partner = publicKeyArg(options.partner ?? env.partnerWallet, 'PARTNER_WALLET (or --partner)');
    const connection = connect(env);
    await assertNetwork(connection, env);
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
    let failed = false;
    const quotes = await quotesFor(scope, connection);
    if (quotes.length < scope.length) failed = true;
    for (const { entry, quote, resolved } of quotes) {
      const unit = quote.pair.symbol;
      if (resolved && !resolved.hasInterface) {
        console.log(`✗ ${unit}: Rings has no interface for it yet, so the site keeps this pair off. \`npm run configs:apply yes mainnet ${entry.token.id}\` creates one.`);
        failed = true;
      }
      for (const tier of FEE_TIERS) {
        const envKey = configEnvKey(tier, entry.token.id);
        const name = `${unit} ${tier.label}`;
        const configAddress = entry.configs[tier.feeBps];
        if (!configAddress) {
          console.log(`✗ ${name}: ${envKey} is not set.`);
          failed = true;
          continue;
        }
        const account = await dbc.state.getPoolConfig(new PublicKey(configAddress));
        if (!account) {
          console.log(`✗ ${name}: no config account at ${configAddress}.`);
          failed = true;
          continue;
        }
        // Compared with the environment, because that is what the server runs with: its CURVE_* and
        // CREATOR_FEE_SHARE_PCT settings must be the ones this config was created with.
        const { config } = planTier(tier, env.economics, partner, quote);
        const problems = configMismatches(tier, config, account as unknown as Record<string, unknown>, partner, quote.pair.mint);
        if (problems.length > 0) {
          console.log(`✗ ${name}: ${configAddress}\n    ${problems.join('\n    ')}`);
          console.log('    If the fee lines above are fine and only curve numbers differ, the environment holds different launch');
          console.log('    economics from the ones this config was created with. They are recorded in its file in ops/records.');
          failed = true;
        } else {
          console.log(`✓ ${name}: ${configAddress}  priced in ${unit}, charges ${tier.feeBps} bps on the curve and ${tier.feeBps} bps after graduation, no schedule, no dynamic fee.`);
        }
      }
    }
    // The configs kept from earlier sets: each must still be one of the platform's own.
    if (env.previousConfigs.length > 0 && named.length === 0) {
      const { kept, refused } = await readKeptConfigs(connection, env, quotes.map(({ quote }) => quote.pair));
      for (const config of kept) {
        console.log(
          `✓ kept: ${config.address}  ${config.pair.symbol} ${config.feeBps / 100}%, creator share ${config.creatorFeeSharePct}% of what is left of each curve fee after Meteora. Its tokens stay listed; nothing new launches on it.`,
        );
      }
      for (const { address: kept, why } of refused) {
        console.log(`✗ kept: ${kept}: ${why}. Tokens launched on it are not listed.`);
        failed = true;
      }
    }
    if (failed) process.exit(1);
    return;
  }

  console.log('Usage: tsx ops/configs.ts <plan|apply|verify|retire [write [share]]> [yes mainnet [resize]] [PAIR ...] [--partner <address>]');
  console.log(`Record files are written to ${dirname(resolve(RECORD_DIR, 'x'))}.`);
  process.exit(command ? 1 : 0);
}

main().catch(fail);
