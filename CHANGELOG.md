# Changelog

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
