# v24 validation record

## Passed in this environment

- `npm run ghost:check`: 15/15 tests passed, zero failures, using Node 22.16.0 and globally available TypeScript 5.8.3. The standalone runner compiles the three new dependency-free research modules with strict compiler settings.
- Scoped TypeScript check of the two new browser entry points and research modules: zero diagnostics in those files. Transitive source imports had 18 diagnostics in the incomplete dependency environment; this is not a full project typecheck.
- Transpilation of the two new browser pages and their direct local runtime dependencies succeeded using TypeScript's transpileModule. This is not a Vite bundle or end-to-end browser test.
- Static wiring checks verified Vite entry points, status router, required element IDs, configuration equivalence and non-execution guard.
- Archive hash comparison: no original source files deleted. Core transaction, signing, privacy, keyring, desk, environment, production wallet/trade, deployment manifest and lockfile files remain byte-identical to v23.

## Blocked or not executed

- `npm ci --offline`: failed because required packages were not cached (`ENOTCACHED`, including yocto-queue). Online `npm ci` did not complete within the attempted run. Partial node_modules was excluded from the archive.
- `npm run typecheck`: exits 2 because the Node type definitions were unavailable (`TS2688`). Full Vitest suite and production Vite/server build could not be validated without the original dependencies.
- Chromium smoke test: browser navigation blocked by the environment (`ERR_BLOCKED_BY_ADMINISTRATOR`), before page assertions ran. Visual layout, real server routing, actual API responses, and browser interactions remain to be tested in the target environment. No claim of browser test success.
- No devnet or mainnet deployment, no real on-chain ring operations, no Helius account credentials, no audited custom-ring artifacts verified. No security audit or legal determination performed.

## Required before deploying the source candidate

In a clean checkout with Node >=22.13 and network access to the package registry, run:

```
npm ci
npm run ghost:check
npm run test
npm run build
```

Verify `/ghost` and `/ghost-intelligence`, check the JSON export, simulate a successful and failed fill, toggle pause/freeze/blocklist/co-signing, reset the simulation, and confirm the public data view displays unavailable when the index is disabled. Check `/api/custom-rings/status` reports `canTransact: false` and attempts at state-changing custom-ring requests return 403. Compare the existing market, launch, wallet and trade pages against v23. Do not change the production deployment until these checks pass. See GHOST_RING_V24.md for scope and readiness gates.
