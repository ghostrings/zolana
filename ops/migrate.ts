/**
 * `npm run migrate <mint> [yes]` — graduates a completed curve to its
 * DAMM v2 pool.
 *
 * Meteora's keeper does this by itself for the curves it covers: SOL curves
 * whose target is 10 SOL or more, USDC curves of 750 USDC or more, and curves
 * against another pair token only when Jupiter lists that token as verified
 * with an organic score above 50 and the curve raises over 750 dollars' worth.
 * Any other completed curve waits until somebody sends this instruction. It
 * is permissionless: any funded wallet can pay for it, from the token's page
 * on the site or with this script, and gains nothing by doing so. The
 * liquidity goes to the platform's locked position, as the tier config says.
 */

import { Transaction } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { loadMarket, migrationInstructions } from '../shared/src/meteora.js';
import { keeperRule } from '../shared/src/quotes.js';
import { formatUnits } from '../shared/src/units.js';
import { allowedConfigsOf, assertNetwork, confirmed, connect, explorerTx, fail, heading, keypairFromEnv, line, loadEnv, parseArgs, publicKeyArg, simulateSendConfirm } from './lib.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const { command } = args;
  const mint = publicKeyArg(command, 'A mint address');
  const connection = connect(env);
  await assertNetwork(connection, env);
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const market = await loadMarket(dbc, mint, await allowedConfigsOf(connection, env));
  const unit = market.pair.symbol;

  heading(`${mint.toBase58()} — ${unit} pair, ${market.tier.label} tier`);
  line('curve pool', market.pool.toBase58());
  line('stage', market.stage);
  const reserve = BigInt(market.state.poolState.quoteReserve.toString());
  const threshold = BigInt(market.config.migrationQuoteThreshold.toString());
  line(`raised / target (${unit})`, `${formatUnits(reserve, market.pair.decimals)} / ${formatUnits(threshold, market.pair.decimals)}`);
  line("Meteora's keeper", keeperRule(market.pair, threshold).note);
  if (market.stage === 'graduated') {
    console.log('\n  Already graduated. Nothing to do.\n');
    return;
  }
  if (market.stage !== 'migrating') {
    console.log('\n  The curve is not complete yet, so it cannot graduate.\n');
    return;
  }
  if (!confirmed(args)) {
    console.log('\n  Dry run. Add the word `yes` after the mint to send the migration (needs DEPLOYER_KEY to pay for it).\n');
    return;
  }
  const payer = keypairFromEnv('DEPLOYER_KEY');
  const built = await migrationInstructions(dbc, market, payer.publicKey);
  line('DAMM v2 config', built.dammConfig.toBase58());
  const signature = await simulateSendConfirm(connection, new Transaction().add(...built.instructions), [payer, ...built.signers], 'migrate');
  line('transaction', explorerTx(signature, env));
  console.log(`\n✓ Graduated. Run \`npm run verify:graduated ${mint.toBase58()}\` to check the pool's fee.\n`);
}

main().catch(fail);
