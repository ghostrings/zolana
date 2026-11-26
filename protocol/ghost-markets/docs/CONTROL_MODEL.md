# V27 control model and trust boundaries

This release is a **fresh locked deployment candidate**, not a production market. The default binary has `LOCAL_MARKET_TESTING == false`, and every financial instruction refuses execution. Merely changing a protocol account, an environment variable, an API response or a frontend setting cannot turn on this binary. The separate `local-market-testing` compile feature exists only to validate policy and market behavior against a loopback validator. Solana programs do not inherently know the cluster, so the enabled artifact is not intrinsically cluster-bound; do not publish or deploy it on a public network.

## Singleton protocol PDA

`findProgramAddress(["protocol"], programId)` binds the `ProtocolConfig` account to this executable. All existing market instructions now require this read-only account as their last argument. State: schema (1), bump, mode (0 locked, 1 active, 2 paused), admin, pauser, pending admin. No per-market bypass. Account ownership, PDA seeds and canonical bump at initialization are Anchor-checked. Market account layout and math are unchanged; instruction account lists are intentionally incompatible with V26.

Initialization is restricted to the current loader-v3 upgrade authority, not the first caller: the executable typed `Program<GhostMarkets>` must link to the provided `ProgramData` account, which in turn must name the signing authority. It creates the PDA in locked mode; an unrelated signer cannot bootstrap it. The default binary permits only configuration/role management; `set_protocol_mode` rejects every transition, even for the admin. A future reviewed upgrade is required for production activation.

| Authority | Scope |
| --- | --- |
| Loader upgrade authority | Bootstraps the config once; can replace all executable logic. Keep it under reviewed multisig control before operational use. |
| Config admin | Nominates a successor; changes the pauser. In the enabled local test variant only, activates, pauses or resumes. |
| Pending admin | May accept its own nomination. Zero cancels a pending nomination. |
| Pauser | In the enabled variant only, pauses an active protocol, but cannot activate or resume. |
| Traders / LPs | No administrative privilege. SPL account and signature constraints still apply. |

The program emits public role and mode events. Authority management cannot move customer funds. No permanent delegate or administrative withdrawal instruction exists.

## Operation matrix

| Operation | Default binary (any config) | Local test: locked/uninitialized | Local test: active | Local test: paused |
| --- | --- | --- | --- | --- |
| Create market | Refuse | Refuse | Allowed | Refuse |
| Curve buy | Refuse | Refuse | Allowed | Refuse |
| Curve sell | Refuse | Refuse | Allowed | Allowed subject to existing reserve/slippage guards |
| Graduation | Refuse | Refuse | Ready phase only | Ready phase only |
| Pool swap (both directions) | Refuse | Refuse | Allowed | Refuse |
| Add liquidity | Refuse | Refuse | Allowed | Refuse |
| Remove liquidity | Refuse | Refuse | Allowed | Allowed subject to existing LP/withdrawal constraints |

A transition back to `locked` from `active` or `paused` is not available in the test variant; it could otherwise prevent exits. The paused state deliberately allows ready-phase graduation, so an eligible market is not permanently stuck in Ready; the resulting pool stays paused. This does **not** guarantee universal exits: pool token holders without LP shares cannot sell while paused, insufficient curve reserves still prevent exits, and stalled launches have no refund mechanism. Unsolicited deposits remain outside accounted reserves. The default binary has no markets to exit; never install it over a live market.

## Remaining review items

- Review the lock's exact SBF implementation, account init failure rollback, role transitions, IDL, and compiled binary.
- Run both local variants. Test spoofed ProgramData, wrong/missing protocol PDA, unauthorized signers, default activation failure, locked issuance rollback and paused operation rules.
- Evaluate the economics, supported assets, mint authorities, donation recovery, stalled launch recovery, upgrade risks, compute limits and public disclosure policy. No production activation until these are addressed and independently reviewed.
- Privacy remains a separate, supported proof-based integration with Helius. No custom proof or private market path is implemented by V27.
