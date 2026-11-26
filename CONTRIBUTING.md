# Contributing

This is an independent application integration, not the Helius protocol repository. Changes must preserve the separation of existing mainnet code and synthetic Custom Ring research.

Application repository: [ghostrings/zolana](https://github.com/ghostrings/zolana). Review the [code of conduct](CODE_OF_CONDUCT.md) before contributing.

## Workflow

1. Read [README](README.md), [security](SECURITY.md), and the [architecture](docs/engineering/ARCHITECTURE.md). Work in a fresh private branch. Do not use production credentials or funds.
2. Open a small issue or design note describing the problem, scope, affected package versions and expected behavior. Separate observations from proposals.
3. Write a focused change and tests. Prefer typed inputs, integer accounting, bounded state and fail-closed behavior; do not disable existing transaction checks to make a test pass.
4. Run `npm ci` and `npm run verify`; attach actual output and describe any test you could not run. For research changes, also run `npm run --silent ghost:demo` and compare with the committed fixture. Update a fixture only for an intentional, reviewed behavior change.
5. Review the full diff, including public visibility, key ownership and failure paths. The v23 baseline guard is release-specific; changes to protected paths require deliberate reviewer agreement, a documented rationale and a new reviewed baseline, not an automatic regeneration.
6. Open a draft PR to the project's own repository. Require a successful CI run and independent review before merging. Mainnet deployment is a separate operational approval, never a side effect of CI.

## Scope conventions

- `docs:` documentation and integration notes.
- `test:` regression and conformance checks.
- `fix:` independently reproducible corrections.
- `feat:` reviewed application capabilities.
- `chore:` nonbehavioral tooling changes.

Use minimal, reviewable commits with specific titles. Link the reproducer or issue; don't use unsupported audit, compatibility or anonymity claims. Do not submit proprietary application source, branding or customer data to upstream repos. A maintainer must approve the intended contribution scope and applicable license/CLA/DCO before public submission. [Upstream kit](contrib/helius/README.md) describes the proposed first contribution.
