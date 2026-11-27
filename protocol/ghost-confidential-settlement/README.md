# GHOST Confidential Settlement — V41 proof baseline

**Local research only. No mainnet deployment, new swap program ID, GHOST/ZOL settlement adapter, or production proof keys are supplied.**

The upstream Helius example at commit `9e5d69ade7e0c107a2929306d3b758a8969e1089` implements confidential maker/taker settlement via the Solana Privacy Program. It verifies a Groth16 application proof and invokes the shielded pool. The example explicitly uses insecure, publicly seeded test setup artifacts: anyone can forge the proofs with these keys. Never deploy or fund them.

## Run the real proof baseline

Use WSL Ubuntu x86-64, Python 3.11+, curl, shasum, rustup/cargo and the Solana SBF build tools. Rust 1.98.1 and platform-tools v1.54 are the upstream versions. This is separate from the native program's Anchor 0.32.1 / Solana 2.3.0 workspace. The upstream tools and crates require network downloads, adequate disk space and memory. Do not update the native production toolchain just to make this experiment compile; use an isolated environment if the installed SBF CLI cannot use the requested version.

From the repository root:

```sh
npm run markets:confidential:local
```

The runner creates a fresh private scratch directory, downloads the pinned upstream archive, checks selected source Git blobs, and isolates HOME, Cargo cache and inherited environment. It invokes upstream checksum-pinned tool setup, compiles test-only circuit artifacts, checks the committed proving/verifying key checksums, builds the example program and starts its fixture localnet with the actual prover and indexer. The `make_and_take_swap_inline` and `make_and_cancel_swap_inline` test commands exercise proof verification, maker substitution rejection, note settlement and refund after expiry. Both must pass; absence of either result is failure. Upstream localnet handles funding fixture actors; no mainnet key, account, balance, mint or RPC endpoint is passed into these tests.

The result, if successful, proves the upstream local SPL/SOL exchange and cancellation baseline. The SPL asset is a **fixture**, not ZOL or a mint created by GHOST Markets. The test uses signer-visible confidential execution, not anonymous trading. Do not upload the generated scratch directory or keys. Only review sanitized test results.

## GHOST-specific integration gate

Before calling this a SOL/ZOL confidential exchange, demonstrate the exact GHOST-created *local* mint registered as a local privacy asset, maker and taker funding and encrypted-note discovery, proof-authorized atomic asset exchange and cancellation; reconcile each participant's before/after holdings, verify fees and conservation, reject altered inputs/outputs and replay, and confirm no public SPL swap occurs in the settlement transaction. Keep public issuance, allocation disclosures, participant controls and policy accountability. No production adapter is provided in V41.

A production confidential route requires secure setup/verifying keys, reviewed CPI and fee logic, custody and recovery policy, a separate independently audited release and any required protocol authorization. Custom Ring registration and activation have not been established by these tests. No private AMM or anonymous settlement is implemented. Never label encrypted holdings or an ordinary public swap as private execution.

Source: [pinned Helius example](https://github.com/helius-labs/privacy-ring-examples/tree/9e5d69ade7e0c107a2929306d3b758a8969e1089/swap). This package invokes the upstream reference tests; it does not redistribute the upstream cryptographic code or claim Helius affiliation.
