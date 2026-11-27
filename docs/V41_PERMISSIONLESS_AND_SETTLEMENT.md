# V41 engineering and release runbook

This source package includes two separate workstreams. Neither changes the live program or the live Render deployment. Current native V33 execution remains public. Existing privacycash.fun/Meteora/Default Ring functionality is preserved in source.

| Parameter | Existing V33 market | New V41 profile |
|---|---:|---:|
| Initial supply (before burns) | 1,000,000 | 1,000,000 |
| Virtual starting FDV | 0.1 SOL | 3.5 SOL |
| Real reserve threshold | 0.2 SOL | 12.040270268 SOL |
| Nominal pre-burn graduation FDV | 0.9 SOL | 69 SOL |
| Accounted quote + unpaid fees cap | 1 SOL | 25 SOL (proposed) |
| Native issuance signatures | creator + admin | creator only |

The constant-product curve with initial base supply S, virtual quote v and net real reserve r has idealized base reserve S*v/(v+r). Its marginal FDV on original supply is `(v+r)^2/v`. The threshold is a **reserve threshold calibrated to nominal FDV**, not a 69 SOL funding target or an exact valuation oracle. Integer rounding and trade paths affect the result. Supply decreases through the graduation burn, and the post-burn market cap is not the 69 SOL original-supply FDV. Fees are separate, and a final buy cannot overshoot the new target. The final buy may require a smaller quote to fill the remaining reserve exactly. The legacy profile still permits its existing V33 graduation behavior. No re-pricing or migration of old markets is included.

## Installation and review

Use a fresh directory, run `npm ci`, `npm run markets:v41:check`, `npm run markets:production:check`, `npm run markets:v41:client-check`, `npm test`, `npm run build`, `npm run markets:v41:local` and `npm run markets:v41:compat`. The local validators use temporary fixture keys. `npm run markets:confidential:local` is a separate upstream real-proof baseline (fixture SPL/SOL; not GHOST-minted ZOL). See `protocol/ghost-confidential-settlement/README.md`.

Once the native tests pass, `npm run markets:prepare:v41` builds a candidate in a private scratch directory. Its public export includes reviewed source, candidate hashes and IDL. That does not approve a mainnet upgrade. Before upgrading, review source and binary, verify balances, roles, old curve and pool compatibility, recovery and pause semantics, token and SOL account rent/fees, market cap economics, and load testing. The existing scanner refuses snapshots above 500 native markets: permissionless issuance needs a production indexing/pagination and abuse-resilience plan before a large-scale launch. The 25 SOL cap bounds per-market accounting only, not aggregate protocol exposure. Existing assets are at risk from any live same-address upgrade; retain the old executable and verify rollback compatibility before taking that step. New-profile markets cannot simply be rolled back into the V33 implementation because of their different reserve/cap rules.

The new `/create?rail=native` code switches to a single-wallet V41 launch only for the exact approved V41 executable/slot. It builds a canonical message, simulates, checks cost, obtains one signature and submits only after user approval. No initial buy. Existing V33 remains recognized and retains its old issuer restrictions. Old signature/approval helpers are historical and must not be used to launch a V41 market. The legacy native diagnostic page points to the creation flow instead.

`shared/src/ghost-markets/v41-release-record.ts` is intentionally null. Do not invent an audit, copy a V33 authorization or change a boolean to bypass the release check. After the actual reviewed release, bind its exact public identity, executable hash and deployment slot to a genuine review record. If the binary changes unexpectedly, native signing fails closed. Update verified public IDL and executable evidence after an authorized upgrade. The review record is not an on-chain authorization; the program enforces its own on-chain launch and trading rules.

## Privacy boundaries

V41 native issuance and trading remain public SPL. A red Rings badge indicates verified encrypted-holdings registration, not private execution. The proof baseline uses the upstream test-only keys and local assets. A GHOST-specific settlement adapter, secure proof setup, production review and Custom Ring authorization are still outstanding. Do not expose any test keys, production wallets, signed approval files, API secrets or local caches. Public release evidence alone can be shared.


## Coordinated cutover addendum

See [V41 cutover](V41_CUTOVER.md). The exact V41 candidate is recognized separately from the independent review record; the separate, initially null owner record allows an explicit unaudited release if the operator chooses it. Historical V33 authorization is not reused. No production audit or private settlement is claimed.
