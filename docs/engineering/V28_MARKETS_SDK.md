# V28 — read-only market SDK and deployment evidence

The first GHOST Markets program (Program B) has a user-reported, verified, intentionally locked mainnet deployment. V28 does not upgrade it, initialize the config or deploy a Custom Ring. The existing launchpad, transaction validation, Ghost desk, wallet, cryptography and Meteora paths remain unchanged.

## Commands

From repository root with Node 22 and the existing locked npm dependencies:

```sh
npm ci
npm run markets:check
npm run verify
npm run markets:observe -- status
npm run markets:observe -- history
npm run markets:observe -- scan
# npm run markets:observe -- market PUBLIC_MARKET_ACCOUNT
```

`status` compares the finalized account snapshot to the recorded genesis, loader, ProgramData pointer, original slot, current upgrade authority, exact executable size and SHA-256 digest. An unexpected mode, schema or changed executable fails closed. `history` returns up to ten public signatures involving the program, not fills or volume. `scan` requests a filtered public account snapshot by known program, account size and discriminator. Providers may reject program scans; no empty index is invented. The scan is capped at 5,000 accounts and the RPC response at 8 MiB. No persistent event replay, incremental indexing, reserve reconciliation or full history coverage is claimed. A snapshot is not a current market quote, proof of ownership, or a permission to trade. For trusted HTTPS RPCs, set `GHOST_MAINNET_RPC` privately; never put credentials in a public command transcript or web source.

The browser page `/ghost-markets` uses the existing same-origin `/api/helius` read methods. It does not import wallet or trade builders. No expensive program scan is exposed in the browser. It renders public account fields as text, never loads token metadata URLs, and clears current data on re-verification. Unknown status is distinct from a matched locked release. No customer wallet address, private notes, audit data or proof inputs are requested. RPC checks rely on provider correctness; finalized snapshots are not a light-client proof and may become stale after upgrade.

## SDK modules

| File | Purpose |
|---|---|
| [`observe.ts`](../../shared/src/ghost-markets/observe.ts) | Narrow read-only RPC, strict account codecs, integer-safe public data and pinned binary checks |
| [`local-instructions.ts`](../../shared/src/ghost-markets/local-instructions.ts) | Unsigned V27 instruction descriptors for five public market operations, loopback test identity only |
| [`markets-observe.ts`](../../ops/markets-observe.ts) | Operator snapshot and verification CLI |
| [`markets-sdk.node.mjs`](../../tests/markets-sdk.node.mjs) | Offline fixture tests; synthetic binary only, never evidence of mainnet verification |

The local descriptors reproduce the Anchor discriminator, Borsh fields, account order and signer/writable flags; they are not complete signed transactions. The caller supplies local account/PDA addresses. Only local HTTP endpoints and identities distinct from the known deployed program are accepted. This is a developer guard, not a cryptographic cluster guarantee. Do not use a loopback proxy to mainnet. No wallet, signing, blockhash, submission or activation API is provided. The deployed program's own lock is authoritative. Actual local-validator use of the new descriptors remains to be tested; the previously successful validator suite used its original instruction encoders.

## Evidence and remaining work

The November 26 owner-provided logs report V27 Rust compilation, 15/15 Rust tests, 9/9 operational and 3/3 locked local validator tests, plus the successful sealed production-identity verification. Those results are for the V27 build, not new V28 UI or SDK code. V28 keeps the exact supplied Cargo.lock and incorporates the confirmed local script and error-code corrections. The exact binary and production-ID source can be exported from the owner's sealed directory using the [deployment evidence runbook](../../deployments/mainnet/README.md).

The [Program A readiness](../../protocol/ghost-ring/README.md) and [Helius intake](../../contrib/helius/HELIUS_INTAKE.md) are separate integration planning, not deployed or approved features. Independent review of the production binary remains unestablished. A separately reviewed upgrade, approved governance, recovery, custody/exit controls and applicable compliance review are required before real market operations. Private settlement requires compatible upstream proof interfaces, audited keys, proper authorization and independently reviewed market-specific proof validation. See [settlement contract](../../protocol/ghost-markets/docs/SETTLEMENT_CONTRACT.md).

### Packaging validation (executed)

- V28 SDK: 21/21 standalone tests, including fail-closed byte comparisons and public-only local instruction descriptors.
- Existing GHOST research checks: 17/17; market/reference and release verifier: 34/34; historical V25: 13/13 (overlapping pricing coverage).
- 229/229 protected original files, exact uploaded Rust lockfile, unchanged npm lockfile, unchanged V27 Rust code and deployment/verifier scripts. Deterministic demo and lifecycle vectors matched.
- Scoped TypeScript compilation of the new SDK, browser entry and CLI; shell syntax, workflow YAML, local documentation links and page IDs checked.
- [Raw standalone test output](../../evidence/v28-checks.txt).

Full application dependency installation was blocked by an uncached npm package in the original packaging environment. The owner subsequently reported passing application checks and supplied successful finalized CLI status and scan results; see [observations](../../deployments/mainnet/v28-observations.json). Full CI logs, independent browser verification and local-validator use of the new descriptors remain unverified here. No new transaction, PR, ring registration, release attestation or program upgrade was performed.
