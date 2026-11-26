#!/usr/bin/env bash
# Fresh locked deployment only. Explicit owner action, no auto-deploy or upgrade.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
KEYDIR="$HOME/.config/ghost-markets/mainnet-v27"
REL="$KEYDIR/release"
RPC="${GHOST_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
usage(){ echo 'Usage: bash scripts/deploy-mainnet.sh preflight|verify|deploy'; }
[[ $# -eq 1 ]] || { usage; exit 1; }
ACTION="$1"
[[ -f "$REL/SHA256SUMS" ]] || { echo 'Prepare and review the locked candidate first.' >&2; exit 1; }
(cd "$REL" && sha256sum -c SHA256SUMS && sha256sum -c source-sha256.txt)
PID="$(solana-keygen pubkey "$KEYDIR/program.json")"
AUTH="$(solana-keygen pubkey "$KEYDIR/deployer.json")"
[[ "$PID" != "$AUTH" ]] || { echo 'Expected distinct program and deployer identities' >&2; exit 1; }
case "$ACTION" in
  preflight) node scripts/mainnet-status.mjs preflight "$REL" "$PID" "$AUTH"; exit 0;;
  verify) node scripts/mainnet-status.mjs verify "$REL" "$PID" "$AUTH"; exit 0;;
  deploy) ;;
  *) usage; exit 1;;
esac
# Refuse deployments until an independent reviewer has checked this exact release.
# This is an explicit operator attestation, NOT proof that an audit has occurred.
EXPECTED="$(sha256sum "$REL/ghost_markets.so" | cut -d' ' -f1)"
[[ "${GHOST_REVIEWED_SHA256:-}" == "$EXPECTED" ]] || { echo 'Set GHOST_REVIEWED_SHA256 only after independent review of this exact binary/source and locked tests.' >&2; exit 1; }
GHOST_REQUIRE_FUNDED=1 node scripts/mainnet-status.mjs preflight "$REL" "$PID" "$AUTH"
printf '\nREAL SOL will be spent. New locked program only: %s\n' "$PID"
printf 'Planned upgrade authority: %s\nBinary SHA-256: %s\n' "$AUTH" "$EXPECTED"
printf 'The deployment does not activate markets, a Custom Ring, or private trading.\n'
read -r -p 'Type the exact program ID to confirm deployment: ' CONFIRM
[[ "$CONFIRM" == "$PID" ]] || { echo 'No deployment performed.'; exit 1; }
# Use explicit endpoint and authority, never alter the global Solana config.
solana --url "$RPC" --keypair "$KEYDIR/deployer.json" program deploy "$REL/ghost_markets.so" --program-id "$KEYDIR/program.json" 2>&1 | tee "$KEYDIR/deployment-output.txt"
# Finalized reads may take time. If verification fails, inspect using the read-only verify action;
# do not blindly rerun deploy. The preflight refuses any already existing program ID.
node scripts/mainnet-status.mjs verify "$REL" "$PID" "$AUTH" | tee "$KEYDIR/deployment-verification.json"
