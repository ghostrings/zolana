#!/usr/bin/env bash
# Build and test in a fresh isolated workspace; no mainnet keys, RPC, deployment or upgrade.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
WORKSPACE="$PWD"
ROOT="$(cd ../.. && pwd)"
for tool in node cargo solana solana-keygen anchor python3 sha256sum; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
anchor --version | grep -q '0.32.1'
solana --version | grep -q '2.3.0'
sha256sum -c evidence/Cargo.lock.sha256
node --input-type=module -e 'await import("@solana/web3.js"); await import("@solana/spl-token")'
node --test tests/quote.test.mjs tests/lifecycle.test.mjs tests/pilot-profile.test.mjs tests/security-txt.test.mjs
BUILD="$(mktemp -d "$HOME/ghost-pilot-local.XXXXXX")"
printf 'Fresh loopback workspace: %s\n' "$BUILD"
cp -- Cargo.toml Cargo.lock Anchor.toml "$BUILD/"
cp -a -- crates programs reference tests evidence scripts "$BUILD/"
ln -s "$ROOT/node_modules" "$BUILD/node_modules"
cd "$BUILD"
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase --silent --outfile target/deploy/ghost_markets-keypair.json
solana-keygen new --no-bip39-passphrase --silent --outfile target/localnet-wallet.json
anchor keys sync
grep -Eiq '^[[:space:]]*cluster[[:space:]]*=[[:space:]]*("localnet"|'"'"'localnet'"'"')[[:space:]]*$' Anchor.toml
unset ANCHOR_PROVIDER_URL ANCHOR_WALLET GHOST_MARKETS_TEST_MODE
cargo test --workspace --locked
cargo test --workspace --locked --features ghost-markets/public-pilot
# Test default locked artifact with existing regression suite first.
anchor build --no-idl -- -- --locked
node scripts/check-security-txt.mjs target/deploy/ghost_markets.so > target/locked-security-txt.json
mkdir -p target/idl
anchor idl build --out "$PWD/target/idl/ghost_markets.json" -- --locked
GHOST_MARKETS_TEST_MODE=locked anchor test --skip-build --provider.cluster localnet --provider.wallet target/localnet-wallet.json 2>&1 | tee target/locked-local-test.txt
# Use the pilot suite only after the locked baseline succeeds.
python3 - <<'PY'
from pathlib import Path
p=Path('Anchor.toml');s=p.read_text();old='node --test tests/localnet.integration.mjs';assert old in s;p.write_text(s.replace(old,'node --test tests/pilot.integration.mjs'))
PY
anchor build --no-idl -- -- --locked --features public-pilot
node scripts/check-security-txt.mjs target/deploy/ghost_markets.so > target/public-pilot-security-txt.json
anchor idl build --out "$PWD/target/idl/ghost_markets.json" -- --locked --features public-pilot
GHOST_MARKETS_TEST_MODE=public-pilot anchor test --skip-build --provider.cluster localnet --provider.wallet target/localnet-wallet.json 2>&1 | tee target/public-pilot-local-test.txt
sha256sum -c evidence/Cargo.lock.sha256
# Do not leave an enabled artifact under the repository's deploy directory.
# Evidence remains local to this private build directory; never upload it wholesale.
printf '\nLocal checks complete. No mainnet transaction. Keep this workspace private; it contains ephemeral test keys.\n'
printf 'Public pilot test output: %s/target/public-pilot-local-test.txt\n' "$BUILD"
