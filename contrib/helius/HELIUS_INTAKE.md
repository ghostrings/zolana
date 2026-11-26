# GHOSTRINGS / privacycash.fun — engineering integration request

**Draft for owner review and submission. Not sent; no affiliation, approval or access claimed.**

Hello Helius Privacy Engineering Team,

We are building GHOSTRINGS, the independent Solana privacy application behind [privacycash.fun](https://privacycash.fun). Our public repository is [ghostrings/zolana](https://github.com/ghostrings/zolana). The existing application uses Solana Privacy Rings for confidential balances/settlement and Meteora for public market execution. We would like to explore supported, auditable programmable privacy for an independent market protocol.

## Engineering milestone

On November 26, 2026 our operator reported a successful Solana mainnet deployment of **GHOST Markets V27 (Program B)**, a separate Anchor executable that is intentionally locked. The owner-provided RPC verification reported the deployed bytes match the sealed release. This is not a deployed or activated Custom Ring. It does not execute markets or private settlement. No independent audit is claimed.

- [Program ID](https://explorer.solana.com/address/5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n): `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n`
- [Deployment transaction](https://explorer.solana.com/tx/5TMpEwE2XkjWTfY42XShQPks3UoYrVEDWiHFdAzcCXeJcZ1wnu6AXyEaXefQn3cx3geMixMHjKtziSe6vtXaANjT)
- Deployment slot: `474265505`
- SHA-256: `2fba22c284791879f003aec3118c74fbd271f808f91b39e394e2654f9cc80d7d`
- Operator-reported local validator: 9/9 operational variant; 3/3 locked variant; default binary cannot activate.
- [Public release record](../../deployments/mainnet/ghost-markets-v27.json) · [Program source workspace](../../protocol/ghost-markets/README.md) · [V28 SDK and validation](../../docs/engineering/V28_MARKETS_SDK.md).

## Technical alignment request

1. Which current program, SDK, circuit/verifier and service releases are supported for an independent Custom Ring integration? Is early-access engineering support available?
2. Which registry and governance approval steps apply, and what security review and operational requirements must an independent applicant satisfy? We seek the authorized path, not a bypass of activation.
3. Which program-owned note/escrow and atomic settlement interfaces are supported for a market application? We want to understand how a reviewed adapter can establish a valid settlement without trusting a client-supplied proof flag or unsafe test keys.
4. Which auditor-access, participation, asset controls and data/reporting interfaces should we use? We plan accurate user disclosures, restricted auditor access, and meaningful market-integrity and insider-allocation reporting.
5. Would maintainers welcome small reproducible integration tests or documentation improvements? We can share a narrowly scoped fixture and validation checklist after aligning on the supported release.

We have kept market execution locked and do not intend to enable real customer funds until the program and relevant privacy settlement are independently reviewed, activation is authorized, and operating requirements are satisfied. We would welcome an engineering discussion on the supported integration and appropriate security requirements.

Thank you,
GHOSTRINGS / privacycash.fun

**Submit via:** [Helius Privacy Rings announcement/contact resources](https://www.helius.dev/blog/solana-privacy-rings) or [Helius contact](https://www.helius.dev/contact). Verify current submission channel before sending. No email has been sent by this package.

**Additional owner-reported evidence:** [V28 finalized status and public scan](../../deployments/mainnet/v28-observations.json). The operator reported successful V28 application verification and exported the public sealed-release evidence locally. The detailed full CI log and exact release export are not part of this source package; independent review remains outstanding.
