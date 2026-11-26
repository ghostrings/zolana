/**
 * The doctor's check of converting through Jupiter.
 *
 * It asks Jupiter, with the operator's key, for the same conversions the site
 * would ask for: between SOL and USDC, and between each of those and every
 * pair token in use. Each answer is read with the very check the pages run
 * before a wallet signs (`readBuild`). Nothing is signed or sent here, and the
 * wallet named in the requests needs no funds.
 *
 * Where the site also buys tokens that were not launched here, it asks for
 * three more: one well-known SPL Token mint bought and sold back, and one
 * Token-2022 mint bought, because Jupiter builds those differently and the
 * pages must read both.
 *
 * This is where a change on Jupiter's side shows up first: an instruction the
 * site does not know how to read is refused, and the line says which.
 */

import { Keypair } from '@solana/web3.js';

import { SOL_DECIMALS, TOKEN_2022_PROGRAM_ID, WSOL_MINT } from '../shared/src/constants.js';
import {
  type BuildRequest,
  CONVERSION_ACCOUNTS,
  ConvertError,
  JUPITER_BUILD_URL,
  JUPITER_PROGRAM_ID,
  OUTSIDE_ACCOUNTS,
  buildQuery,
  readBuild,
} from '../shared/src/jupiter.js';
import { formatUnits } from '../shared/src/units.js';
import { CONVERT_ASSETS } from '../server/src/convert.js';
import type { AppEnv } from '../server/src/env.js';

interface Report {
  ok(message: string): void;
  bad(message: string): void;
  warn(message: string): void;
}

interface Asset {
  readonly symbol: string;
  readonly mint: string;
  readonly decimals: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** BONK: an SPL Token mint that has traded on Solana for years. It stands for "a token that was not launched here". */
const BONK: Asset = Object.freeze({ symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 });
/**
 * PayPal USD: a Token-2022 mint. The site itself does not buy it, because of
 * the features its mint carries; it is asked for here only because its answer
 * shows how Jupiter builds a swap for a Token-2022 token.
 */
const PYUSD: Asset = Object.freeze({ symbol: 'PYUSD', mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', decimals: 6 });

/** Asks Jupiter for one conversion. Returns the answer's JSON, or a sentence saying why there is none. */
async function ask(apiKey: string, request: BuildRequest): Promise<{ body: unknown } | { problem: string }> {
  let response: Response;
  try {
    response = await fetch(`${JUPITER_BUILD_URL}?${buildQuery(request).toString()}`, {
      headers: { accept: 'application/json', 'x-api-key': apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { problem: `Jupiter did not answer (${error instanceof Error ? error.message : String(error)})` };
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) return { problem: `Jupiter refused the key (HTTP ${response.status}). Check JUPITER_API_KEY` };
  if (response.status === 429) return { problem: 'Jupiter is rate limiting this key right now. Run the doctor again in a minute' };
  if (!response.ok) {
    let reason = '';
    try {
      const parsed = (JSON.parse(text) as { error?: unknown }).error;
      reason = typeof parsed === 'string' ? parsed.replace(/[^\x20-\x7e]/g, ' ').slice(0, 120) : '';
    } catch {
      reason = '';
    }
    return { problem: `HTTP ${response.status}${reason ? `: ${reason}` : ''}` };
  }
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { problem: 'Jupiter answered with something that is not JSON' };
  }
}

/**
 * Checks every conversion the site could be asked for. `pairs` are the pair
 * tokens in use other than SOL and USDC.
 */
export async function checkConversions(env: AppEnv, pairs: readonly Asset[], report: Report): Promise<void> {
  const apiKey = env.jupiterApiKey;
  if (!apiKey) {
    report.ok('off (JUPITER_API_KEY is not set). A token is paid for in its own pair token only; the pages link to Jupiter for the rest.');
    return;
  }
  const sol = CONVERT_ASSETS.find((asset) => asset.id === 'SOL');
  const usdc = CONVERT_ASSETS.find((asset) => asset.id === 'USDC');
  if (!sol || !usdc) throw new Error('The conversion assets are not SOL and USDC.');
  // A wallet for the requests to name. It signs nothing and needs nothing in it.
  const taker = env.partnerWallet ?? Keypair.generate().publicKey.toBase58();
  const gap = Math.ceil(1000 / env.jupiterRps) + 150;
  console.log(`    key set; requests are spaced for ${env.jupiterRps} a second (JUPITER_RPS). Each line below is one request, read the way the pages read it.`);

  let first = true;
  /** One conversion. Returns what it would pay out at least, to size the conversion back. `more` is what a request for a token that was not launched here adds. */
  const check = async (from: Asset, to: Asset, amount: bigint, more: Partial<BuildRequest> = {}): Promise<bigint | null> => {
    if (!first) await sleep(gap);
    first = false;
    const label = `${formatUnits(amount, from.decimals, 6)} ${from.symbol} → ${to.symbol}`;
    const request: BuildRequest = { inputMint: from.mint, outputMint: to.mint, amount, taker, slippageBps: 50, maxAccounts: CONVERSION_ACCOUNTS.fromPrivate, ...more };
    const answer = await ask(apiKey, request);
    if ('problem' in answer) {
      // No route is a fact about the market, not about this setup.
      (/No routes? found|HTTP 400/i.test(answer.problem) ? report.warn : report.bad)(`${label}: ${answer.problem}.`);
      return null;
    }
    try {
      const swap = readBuild(answer.body, request);
      const jupiter = swap.instructions.find((instruction) => instruction.programAddress === JUPITER_PROGRAM_ID);
      const named = new Set((jupiter?.accounts ?? []).map((account) => account.address)).size;
      report.ok(`${label}: about ${formatUnits(swap.expectedOut, to.decimals, 6)} ${to.symbol}, at least ${formatUnits(swap.minimumOut, to.decimals, 6)}; via ${swap.route.join(' → ') || 'Jupiter'}; ${swap.instructions.length} instructions, the swap names ${named} accounts`);
      return swap.minimumOut;
    } catch (error) {
      if (error instanceof ConvertError) report.bad(`${label}: the site would refuse this answer. ${error.message}`);
      else report.bad(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const someSol = 50_000_000n; // 0.05 SOL
  const someUsdc = 10_000_000n; // 10 USDC
  if (sol.decimals !== SOL_DECIMALS || sol.mint !== WSOL_MINT) throw new Error('The conversion assets are not SOL and USDC.');
  // (USDC's decimals are pinned in the pair list and re-read from its mint above, under "Pair tokens".)
  await check(sol, usdc, someSol);
  await check(usdc, sol, someUsdc);
  for (const pair of pairs) {
    const got = await check(sol, pair, someSol);
    await check(usdc, pair, someUsdc);
    // The way back, for the amount the way in would have bought.
    if (got !== null && got > 0n) {
      await check(pair, sol, got);
      await check(pair, usdc, got);
    }
  }

  if (!env.swapAnyToken) {
    console.log('    swap: off (SWAP_ANY_TOKEN=NO). Tokens that were not launched here are not traded, so nothing more is asked.');
    return;
  }
  console.log('    swap: on. Three more requests, for tokens that were not launched here: an SPL Token mint bought and sold back, and a Token-2022 mint bought.');
  const outside = { maxAccounts: OUTSIDE_ACCOUNTS.fromPrivate, slippageBps: 100 };
  const bought = await check(sol, BONK, someSol, outside);
  if (bought !== null && bought > 0n) await check(BONK, sol, bought, outside);
  // The page reads a mint's token program from chain and holds Jupiter's answer to it. Here the program is known.
  await check(sol, PYUSD, someSol, { ...outside, outputProgram: TOKEN_2022_PROGRAM_ID });
}
