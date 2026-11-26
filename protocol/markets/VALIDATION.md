# Validation record — 2026-11-26

## Completed locally

- Node v22.16.0: 13/13 tests passed (`node --test protocol/markets/tests/quote.test.mjs`).
- 10,000 fixed-seed public quote property cases passed within the Node suite.
- Checks include exact integer rounding, fee accounting, slippage, invalid base units, overflow, virtual versus real reserves, and constant-product nondecrease.
- See `node-test-evidence.txt` for the captured test output.

## Not verified

- Rust compiler, Cargo and Solana CLI were unavailable. Rust source is a proposed equivalent implementation and its tests were not run. Cross-language parity remains unverified.
- GitHub workflow is supplied but has not been executed remotely.
- No actual Solana program was generated, built, deployed, registered or activated. No program address, transaction signature, proof, audit or wallet integration is claimed.
- No new mint, liquidity account, custody, private swap, or other real asset movement is implemented.
- This is not a security audit or complete AMM model. LP operations, curve calibration, fees distribution, graduation, transaction authorization and proof composition require separate engineering and review.

This additive package does not replace any existing file from the supplied ghostrings-zolana repository. It has no npm dependency and no network/credential requirement at test runtime. Its scope is intentionally limited to public pricing arithmetic and an engineering RFC. Do not deploy the code as a market or represent it as an actual Custom Ring.
