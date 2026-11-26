# GHOST Markets — protocol engineering RFC 0001

**Status: proposed; public pricing reference tested locally. No ring, settlement program, proofs or on-chain deployment are included.**

This is an additive, isolated contribution for [ghostrings/zolana](https://github.com/ghostrings/zolana). It does not alter privacycash.fun's existing wallet, Meteora routes, Ghost desk, server or dependencies. It is not a successor production release and should not be used to execute real trades.

The objective is to own market execution while using supported Solana Privacy Rings for confidential, authorized settlement. Public token supply, declared related-party allocations, fee rules and market integrity remain verifiable. The design does not promise to hide issuer concentration, coordinated trades or all network metadata.

## Contents

- [Protocol RFC](RFC-0001.md): scope, boundaries, market lifecycle, proof integration and deployment gates.
- `src/quote.mjs`: dependency-free BigInt implementation of public constant-product exact-input quoting, with optional virtual reserve offsets, bounded u64 inputs, rounding and a strictly positive real reserve.
- `tests/quote.test.mjs`: 13 Node tests, including 10,000 deterministic property cases.
- `rust/`: proposed equivalent dependency-free Rust arithmetic library, **not compiled in the preparation environment**. This is not a Solana SBF program.
- [Validation](VALIDATION.md): what actually ran and what remains unverified.

## Run

From the repository root with Node 22:

```sh
node --test protocol/markets/tests/quote.test.mjs
```

With Rust 1.85 or later:

```sh
cargo test --locked --manifest-path protocol/markets/rust/Cargo.toml
```

No credentials or network access are needed by these unit tests. The supplied GitHub Actions workflow tests the Node and Rust references separately. Rust execution and parity are pending until CI actually runs; no green badge is claimed.

## Contributing

Do not add an on-chain settlement instruction until its proof and authorization semantics are validated with the upstream maintainers. A deployed program ID is not evidence of an activated ring or safe private markets. Preserve the repository's source rights and disclose limitations. No affiliation or endorsement is claimed.
