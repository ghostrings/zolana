# Proposed upstream contribution — integration readiness and exact-release evidence

Status: draft discussion, not a submitted PR. Repository: [helius-labs/custom-privacy-rings](https://github.com/helius-labs/custom-privacy-rings). Start by asking maintainers whether an application-facing conformance checklist belongs in the reference implementation or examples repository.

## Problem

An application may have a real deployed executable without an initialized or activated ring. A matching bytecode hash establishes identity, not an audit or proof correctness. Application clients need to distinguish program deployment, protocol registration, governance activation and support for specific settlement operations.

## Proposed additive change

A short integration-readiness checklist covering supported release pin, cluster and program IDs, registration and activation evidence, explicit feature readiness, negative conformance cases, auditor access disclosures and no-real-funds test boundaries. It should also clarify that public reserve changes are not hidden by private settlement alone. Do not alter core circuits or public SDK APIs as part of the documentation PR.

## Evidence and reproduction

Our independent application now has a locked mainnet Program B, and a read-only observer which compares the pinned release against finalized RPC account data. The fixture checks mismatched bytecode, owner, ProgramData pointer, authority, cluster and slot; malformed public market data; and refusal of state-changing RPC methods. These are application tests, not upstream ring proof tests. `npm run markets:check` in [ghostrings/zolana](https://github.com/ghostrings/zolana) runs the offline fixture suite. The prior [draft patch](0001-docs-application-readiness.patch) needs rebasing and maintainer review before use.

Ask for maintainer feedback first; then prepare a small targeted patch against the actual current upstream commit. No PR or issue has been submitted, and no ring has been whitelisted.
