#!/usr/bin/env bash
# Separate local validator upgrade test; never access the deployed GHOST program.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
NEW=$PWD
OLD=$(cd ../ghost-markets-pilot && pwd)
ROOT=$(cd ../.. && pwd)
for tool in node cargo solana solana-keygen anchor python3 sha256sum; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
anchor --version | grep -q '0.32.1'
solana --version | grep -q '2.3.0'
WORK=$(mktemp -d "$HOME/ghost-v41-compat.XXXXXX")
for v in old new; do
  src=$OLD; [[ "$v" != new ]] || src=$NEW
  mkdir -p "$WORK/$v/target/deploy"
  cp "$src/"{Cargo.toml,Cargo.lock,Anchor.toml} "$WORK/$v/"
  cp -a "$src/"{crates,programs,reference,evidence} "$WORK/$v/"
  ln -s "$ROOT/node_modules" "$WORK/$v/node_modules"
  (cd "$WORK/$v";sha256sum -c evidence/Cargo.lock.sha256)
done
solana-keygen new --no-bip39-passphrase --silent --outfile "$WORK/old/target/deploy/ghost_markets-keypair.json"
solana-keygen new --no-bip39-passphrase --silent --outfile "$WORK/old/target/localnet-wallet.json"
cp "$WORK/old/target/deploy/ghost_markets-keypair.json" "$WORK/new/target/deploy/ghost_markets-keypair.json"
unset ANCHOR_PROVIDER_URL ANCHOR_WALLET
(cd "$WORK/new";anchor keys sync;anchor build --no-idl -- -- --locked --features public-v41)
(cd "$WORK/old";anchor keys sync;anchor build --no-idl -- -- --locked --features public-pilot)
mkdir -p "$WORK/old/tests"
cp "$NEW/tests/compat.integration.mjs" "$WORK/old/tests/"
cd "$WORK/old"
python3 - <<'PY'
from pathlib import Path
p=Path('Anchor.toml');s=p.read_text();old='node --test tests/localnet.integration.mjs';assert old in s;p.write_text(s.replace(old,'node --test tests/compat.integration.mjs'))
PY
GHOST_V41_COMPAT=local-only anchor test --skip-build --provider.cluster localnet --provider.wallet target/localnet-wallet.json 2>&1 | tee "$WORK/compat-result.txt"
printf 'Local compatibility evidence: %s/compat-result.txt\nDo not publish the workspace; it contains temporary local test wallets.\n' "$WORK"
