# V31 — native launchpad fee policy (historical local candidate)

For the subsequent soft-pause and build changes, see [V32 release review](V32_RELEASE_REVIEW.md). The pause policy and packaging evidence below describe V31 only.

**privacycash.fun / GHOST Markets.** This candidate changes only the independent native program and loopback lab. The already deployed V27 program remains locked; the existing production Meteora, wallet, Rings, desk, conversion, vaults, explorer, fees and other modules remain unchanged. No mainnet signing, deployment, upgrade, initialization or activation is supplied. No private settlement is implemented.

## Economics requested for the native rail

The immutable launch choices are 200, 300 and 400 basis points (2%, 3%, 4%); default in the lab is 300 bps. The rate stays the same through graduation. All native fees are assessed in original SPL wrapped SOL (WSOL), like the quote-asset fee policy of the existing site. They are not extra surcharges on top of the selected trading rate.

| Phase | Platform | Deployer | LP principal |
| --- | ---: | ---: | --- |
| Bonding curve | 80% | 20% | Reserve remains program-controlled |
| Graduated pool | 100% | 0% of new pool fees | 100% genesis LP shares in the lock PDA |

Interpretation: the 80/20 split applies to curve trading; 100% of the fees from the exclusively locked graduated liquidity belongs to the platform. Previously accrued deployer fees remain claimable after graduation. No separate creator pool payout is implied. No third-party LP shares may be minted or redeemed under this native pilot. The older general-purpose `local-market-testing` feature retains the historical LP math and operations, and the existing production Meteora modules are unaffected. A future external-LP design would need a separate fee entitlement model and review.

### WSOL conservation and claims

A buy pays the fee from gross WSOL input; a sell pays the fee from gross WSOL output before minimum output is checked. The fee is rounded upward to the lamport. On the curve, deployer share is rounded down to a lamport (fee / 5), and platform receives the remainder. The pool pays all fee lamports to the platform. No creator premint and no new migration fee.

Fees are separately accounted liabilities inside the quote vault, not tradeable reserves or withdrawable liquidity. `quote_vault.amount >= quote_reserve + platform_fee_quote + creator_fee_quote` is checked on swaps, graduation and claims; unaccounted donations are not fee revenue. Graduation is based on net quote reserves. The 1 SOL pilot cap now includes accounted reserves and unclaimed fee liabilities, not unsolicited transfers. A fee claim transfers only the signer's owed WSOL into a token account controlled by that signer, and zeroes that liability atomically. It does not change the reserve or LP balance. The platform signer is pinned at launch to the approving administrator; the deployer is a distinct signer. Admin rotation cannot redirect earlier markets' accrued fees. Production treasury separation and multisig governance require review.

The existing production Meteora route is not governed by these new instructions. Its configs are immutable and have a third-party protocol cut. Source defaults specify 30% to the creator of the remainder after Meteora's 20%; live Render settings may differ and were not inspected. Do not change environment variables or existing pool terms to advertise 80/20. Any change to future Meteora launches must use the established config retirement process, with verified on-chain fee terms; existing creators retain their actual contractual terms.

## Account and release boundary

Market schema changes from 1 to 2; account size increases from 563 to 611 bytes, adding the pinned platform public key and two u64 liabilities before variable-length metadata. The V27 observer remains pinned to its original executable and schema. Never decode schema 2 accounts with the old production observer. No current mainnet upgrade is authorized or proposed as ready. The default binary remains execution-disabled; only the separate candidate feature is exercised by the fresh local validator scripts. Existing pause behavior blocks ordinary pool sells; curve sells and fee claims may be allowed. Stalled-curve recovery, pool token-holder exit behavior, economic design, reserve and account migration safety, independent review and secure upgrade authority remain production gates. Locked principal is enforced by the supplied code, not a promise that the current upgrade authority cannot replace it.

## Verification

From the repository root in Ubuntu:

```sh
npm ci
npm run markets:check
npm run markets:pilot:check
npm run markets:lab:check
npm run markets:pilot:local
```

The last script compiles the new candidate and tests the locked default plus all three fee tiers on a new loopback validator. Tests check actual fee transfers, claims, cap, unauthorized signers, graduation, external LP refusal and pause behavior. Then `npm run markets:pilot:lab` starts the local interactive lab at `http://127.0.0.1:17828/` with the tier selector and test-only platform/deployer claim controls. Do not upload any temporary workspaces, key files or target folders.

At packaging, 23 observer tests, 38 pricing/lifecycle/profile tests and 6 lab-core tests passed. New Rust, SBF, local-validator and full application/browser checks remain pending in the owner's environment. Historical V29 evidence is retained as historical evidence only, not verification of V31. Exact Cargo.lock and package-lock.json are unchanged.
