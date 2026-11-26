# Validation and release gates

Prepared as V26 candidate for `ghostrings/zolana`. The V25 reference pricing file was retained and extended via a new separate workspace. No existing source, package lock or workflow is replaced by this additive archive.

## Executed in preparation environment

- `node --test tests/quote.test.mjs tests/lifecycle.test.mjs`: 31 passed, 0 failed. Includes the inherited 10,000 deterministic pricing property cases, 5,000 generated full lifecycle scenarios, 128 committed CSV lifecycle vectors, round-trip loss/rounding, reserve floor, minimum outputs and slippage, phase, integer limits and LP lock math.
- `node --check tests/localnet.integration.mjs`: JavaScript syntax check only; no dependencies loaded, no validator contacted.
- `bash -n scripts/test-localnet.sh`: shell syntax check only.
- Manifest and archive structure checks; no private key file or compiled binary included.

See `../evidence/reference-test-results.txt`. These reference results do not establish on-chain correctness, privacy, security or economic soundness.

## Written but NOT run

Rust and Solana CLI/Anchor tooling are unavailable in the preparation environment. Downloads from the Rust and npm registries were blocked by DNS/network restrictions. There is no compiled binary, no generated IDL, no Cargo.lock, no actual local-validator result and no deployment. The program ID in Anchor.toml and `declare_id!` is a placeholder, not a real program deployment. The direct Anchor dependencies are pinned; a complete Rust lockfile and reproducible binary still need to be generated and reviewed.

The local-validator test is intended to check actual token mint and freeze authority revocation, zero premint, buy and sell settlement deltas, immutable account bindings, duplicate create, stale quote, expired deadline, slippage and account substitution, permissionless graduation by a different signer, correct burn and locked LP, pool swaps, donations outside accounted reserves, failure of the second liquidity CPI with a confirmed failed transaction and rollback, external LP burn and LP donation, proportional removal and preservation of locked liquidity. It has not been executed. More tests and independent review are required.

## Release gates (in order)

| Gate | Required evidence | Status |
| --- | --- | --- |
| R0 | Local BigInt reference and fixture reproduction | Passed |
| R1 | Independent Rust core test incl. cross-language vectors | Pending |
| R2 | Rust workspace build, SBF build, IDL generation; review complete Cargo.lock and toolchain | Pending |
| R3 | Local validator conformance suite, expanded adversarial tests and actual logs | Pending |
| R4 | Review economics, SPL custody, PDA constraints, rounding, compute/transaction limits, metadata/asset policy, exit behavior and upgrade authority; independent security review | Pending |
| R5 | Separate devnet-only review and approved public test deployment with actual program address and receipt evidence | Pending |
| R6 | Supported Program A proof integration, market-specific proof review, authorized activation and privacy tests | Not implemented |
| R7 | Independent production audit, operator/compliance approval, incident and recovery plan, verified program binary and config | Not approved |

No stage can be skipped merely to announce an explorer address. Keep existing mainnet production routes independent of this candidate. No privacy or live financial claims should be made for Program B until the corresponding evidence exists.

## Known risks and open work

Public execution leaks amounts and parties. Markets can stall below graduation; no refund mechanism. The quote asset can be manipulated by its mint authority. Unsolicited deposits are stranded. The upgrade authority can replace the source's lock and custody logic. Pricing and LP design are research choices, not a market-tested or audited AMM. The core does not certify prices or token legitimacy. Frontend, metadata, asset list, production security controls and actual privacy settlement are not implemented. No source publication license change has been made.
