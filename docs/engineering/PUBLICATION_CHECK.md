# V28 public-source package — publication safety record

**Scope:** the delivered V28 archive only, prepared on 26 November 2026 for manual upload to [ghostrings/zolana](https://github.com/ghostrings/zolana). No access to the owner's local wallets, production configuration, GitHub history or RPC credentials was needed. No RPC or deployment transactions were sent during this revision. No repository changes were made remotely.

## What was checked

- Inventory: ordinary application source, documentation, static artwork, public deployment records, dependency lockfiles, build/CI configuration and tests. No private keypair/wallet JSON files, filled `.env` files, secret stores, generated build/validator directories, local databases, archives of private folders or Git history are included.
- Text review: checked common provider/API tokens, PEM private-key headers, JWTs, credential-bearing URLs, secret-setting literals, long base58 strings, potential byte-array keys and JSON structure. Reviewed matches were synthetic test data, documentation placeholders, public transaction signatures or package integrity strings. The example environment file is unpopulated for secrets; Render's credential settings use external configuration.
- Tests contain deliberately public deterministic test seeds, fake API credentials and generated ephemeral local keys. These are test fixtures, not owner credentials or reusable production wallets. Never fund or reuse them. JSON manifests and public account addresses are necessary for builds and verification and are not wallet key exports.
- Removed the machine-specific Windows username from the historical deployment guide. Extended ignore patterns for accidental future keypair, wallet, cache and local backup additions. Browser uploads ignore those patterns; do not upload directly from a working or deployment folder.
- Preserved the application execution source, original npm lockfile, exact supplied Rust Cargo.lock, and locked V27 program source. Refreshed the older Program B source inventory at `protocol/ghost-markets/evidence/SOURCE-SHA256.txt` to match this checkout. This inventory hashes the development source tree, **not** the deployed executable or its exact production-identity source. The sealed deployed binary fingerprint has not been changed.

## Reproduced offline checks

| Check | Result |
| --- | --- |
| Original application baseline | 229/229 |
| GHOST standalone tests | 17/17 |
| V28 market SDK tests | 21/21 |
| Market/reference and release verification tests | 34/34 |
| Supplied Rust lockfile | Exact SHA-256 match |

The owner reported that their full V28 verification passed, but its full log was not supplied here. [Owner-provided finalized RPC observations](../../deployments/mainnet/v28-observations.json) are distinct from these offline tests. No fresh full npm/CI/browser run or independent security audit was performed in this publication pass.

## Safe manual upload

Extract the ZIP into a new, empty directory. Upload only that extracted source tree, preserving hidden files and subdirectories. Do not copy your active development directory, wallet directory, or parent `~/.config/ghost-markets/` folder. Keep private keys, recovery phrases, actual `.env`, RPC/API secrets, local validator data and backups off GitHub. The exact public `v27-release/` export exists on the owner's machine and has not been supplied for this archive; do not substitute any locally generated binary. It may be uploaded separately only after reviewing the allowlisted export contents. Public addresses and transaction signatures in `deployments/mainnet/` are intentional. The program remains locked at the last reported verification; no Custom Ring or private settlement is operational.

This limited static review is not a comprehensive secret scan, dependency review or assurance that the existing public repository/history contains no credentials. A dedicated secret scanner and owner review are still recommended, along with rights and licensing review. Rotate any credential that has already been exposed; uploading a clean ZIP does not remove existing remote files or history. See [publication guide](PUBLISHING.md).
