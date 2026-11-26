# Engineering intake draft — Helius Privacy Rings

**Draft for project owner review.** Suggested destination: official Helius integration support or `sales@helius.xyz` as listed in the [Custom Rings integration documentation](https://www.helius.dev/docs/privacy/integration/custom-ring). This is a request for technical collaboration, not an existing accepted pilot, grant application form or partnership. Do not send until a shareable repository and verified evidence are available.

**Subject:** privacycash.fun / GHOST — existing Default Ring integration and Custom Ring engineering pilot

Hello Helius Privacy team,

We are developing privacycash.fun, an independent Solana launchpad and self-custodial wallet application built around Solana Privacy Rings and Meteora bonding curves. Our existing application uses the Default Ring for private balances and transfers, and includes an optional inventory-based confidential settlement path and a public Rings explorer. We distinguish public AMM execution from private settlement and do not claim Default Ring anonymity.

We are preparing GHOST, an application foundation for a future Custom Ring integration:

- GHOST Launch: the existing token launch and public market execution path.
- GHOST Wallet: the existing encrypted wallet plus an explicit ring-readiness boundary.
- GHOST Ring: a strictly synthetic policy and atomic settlement model. No Custom Ring is deployed and no real Custom Ring transaction is supported today.
- GHOST Intelligence: public vault/index metrics and a separate synthetic reporting prototype, with a future independently reviewed aggregate auditor-report interface.

Our reproducible local research evidence currently includes 17 passing standalone tests, a seeded 2,000-operation state-machine check, a deterministic demo covering accepted and rejected operations, and 229 unchanged original v23 files verified against SHA-256 baseline hashes. The full locked dependency install, regression suite, production build and live devnet integration remain pending. The research target is not an upstream deployment manifest or a claim of anonymity. We intend to validate the supported confidential devnet path first, and evaluate additional modes only after upstream support and appropriate operational/security/legal review.

We would value technical feedback on the following:

1. Which released Custom Ring SDK, program artifacts and devnet integration harness should an independent application pin?
2. What is the expected supported activation, enrollment, policy and transaction-authorization contract, including pause and recovery behavior?
3. Which atomic settlement approach is supported for two-party exchange, and what negative/conformance tests would be useful to your maintainers?
4. How should auditor access and scoped, independently verifiable aggregate reporting be integrated without treating public vault totals as private holder balances?
5. Is a small application-readiness documentation contribution useful, and is there an appropriate channel for a confidential devnet integration pilot or technical review?

Our intended approach is to reuse the official SDK and reference implementation, make focused upstream contributions, and avoid introducing new cryptography or unsupported production behavior.

Website: https://privacycash.fun
GitHub namespace: https://github.com/ghostrings
Repository/revision: https://github.com/ghostrings/zolana — [confirm access and insert actual commit SHA after upload]
Verification: [insert actual green CI run or clearly labelled pending checks, plus the reproducible demo and validation record]
Technical contact: [insert authorized project contact]

Thank you for your time. We'd be happy to share a minimal reproduction and align on a contribution that is useful to the broader Rings ecosystem.

privacycash.fun / GHOST engineering
