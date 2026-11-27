#!/usr/bin/env bash
# Build the candidate for the existing public program ID. No keys, RPC or deployment.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
for tool in node python3 sha256sum solana-verify docker anchor; do
  command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }
done
[[ "$(solana-verify --version)" == 'solana-verify 0.5.2' ]] || { echo 'Expected solana-verify 0.5.2' >&2; exit 1; }
anchor --version | grep -q '0.32.1'
docker info >/dev/null
sha256sum -c evidence/Cargo.lock.sha256
PROGRAM='5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n'
BUILD="$(mktemp -d "$HOME/ghost-v41-review.XXXXXX")"
printf 'Review workspace: %s\n' "$BUILD"
FILES=(Cargo.toml Cargo.lock Anchor.toml crates/market-math/Cargo.toml crates/market-math/src/lib.rs reference/lifecycle-vectors.csv programs/ghost-markets/Cargo.toml programs/ghost-markets/src/lib.rs)
for file in "${FILES[@]}"; do install -D -- "$file" "$BUILD/source/$file"; done
install -D scripts/check-security-txt.mjs "$BUILD/check-security-txt.mjs"
cd "$BUILD/source"
# Only replace the public placeholder, never read or copy a program keypair.
python3 - "$PROGRAM" <<'PY'
from pathlib import Path
import sys
old='FQ9qkZv3nBnDubM5oznc4kF2LzzTA7i5xsmBkC6hAWbg'
for f in ['Anchor.toml','programs/ghost-markets/src/lib.rs']:
    p=Path(f); s=p.read_text(); assert s.count(old)==1, f; p.write_text(s.replace(old,sys.argv[1]))
PY
sha256sum "${FILES[@]}" > "$BUILD/source-sha256.txt"
# Build the enabled, restricted public pilot in Docker. Never deploy this automatically.
# The feature list must be identical in any subsequent remote verification submission.
unset ANCHOR_PROVIDER_URL ANCHOR_WALLET
solana-verify build --library-name ghost_markets -- --features public-v41 2>&1 | tee "$BUILD/docker-build.txt"
sha256sum -c "$BUILD/source-sha256.txt"
install -m 600 target/deploy/ghost_markets.so "$BUILD/ghost_markets.so"
node "$BUILD/check-security-txt.mjs" "$BUILD/ghost_markets.so" > "$BUILD/security-txt.json"
solana-verify get-executable-hash "$BUILD/ghost_markets.so" | tee "$BUILD/solana-verify-hash.txt"
# IDL only; do not overwrite the saved Docker-built executable with an Anchor build.
CARGO_TARGET_DIR="$BUILD/idl-target" anchor idl build --out "$BUILD/ghost_markets.json" -- --locked --features public-v41
sha256sum -c "$BUILD/source-sha256.txt"
python3 - "$BUILD/ghost_markets.json" "$PROGRAM" <<'PY'
import json,sys
with open(sys.argv[1]) as f: idl=json.load(f)
assert idl.get('address')==sys.argv[2], 'IDL address mismatch'
assert {'create_market','swap','graduate','claim_fees','initialize_protocol','set_protocol_mode'} <= {i['name'] for i in idl['instructions']}, 'IDL instruction mismatch'
PY
# Export only explicit public evidence, not a build cache or any generated key files.
mkdir -p "$BUILD/public/source"
for file in "${FILES[@]}"; do install -D -- "$file" "$BUILD/public/source/$file"; done
for file in ghost_markets.so ghost_markets.json security-txt.json solana-verify-hash.txt source-sha256.txt; do install -- "$BUILD/$file" "$BUILD/public/$file"; done
cd "$BUILD/public"
python3 - <<'PY'
import hashlib,json
from pathlib import Path
binary=Path('ghost_markets.so').read_bytes()
lines=Path('solana-verify-hash.txt').read_text().splitlines()
hashes=[l.strip() for l in lines if len(l.strip())==64 and all(c in '0123456789abcdef' for c in l.strip())]
assert len(hashes)==1, 'Expected exactly one executable hash'
Path('candidate.json').write_text(json.dumps({'programId':'5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n','version':'V41','buildFeatures':['public-v41'],'solanaVerifyVersion':'0.5.2','binaryBytes':len(binary),'binarySha256':hashlib.sha256(binary).hexdigest(),'solanaVerifyHash':hashes[0],'status':'local review candidate; NOT deployed or approved','privateSettlement':False},indent=2)+'\n')
PY
# Manifest covers all public files, without self-reference.
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum -c SHA256SUMS
printf '\nCandidate prepared: %s/public\nNo mainnet transaction, no key read, no activation.\n' "$BUILD"
printf 'Preserve V27 and V33 verification records. Publish candidate source only after review.\n'
