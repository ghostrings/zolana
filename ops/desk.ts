/**
 * Ghost desk operator commands.
 *
 *   npm run desk:new        make a new key for the desk and show it once
 *   npm run desk:address    print the desk wallet's address (fund this)
 *   npm run desk:register   one-time: register it with Rings
 *   npm run desk:status     public and private balances
 *   npm run desk:check      everything a Ghost fill needs, tried on mainnet with nothing sent
 */

import { type Address, type Instruction, address, getTransactionSize } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { transactInstruction } from '@heliuslabs/spr/interface';

import { COMPUTE_UNITS, TX_V1_MAX_BYTES } from '../shared/src/constants.js';
import { DESK_MAX_NOTES, DESK_SIGN_WINDOW_MS, mostFragmented } from '../shared/src/desk-rules.js';
import { formatUnits } from '../shared/src/units.js';
import {
  SOL_MINT,
  buildGhostLeg,
  fetchAssetId,
  isRegistered,
  latestLifetime,
  privateHoldings,
  registrationTransactions,
  simulate,
  syncRings,
} from '../shared/src/privacy.js';
import { composeV1 } from '../shared/src/tx.js';
import { DESK_LOW_GAS_LAMPORTS, Desk, deskFundingHint } from '../server/src/desk.js';
import { requireRpc } from '../server/src/env.js';
import { clampPriority, estimatePriority, fixedPriority } from '../server/src/priority.js';
import { assertNetwork, connect, explorerTx, fail, heading, line, loadEnv, newWalletKey, parseArgs } from './lib.js';

async function main(): Promise<void> {
  const { command, rest } = parseArgs(process.argv.slice(2));

  if (command === 'new') {
    // Needs no settings and touches no network. Nothing is written anywhere: a key in a file in
    // this folder is a key that ends up in a repository.
    const key = newWalletKey();
    console.log('\nA new wallet for the desk. Nothing was saved, so copy both values now.\n');
    console.log('  Address (public). The desk\'s SOL is sent here:');
    console.log(`    ${key.address}\n`);
    console.log('  DESK_SECRET_KEY (secret). Whoever has this controls everything the desk holds:');
    console.log(`    ${key.secret}\n`);
    console.log('Keep the secret in a password manager and in your server\'s environment as DESK_SECRET_KEY.');
    console.log('Do not put it in a file in this folder, and do not send it to anyone. Then clear this screen.\n');
    if (process.env.DESK_SECRET_KEY) console.log('Note: DESK_SECRET_KEY is already set in this shell. The key above is a different, new one.\n');
    return;
  }

  const env = loadEnv();

  if (command === 'address') {
    const { ctx } = await Desk.context(env);
    console.log(ctx.owner);
    return;
  }

  const connection = connect(env);
  await assertNetwork(connection, env);

  if (command === 'register') {
    // Priced from the live estimate, so the registration lands on a busy network too.
    const price = clampPriority(await estimatePriority(requireRpc(env).rpcUrl), env.priorityMinMicroLamports, env.priorityMaxMicroLamports);
    const signatures = await Desk.register(env, fixedPriority(price));
    if (signatures.length === 0) console.log('The desk wallet is already registered and merge-enabled.');
    for (const signature of signatures) console.log(`✓ ${explorerTx(signature, env)}`);
    return;
  }

  if (command === 'status') {
    const { ctx, client } = await Desk.context(env);
    heading(`Desk ${ctx.owner} (Solana mainnet)`);
    line('registered with Rings', (await isRegistered(client, address(ctx.owner))) ? 'yes' : 'NO — run desk:register');
    const publicLamports = BigInt(await connection.getBalance(new PublicKey(ctx.owner)));
    line('public SOL', formatUnits(publicLamports, 9));
    await syncRings(ctx);
    const holdings = privateHoldings(ctx);
    if (holdings.length === 0) line('private balances', 'none');
    for (const holding of holdings) {
      const isSol = holding.mint === SOL_MINT;
      line(`private ${isSol ? 'SOL' : holding.mint}`, `${formatUnits(holding.amount, isSol ? 9 : 6)} (${holding.notes} note${holding.notes === 1 ? '' : 's'})`);
    }
    line('enabled in this environment', env.desk.enabled ? 'yes' : 'no');
    line('spread', `${env.desk.spreadBps} bps`);
    line('max order', `${formatUnits(env.desk.maxOrderLamports, 9)} SOL`);
    line('target inventory per token', `${formatUnits(env.desk.targetInventoryLamports, 9)} SOL`);
    const hint = deskFundingHint(publicLamports, holdings.find((holding) => holding.mint === SOL_MINT)?.amount ?? 0n);
    if (hint) console.log(`\n  ! ${hint}`);
    console.log('');
    return;
  }

  if (command === 'check') {
    // Looks at everything a Ghost fill depends on, on mainnet, and sends nothing. The last part
    // makes real proofs and has the chain run them without recording anything (a simulation).
    const { ctx, client } = await Desk.context(env);
    heading(`Desk check for ${ctx.owner} (Solana mainnet). Nothing is sent.`);
    let problems = 0;
    const good = (text: string): void => console.log(`  ✓ ${text}`);
    const wrong = (text: string): void => {
      problems += 1;
      console.log(`  ✗ ${text}`);
    };
    const note = (text: string): void => console.log(`  · ${text}`);
    const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

    const expected = rest[0];
    if (expected) {
      if (expected === ctx.owner) good('the key in this shell is the key of the address you gave');
      else wrong(`the DESK_SECRET_KEY in this shell belongs to ${ctx.owner}, not to ${expected}`);
    }

    const registered = await isRegistered(client, address(ctx.owner));
    if (!registered) wrong('not registered with Rings. Run `npm run desk:register`. Ghost fill is off until then.');
    else {
      good('registered with Rings');
      if ((await registrationTransactions(ctx)).length === 0) good('set up for consolidation');
      else wrong('registered, but not set up for consolidation. Run `npm run desk:register` again.');
    }

    const publicLamports = BigInt(await connection.getBalance(new PublicKey(ctx.owner)));
    if (publicLamports >= DESK_LOW_GAS_LAMPORTS) good(`${formatUnits(publicLamports, 9)} public SOL for fees`);
    else wrong(`only ${formatUnits(publicLamports, 9)} public SOL for fees. Every fill and pool trade is paid from it. Send SOL to ${ctx.owner}`);

    await syncRings(ctx);
    const holdings = privateHoldings(ctx);
    const privateSol = holdings.find((holding) => holding.mint === SOL_MINT);
    if (privateSol) good(`private SOL: ${formatUnits(privateSol.amount, 9)} in ${privateSol.notes} note${privateSol.notes === 1 ? '' : 's'}. This is what sellers are paid from.`);
    else wrong(`no private SOL, so nobody can sell to the desk. ${deskFundingHint(publicLamports, 0n) ?? 'It moves public SOL above its fee reserve into the private balance on its next pass.'}`);
    for (const holding of holdings) {
      if (holding.mint === SOL_MINT) continue;
      note(`private ${holding.mint}: ${formatUnits(holding.amount, 6)} in ${holding.notes} note${holding.notes === 1 ? '' : 's'}`);
    }
    const crowded = mostFragmented(holdings.map((holding) => ({ mint: holding.mint as string, notes: holding.notes })));
    if (crowded) {
      note(
        `${crowded.mint === SOL_MINT ? 'SOL' : crowded.mint} is split across ${crowded.notes} notes; a fill can spend five. ${
          env.desk.autoConsolidate ? 'DESK_AUTO_CONSOLIDATE is on, so the server merges them.' : `Past ${DESK_MAX_NOTES}, set DESK_AUTO_CONSOLIDATE=YES on the server, or consolidate from the wallet page.`
        }`,
      );
    }

    note(`settings in this shell: up to ${formatUnits(env.desk.maxOrderLamports, 9)} SOL a trade, spread ${env.desk.spreadBps} bps, a price is held ${env.desk.quoteTtlMs / 1000}s, then ${DESK_SIGN_WINDOW_MS / 1000}s to sign. The server's own settings are the ones that count.`);
    if (env.desk.stockMints.length === 0) {
      note('DESK_STOCK_MINTS is empty here: the desk can fill a BUY only out of what sellers have just delivered, so most buys go to the Shielded route.');
    }
    for (const mint of env.desk.stockMints) {
      const assetId = await fetchAssetId(client, address(mint)).catch(() => undefined);
      const stock = holdings.find((holding) => holding.mint === mint);
      if (assetId === undefined) wrong(`stocked token ${mint} has no Rings interface, so the desk cannot hold it`);
      else if (stock) good(`stocked token ${mint}: ${formatUnits(stock.amount, 6)} in stock, so buys of it can be filled`);
      else note(`stocked token ${mint}: nothing in stock yet. The server buys it on a pass once it has private SOL to spare.`);
    }

    // The dry run. A fill is two private transfers in one transaction. The desk makes up to two of
    // its own here, each paying itself the smallest unit out of a different note, and has the
    // chain run them. Each one costs a proof on your Helius plan, like any private transfer.
    if (!registered || holdings.length === 0) {
      note('dry run skipped: it needs a registered wallet with a private balance.');
    } else {
      const picks: Array<{ mint: Address; note: ReturnType<typeof ctx.wallet.balance>['utxos'][number] }> = [];
      const ordered = [...holdings].sort((a, b) => (a.mint === SOL_MINT ? -1 : b.mint === SOL_MINT ? 1 : 0));
      for (const holding of ordered) {
        const notes = [...ctx.wallet.balance(holding.mint).utxos].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
        for (const candidate of notes) if (picks.length < 2 && candidate.amount > 1n) picks.push({ mint: holding.mint, note: candidate });
      }
      const legs: Instruction[] = [];
      try {
        for (const pick of picks) {
          const data = await buildGhostLeg(ctx, { asset: pick.mint, amount: 1n, recipient: ctx.shielded, feePayer: ctx.owner, notes: [pick.note] });
          legs.push(await transactInstruction({ payer: ctx.owner, ownerSigners: [ctx.owner], inputTree: client.tree, outputTree: client.tree, data }));
        }
      } catch (error) {
        wrong(`dry run: a proof could not be made (${reason(error)}). The prover is what every fill needs.`);
      }
      const first = legs[0];
      if (first) {
        good(`dry run: ${legs.length} proof${legs.length === 1 ? '' : 's'} made by the prover`);
        const lifetime = await latestLifetime(client);
        const one = await simulate(client, composeV1({ feePayer: ctx.owner, lifetime, instructions: [first], computeUnitLimit: COMPUTE_UNITS.single }));
        if (one.ok) good(`dry run: one private transfer passes on chain (${one.unitsConsumed?.toString() ?? '?'} of ${COMPUTE_UNITS.single} compute units)`);
        else wrong(`dry run: one private transfer does not pass on chain: ${one.error}`);
        if (legs.length === 2) {
          const both = composeV1({ feePayer: ctx.owner, lifetime, instructions: legs, computeUnitLimit: COMPUTE_UNITS.ghostFill });
          const two = await simulate(client, both);
          if (two.ok) {
            good(`dry run: two private transfers in one transaction pass on chain (${two.unitsConsumed?.toString() ?? '?'} of ${COMPUTE_UNITS.ghostFill} compute units, ${getTransactionSize(both)} of ${TX_V1_MAX_BYTES} bytes). That is the shape of a fill.`);
          } else {
            wrong(`dry run: two private transfers in one transaction do not pass on chain: ${two.error}`);
            for (const entry of two.logs.slice(-6)) console.log(`      ${entry}`);
          }
        } else {
          note('dry run: the desk has one note, so two transfers in one transaction could not be tried. After its first restock or fill it will have two; run this again then.');
        }
      }
    }

    console.log(problems === 0 ? '\n  Nothing wrong found. What this cannot show is a fill with a second wallet: do one small buy and one small sell from the site.\n' : `\n  ${problems} thing${problems === 1 ? '' : 's'} to fix, marked ✗ above.\n`);
    process.exit(problems === 0 ? 0 : 1);
  }

  console.log('Usage: tsx ops/desk.ts <new|address|register|status|check [address]>');
  process.exit(command ? 1 : 0);
}

main().catch(fail);
