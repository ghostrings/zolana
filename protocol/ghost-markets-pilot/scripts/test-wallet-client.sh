#!/usr/bin/env bash
# Disposable loopback-only V33 test. Never reads mainnet keys.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
ROOT="$(cd ../.. && pwd)"
for tool in node cargo solana solana-keygen anchor python3 sha256sum; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
anchor --version | grep -q '0.32.1'
solana --version | grep -q '2.3.0'
sha256sum -c evidence/Cargo.lock.sha256
node --input-type=module -e 'await import("@solana/web3.js"); await import("@solana/spl-token")'
BUILD="$(mktemp -d "$HOME/ghost-wallet-local.XXXXXX")"
cp -- Cargo.toml Cargo.lock Anchor.toml "$BUILD/"
cp -a -- crates programs reference tests lab wallet evidence "$BUILD/"
ln -s "$ROOT/node_modules" "$BUILD/node_modules"
cd "$BUILD"
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase --silent --outfile target/deploy/ghost_markets-keypair.json
solana-keygen new --no-bip39-passphrase --silent --outfile target/localnet-wallet.json
anchor keys sync
grep -Eiq '^[[:space:]]*cluster[[:space:]]*=[[:space:]]*("localnet"|'"'"'localnet'"'"')[[:space:]]*$' Anchor.toml
python3 - <<'PY'
from pathlib import Path
p=Path('Anchor.toml');s=p.read_text();old='node --test tests/localnet.integration.mjs';assert s.count(old)==1;p.write_text(s.replace(old,'node --test tests/wallet-client.integration.mjs'))
PY
unset ANCHOR_PROVIDER_URL ANCHOR_WALLET GHOST_MARKETS_TEST_MODE
anchor build --no-idl -- -- --locked --features public-pilot
mkdir -p target/idl
anchor idl build --out "$PWD/target/idl/ghost_markets.json" -- --locked --features public-pilot
GHOST_WALLET_TEST=fresh-local-only anchor test --skip-build --provider.cluster localnet --provider.wallet target/localnet-wallet.json 2>&1 | tee target/wallet-client-test.txt
sha256sum -c evidence/Cargo.lock.sha256
printf 'Wallet test complete. Private disposable workspace: %s\n' "$BUILD"
printf 'Public log: %s/target/wallet-client-test.txt\n' "$BUILD"
