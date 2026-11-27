# GHOST Markets V33 — mainnet deployment record

Operator-supplied finalized RPC output at slot 474351235 reports the V33 deployment at slot 474345522, initialized and active. The native market program settles **public SPL transactions**, requires administrator-approved issuance, and has a 1 SOL accounted reserve/fee-liability cap per market. Website signing is disabled pending independent security and economic review. No first native mainnet launch, Custom Ring, or V33 OtterSec verification is evidenced here.

- [Program explorer](https://orbmarkets.io/address/5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n)
- [Initialization transaction](https://explorer.solana.com/tx/4qToY4Ga19pY7QjbxaZg2UvXkBEp3BZ9exUjYhEuWZYF8coqjaRT1V7dvZ7amLUtBDeAtBXDTsYeV4ASQ3mUy7Z6)
- [Operator activation observation](activation-observation.json)
- [Verification status](https://verify.osec.io/status/5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n)

`candidate.json`, `SHA256SUMS`, the binary, IDL and source are preserved unchanged from the original sealed V33 build. The candidate status text records the time it was built, **not** the later deployment status. The additional `activation-observation.json` documents the subsequent operator-provided mainnet results. No activation signature was supplied; do not invent one. The older V27 verified commit is `b723d275bda85bac40ed9c9f4f7d3c479c5758d7` and does not verify V33.

Reproduce with Solana Verify 0.5.2, Solana 2.3.0, library `ghost_markets`, workspace `source`, feature `public-pilot`. From `source`: `solana-verify build --library-name ghost_markets -- --features public-pilot`. Expected Solana Verify hash `33a41e48d76fe0bbf936aa41e926a6ebb9005034cfcbf3651318a1ff0e8e9ec5`. Verify the original 14 checksums with `sha256sum -c SHA256SUMS` in this directory and eight source checksums with `(cd source && sha256sum -c ../source-sha256.txt)`.

2%, 3%, or 4% fees; curve fees 80% platform / 20% creator; graduated pool fees 100% platform. Creator premint zero, genesis liquidity locked by upgradeable code, not guaranteed immutable. No audited status or guaranteed exits are claimed. Public metadata, source, executable, public addresses and observed signature only; no keys or signed pending approvals.
