/**
 * `npm run verify:graduated <mint>` — reads a graduated token's DAMM v2
 * pool and checks that it charges exactly the tier fee, with no schedule and
 * no dynamic fee. This is the on-chain check behind "the fee never drops
 * after graduation". It also reports who holds the locked liquidity, which
 * should be the platform alone. It sends nothing.
 */

import { PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { assertGraduatedFee, graduatedFeeTerms, loadGraduatedPool, loadMarket, lockedLiquidityShareBps } from '../shared/src/meteora.js';
import { allowedConfigsOf, assertNetwork, connect, fail, heading, line, loadEnv, publicKeyArg } from './lib.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const mint = publicKeyArg(process.argv[2], 'A mint address');
  const connection = connect(env);
  await assertNetwork(connection, env);
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const market = await loadMarket(dbc, new PublicKey(mint), await allowedConfigsOf(connection, env));
  const unit = market.pair.symbol;

  heading(`${mint.toBase58()} — ${unit} pair, ${market.tier.label} tier`);
  line('curve config', market.configAddress.toBase58());
  line('stage', market.stage);
  if (market.stage !== 'graduated') {
    console.log('\n  This token has not graduated yet. Its config already fixes the graduated pool fee;\n  run this again once the curve completes to check the live pool.\n');
    return;
  }
  const pool = await loadGraduatedPool(connection, market);
  const terms = graduatedFeeTerms(pool.state);
  line('DAMM v2 pool', pool.address.toBase58());
  line('base fee mode', terms.baseFeeMode);
  line('pool fee', `${terms.feeBps} bps`);
  line('fee schedule periods', terms.schedulerPeriods);
  line('fee reduction factor', terms.reductionFactor);
  line('dynamic fee', terms.dynamicFeeInitialized ? 'ENABLED' : 'disabled');
  assertGraduatedFee(terms, market.tier);

  const liquidity = BigInt(pool.state.liquidity.toString());
  const locked = BigInt(pool.state.permanentLockLiquidity.toString());
  const lockedPct = liquidity > 0n ? Number((locked * 10_000n) / liquidity) / 100 : 0;
  line('fee collected in', Number(pool.state.collectFeeMode) === 1 ? `${unit} only` : `mode ${String(pool.state.collectFeeMode)}`);
  line('Meteora protocol share of fees', `${String(pool.state.poolFees.protocolFeePercent)}%`);
  line('liquidity permanently locked', `${lockedPct}%`);
  if (lockedPct < 99.99) {
    console.log('\n  Note: less than all of the liquidity is permanently locked. Someone has added unlocked liquidity,\n  or the tier config does not lock 100%. The fee is still fixed.');
  }
  // Who holds the locked liquidity. The configs give all of it to the platform and none to the creator.
  let ownershipProblem = false;
  if (env.partnerWallet) {
    const partner = new PublicKey(env.partnerWallet);
    const platformBps = await lockedLiquidityShareBps(connection, pool, partner);
    line("locked liquidity held by the platform", `${platformBps / 100}%  (${partner.toBase58()})`);
    if (!market.creator.equals(partner)) {
      const creatorBps = await lockedLiquidityShareBps(connection, pool, market.creator);
      line('locked liquidity held by the creator', `${creatorBps / 100}%  (${market.creator.toBase58()})`);
      if (creatorBps > 0) ownershipProblem = true;
    }
    if (platformBps < 9_900) ownershipProblem = true;
  } else {
    console.log('\n  PARTNER_WALLET is not set, so who holds the locked liquidity was not checked.');
  }
  console.log(`\n✓ The graduated pool charges ${market.tier.feeBps} bps, the same as the curve: no schedule, no dynamic fee.`);
  if (ownershipProblem) {
    console.log('✗ The locked liquidity is not held by the platform alone. This pool does not match the tier configs this project creates.\n');
    process.exit(1);
  }
  if (env.partnerWallet) console.log('✓ The locked liquidity is held by the platform, and none of it by the creator.\n');
  else console.log('');
}

main().catch(fail);
