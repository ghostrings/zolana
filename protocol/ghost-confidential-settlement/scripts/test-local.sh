#!/usr/bin/env bash
# A real upstream proof test on disposable local fixtures only. NOT production proving keys.
set -euo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
for tool in python3 curl cargo rustup cargo-build-sbf shasum; do command -v "$tool" >/dev/null || { echo "Missing $tool; see $ROOT/README.md" >&2; exit 1; }; done
WORK=$(mktemp -d "$HOME/ghost-confidential-local.XXXXXX")
RUSTUP_DIR=${RUSTUP_HOME:-$HOME/.rustup}
mkdir -p "$WORK/home" "$WORK/cargo" "$WORK/evidence"
printf 'Local-only proof workspace: %s\nInsecure upstream test keys. Never deploy or fund this example.\n' "$WORK"
# Use no inherited RPC, key paths, API tokens, wallet config or shell startup files.
# Only the installed rustup toolchain and executable search path are reused.
env -i HOME="$WORK/home" CARGO_HOME="$WORK/cargo" RUSTUP_HOME="$RUSTUP_DIR" PATH="$PATH" LANG=C.UTF-8 TERM=dumb \
  bash --noprofile --norc "$ROOT/scripts/run-pinned.sh" "$ROOT" "$WORK"
