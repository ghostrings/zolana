# V33 — treasury separation and native curve exit review

**Local review candidate only.** No deployment, upgrade, wallet funding, activation or private settlement is performed by this package. The currently verified locked V27 program is unchanged. The original privacycash.fun launch, wallet, Meteora, desk, RPC and Render routes are preserved.

## Evidence from the uploaded V32 archive

- 14/14 release checksum entries and 8/8 source checksum entries matched.
- 545,200-byte ELF; raw SHA-256 `492686130734e565991d553ec88d6af7a4084061cb0fb03ca1a49520c831545a`; zero-tail-normalized SHA-256 `b52af23a6f9efc7570704195d9de79301db516fa7a3e11c32cad3dc58ca200d8` matches the supplied Solana Verify record.
- IDL address equals `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n`; 11 instructions. The expected Security.txt strings are embedded. No private keypair files are present in the archive.
- Source differs from the V32 package only by the intended public program ID substitution in `Anchor.toml` and `declare_id!`; the lockfile and other source files match byte-for-byte.
- The owner reported 5/5 V32 public-pilot validator tests and a successful Docker build. Those logs were not contained in this archive and are not evidence of V33 execution. The historical V32 candidate is retained in `deployments/review/v32-candidate/`.

## Findings and changes

1. **Curve exit edge case.** With the fixed 1,000,000-token supply and 0.1 SOL virtual reserve, an exact buy of 0.025 SOL net produces a round-trip case where the gross return equals the real quote reserve. The old generic quote guard refused equality. V33 permits it only for a native curve sell; the constant-product invariant, real reserve bound, fee rounding and minimum-output checks remain in place. Graduated pools retain strictly positive reserves. This permits that specific valid final exit, not a guaranteed refund or unlimited liquidity. Fee liabilities remain segregated and claimable. Tests cover all three tiers, full round trip, over-reserve refusal, restart and minimum output.
2. **Treasury and approval were conflated.** V32 pinned the admin as each market's platform recipient. V33 adds an explicit `treasury` signer at initialization, separate from admin and pauser, and stores its address in protocol config schema 2. The pilot rejects a treasury-owned launch, a treasury approval authority, and treasury nomination as admin/pauser. Each market pins that treasury, and only the named beneficiary can claim fees. Neither the admin nor pauser can redirect existing fees. Treasury is immutable in this candidate: custody and recovery must be reviewed before initialization. A program upgrade can still replace checks.
3. **Schema and integration.** The new protocol config is 139 bytes (previously 107). The market account schema is unchanged. The candidate deliberately fails on older protocol config schema and provides no migration. Before any future same-address upgrade, freshly verify that the existing protocol account and market accounts are absent. If not, stop and design/test migration; never overwrite or reinterpret existing accounts. The website's observer remains pinned to V27 and will refuse an unexpected executable. V33 does not enable a production transaction route. The local lab uses separate synthetic actors with real local-validator transactions.
4. **Residual production risks.** Per-market cap is not a platform-wide cap; creator/admin approval is permissioned, not permissionless. Soft pause allows sells, graduation and fee claims; it is not a full emergency circuit breaker if settlement itself is faulty. Locked LP means no outside liquidity provision or principal redemption, and does not guarantee token holders can sell arbitrary amounts or recover original investment. Review protocol-level exposure, fee and market economics, low-liquidity/dust behavior, incident response, multisig roles and secure signing. Native fees remain 2/3/4%, 80/20 curve allocation, 100% platform graduated fees.
5. **Privacy boundary.** The candidate emits public market/trader events and uses public SPL transfers. It is not a Custom Ring or private market; no anonymous relayer, proof integration or private settlement is provided. Keep investor disclosures and public market data accurate.

## Verification and next gate

Run in a fresh local directory, not a production Render checkout:

```bash
npm ci
npm run markets:check
npm run markets:pilot:check
npm run markets:lab:check
npm run markets:pilot:local
```

The last command must pass locked and public-pilot actual Solana tests. It generates ephemeral local-only keys. Do not upload its working directory. Only after success run `npm run markets:prepare:v33` with Docker. IDL generation now uses a separate Cargo target directory to avoid the previous Docker-owned-directory failure. The preparation is keyless and sends no transaction. V33 changes the executable and IDL; V32 hashes and V27 verification cannot approve it. Reproduce, independently review, and reverify the final upgrade before any mainnet change.

The current archive is a preliminary technical review and source patch, not an independent security audit. No Rust or SBF toolchain was available in the packaging environment, so V33 compilation, validator execution and complete application build remain unverified. Browser-based real user wallet integration, production administrator co-signing, public market indexing, custody/incident procedures, release-specific IDL publication, and authorized Custom Ring settlement are still outstanding.
