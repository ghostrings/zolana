#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
for tool in node cargo solana solana-keygen anchor; do command -v "$tool" >/dev/null || { echo "Missing $tool; see README.md" >&2; exit 1; }; done
anchor --version | grep -q '0.32.1' || { echo 'Expected Anchor CLI 0.32.1' >&2; exit 1; }
solana --version | grep -q '2.3.0' || { echo 'Expected Solana CLI 2.3.0' >&2; exit 1; }
grep -q '^cluster = "Localnet"$' Anchor.toml || { echo 'Refusing non-localnet Anchor config' >&2; exit 1; }
node --input-type=module -e 'await import("@solana/web3.js"); await import("@solana/spl-token")' || { echo 'Run npm ci in the parent Zolana checkout.' >&2; exit 1; }
# Use a dedicated local validator key. Never read ~/.config/solana/id.json.
umask 077
mkdir -p target/deploy
for file in target/deploy/ghost_markets-keypair.json target/localnet-wallet.json; do
  if [[ ! -e "$file" ]]; then solana-keygen new --no-bip39-passphrase --silent --outfile "$file"; fi
done
anchor keys sync
# Reject inherited provider overrides. The explicit config and CLI flags remain localnet.
unset ANCHOR_PROVIDER_URL ANCHOR_WALLET
anchor test --provider.cluster localnet --provider.wallet target/localnet-wallet.json
