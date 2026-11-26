/**
 * Priority fees.
 *
 * On mainnet a transaction that pays nothing extra can sit unprocessed when
 * the network is busy. Every transaction this platform builds therefore
 * carries a priority fee, priced per compute unit. The price follows Helius's
 * live estimate for the two programs these transactions touch, held between a
 * floor and a ceiling the operator sets. When no estimate is available the
 * floor is used.
 */

import { DBC_PROGRAM_ID, SPP_PROGRAM_ID } from '../../shared/src/constants.js';
import type { AppEnv } from './env.js';

/**
 * Helius's estimate, in micro-lamports per compute unit, for transactions
 * that write to the bonding-curve and Rings programs. Undefined when the RPC
 * does not offer the method or does not answer.
 */
export async function estimatePriority(rpcUrl: string, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  try {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'priority',
        method: 'getPriorityFeeEstimate',
        params: [{ accountKeys: [DBC_PROGRAM_ID, SPP_PROGRAM_ID], options: { priorityLevel: 'High' } }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { result?: { priorityFeeEstimate?: unknown } };
    const value = Number(body.result?.priorityFeeEstimate);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function clampPriority(value: number | undefined, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface PriorityOracle {
  /** Micro-lamports per compute unit to pay right now. */
  current(): number;
  stop(): void;
}

/** A fixed price, for a server that has no RPC to ask. */
export function fixedPriority(microLamports: number): PriorityOracle {
  return { current: () => microLamports, stop: () => undefined };
}

export function startPriorityOracle(env: AppEnv, rpcUrl: string, log: (message: string) => void): PriorityOracle {
  const min = env.priorityMinMicroLamports;
  const max = env.priorityMaxMicroLamports;
  let value = min;
  let failures = 0;

  async function tick(): Promise<void> {
    const estimate = await estimatePriority(rpcUrl);
    if (estimate === undefined) {
      failures += 1;
      if (failures === 1) log(`priority: no live estimate from the RPC; holding ${value} micro-lamports per unit, then the floor (${min})`);
      // An estimate that is two minutes old says nothing about now.
      if (failures >= 6) value = min;
      return;
    }
    if (failures > 0) log('priority: live estimates are back');
    failures = 0;
    value = clampPriority(estimate, min, max);
  }

  void tick();
  const timer = setInterval(() => void tick(), 20_000);
  timer.unref();
  return { current: () => value, stop: () => clearInterval(timer) };
}
