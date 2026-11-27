import { DEPLOYMENT, observeDeployment, type DeploymentObservation, type RpcRead } from './observe.js';

/** Read-only, pinned-release status. No field in this API authorizes transaction execution. */
export type NativeMarketStatus = {
  readonly programId: string;
  readonly marketExecution: false;
  readonly privateSettlement: false;
} & (
  | { readonly verification: 'verified-locked'; readonly observation: DeploymentObservation }
  | { readonly verification: 'unavailable'; readonly observation: null; readonly reason: 'rpc-not-configured' | 'verification-failed' }
);

const disabled = Object.freeze({ programId: DEPLOYMENT.programId, marketExecution: false as const, privateSettlement: false as const });
function unavailable(reason: 'rpc-not-configured' | 'verification-failed'): NativeMarketStatus {
  return { ...disabled, verification: 'unavailable', observation: null, reason };
}

/** Coalesce concurrent requests and cache a bounded public check, including failures.
 * A failed refresh never returns the previous verified result. No wallet or request parameters.
 */
export function createNativeStatusReader(
  rpc: RpcRead | undefined,
  observe: (rpc: RpcRead) => Promise<DeploymentObservation> = observeDeployment,
  now: () => number = Date.now,
): () => Promise<NativeMarketStatus> {
  let cached: { expiresAt: number; value: NativeMarketStatus } | undefined;
  let pending: Promise<NativeMarketStatus> | undefined;
  return async () => {
    if (!rpc) return unavailable('rpc-not-configured');
    if (cached && cached.expiresAt > now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let value: NativeMarketStatus;
      try {
        const observation = await observe(rpc);
        // Even a changed or improperly implemented observer must never enable trading.
        if (observation.programId !== DEPLOYMENT.programId || observation.programData !== DEPLOYMENT.programData ||
            observation.binarySha256 !== DEPLOYMENT.binarySha256 || observation.deploymentSlot !== DEPLOYMENT.deploymentSlot ||
            observation.upgradeAuthority !== DEPLOYMENT.upgradeAuthority || observation.marketExecution !== false ||
            observation.privateSettlement !== false || (observation.protocol !== null && observation.protocol.mode !== 'locked')) {
          throw new Error('Unexpected release observation');
        }
        value = { ...disabled, verification: 'verified-locked', observation };
      } catch {
        // Never expose the RPC URL, API key, provider response, or error stack.
        value = unavailable('verification-failed');
      }
      cached = { expiresAt: now() + (value.verification === 'verified-locked' ? 60_000 : 20_000), value };
      return value;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
