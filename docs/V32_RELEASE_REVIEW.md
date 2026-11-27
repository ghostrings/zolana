> Historical V32 instructions. The current workspace is V33; see [V33 release review](V33_RELEASE_REVIEW.md). Use the archived V32 source for V32 reproduction.

# GHOST Markets V32 — exit policy and reproducible release candidate

## What exists on mainnet

V27 remains the deployed, execution-disabled program at `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n`. The owner reported successful OtterSec verification on November 26, 2026, from commit [`b723d275bda85bac40ed9c9f4f7d3c479c5758d7`](https://github.com/ghostrings/zolana/tree/b723d275bda85bac40ed9c9f4f7d3c479c5758d7), with executable verification hash `6377135292ec0e082b9f57d8cdd3caec1df31254c33248cfd32df483be9453ad`. [Verification status](https://verify.osec.io/status/5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n). [Recorded evidence](../deployments/mainnet/v27-verifiable-build.json). Preserve the exact verified historical source at `deployments/mainnet/v27-release/source` and its original commit. This package does not contain the locally sealed V27 binary or exact historical source directory, and must not replace or delete that directory in the public repository. Do not overwrite the published V27 IDL with a V32 candidate IDL.

## V32 changes

The `public-pilot` feature retains the V31 native WSOL market profile, fixed 2/3/4% fees, 80/20 curve distribution, 100% platform pool fees, fee recipient and principal segregation, no external LP issuance, administrator-approved launches and zero creator premint. The default binary remains locked. The original wallet, signing, Meteora trading, server and Render modules are unchanged. No private settlement or Custom Ring integration is introduced.

V32's **soft pause** is an entry stop. It refuses launches and buys but permits valid sells in the curve and pool, claims, and permissionless READY-to-POOL graduation; the historical generic local test feature is not changed. The paused sale executes the same checked arithmetic, minimum output, deadline, state version and token-account constraints as an active sale. This removes the specific V31 pool-sell freeze, not all exit risk: no fixed-price redemption, no guaranteed liquidity, no right to locked LP principal and no recovery of unsolicited donations are provided. READY markets must graduate before selling. If the pricing or account checks refuse a sale, no payout is guaranteed. Sells may still be unsafe during some exploits: this is not a full circuit breaker. A reviewed incident response and stalled-market plan are necessary before production use.

The browser lab normalizes the symbol input to uppercase and does not halt merely because input or a quote fails before submission. Once submission may have started, uncertainty still causes a halt. The local service uses fresh ephemeral wallets, not customer wallets, and remains loopback-only.

Embedded security.txt uses the standard `solana-security-txt` macro from 1.1.3, already in the working dependency graph. The only Cargo.lock semantic change is adding a direct dependency edge. A new checksum records the resulting lockfile. The test runner inspects the actual executable for the expected null-delimited fields. Enable private vulnerability reporting and confirm the published contact works before an upgrade. No audit claim is embedded.

## Local test and release preparation

Run in a fresh Ubuntu extraction, not the old validator workspace:

```sh
npm ci
npm run markets:check
npm run markets:pilot:check
npm run markets:lab:check
npm run markets:pilot:local
```

The last command compiles/tests the default locked binary and the restricted public pilot, checks embedded security metadata in both, and tests all fee tiers with paused pool sells and paused graduation. It reads no production key. Do not upload the temporary validator workspace or its target folder. Optional browser lab: `npm run markets:pilot:lab` at `http://127.0.0.1:17828/`.

After those tests pass, with Docker running and Solana Verify 0.5.2 installed:

```sh
npm run markets:prepare:v32
```

This is build preparation only. It creates a fresh `~/ghost-v32-review.*` workspace and copies an explicit allowlist of public source files. It substitutes the existing public mainnet program ID in the temporary source, without reading or copying any program keypair. It compiles the review candidate with `solana-verify build --library-name ghost_markets -- --features public-pilot` and stores the Docker-built executable separately from the later IDL-only generation. The actual binary must contain the expected security.txt. The `public` export includes source, binary, IDL, feature flags, checksums and candidate hashes, no keys. Confirm the candidate hash and source checksums, not the local-validator program ID. This script sends no transaction.

For eventual reproducibility submission, the exact public source under the candidate directory (e.g. `deployments/candidates/v32-public/source`) must be uploaded manually to an immutable GitHub commit. Record the build flags exactly, including `--features public-pilot`. Do not submit the candidate as the source of the existing V27 deployment. After a separately authorized upgrade, publish the corresponding IDL and repeat the remote verification on the new executable. See [official verification instructions](https://solana.com/docs/programs/verified-builds) and [Security.txt format](https://github.com/neodyme-labs/solana-security-txt).

## Review gates — not yet production-ready

- Re-run Rust/SBF/local-validator/browser checks for V32, including the compiled Security.txt and exact fee invariants; the V31 tests are historical, not V32 execution evidence.
- Obtain independent review of arithmetic, reserve solvency, token-account constraints, pause/exit/recovery policy and privilege boundaries. The 1 SOL accounted cap is **per market**, not a platform-wide risk cap. Review graduation burn, dust, rounding, thin liquidity, donation behavior and economics. A verified build is not a security audit.
- Choose an independently reviewed multisig/treasury and signing policy. The platform fee recipient is pinned to the approving administrator at creation, and rotating the admin does not redirect those fees. Do not use the existing deployment hot key as the sole production treasury/admin. No production treasury separation or migration is implemented.
- Confirm finalized mainnet protocol and market accounts are still empty before any schema-changing upgrade. The current observer is pinned to V27 bytecode and schema; it must reject changed binaries rather than silently label them verified. Implement and review a separate version-aware observer and production wallet transaction builders, consent, user-owned token accounts, signing and transaction confirmation; none are enabled in V32.
- Plan a reviewed same-address upgrade and initialization while still locked, verify the exact deployed executable and matching IDL, and activate only after governance authorization and release review. No automated mainnet upgrade or activation is supplied. Keep V27 proof history.
- Private settlement is a separate, unresolved protocol integration. The proposed native markets are public and must be presented as such. Keep existing Default Ring holding functionality and market transparency distinct.

## Evidence

At packaging, 23 observer tests, 41 pricing/fee/metadata-source/parser tests, and 8 lab-core tests passed. New on-chain behavior and the binary metadata have not been compiled or executed in this environment; the Docker preparation script has not been run here. No mainnet action or additional SOL transfer is performed. Full application dependency installation/build remains unverified here. See [V31 historical fee specification](V31_NATIVE_FEES.md) for the unchanged economic model; its pause text describes V31 only.
