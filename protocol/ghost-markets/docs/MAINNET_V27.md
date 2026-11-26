> **Historical runbook.** The owner has already deployed the locked V27 binary at `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n`. Do not repeat deployment or generate replacement keys. V28 uses read-only verification and [evidence export](../../../deployments/mainnet/README.md). Independent review was not established in the supplied output.

# V27 · Direct mainnet preparation (locked candidate)

**Not a production exchange.** This candidate exists to permit independent review of a fresh, intentionally inactive executable. No market operations or private settlement are available in the default binary. A different, reviewed upgrade will be required before the deployment can operate a market. Do not deploy the `local-market-testing` feature to mainnet. There is no public devnet requirement in this runbook; all conformance tests use an isolated local validator.

## Preserve your tested V26 workspace

The supplied `Cargo.lock` is the exact file provided by the owner after the successful V26 build. Do not regenerate it, remove the compatible pins, or reuse any local validator keys for mainnet. The source ZIP contains no private keypair, populated `.env`, `node_modules`, or `target/`. The public mainnet program address is recorded in the newer V28 deployment documentation. Upload the public source files manually, after publication review. Do not upload a working directory containing generated keys, build products or private configuration.

The following paths assume the existing Linux repository is `~/src/Ghostring` and the owner has already installed the pinned toolchain, Node and npm dependencies. If the extracted V27 ZIP is in Windows `Downloads/ghostrings-zolana-v27`, overlay only the source files as shown below. Do not copy generated keys from Windows or replace `target/`.

```bash
cd ~/src/Ghostring
# Set this variable to your actual extracted V27 source directory.
V27_SOURCE="/mnt/c/Users/YOUR_WINDOWS_USER/Downloads/ghostrings-zolana-v27"
cp -a "$V27_SOURCE/." .
cd protocol/ghost-markets
sha256sum -c evidence/Cargo.lock.sha256
bash scripts/test-localnet.sh
```

Change the Windows path to match the actual extracted folder. This copy intentionally updates `Anchor.toml` and `declare_id!` to the packaged placeholder, not the secret key files; the runner resynchronizes to the existing local key. Existing backup lockfiles remain local. On a fresh Linux checkout run `npm ci` at repository root first. No version-control commands are required.

## Gate 1 — Local execution and locked-build checks

The runner executes the Rust workspace tests twice (default and local-only feature), builds the local-enabled binary, and exercises the actual market lifecycle and new controls. It then rebuilds with default features and tests that even the verified upgrade authority cannot activate it or create a market. Both must pass; the final `target/deploy/ghost_markets.so` is the locked **local identity** artifact. `target/v27-local-evidence/locked-program-sha256.txt` is written only on success. Do not deploy any local test artifact.

## Gate 2 — Prepare a separate mainnet identity and exact locked binary

```bash
cd ~/src/Ghostring/protocol/ghost-markets
bash scripts/prepare-mainnet.sh
```

The script creates a new program identity and a separate deployment wallet under `~/.config/ghost-markets/mainnet-v27/` (never in the repository). Key generation may display recovery words; keep them private and securely backed up. Do not fund these wallets until the candidate has been reviewed. The script copies only the Rust workspace and tests to a private temporary build directory, synchronizes the fresh program ID, uses the supplied lockfile, compiles default features, and runs the locked tests again with a separate local validator wallet. It seals the exact tested binary, IDL, log and corresponding public source in `~/.config/ghost-markets/mainnet-v27/release/`. This step never sends a mainnet transaction. It refuses to overwrite an existing sealed release.

Review `release/release.json` and the exact release/source hashes. The program address is reserved by the keypair, not deployed. The only public files in the release directory are intended for review; do not share the surrounding key directory. Verify the IDL, exact source and program bytes independently. Matching a binary hash does not prove reproducible compilation or an audit.

## Gate 3 — Read-only mainnet preflight and independent review

```bash
bash scripts/deploy-mainnet.sh preflight
```

The default endpoint is `https://api.mainnet-beta.solana.com`; a trusted HTTPS RPC may be supplied privately in `GHOST_MAINNET_RPC` if the public service rate limits. The preflight checks the full mainnet genesis hash, confirms the program, ProgramData and config PDAs are absent, validates the sealed release and reports the current payer balance and rent estimates in lamports. It neither signs nor sends a transaction. Rent estimates do not include all transaction fees or possible extra allocation. A fresh locked deployment spends real SOL and may require temporary buffer funding; there is no guarantee of an exact deployment cost.

Before proceeding, independently review the new code, lockfile/security advisories, both local test logs, source-to-binary provenance, key backup and planned upgrade authority. Keep the entire release inactive and separate from the live frontend. The existing market code was tested in V26, but V27 changes the instruction ABI and needs fresh conformance. The user-confirmed V26 success does not authorize any V27 deployment. The deployment wallet will initially hold upgrade authority; production governance requires a separately reviewed multisig transfer. The upgrade authority can replace the entire locked program; this is not an immutable lock.

## Gate 4 — Optional fresh locked deployment after review

Use only the `deploy` action with the independently reviewed binary SHA-256. Do not substitute a hash merely because it is printed in the preparation log; the value is an explicit operator attestation that independent review of the exact release occurred.

```bash
# Set GHOST_REVIEWED_SHA256 to the actual independently reviewed 64-character digest.
# Do not run until the required review and funding decision are complete.
bash scripts/deploy-mainnet.sh deploy
```

The script verifies the checksums and expected identities, requires the exact reviewed hash in `GHOST_REVIEWED_SHA256`, repeats mainnet preflight, and prompts for the exact program ID. Only the user's confirmation can trigger `solana program deploy`. It refuses any existing target, so it is not an upgrade script. It does not initialize the config, start a market, register a ring, fund a vault, or change your global Solana CLI configuration. If deployment fails or post-deployment verification is delayed, do not repeat blindly; inspect the actual on-chain address and any buffer account. Solana CLI errors and real funding decisions require manual review.

## Gate 5 — Verify and publish the actual deployment

```bash
bash scripts/deploy-mainnet.sh verify
```

Read-only verification checks the mainnet genesis hash, loader owner, executable flag, ProgramData PDA, slot, current upgrade authority and byte-for-byte code (allowing only zero allocation padding). It checks the protocol config is absent as expected for a fresh deployment. Publish the genuine public program ID, slot, reviewed source snapshot, IDL, binary hash and receipt only after verification succeeds. Do not claim deployed code is audited, live trading is available or a Helius Custom Ring is activated. Do not publish recovery phrases, program/deployer keypairs, the local validator wallet, RPC credentials, or the entire private build directory.

## Gate 6 — Operational market release is a different project

The default executable has no operational unlock instruction. A later security-reviewed upgrade would have to provide a production activation mechanism, approved quote assets, safe stalled-launch recovery, reviewed pause/exit semantics, frontend integration, monitoring, and governance. Helius Program A, registry/activation and a market proof adapter are separate milestones. Program B cannot provide anonymous trading, hidden AMM reserves or proof-bound private settlement today.

References: [Solana program deployment](https://solana.com/docs/programs/deploying), [Anchor validator configuration](https://www.anchor-lang.com/docs/references/anchor-toml), [Solana ProgramData authorization pattern](https://github.com/solana-foundation/developer-content/blob/main/content/courses/program-optimization/program-configuration.md).
