# Draft maintainer discussion

**Title:** docs: application readiness and public-vs-audited data boundaries for Custom Ring integrations

We are maintaining an independent application that already uses the Default Ring for private balances and has public market execution. While preparing a separate Custom Ring research integration, we found it useful to make the application's deployment readiness and the source/coverage of analytics explicit.

This is not a report of a verified upstream bug. Our current test model is synthetic and does not establish SDK or program compatibility. Before implementing a supported devnet adapter, would a small integrator checklist be useful in this repository?

Proposed scope:

- Record the exact network, SDK release, program identity, activation and artifact compatibility before presenting a ring as available.
- Fail closed on unknown or unavailable readiness, and distinguish local examples from supported protocol transactions.
- Record actual policy/authorization behavior and test rejection/rollback using the supported harness rather than assuming a local model matches the protocol.
- Separate shared public vault/index metrics from scoped audited reports; document the report's coverage and verification limits.

We have a short additive documentation draft, with no new transaction code or claims of official support. If the scope is useful, please suggest the preferred location and applicable contribution/check conventions. We will check ongoing work for overlap and align the text with the supported release before a draft PR.

References: [Custom Rings documentation](https://www.helius.dev/docs/privacy/integration/custom-ring), [Security](https://www.helius.dev/docs/privacy/security), [Privacy Rings examples](https://github.com/helius-labs/privacy-ring-examples).
