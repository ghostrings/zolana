#!/usr/bin/env bash
# Publish only the public sealed release snapshot. No private keys or transaction calls.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
ROOT="$(cd ../.. && pwd)"
REL="$HOME/.config/ghost-markets/mainnet-v27/release"
OUT="$ROOT/deployments/mainnet/v27-release"
PID='5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n'
AUTH='J4JRQza7JXnkct6kQC3roPYstoH2xFBoyQ5Wczpt5jPt'
HASH='2fba22c284791879f003aec3118c74fbd271f808f91b39e394e2654f9cc80d7d'
[[ -d "$REL" && ! -e "$OUT" ]] || { echo 'Original sealed release missing or export already exists.' >&2; exit 1; }
# No glob copying: exact allowlist matches the sealed V27 release source snapshot.
FILES=(release.json ghost_markets.so ghost_markets.json locked-test.txt SHA256SUMS source-sha256.txt source/Anchor.toml source/Cargo.lock source/Cargo.toml source/crates/market-math/Cargo.toml source/crates/market-math/src/lib.rs source/programs/ghost-markets/Cargo.toml source/programs/ghost-markets/src/lib.rs)
for f in "${FILES[@]}"; do [[ -f "$REL/$f" && ! -L "$REL/$f" ]] || { echo "Missing or unexpected link: $f" >&2; exit 1; }; done
printf '%s  %s\n' "$HASH" "$REL/ghost_markets.so" | sha256sum -c -
(cd "$REL" && sha256sum -c SHA256SUMS && sha256sum -c source-sha256.txt)
mkdir -p "$ROOT/deployments/mainnet"
STAGE="$(mktemp -d "$ROOT/deployments/mainnet/.v27-export.XXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
node scripts/mainnet-status.mjs verify "$REL" "$PID" "$AUTH" > "$STAGE/observed.json"
for f in "${FILES[@]}"; do mkdir -p "$STAGE/$(dirname "$f")"; cp -- "$REL/$f" "$STAGE/$f"; done
(cd "$STAGE" && sha256sum -c SHA256SUMS && sha256sum -c source-sha256.txt)
mv -- "$STAGE" "$OUT"
echo "Public release export: $OUT (no keys, no deployment or upgrade). Review before manual upload."
