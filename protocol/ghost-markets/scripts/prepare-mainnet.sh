#!/usr/bin/env bash
# Prepare a fresh, locked mainnet candidate. All tests run on loopback; no real transactions.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
WORKSPACE="$PWD"
ROOT="$(cd ../.. && pwd)"
KEYDIR="$HOME/.config/ghost-markets/mainnet-v27"
for tool in node cargo solana solana-keygen anchor python3 sha256sum; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
anchor --version | grep -q '0.32.1'
solana --version | grep -q '2.3.0'
sha256sum -c evidence/Cargo.lock.sha256
# Do not accept a V26 test or a partially completed V27 run.
test -s target/v27-local-evidence/locked-program-sha256.txt || { echo 'Run scripts/test-localnet.sh successfully first.' >&2; exit 1; }
sha256sum -c target/v27-local-evidence/locked-program-sha256.txt
node --test tests/release-verify.test.mjs
test -d "$ROOT/node_modules/@solana/web3.js" || { echo 'Run npm ci in the Linux repository root.' >&2; exit 1; }
mkdir -p "$KEYDIR"; chmod 700 "$KEYDIR"
if [[ -e "$KEYDIR/release" ]]; then echo "Release already exists: $KEYDIR/release. Review it; refusing to replace it." >&2; exit 1; fi
for file in program.json deployer.json; do
  if [[ ! -f "$KEYDIR/$file" ]]; then solana-keygen new --outfile "$KEYDIR/$file"; fi
  chmod 600 "$KEYDIR/$file"
done
PROGRAM_ID="$(solana-keygen pubkey "$KEYDIR/program.json")"
AUTHORITY="$(solana-keygen pubkey "$KEYDIR/deployer.json")"
LOCAL_ID="$(solana-keygen pubkey target/deploy/ghost_markets-keypair.json)"
[[ "$PROGRAM_ID" != "$AUTHORITY" && "$PROGRAM_ID" != "$LOCAL_ID" && "$AUTHORITY" != "$LOCAL_ID" ]] || { echo 'Mainnet identities must be separate from local test identities.' >&2; exit 1; }
BUILD="$(mktemp -d "$KEYDIR/build.XXXXXX")"
cp -- Cargo.toml Cargo.lock Anchor.toml "$BUILD/"
cp -a -- crates programs reference tests evidence "$BUILD/"
ln -s "$ROOT/node_modules" "$BUILD/node_modules"
cd "$BUILD"
# Local tests of the production identity use a distinct funded local validator wallet.
mkdir -p target/deploy
ln -s "$KEYDIR/program.json" target/deploy/ghost_markets-keypair.json
solana-keygen new --no-bip39-passphrase --silent --outfile target/localnet-wallet.json
# Anchor keys sync changes only this private build's source ID and localnet mapping.
anchor keys sync
grep -Eiq "^[[:space:]]*cluster[[:space:]]*=[[:space:]]*(\"localnet\"|'localnet')[[:space:]]*$" Anchor.toml
unset ANCHOR_PROVIDER_URL ANCHOR_WALLET GHOST_MARKETS_TEST_MODE
cargo test --workspace --locked
# Explicitly build DEFAULT features. Do not call the local-market-testing build here.
anchor build --no-idl -- -- --locked
mkdir -p target/idl
anchor idl build --out "$PWD/target/idl/ghost_markets.json" -- --locked
sha256sum target/deploy/ghost_markets.so > target/locked-before-test.sha256
GHOST_MARKETS_TEST_MODE=locked anchor test --skip-build --provider.cluster localnet --provider.wallet target/localnet-wallet.json 2>&1 | tee target/locked-mainnet-candidate-test.txt
sha256sum -c target/locked-before-test.sha256
sha256sum -c evidence/Cargo.lock.sha256
# Seal a public-source/artifact-only release snapshot after the locked test passes.
OUT="$BUILD/release"
mkdir -p "$OUT/source"
cp -- target/deploy/ghost_markets.so "$OUT/ghost_markets.so"
cp -- target/idl/ghost_markets.json "$OUT/ghost_markets.json"
cp -- target/locked-mainnet-candidate-test.txt "$OUT/locked-test.txt"
cp -- Cargo.toml Cargo.lock Anchor.toml "$OUT/source/"
cp -a -- crates programs "$OUT/source/"
python3 - "$OUT" "$PROGRAM_ID" "$AUTHORITY" <<'PY'
import hashlib,json,pathlib,sys
out=pathlib.Path(sys.argv[1]); b=(out/'ghost_markets.so').read_bytes(); idl=json.loads((out/'ghost_markets.json').read_text())
assert b[:4]==b'\x7fELF' and idl.get('address')==sys.argv[2], 'Incorrect binary or IDL identity'
manifest=dict(schema=1,release='v27-locked-candidate',marketExecution=False,buildFeatures='default',programId=sys.argv[2],plannedUpgradeAuthority=sys.argv[3],binarySha256=hashlib.sha256(b).hexdigest(),binaryBytes=len(b),lockSha256=hashlib.sha256((out/'source/Cargo.lock').read_bytes()).hexdigest(),lockedLoopbackTest='passed',securityReview='required; not certified')
(out/'release.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
(cd "$OUT" && find source -type f -print0 | sort -z | xargs -0 sha256sum > source-sha256.txt && sha256sum release.json ghost_markets.so ghost_markets.json locked-test.txt source-sha256.txt > SHA256SUMS)
mv "$OUT" "$KEYDIR/release"
cat "$KEYDIR/release/release.json"
printf '\nPrepared locked release (no mainnet transaction): %s/release\n' "$KEYDIR"
# The separate deployment script requires explicit independent review and approval.
