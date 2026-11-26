/**
 * Fee modules, operator commands.
 *
 *   npm run modules:new       make a new seed and show it once, with the gas tank address that belongs to it
 *   npm run modules:status    what the live site's modules are doing, and how much the gas tank holds
 *
 * `new` needs no settings and touches no network. `status` asks the live site
 * (PUBLIC_ORIGIN): the seed is on the server only and is never needed on this
 * computer.
 */

import { formatUnits } from '../shared/src/units.js';
import { type ModulesPublic, gasTankOf, moduleSeedBytes, newModuleSeed } from '../server/src/modules.js';
import { fail, heading, line, loadEnv, parseArgs } from './lib.js';

const ago = (time: number): string => {
  if (!time) return 'never';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 120) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
};

async function main(): Promise<void> {
  const { command } = parseArgs(process.argv.slice(2));

  if (command === 'new') {
    // Nothing is written anywhere: a secret in a file in this folder is a secret that ends up in a repository.
    const seed = newModuleSeed();
    const gasTank = gasTankOf(moduleSeedBytes(seed)).publicKey.toBase58();
    console.log('\nA new seed for the fee modules. Nothing was saved, so copy both lines now.\n');
    console.log('  The seed (SECRET). Every module wallet follows from it:\n');
    console.log(`MODULES_SEED=${seed}\n`);
    console.log('  The gas tank (public). It pays the modules\' network fees; send it SOL:\n');
    console.log(`MODULES_GAS_TANK=${gasTank}\n`);
    console.log('What to do with them:');
    console.log('  1. Put BOTH lines in your server\'s environment (the hosting platform\'s settings). Not in a file');
    console.log('     in this folder, not in a chat, not in an email.');
    console.log('  2. Keep a second copy of the seed somewhere safe and offline, such as a password manager.');
    console.log('     LOSING THE SEED IS PERMANENT: the creator fees of every token that has switched modules on');
    console.log('     can only ever be reached with this exact seed. A new seed does not replace it.');
    console.log('  3. Never change the seed once any token has modules. The server refuses to start modules when');
    console.log('     the seed does not match MODULES_GAS_TANK, which is what that second line is for.');
    console.log('  4. Send the gas tank about 0.1 SOL, then follow Part J of docs/MAINNET_RUNBOOK.md.\n');
    console.log('Then clear this screen.\n');
    if (process.env.MODULES_SEED) console.log('Note: MODULES_SEED is already set in this shell. The seed above is a different, new one. Do not replace a seed that is in use.\n');
    return;
  }

  if (command === 'status') {
    const env = loadEnv();
    if (!env.publicOrigin) throw new Error('Set PUBLIC_ORIGIN in this .env to the address of the live site (for example https://privacycash.fun). This command asks the site itself.');
    const response = await fetch(`${env.publicOrigin}/api/modules`, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${env.publicOrigin}/api/modules answered ${response.status}. Is the site running a version that has fee modules?`);
    const body = (await response.json()) as ModulesPublic;
    heading(`Fee modules on ${env.publicOrigin}`);
    if (!body.enabled) {
      console.log('  Off. Part J of docs/MAINNET_RUNBOOK.md says how to switch them on.\n');
      return;
    }
    line('mode', body.dryRun ? 'DRY RUN: checked against the chain, nothing sent' : 'live');
    line('a pass every', `${body.everyMinutes} minutes`);
    line('gas tank', body.gasTank.address);
    const lamports = body.gasTank.lamports === null ? null : BigInt(body.gasTank.lamports);
    line('gas tank balance', lamports === null ? 'could not be read' : `${formatUnits(lamports, 9)} SOL${lamports < 20_000_000n ? '   ! LOW: send it SOL' : ''}`);
    line('tokens with modules', body.modules.length);
    for (const row of body.modules) {
      heading(`${row.symbol ? `$${row.symbol}` : row.mint}${row.stalled ? '   ! the last pass did not finish' : ''}`);
      line('mint', row.mint);
      line('settings', row.settings);
      line('switched on by', row.dev);
      line('fee wallet (creator role)', row.wallet);
      if (row.pot) line('buyback pot', row.pot);
      // Totals are in each token's own pair token, in its base units: they are not added across tokens.
      line('paid to wallets (base units)', row.paid);
      line('spent on buybacks (base units)', row.spent);
      line('tokens burned (base units)', row.burned);
      line('last looked at', ago(row.lastPassAt));
    }
    if (body.modules.some((row) => row.stalled)) {
      console.log('\n  ! For a token marked above, the reason is in the server\'s log: look for lines that start with "modules:".');
      console.log('    Nothing is lost while a pass does not finish. Fees stay where they are and the next pass tries again.');
    }
    console.log('');
    return;
  }

  console.log('Usage: tsx ops/modules.ts <new|status>');
  process.exit(command ? 1 : 0);
}

main().catch(fail);
