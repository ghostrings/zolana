# Changelog

## V28 public-source revision — 2026-11-26

- Added the owner-reported finalized RPC status/scan evidence and passing application-check report, with provenance and scope.
- Hardened publication exclusions, removed a machine-specific username from the historical runbook, and added a publication safety record.
- No execution code, dependency lockfiles, deployed program, authority or activation state changed. No private release files or keys included.

## V28 mainnet observer and SDK — 2026-11-26

- Recorded the owner-provided successful locked V27 mainnet deployment, program ID, receipt, authority and exact binary hash; no independent audit or current RPC verification claimed during packaging.
- Integrated the tested build argument forwarding, case-insensitive localnet guard and corrected V27 validator error mapping; preserved Cargo.lock and on-chain Rust source.
- Added a read-only deployment/account observer, filtered CLI discovery snapshot, recent program history, browser status page, and unsigned local-only public instruction descriptors. No new wallet signing, mainnet execution or private-proof path.
- Added exact sealed release export and updated Helius technical intake, Program A readiness and upstream discussion draft. No remote actions, activation or PR submission.
- See [V28 verification record](docs/engineering/V28_MARKETS_SDK.md) for tests and outstanding gates.

## V27 locked mainnet candidate — 2026-11-26

- Imported the owner’s exact working Cargo.lock (266 entries) without changing resolutions; retained the corrected second token account in the validator fixture.
- Recorded the owner-reported V26 Rust (12/12) and actual local-validator (6/6) results separately from V27.
- Added a compile-time default execution lock, authenticated singleton configuration, admin/pauser and two-step admin transfer. Local-only controls permit limited exits during pause; no universal refunds.
- Added two-variant validator runner, fresh mainnet preparation, read-only preflight and byte-verification tools, and explicit reviewed-hash deployment approval. The default binary cannot be activated; the test build must stay local.
- Packaging checks: 17 GHOST tests, 34 market/reference tests, 229 protected files and the exact lockfile verified. New V27 Rust/SBF compilation, validator execution, security review and deployment remain pending.
- No operational market or private settlement enabled; application code and npm lock unchanged.

## v26 combined engineering candidate — 2026-11-26

- Added the complete V25 pricing RFC and V26 GHOST Markets Anchor workspace, including their reference tests, Rust math, instruction source, validation notes and independent CI workflows. No new execution route or private settlement is enabled.
- Corrected the application workflow concurrency policy (`cancel-in-progress: false`), expanded the timeout to 30 minutes, split verification stages, and added build entry-point checks. All prior tests and production builds remain required.
- Documented the owner-provided cancelled GitHub run: 943 Vitest tests, 17 standalone checks, 229 baseline matches and type-checking passed; Vite was interrupted. The cancellation cause is consistent with a newer push but not independently proven.
- Production build and remote CI for this merged candidate, plus Rust/SBF compilation, validator tests, independent review and deployment, remain outstanding.
- Existing execution source, dependency lockfile, research settings and production configuration are unchanged.

## v24 GitHub publication package — 2026-11-26

Documentation and repository packaging revision only. Added GHOSTRINGS branding, locally hosted diagrams and evidence graphics, community files, publication instructions and repository metadata. The Custom Ring configuration and application execution code remain unchanged; no new integration or remote CI result is claimed.

## v24 engineering candidate — 2026-11-26

Unpublished, unaudited research release candidate. No live Custom Ring or anonymous settlement implementation.

### Added

- Concise review-oriented README and original platform documentation retained in `PLATFORM.md`.
- GitHub Actions verification workflow, PR/issue templates and contribution/security guidance.
- Release-specific SHA-256 guard for 229 unchanged v23 files, standalone synthetic demo and committed deterministic evidence.
- Fixed-seed 2,000-operation state-machine test; dense fixed-participant snapshot rejection tests; isolated HTTP contract test queued for full Vitest run.
- Architecture, trust boundaries, gated roadmap, validation and publication runbook.
- Helius technical intake, maintainer discussion, draft PR and additive documentation patch (scratch-verified only).

### Fixed

- Synthetic aggregate validation now rejects shortened or sparse balance arrays instead of silently omitting participants.

### Unchanged

- Original mainnet trading, signing, key-management, privacy and desk logic; production Render configuration and locked dependencies. The existing v24 research configuration remains unchanged and cannot enable live execution.

### Pending

- Clean npm install, full Vitest suite, production build, HTTP and browser verification, real CI run, upstream agreement, devnet protocol integration, security and operational review. Do not deploy over v23 on the strength of simulator tests.

## v24 research foundation (imported)

Four-product hub, immutable research target, synthetic policy model and separate public Intelligence view. Original preparation record: [docs/GHOST_VALIDATION.md](docs/GHOST_VALIDATION.md).

## v23 (imported)

User-supplied platform baseline; reconstructed archive provenance, not the original development history.
