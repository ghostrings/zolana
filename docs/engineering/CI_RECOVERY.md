# GitHub verification cancellation — investigation and recovery

Repository: [ghostrings/zolana](https://github.com/ghostrings/zolana) · 2026-11-26 · combined v26 candidate.

## What was observed

The owner supplied a GitHub Actions log labelled `verify — cancelled ... in 53s`. It reported:

| Stage | Earlier run evidence |
| --- | --- |
| Locked npm installation | Reached `npm run verify` after installation |
| Baseline | 229/229 match |
| Standalone GHOST checks | 17 passed, 0 failed |
| Vitest | 39 files passed, 943 tests passed, including 9 HTTP tests |
| TypeScript | Both `tsc --noEmit` commands finished before Vite started |
| Vite production build | Entered `transforming...`, then `Error: The operation was canceled.` |
| Server build / demo comparison | Not observed completing |

The SQLite experimental and SDK deprecation messages were warnings in passing tests, not reported failures. Cancellation is not a compilation diagnostic and does not establish that Vite would have completed successfully.

The previous [live CI workflow](https://github.com/ghostrings/zolana/blob/main/.github/workflows/ci.yml), read before packaging the update, set `cancel-in-progress: true` with a workflow/ref concurrency group. The repository history contains another commit at 13:46:47 UTC, during the supplied log's 13:46:34 test start. A newer push is a plausible cause. No Actions cancellation actor or complete run metadata was available, so the exact cause remains unconfirmed. See [GitHub concurrency documentation](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency).

## Changes in this package

- `cancel-in-progress: false` — a newer commit no longer automatically cancels the active run in the concurrency group. Pending runs can still be superseded; manual cancellation and timeouts still apply.
- 30-minute job timeout (previously 20 minutes); the supplied 53-second run was not consistent with the configured timeout.
- Separate install, baseline, research tests, full Vitest, typecheck, Vite build, server build, output checks and deterministic demo steps. No test is skipped, no error is ignored, and all production builds remain mandatory.
- Separate [V25 pricing workflow](../../.github/workflows/markets-reference.yml) and [V26 program workflow](../../.github/workflows/ghost-markets-program.yml); neither performs a production deployment. The heavyweight V26 local-validator suite is manually dispatched.
- Existing app code, lockfile and protected source bytes are unchanged. No Vite workaround or dependency upgrade was applied without a real failure to diagnose.

## Upload and run

1. Extract the entire combined archive at the repository root (not inside another directory). Review publication rights and credentials. Prefer copying all files into a local clone and committing once on an update branch. If using the browser uploader, use a branch and commit the final workflow and full source before opening a PR. Preserve `.github` and other hidden paths.
2. Push the update; open [Actions](https://github.com/ghostrings/zolana/actions). Run **Engineering verification** for the final complete commit or let its main-branch/PR trigger run. Allow it to finish. Inspect the named stage if a real build failure occurs.
3. Run **GHOST Markets Program B** separately using **Run workflow** for Rust/SBF and local-validator tests. Its reference-only push/PR run does not prove the on-chain program builds.
4. Confirm the green result for the final commit, including all build stages, before any application rollout. Do not deploy the market candidate or claim private trading based on a green application build.

For a local connected checkout:

```sh
npm ci
npm run verify
npm run --silent ghost:demo > evidence/ghost-policy-demo.json
git diff --exit-code -- evidence/ghost-policy-demo.json
node --test protocol/ghost-markets/tests/quote.test.mjs protocol/ghost-markets/tests/lifecycle.test.mjs
```

A clean npm install and full build cannot be reproduced in the packaging environment (registry DNS unavailable); Rust/Solana tooling is also absent. The latest merged source must be verified by a fresh GitHub run. Historical passed counts above are not reported as new CI results.
