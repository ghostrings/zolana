# V29 candidate validation

- 35/35 dependency-free Node tests passed (31 inherited market arithmetic/lifecycle checks plus 4 pilot profile tests).
- 23/23 existing website observer/status tests passed.
- The owner's uploaded working Cargo.lock is byte-for-byte identical; its SHA-256 check passed.
- New shell script syntax and JavaScript syntax checks passed. Loopback configuration guard accepts localnet and rejects mainnet.
- All 286 files of the website V26 archive are retained; 281 are byte-for-byte unchanged. Changes are limited to .gitignore, README, native integration documentation, package scripts and accurate status-page wording. Existing transaction builders, signing, wallet, API status and deployment files are unmodified.
- Archive checks exclude keypair-shaped JSON and common keypair filenames and local directories. This is not a comprehensive secret or security audit.
- Rust/SBF compiler and Solana CLI are not installed in the packaging environment. New V29 Rust and local-validator tests have NOT been executed. Reference and syntax checks do not prove on-chain execution. Full app dependency installation/build and browser tests were not performed here.
- Mainnet V27 release identity and observer are unchanged. No deployment, upgrade, protocol initialization, activation, transaction or private settlement was performed.

## V31 candidate (supersedes prior local code; historical results above)

- New native fee and reference checks: 38 passed; lab-core checks: 6 passed; website observer checks: 23 passed.
- Cargo.lock unchanged. Rust/SBF/local validator/browser execution of changed code is pending.
- No deployment, real funds or private settlement.

## V32 review candidate

- Owner-reported V31 validator result: 5/5 tests passed, including all three fee tiers (historical only).
- Owner-reported V27 OtterSec remote build verification: exact hash match (historical deployed executable only).
- V32 packaging: 23 observer, 41 pricing/fee/metadata and 8 lab tests passed; shell and JS syntax checks passed.
- New Security.txt direct dependency edge to already resolved version 1.1.3; no resolved package versions changed.
- V32 Rust/SBF, real binary metadata, local-validator/browser execution, Docker build and independent review pending. No mainnet action.
