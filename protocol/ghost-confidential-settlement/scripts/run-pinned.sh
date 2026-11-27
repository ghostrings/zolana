#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$1
WORK=$2
[[ "$HOME" == "$WORK/home" && "$CARGO_HOME" == "$WORK/cargo" ]] || { echo 'Isolated home required' >&2; exit 1; }
EVIDENCE="$WORK/evidence"
python3 "$ROOT/scripts/fetch-upstream.py" "$WORK/upstream"
cd "$WORK/upstream/swap/xark"
load_paths(){
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      ZOLANA_CLI_BIN|SHIELDED_POOL_PROGRAM_PATH|PROVER_BIN|ZOLANA_PHOTON_BIN|SURFPOOL_BIN|USER_REGISTRY_PROGRAM_PATH) ;;
      *) echo "Unexpected upstream environment key: $key" >&2; return 1 ;;
    esac
    [[ "$value" == "$WORK/"* && -f "$value" && "$value" != *$'\r'* ]] || { echo "Unexpected $key path" >&2; return 1; }
    local canonical; canonical=$(realpath -- "$value")
    [[ "$canonical" == "$WORK/"* ]] || { echo 'Artifact escaped isolated workspace' >&2; return 1; }
    export "$key=$canonical"
  done < "$1"
}
bash scripts/setup-zk-tools.sh > "$EVIDENCE/setup.env"
load_paths "$EVIDENCE/setup.env"
: "${ZOLANA_CLI_BIN:?Missing CLI}"
"$ZOLANA_CLI_BIN" zk compile --test --skip-wasm --manifest-path program/Cargo.toml 2>&1 | tee "$EVIDENCE/compile.txt"
bash scripts/check-keys.sh | tee "$EVIDENCE/keys.txt"
cargo build-sbf --manifest-path program/Cargo.toml --tools-version v1.54 -- --locked --features bpf-entrypoint 2>&1 | tee "$EVIDENCE/build.txt"
bash scripts/build-localnet.sh > "$EVIDENCE/localnet.env"
load_paths "$EVIDENCE/localnet.env"
: "${SHIELDED_POOL_PROGRAM_PATH:?}" "${PROVER_BIN:?}" "${ZOLANA_PHOTON_BIN:?}" "${SURFPOOL_BIN:?}" "${USER_REGISTRY_PROGRAM_PATH:?}"
export ZOLANA_PROVER_KEYS_DIR="$HOME/.config/zolana/proving-keys"
mkdir -p "$ZOLANA_PROVER_KEYS_DIR"
# Use upstream fixture actors and its own local validator, indexer and prover.
# These tests never use GHOST mainnet or customer wallets.
cargo test --release --locked -p swap-test --test swap make_and_take_swap_inline -- --exact --nocapture --test-threads=1 2>&1 | tee "$EVIDENCE/swap.txt"
grep -Eq 'test result: ok\. 1 passed; 0 failed' "$EVIDENCE/swap.txt"
cargo test --release --locked -p swap-test --test cancel make_and_cancel_swap_inline -- --exact --nocapture --test-threads=1 2>&1 | tee "$EVIDENCE/cancel.txt"
grep -Eq 'test result: ok\. 1 passed; 0 failed' "$EVIDENCE/cancel.txt"
printf 'Upstream SPL/SOL proof baseline passed (fixture assets only).\nNot a GHOST/ZOL integration or production proving setup.\nEvidence: %s\nNever upload the whole workspace.\n' "$EVIDENCE"
