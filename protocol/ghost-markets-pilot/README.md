# GHOST Markets V33 — treasury and full-exit review candidate

See [V32 release review](../../docs/V32_RELEASE_REVIEW.md) and the [historical V31 fee policy](../../docs/V31_NATIVE_FEES.md) for the full accounting contract, fee tier choices, locked liquidity rules, verification and publication boundaries.

This independent Anchor workspace is a local-review candidate. Its default binary is locked; `public-pilot` is the restricted public-SPL native fee model tested by the loopback scripts. `local-market-testing` retains the old generic fee-in-reserve LP math for separate historical testing. Enabled features are mutually exclusive. None of these variants is approved for production funds. The current mainnet binary and production privacycash.fun routes are unchanged.

| Parameter | Pilot value |
| --- | --- |
| Supply | 1,000,000 tokens (6 decimals), zero creator premint |
| Quote asset | Original SPL WSOL |
| Virtual quote | 0.1 SOL |
| Graduation | 0.2 SOL net quote reserve |
| Fee tiers | 2%, 3%, 4% (immutable; 3% default in lab) |
| Curve fees | 80% pinned platform / 20% deployer |
| Graduated fees | 100% pinned platform; no outside LP shares |
| Fee asset | WSOL on buys and sells |
| Accounted WSOL cap | 1 SOL, reserves plus accrued fee liabilities |

Run from repository root:

```sh
npm run markets:pilot:check
npm run markets:lab:check
npm run markets:pilot:local
npm run markets:pilot:lab
```

The local suite covers the locked binary and all three actual fee tiers. The lab creates fresh local test identities, never reads a real wallet, and provides actual public-SPL transactions, fee claims, and graduation on loopback only. The local scripts preserve the working resolved versions; the new Cargo.lock adds the already-resolved Security.txt crate as a direct dependency. New program compilation and validator execution are pending on the owner's Ubuntu toolchain. Historical V29/V30 logs and IDL remain under `evidence/v29-owner/` and must not be presented as V31 test results.

Native market schema 2 adds the pinned platform address and two fee counters, so it is not ABI-compatible with V27's market account schema. The default mainnet observer stays unchanged. The fee claim instruction cannot redeem principal, and no third-party LP issuance is supported by this fee profile. V32 permits checked pool sells during a soft pause, but a complete exit/recovery and incident-response policy still requires review. `npm run markets:prepare:v33` prepares a Docker-built public review candidate with embedded security.txt, no signing keys and no deployment. No mainnet deployment or private settlement commands are included.


See [V33 release gates](../../docs/V33_RELEASE_REVIEW.md). V33 requires a fresh schema-2 protocol config and separate treasury signature at initialization; it deliberately does not migrate a V27/V32 config. Only after a fresh finalized RPC check confirms the config is absent may an upgrade be considered. The treasury is pinned at initialization and at each launch, and cannot be the launch approver or creator in the native pilot. Full curve round-trip regression tests now include zero real quote principal with remaining fee liabilities. Production signing and independent security review are outstanding.
