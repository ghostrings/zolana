/** Research target, not an on-chain ring or a deployable Helius CLI configuration. */
export const GHOST_RING_TARGET = Object.freeze({
  name: 'GHOST Trading Ring v1',
  environment: 'devnet-research',
  privacy: 'anonymous',
  assets: 'all',
  membership: 'open',
  blocklist: true,
  freeze: true,
  cosigning: true,
  auditor: true,
  pause: true,
  permanentDelegate: false,
} as const);

/** The lab models these operations. Actual policy semantics must be checked against audited upstream code. */
export const LAB_COSIGN_OPERATIONS = ['deposit', 'transfer', 'withdraw'] as const;

/** Deliberately has no environment override or transition to live operation. */
export function ghostRingStatus() {
  return {
    target: GHOST_RING_TARGET,
    execution: 'local-simulation-only' as const,
    network: null,
    ringProgram: null,
    canTransact: false as const,
    auditedAnalytics: false as const,
    blockers: [
      'Anonymous mode is not enabled in the public Helius configurator (checked 2026-11-26).',
      'No audited, compatible Custom Ring SDK/program has been verified for this release.',
      'No ring deployment, governance activation, Ring RPC or auditor/operator authorities have been configured.',
      'Atomic ring settlement, independent security review and operator compliance assessment are pending.',
    ],
    checkedOn: '2026-11-26',
  };
}
export type GhostRingStatus = ReturnType<typeof ghostRingStatus>;
