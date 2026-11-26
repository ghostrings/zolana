# Program A — GHOST Ring integration (blocked)

**No Custom Ring is deployed or registered by this repository.** Program B's confirmed-by-owner mainnet address is not a Custom Ring program ID. The `config/ghost-ring.research.json` file describes a previous fictional research target; it is not a deployable upstream manifest or a production participation policy.

## Upstream alignment

Use the maintained [Custom Rings reference](https://github.com/helius-labs/custom-privacy-rings), the [ring generation template](https://github.com/helius-labs/zolana-ring) and the [official release announcement](https://www.helius.dev/blog/solana-privacy-rings). The November 10 announcement describes the permissionless default ring as live and Custom Rings as in audit with a Q4 2026 target. A release target is not evidence that an arbitrary third-party ring is activated. Obtain maintainer-confirmed current release pins, supported SDK and service endpoints, proving/verification artifacts, deployment and activation requirements, and independent security review. The [upstream integration request](../../contrib/helius/HELIUS_INTAKE.md) asks for those details.

## Engineering stages

| Gate | Evidence required | State |
|---|---|---|
| A0 | Authorized engineering contact and supported version matrix | Requested in draft only |
| A1 | Distinct Program A ID, pinned source, reviewed program and proof artifacts | Not implemented |
| A2 | Isolated local/test-cluster conformance: valid transactions, wrong proof and wrong asset rejection, policy and exit tests | Not performed |
| A3 | Authorized registration and activation; appropriate lawful operation and governance | Not performed |
| A4 | Independent review of auditor access, enrollment and user disclosure; approved scoped reporting | Not performed |
| A5 | Atomic market settlement adapter, reviewed independently of Program B | Not implemented |

No real assets should be accepted through any of these gates until the relevant production approvals and security requirements are met. Program A must use authorized upstream interfaces; it must never modify the current locked deployment or bypass governance. Use conservative, approved participation and asset policies and accurately disclose auditor, relayer, upgrade and pause powers. Permanent delegate is not requested for the initial integration. The original wallet and research lab remain separate.

## Boundary

A Ring proof enforces privacy/policy rules for its supported transactions. It does not automatically prove AMM pricing, liquidity, fair issuance, ownership disclosures or private market state. The [settlement contract](../ghost-markets/docs/SETTLEMENT_CONTRACT.md) specifies what an independent market adapter must establish. No test proving key, mock proof, on-chain adapter or relayer is included in V28. No approval, partnership or whitelist entry is implied.
