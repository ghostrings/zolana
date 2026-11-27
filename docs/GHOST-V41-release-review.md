# GHOST Markets V41 — preliminary release review

**Disposition:** artifact integrity and static compatibility checks pass; not an independent audit or a mainnet upgrade authorization. No transactions were sent. This review does not approve the candidate for customer funds.

## Reviewed artifacts

- Uploaded `GHOST-V41-review.tar.gz`, compared with `privacycash-v41-permissionless-settlement-candidate.zip` and the prior uploaded V33 candidate.
- Program ID: `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n`
- Candidate build feature: `public-v41`
- Candidate executable: 550,056 bytes; raw SHA-256 `0bbb6ee73824e8077a0355021c6bf4178f9de0ffbeced0723a0316880e219efd`
- Solana Verify hash: `ee9f32d573967169cac33c3510922313e2a8ea418db497d2cfa8dc60d2e5a1df` (reproduced locally by hashing the executable after stripping its 15 trailing zero bytes, consistent with the supplied manifest).
- Historical V33 executable: 547,816 bytes; increase in candidate length 2,240 bytes. Actual on-chain allocation must be read from RPC.

## Checks performed

| Check | Result |
|---|---|
| Release SHA256SUMS | 14/14 match |
| Source manifest | 8/8 match |
| Candidate size and raw hash | Match |
| Recorded Solana Verify hash | Match |
| Embedded Security.txt marker | Present |
| IDL address | Correct |
| IDL instructions, account definitions, types and events | Identical to V33; one added error |
| Reviewed package vs exact source | All eight files match after substituting permanent program ID in Anchor.toml and program source |
| Market math source and Cargo.lock vs V33 | Byte-identical |
| V41 reference and policy tests rerun | 44/44 pass |
| Existing production observer tests rerun | 23/23 pass |
| Archive contents | 15 regular files and directories; no keypair JSON or wallet exports detected |

No new Rust/SBF compilation, Docker build, validator execution, live RPC inspection, security audit or confidential proof execution was performed by the reviewer. The operator reported successful local validator and upstream proof tests; the submitted release archive does not contain their logs. The source and binary manifest checks establish internal consistency, not independent source-to-binary reproduction.

## Source changes and economics

The V41 `create_market` path removes the V33 extra administrator signer, requires no remaining accounts, pins the SPL native quote mint and enforces the new immutable profile. It retains the existing creator signer, treasury role, fixed supply, mint-authority revocation, fee tiers and zero premint. It does not migrate or resize old market accounts. The current config schema and instruction ABI are unchanged. Existing markets retain the V33 profile cap. The fee claim change allows a treasury wallet that also creates a market to claim both of its own ledgers without redirecting another wallet's fees.

| Parameter | Legacy V33 | New V41 |
|---|---:|---:|
| Original supply | 1,000,000 tokens | 1,000,000 tokens |
| Virtual starting valuation | 0.1 SOL | 3.5 SOL |
| Real graduation reserve | 0.2 SOL | 12.040270268 SOL |
| Nominal pre-burn original-supply valuation at threshold | 0.9 SOL | 69 SOL |
| Accounted reserve + unpaid fees cap | 1 SOL | 25 SOL |
| Issuance | Creator + administrator | Creator only |

Reference calculation for a single exact-target buy from a fresh V41 market:

| Fee tier | Gross SOL paid | WSOL fee | Net principal |
|---|---:|---:|---:|
| 2% | 12.285990070 | 0.245719802 | 12.040270268 |
| 3% | 12.412649761 | 0.372379493 | 12.040270268 |
| 4% | 12.541948196 | 0.501677928 | 12.040270268 |

These figures exclude rent and network fees; actual paths may differ due to rounding and intervening sells. In this example graduation burns 50,724.637681 unsold tokens and leaves 949,275.362319 outstanding tokens. The post-burn capitalization at the continuity price is approximately **65.5 SOL**, not 69 SOL. The requested target is implemented as nominal pre-burn original-supply FDV, not a post-graduation market-cap oracle. Locked LP shares are governed by upgradeable code, not an immutable guarantee.

## Outstanding production concerns

1. **Funded markets and recovery.** Static compatibility and the operator's reported loopback compatibility run are encouraging. The compatibility test creates funded curve and pool accounts under V33, compares their account bytes across the upgrade and tests old-profile caps and sells. It does not exhaustively demonstrate all production recovery or post-upgrade paths. Preserve the exact V33 release. Review successful buys, ready-to-graduate legacy markets, fee claims, pause/resume and a forward-compatible recovery plan. A simple rollback to V33 after new-profile markets have been issued is not safe: V33 has the old 1 SOL cap and cannot reliably operate the new profile. Do not promise that rollback restores all markets.
2. **Coordinated release.** The application `shared/src/ghost-markets/v41-release-record.ts` is null. It intentionally does not recognize an unapproved V41 executable. Installing V41 while the config is active would enable permissionless issuance directly on-chain even while website reads/signing fail closed. A website gate is not an on-chain pause. Plan a coordinated maintenance window, verify that exits remain accessible, use the existing pause controls and require a genuine release decision; never fabricate independent review. Do not reinitialize the existing config.
3. **Indexer scaling.** `scanV33` rejects snapshots containing more than 500 markets. Permissionless issuance needs resilient indexing/pagination, limits on work per request and metadata handling, before opening at scale. The 25 SOL cap is per market and covers accounted principal plus unpaid fees, not aggregate exposure or a guarantee against losses.
4. **Privacy scope.** The uploaded candidate contains the native public market program only. The separately reported successful Helius reference proof tests concern local fixture SPL/SOL assets and insecure test-only proving keys. They are not a GHOST/ZOL confidential exchange, a secure production proof setup, a registered Custom Ring or a private AMM. Private settlement remains false. Keep that research isolated from production wallets and markets.
5. **Release review and funding.** The current on-chain deployment state, upgrade authority, ProgramData allocation and current SOL balance have not been independently checked in this review. Confirm them before estimating an upgrade. A reproducible build or OtterSec hash comparison is not an audit. Production economic, security and custody review remains outstanding.

## Next read-only checks (Ubuntu)

```bash
PROGRAM=5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n
AUTHORITY=J4JRQza7JXnkct6kQC3roPYstoH2xFBoyQ5Wczpt5jPt
RPC=https://api.mainnet-beta.solana.com
solana program show "$PROGRAM" --url "$RPC"
solana balance "$AUTHORITY" --url "$RPC"
solana rent 550101 --url "$RPC"
solana rent 550093 --url "$RPC"
solana-verify get-program-hash -u "$RPC" "$PROGRAM"
```

The two rent inputs include the ProgramData and buffer headers. Actual CLI allocation, temporary buffer funding and fees may vary. The expected pre-upgrade Solana Verify hash, if V33 is still installed, is `33a41e48d76fe0bbf936aa41e926a6ebb9005034cfcbf3651318a1ff0e8e9ec5`.

Keep V40/V33 running until the compatible release and recovery plan are ready. No further program address, initialization, dependency change or routine rebuild is required by this integrity review.
