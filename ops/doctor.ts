/**
 * `npm run doctor` — checks, against Solana mainnet, everything this project
 * assumes about the chain. Run it before the first launch and after any change
 * to the environment. It only reads: it sends no transaction and spends no SOL
 * (a few Helius credits for the reads).
 */

import bs58 from 'bs58';
import { address } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

import {
  DAMM_V2_PROGRAM_ID,
  DBC_PROGRAM_ID,
  KEEPER_MIN_THRESHOLD_LAMPORTS,
  SPP_DEFAULT_TREE,
  SPP_PROGRAM_ID,
  USER_REGISTRY_PROGRAM_ID,
} from '../shared/src/constants.js';
import { type OnChainConfigLike, assertFeeGuarantee, buildTierConfig, configMismatches, feeTermsFromAccount } from '../shared/src/curve.js';
import { RING_CONFIG_SCAN, readRingRegistration, ringStateOf } from '../shared/src/custom-rings.js';
import { createRingsClient, isRegistered, readProtocolFacts } from '../shared/src/privacy.js';
import { PAIR_TOKENS, configEnvKey, curveEnvKeys, keeperRule, pairSymbol, tradingPair } from '../shared/src/quotes.js';
import { FEE_TIERS } from '../shared/src/tiers.js';
import { CONVERT_ASSETS } from '../server/src/convert.js';
import { PUBLIC_PINATA_GATEWAY, requireRpc } from '../server/src/env.js';
import { resolvePairs } from '../server/src/pairs.js';
import { clampPriority, estimatePriority } from '../server/src/priority.js';
import { checkConversions } from './convert.js';
import { assertNetwork, connect, fail, heading, loadEnv, readKeptConfigs } from './lib.js';
import { equivalentCurve } from './pairs.js';

let failures = 0;
let warnings = 0;
const ok = (message: string) => console.log(`  ✓ ${message}`);
const bad = (message: string) => {
  failures += 1;
  console.log(`  ✗ ${message}`);
};
const warn = (message: string) => {
  warnings += 1;
  console.log(`  ! ${message}`);
};

async function main(): Promise<void> {
  const env = loadEnv();
  const { rpcUrl, sprUrl } = requireRpc(env);
  const connection = connect(env);

  heading('Network: Solana mainnet');
  await assertNetwork(connection, env);
  ok('the RPC is Solana mainnet-beta (genesis hash matches)');
  const estimate = await estimatePriority(rpcUrl);
  const price = clampPriority(estimate, env.priorityMinMicroLamports, env.priorityMaxMicroLamports);
  if (estimate === undefined) {
    warn(`the RPC gave no priority fee estimate; transactions will pay the floor, ${env.priorityMinMicroLamports} micro-lamports per compute unit. Raise PRIORITY_FEE_MIN_MICROLAMPORTS if they are slow to land.`);
  } else {
    ok(`live priority fee estimate: ${Math.round(estimate)} micro-lamports per compute unit; transactions will pay ${price} (a shielded trade: about ${((price * 900_000) / 1e15).toFixed(6)} SOL)`);
  }

  heading('Programs');
  for (const [label, id] of [
    ['Solana Privacy Program', SPP_PROGRAM_ID],
    ['Rings user registry', USER_REGISTRY_PROGRAM_ID],
    ['Meteora DBC', DBC_PROGRAM_ID],
    ['Meteora DAMM v2', DAMM_V2_PROGRAM_ID],
  ] as const) {
    const account = await connection.getAccountInfo(new PublicKey(id));
    if (account?.executable) ok(`${label} is deployed (${id})`);
    else bad(`${label} is not an executable program at ${id}`);
  }

  heading('Solana Privacy Rings');
  const client = await createRingsClient({ rpcUrl, sprUrl });
  if (client.tree === SPP_DEFAULT_TREE) ok(`the SDK targets the documented state tree (${client.tree})`);
  else bad(`the SDK targets tree ${client.tree}, not the documented ${SPP_DEFAULT_TREE}`);
  const tree = await connection.getAccountInfo(new PublicKey(client.tree));
  if (tree) ok('the state tree account exists');
  else bad('the state tree account was not found');
  /** How a new custom ring starts out on mainnet. Null when the protocol's settings could not be read. */
  let ringActivationOpen: boolean | null = null;
  try {
    const facts = await readProtocolFacts(client);
    ringActivationOpen = facts.ringActivationIsPermissionless;
    if (facts.splInterfaceCreationIsPermissionless) {
      ok('anyone may create a Rings interface for a new mint, so launched tokens can be held privately');
    } else {
      bad('Rings interface creation is restricted on mainnet right now: a newly launched token could NOT be held privately. Launching is blocked until this changes.');
    }
    console.log(`    protocol authority: ${facts.protocolAuthority}`);
    if (facts.treeFeeFieldLamports !== null) {
      console.log(`    tree fee field (as SDK 0.9.0-alpha decodes it): ${facts.treeFeeFieldLamports} lamports`);
    }
  } catch (error) {
    bad(`could not read the Rings protocol config: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const slot = await client.getSlot();
    ok(`Rings client reaches the RPC (slot ${slot})`);
  } catch (error) {
    bad(`Rings client could not reach the RPC: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const probe = client as unknown as { attestProver?: () => Promise<unknown> };
    if (typeof probe.attestProver === 'function') {
      await probe.attestProver();
      ok('the prover attests against the signed policy for mainnet');
    } else {
      warn('this SDK build has no attestProver(); the first proof request will attest instead');
    }
  } catch (error) {
    bad(`prover attestation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Custom rings: what the chain says today. Nothing here is a requirement of this site, so nothing
  // here can fail the doctor: it only tells you when rings other than the Default Ring exist on mainnet.
  heading('Custom rings on mainnet (read-only, for your information)');
  console.log(
    ringActivationOpen === null
      ? '    how new rings are activated: could not be read'
      : ringActivationOpen
        ? '    a new ring is ACTIVE from the moment it registers (activation is open to anyone)'
        : '    a new ring does nothing until Rings governance activates it (activation is not open)',
  );
  try {
    const found = await connection.getProgramAccounts(new PublicKey(SPP_PROGRAM_ID), {
      commitment: 'confirmed',
      filters: [{ dataSize: RING_CONFIG_SCAN.dataSize }, { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.of(RING_CONFIG_SCAN.type)) } }],
    });
    let listed = 0;
    for (const { pubkey, account } of found) {
      const ring = await readRingRegistration(pubkey.toBase58(), new Uint8Array(account.data));
      if (!ring) continue;
      listed += 1;
      const state = ringStateOf(ring);
      console.log(`    ring ${ring.program}: ${state === 'active' ? 'active' : state === 'paused' ? 'paused by its operator' : 'registered, not activated'}`);
    }
    if (listed === 0) console.log('    no custom ring is registered on mainnet yet');
    if (found.length > listed) console.log(`    ${found.length - listed} account(s) look like a registration and do not check out as one; they are not counted`);
  } catch (error) {
    console.log(`    the register of custom rings could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  heading('Fee tiers (SOL pair)');
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  for (const tier of FEE_TIERS) {
    const configAddress = env.configs[tier.feeBps];
    if (!configAddress) {
      warn(`${tier.label}: ${tier.envKey} is not set (run configs:plan, then configs:apply)`);
      continue;
    }
    const account = await dbc.state.getPoolConfig(new PublicKey(configAddress));
    if (!account) {
      bad(`${tier.label}: no config account at ${configAddress}`);
      continue;
    }
    try {
      assertFeeGuarantee(feeTermsFromAccount(account as unknown as OnChainConfigLike), tier);
      ok(`${tier.label}: ${configAddress} charges ${tier.feeBps} bps before and after graduation`);
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
    if (env.partnerWallet && account.feeClaimer.toBase58() !== env.partnerWallet) {
      bad(`${tier.label}: fee claimer is ${account.feeClaimer.toBase58()}, not PARTNER_WALLET`);
    }
    // The server prices a launch's first buy from its own settings, so they must be this config's.
    const mismatches = configMismatches(
      tier,
      buildTierConfig(tier, env.economics),
      account as unknown as Record<string, unknown>,
      env.partnerWallet ? new PublicKey(env.partnerWallet) : undefined,
    );
    if (mismatches.length > 0) {
      bad(`${tier.label}: this environment's launch settings are not the ones ${configAddress} was created with. Launches on it will be refused.\n      ${mismatches.slice(0, 6).join('\n      ')}`);
    }
    const threshold = BigInt(account.migrationQuoteThreshold.toString());
    if (threshold >= KEEPER_MIN_THRESHOLD_LAMPORTS) {
      ok(`${tier.label}: curves raise ${Number(threshold) / 1e9} SOL, above the 10 SOL at which Meteora's keeper graduates them automatically`);
    } else {
      warn(`${tier.label}: curves raise only ${Number(threshold) / 1e9} SOL. Meteora's keeper graduates curves of 10 SOL or more, so these must be graduated by hand: \`npm run migrate <mint> yes\`. Fine for a first-run set, not for production.`);
    }
  }

  // Every pair token this build knows: what its mint really is, whether Rings can hold it, and where its setup stands.
  heading('Pair tokens');
  const short = (value: string): string => `${value.slice(0, 4)}…${value.slice(-4)}`;
  const priceOf = async (mint: string): Promise<number | undefined> => {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'price', method: 'getAsset', params: { id: mint } }),
        signal: AbortSignal.timeout(8_000),
      });
      const body = (await response.json()) as { result?: { token_info?: { price_info?: { price_per_token?: unknown } } } };
      const price = body.result?.token_info?.price_info?.price_per_token;
      return typeof price === 'number' && price > 0 ? price : undefined;
    } catch {
      return undefined;
    }
  };
  let interfacesOpen: boolean | undefined;
  try {
    interfacesOpen = (await readProtocolFacts(client)).splInterfaceCreationIsPermissionless;
  } catch {
    interfacesOpen = undefined;
  }
  const partner = env.partnerWallet ? new PublicKey(env.partnerWallet) : undefined;
  const solPrice = await priceOf(PAIR_TOKENS[0]?.mint ?? '');
  console.log(solPrice ? `    SOL price from the RPC: $${solPrice.toFixed(2)}. Your SOL curve: ${env.economics.initialMarketCapSol} → ${env.economics.migrationMarketCapSol} SOL of market cap.` : '    The RPC gave no SOL price, so no curve sizes are suggested below.');
  let resolved: Awaited<ReturnType<typeof resolvePairs>> = [];
  try {
    resolved = await resolvePairs(connection, env.pairs);
  } catch (error) {
    bad(`the pair tokens could not be read from chain: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const result of resolved) {
    const { token } = result.env;
    const ticker = pairSymbol(token);
    if (token.native) {
      ok(`${ticker}: native SOL. Rings holds it without an interface. Always in use.`);
      continue;
    }
    const keys = curveEnvKeys(token.id);
    const size = result.env.size;
    const inUse = size !== undefined;
    const facts = result.facts;
    if (!facts) {
      (inUse ? bad : warn)(`${ticker} (${short(token.mint)}): ${result.problems.join(' ')}`);
      continue;
    }
    const label = `${ticker} (${short(token.mint)}): ${facts.program === 'spl-token' ? 'SPL Token' : 'Token-2022'} mint, ${facts.decimals} decimals`;
    // What stops the token being used at all, apart from a Rings interface that `configs:apply` can create.
    const blocking = result.problems.filter((problem) => !/Rings has no interface/.test(problem));
    if (blocking.length > 0) (inUse ? bad : warn)(`${label}. It cannot be a pair here: ${blocking.join(' ')}`);
    else ok(`${label}. It can be a pair here.`);
    console.log(`      ${token.name}. ${token.note}`);
    if (facts.extensions.length > 0) console.log(`      extensions: ${facts.extensions.join(', ')}`);
    console.log(`      can mint more: ${facts.mintAuthority ? short(facts.mintAuthority) : 'nobody'}   can freeze holders: ${facts.freezeAuthority ? `${short(facts.freezeAuthority)} (any account that holds it, a pool's and a Rings vault's included)` : 'nobody'}`);
    if (result.hasInterface) console.log('      Rings: an interface exists, so it can be held privately');
    else if (interfacesOpen) console.log('      Rings: no interface yet. Anyone may create one, at the cost of its rent; `npm run configs:apply` does it before creating this pair\'s configs');
    else console.log(`      Rings: no interface, and ${interfacesOpen === false ? 'creating one is restricted' : 'whether one can be created could not be read'}. It could not be held privately`);
    if (blocking.length > 0) continue;

    if (!inUse) {
      const price = await priceOf(token.mint);
      if (price && solPrice) {
        const same = equivalentCurve(env.economics, solPrice, price);
        console.log(`      not in use. Price $${price < 1 ? price.toPrecision(3) : price.toFixed(2)}: a curve worth what your SOL one is would be ${same.initialMarketCap} → ${same.migrationMarketCap} ${ticker} of market cap (about $${Math.round(same.initialUsd)} → $${Math.round(same.migrationUsd)}).`);
        console.log(`      To switch it on, choose the two sizes (they are permanent), set ${keys.initial}=${same.initialMarketCap} and ${keys.migration}=${same.migrationMarketCap},`);
        console.log(`      then run \`npm run configs:plan ${token.id}\` and \`npm run configs:apply yes mainnet ${token.id}\`.`);
      } else {
        console.log(`      not in use. The RPC gave no price, so no size is suggested. To switch it on, set ${keys.initial} and ${keys.migration} in whole ${ticker}.`);
      }
      continue;
    }

    // In use: its configs must be the ones this environment would create, as for SOL above.
    let pair;
    try {
      pair = tradingPair(token, facts.decimals);
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
      continue;
    }
    console.log(`      in use: curves of ${size.initialMarketCap} → ${size.migrationMarketCap} ${ticker} of market cap`);
    if (!result.hasInterface) bad(`${ticker}: the site keeps this pair off until Rings has an interface for it. Run \`npm run configs:apply yes mainnet ${token.id}\`.`);
    for (const tier of FEE_TIERS) {
      const envKey = configEnvKey(tier, token.id);
      const configAddress = result.env.configs[tier.feeBps];
      if (!configAddress) {
        warn(`${ticker} ${tier.label}: ${envKey} is not set (run \`npm run configs:apply yes mainnet ${token.id}\`)`);
        continue;
      }
      const account = await dbc.state.getPoolConfig(new PublicKey(configAddress));
      if (!account) {
        bad(`${ticker} ${tier.label}: no config account at ${configAddress}`);
        continue;
      }
      let mismatches: string[];
      try {
        mismatches = configMismatches(tier, buildTierConfig(tier, env.economics, { pair, size }), account as unknown as Record<string, unknown>, partner, pair.mint);
      } catch (error) {
        mismatches = [error instanceof Error ? error.message : String(error)];
      }
      if (mismatches.length > 0) {
        bad(`${ticker} ${tier.label}: ${configAddress} is not the config this environment would create. Launches on it will be refused.\n      ${mismatches.slice(0, 6).join('\n      ')}`);
        continue;
      }
      ok(`${ticker} ${tier.label}: ${configAddress} is priced in ${ticker} and charges ${tier.feeBps} bps before and after graduation`);
      if (tier === FEE_TIERS[0]) console.log(`      graduation: ${keeperRule(pair, BigInt(account.migrationQuoteThreshold.toString())).note}`);
    }
  }
  console.log("    Meteora's keeper graduates SOL curves of 10 SOL, USDC curves of 750 USDC, and other pairs only when the pair token");
  console.log('    is Jupiter-verified with an organic score above 50 and the curve raises over $750. Anything else waits for somebody');
  console.log("    to send the graduation: anyone can, from the token's page on the site, or the operator with `npm run migrate`.");

  // Paying with SOL or USDC for a token priced in something else: asked of Jupiter here exactly as the site would ask.
  heading('Converting (Jupiter)');
  const base = new Set(CONVERT_ASSETS.map((asset) => asset.mint));
  await checkConversions(
    env,
    resolved
      .filter((result) => result.env.size !== undefined && result.pair !== undefined && !base.has(result.env.token.mint))
      .map((result) => ({ symbol: pairSymbol(result.env.token), mint: result.env.token.mint, decimals: (result.pair as { decimals: number }).decimals })),
    { ok, bad, warn },
  );

  // Configs kept from an earlier set (a changed fee split, a resized curve): their tokens must stay listed.
  heading('Configs kept from earlier sets');
  if (env.previousConfigs.length === 0) {
    ok('none (DBC_CONFIGS_PREVIOUS is not set). Every listed token is on a config new launches use too.');
  } else {
    try {
      const { kept, refused } = await readKeptConfigs(connection, env, resolved.flatMap((result) => (result.pair ? [result.pair] : [])));
      for (const config of kept) {
        ok(`${config.address}: ${config.pair.symbol} ${config.feeBps / 100}%, creator share ${config.creatorFeeSharePct}% of each curve fee after Meteora's cut. Its tokens stay listed; nothing new launches on it.`);
      }
      for (const { address: kept, why } of refused) bad(`${kept}: ${why}. Tokens launched on it are NOT listed.`);
    } catch (error) {
      bad(`the kept configs could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!env.creatorPoolPayoutExplicit && env.creatorPoolPayoutPct !== 30) {
    warn(
      `CREATOR_POOL_PAYOUT_PCT is not set, so it follows CREATOR_FEE_SHARE_PCT: creators are paid ${env.creatorPoolPayoutPct}% of the pool fees after graduation. Set it yourself if that is not what you mean.`,
    );
  } else {
    ok(`after graduation creators are paid ${env.creatorPoolPayoutPct}% of the pool fees the platform claims (CREATOR_POOL_PAYOUT_PCT)`);
  }

  heading('Fee modules');
  if (!env.modules.enabled) {
    ok('off (MODULES_ENABLED is not YES). Creators claim their fees by hand.');
  } else {
    const { gasTankOf, moduleSeedBytes, GAS_FLOOR_LAMPORTS } = await import('../server/src/modules.js');
    try {
      const derived = gasTankOf(moduleSeedBytes(env.modules.seed ?? '')).publicKey.toBase58();
      if (derived !== env.modules.gasTank) {
        bad('MODULES_SEED is not the seed MODULES_GAS_TANK belongs to. The server will refuse to start. Put the original seed back; never run with a different one.');
      } else {
        ok(`the seed matches the gas tank ${derived}`);
        const lamports = BigInt(await connection.getBalance(new PublicKey(derived)));
        if (lamports >= 20_000_000n) ok(`gas tank: ${Number(lamports) / 1e9} SOL`);
        else if (lamports > GAS_FLOOR_LAMPORTS) warn(`the gas tank holds only ${Number(lamports) / 1e9} SOL. Top it up: it pays every module transaction's fee and the rent of token accounts.`);
        else bad(`the gas tank ${derived} holds ${Number(lamports) / 1e9} SOL, too little to send anything. Send it SOL.`);
      }
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
    if (env.modules.dryRun) warn('MODULES_DRY_RUN is YES: passes are worked out and checked against the chain, and nothing is sent.');
    else warn('fee modules are enabled: this server claims and pays out creator fees from wallets it holds the keys to');
    console.log(`    A pass every ${env.modules.everyMinutes} minutes. It acts on ${Number(env.modules.minLamports) / 1e9} SOL or more; one buyback spends at most ${Number(env.modules.maxBuyLamports) / 1e9} SOL.`);
  }

  heading('Ghost desk');
  if (!env.desk.enabled) {
    ok('off (GHOST_DESK_ENABLED is not YES). Trades use the Shielded route only.');
  } else {
    const { Desk } = await import('../server/src/desk.js');
    const { ctx } = await Desk.context(env);
    console.log(`    desk wallet: ${ctx.owner}`);
    if (await isRegistered(client, address(ctx.owner))) ok('the desk wallet is registered with Rings');
    else bad('the desk wallet is not registered. Run `npm run desk:register`.');
    const lamports = await connection.getBalance(new PublicKey(ctx.owner));
    if (lamports >= 50_000_000) ok(`public SOL for fees: ${lamports / 1e9}`);
    else warn(`the desk has only ${lamports / 1e9} public SOL for fees`);
    warn('the desk is enabled: it trades real funds from a hot wallet');
    if (env.desk.stockMints.length === 0) console.log('    DESK_STOCK_MINTS is empty: the desk can fill a buy only out of what sellers have just delivered.');
    console.log(
      env.desk.blockedWallets.size === 0
        ? '    DESK_BLOCKED_WALLETS is empty: the desk trades with any registered wallet.'
        : `    DESK_BLOCKED_WALLETS in this environment: ${env.desk.blockedWallets.size} wallet(s) the desk does not trade with. The server uses the list in ITS environment, not this one.`,
    );
  }

  heading('Deployment');
  if (!env.publicOrigin) {
    bad('PUBLIC_ORIGIN is not set. It is required: it is written into every token\'s metadata address, and the server will not start without it.');
  } else if (env.localOrigin && !env.pinataJwt) {
    bad(`PUBLIC_ORIGIN is ${env.publicOrigin}, this machine itself, and PINATA_JWT is not set. A token launched now would carry a metadata address nobody else can reach, permanently. The server refuses launches in this setup: set PINATA_JWT, or run on your real https origin.`);
  } else if (env.localOrigin) {
    ok(`PUBLIC_ORIGIN is ${env.publicOrigin} (this machine); metadata is pinned to IPFS, so launched tokens do not depend on it`);
  } else {
    ok(`PUBLIC_ORIGIN is ${env.publicOrigin}; token metadata addresses are built from it`);
  }
  if (env.pinataJwt) {
    ok('artwork and metadata are pinned to IPFS (PINATA_JWT is set)');
    // The gateway in a token's metadata is permanent, so say which one new tokens will carry.
    if (env.allowedOrigins.some((origin) => env.pinataGateway === `${origin}/ipfs`)) {
      ok(`new tokens' logos are addressed at ${env.pinataGateway}: this site, answered from the server's disk`);
    } else if (env.pinataGateway === PUBLIC_PINATA_GATEWAY) {
      warn(`new tokens' logos are addressed at ${env.pinataGateway}, Pinata's shared public gateway, which Pinata throttles. Wallets and explorers load logos from that address, and it cannot be changed after launch. See PINATA_GATEWAY_URL in .env.example. This site's own pages are not affected: they show the server's copies.`);
    } else {
      ok(`new tokens' logos are addressed at ${env.pinataGateway}`);
    }
  }
  else warn('artwork and metadata are served from this server\'s disk; if DATA_DIR is lost, token images are lost with it. Pinning is recommended.');

  console.log(`\n${failures === 0 ? '✓ No blocking problems.' : `✗ ${failures} blocking problem(s).`}${warnings ? ` ${warnings} warning(s).` : ''}\n`);
  if (failures > 0) process.exit(1);
}

main().catch(fail);
