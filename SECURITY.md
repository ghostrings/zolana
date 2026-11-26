# Security and responsible disclosure

## Reporting

Do not open a public issue containing an exploit, private key, seed, wallet export, API token, production logs or personal financial data. Use the repository's private vulnerability reporting once enabled, or contact the project operator privately via an independently verified channel on https://privacycash.fun. Do not assume a private GitHub report is enabled until confirmed. Send a minimal sanitized reproducer, affected revision, impact, and remediation suggestion. Do not test against live user assets without explicit authorization.

## Scope and status

- This release candidate is unaudited and does not implement a live Custom Ring. The research lab is not a wallet, proof verifier, signer, relayer or auditor.
- The original application handles real funds. Preserve its current production deployment; testing this candidate must not use production wallets or API keys. The optional Ghost desk has a hot-key and inventory-risk model; do not publish operational secrets.
- `GET /api/custom-rings/status` is read-only and reports `canTransact: false`, `network: null` and `ringProgram: null`. There is no configuration override to enable Custom Ring execution.
- The public Rings indexer does not establish private holder balances or beneficial ownership. Synthetic aggregates are not audited or privacy-preserving guarantees for real datasets.
- Review dependency advisories on a connected build machine. The original platform documentation flags inherited advisories; this candidate does not claim these are resolved or that a complete dependency or security audit has run.

## Before a public repository or deployment

Owner must approve source and branding publication, choose a license if appropriate, review all tracked files and Git history for secrets, verify dependencies, enable private vulnerability reporting and require CI + code review. No CI secrets or deploy credentials are needed for the workflow included here. Never add a `pull_request_target` job that checks out or executes untrusted code with privileges. See [publication runbook](docs/engineering/PUBLISHING.md).
