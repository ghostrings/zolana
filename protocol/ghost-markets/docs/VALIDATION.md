# Validation and release gates — V27

Date: 2026-11-26. This record distinguishes owner-reported V26 evidence from V27 source and packaging verification. It is not an independent security audit.

## Owner's local V26 evidence

The owner supplied successful `cargo test --workspace --locked` output (11 math tests + one program ID test) and the subsequent actual validator output: six tests passed, zero failures, after changing the duplicate quote account setup to use a fresh Keypair. It covered fixed issuance/early graduation rejection, curve buy/sell, stale quotes, deadlines, account substitution, slippage, graduation/genesis lock, pool settlement and atomic rollback, external LP burns and locked-share accounting. This was real local-validator settlement using public SPL tokens, not a public network deployment or a privacy test.

Owner-reported V26 local identity: `3vakhxu5Xz6PmDmdtJX9BsBBaAHj5HU1VNhU3To7FYiG`.

Owner-reported V26 binary SHA-256: `ae857c4dcadb33370e7effc192e618c9f65e3369bc0be74ced95076cfd4357d9` (reported 430 KiB binary and 15 KiB IDL). Neither binary nor IDL was supplied for inspection. These figures must not be copied into a V27 deployment record.

The owner supplied the actual working `Cargo.lock` with 266 package entries. [Checksum](../evidence/Cargo.lock.sha256) identifies the exact file; it is retained byte-for-byte. Compatibility pins include blake3 1.8.2, constant_time_eq 0.3.1, proc-macro-crate 3.3.0 alongside 0.1.5, indexmap 2.11.4, zeroize 1.8.2, zeroize_derive 1.4.3 and unicode-segmentation 1.12.0. The owner observed a successful SBF build and validator suite with these resolutions. Do not regenerate the file. Security advisory review remains required.

## V27 scope

The unchanged quote and lifecycle math are exercised by the legacy 31-test Node reference suite, including 10,000 seeded pricing cases, 5,000 lifecycle scenarios and 128 cross-language vectors. The V27 deployment byte-verifier has three new standalone Node tests covering identity, hashes, locked-feature metadata and loader-v3 bytes/padding. See [reference results](../evidence/v27-reference-results.txt). These are host-level tests and do not execute SBF.

New Rust code adds a protocol PDA, ProgramData-bound initialization, compile-time lock, authority transitions and pause policies. Its account layout changes market instruction ABI, but not the original Market account layout or math. New Rust guard tests and extended local-validator conformance tests are written; Rust/Solana/Anchor tooling is unavailable in the packaging environment, so neither new Rust nor V27 validator tests have been executed here. Shell and JavaScript syntax checks and workflow YAML parsing do not prove runtime correctness.

## V27 execution and deployment (owner reported later, 2026-11-26)

- Rust: 11 math + 4 program tests passed; SBF and IDL generation succeeded.
- Operational local validator variant: 9 passed, 0 failed. Locked default variant: 3 passed, 0 failed.
- Sealed production identity: locked test passed; source and release checksums verified.
- Mainnet deploy and RPC verification returned `verified: true` for the exact binary at slot `474265505`. See [record and export](../../../deployments/mainnet/README.md). Independent review remains unestablished; no operational market is enabled.
- Historical release gates below are superseded by this evidence where indicated.

## Release gates

| Gate | Evidence required | V27 status |
| --- | --- | --- |
| R0 | Exact owner lock, original app hashes, unchanged reference math, standalone tests | Local packaging verification |
| R1 | Rust workspace default + local-market-testing tests | Owner reported passed |
| R2 | SBF builds/IDLs with pinned toolchains | Owner reported passed |
| R3 | Local-enabled lifecycle/control tests and default locked tests | Owner reported passed |
| R4 | Fresh mainnet identity; exact default-feature candidate, its loopback locked test and reviewed source/binary provenance | Sealed release and locked test reported; independent review not evidenced |
| R5 | Independent review, key custody, read-only mainnet preflight and approved deployment cost | Preflight passed and owner deployed; independent review and governance review remain open |
| R6 | Fresh locked mainnet program, receipt, exact byte/authority verification | Owner reported success; current RPC observation required |
| R7 | Operational market safety, independently audited upgrade, production controls | Not approved |
| R8 | Helius Custom Ring registration/activation and actual proof-bound private settlement | Not implemented |

No public devnet deployment is required for the locked deployment plan. It does not waive local tests, independent review, or later operational and protocol integration requirements. Follow [V27 mainnet preparation](MAINNET_V27.md).

## Open risks

The default binary must be deployed only to a new address, never over live markets. The test feature is not an inherent on-chain network check; enabled artifacts must remain local. Pause protects curve sells and LP withdrawal paths in the test build, but cannot guarantee every exit, and the stalled-launch refund mechanism is not implemented. Quote asset mint authority, price manipulation, vault donations, administrative upgrade powers, liquidity economics, source verification, security and legal review all require further work. The program is public, not anonymous. No operational privacy or safety claims are supported by the V27 source alone.
