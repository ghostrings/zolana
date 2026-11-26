#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
for tool in node cargo solana solana-keygen anchor sha256sum; do command -v "$tool" >/dev/null || { echo "Missing $tool; see README.md" >&2; exit 1; }; done
anchor --version | grep -q '0.32.1' || { echo 'Expected Anchor CLI 0.32.1' >&2; exit 1; }
solana --version | grep -q '2.3.0' || { echo 'Expected Solana CLI 2.3.0' >&2; exit 1; }
grep -Eiq "^[[:space:]]*cluster[[:space:]]*=[[:space:]]*(\"localnet\"|'localnet')[[:space:]]*$" Anchor.toml || { echo 'Refusing non-localnet Anchor config' >&2; exit 1; }
node --input-type=module -e 'await import("@solana/web3.js"); await import("@solana/spl-token")' || { echo 'Run npm ci in the parent Zolana checkout.' >&2; exit 1; }
sha256sum -c evidence/Cargo.lock.sha256
# Dedicated local validator keys. Never read the default CLI wallet.
umask 077
mkdir -p target/deploy target/v27-local-evidence
rm -f target/v27-local-evidence/locked-program-sha256.txt
for file in target/deploy/ghost_markets-keypair.json target/localnet-wallet.json; do
  if [[ ! -e "$file" ]]; then solana-keygen new --no-bip39-passphrase --silent --outfile "$file"; fi
done
anchor keys sync
unset ANCHOR_PROVIDER_URL ANCHOR_WALLET GHOST_MARKETS_TEST_MODE
# Test both variants, including the exact default-feature lock behavior.
# Run the enabled variant first, and finish with the locked artifact; never publish the enabled .so.
# Shell pipefail makes a failed test fail the entire runner.
cargo test --workspace --locked
cargo test --workspace --locked --features ghost-markets/local-market-testing
anchor build --no-idl -- -- --locked --features local-market-testing
mkdir -p target/idl
anchor idl build --out "$PWD/target/idl/ghost_markets.json" -- --locked --features local-market-testing
GHOST_MARKETS_TEST_MODE=local anchor test --skip-build --provider.cluster localnet --provider.wallet target/localnet-wallet.json 2>&1 | tee target/v27-local-evidence/local-market-test.txt
anchor build --no-idl -- -- --locked
mkdir -p target/idl
anchor idl build --out "$PWD/target/idl/ghost_markets.json" -- --locked
GHOST_MARKETS_TEST_MODE=locked anchor test --skip-build --provider.cluster localnet --provider.wallet target/localnet-wallet.json 2>&1 | tee target/v27-local-evidence/locked-test.txt
sha256sum -c evidence/Cargo.lock.sha256
sha256sum target/deploy/ghost_markets.so > target/v27-local-evidence/locked-program-sha256.txt
cat target/v27-local-evidence/locked-program-sha256.txt
printf '\nBoth loopback variants passed. Final local artifact is locked, NOT the production identity.\n'
