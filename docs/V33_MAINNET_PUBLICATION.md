# V33 mainnet publication and launch handoff

> Historical publication handoff. For the later operator-reported verification completion and V35 first-launch/asset readiness tooling see [V35](V35_NATIVE_LAUNCH_AND_ASSETS.md). No new security approval is asserted.

Current operator-reported finalized state: V33 active at slot 474351235; no private settlement; public website signing false. The exact binary and IDL were supplied in the original V33 review archive. No independent security review or first native mainnet token launch is recorded. All instructions below are for the existing program address; no upgrade/rebuild of the deployed binary is necessary. Metadata and verification-PDA writes do spend real SOL and must be authorized locally by the upgrade authority.

## Publish GitHub evidence (manual)

Upload ONLY `deployments/mainnet/v33-release/` from this distribution into that exact path in `ghostrings/zolana`, preserving the existing `deployments/mainnet/v27-release/` directory and historical commit. The included README documents the current state. Add a link to this new release in your repository README; keep the historical V27 record. Copy the commit SHA from GitHub's history after uploading. This archive also contains the full refreshed V34 Render application, which belongs in the website repository if it is separate. Never upload local signing workspaces or approval JSON files.

## Verify current bytes and republish IDL

From the local extracted repository root:

```bash
PROGRAM=5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n
RPC=https://api.mainnet-beta.solana.com
AUTH="$HOME/.config/ghost-markets/mainnet-v27/deployer.json"
REL="$PWD/deployments/mainnet/v33-release"
(cd "$REL" && sha256sum -c SHA256SUMS && cd source && sha256sum -c ../source-sha256.txt)
solana-verify get-program-hash -u "$RPC" "$PROGRAM"
solana-verify get-executable-hash "$REL/ghost_markets.so"
```

Both Solana Verify hashes must be `33a41e48d76fe0bbf936aa41e926a6ebb9005034cfcbf3651318a1ff0e8e9ec5`. Check `solana-keygen pubkey "$AUTH"` matches `J4JRQza7JXnkct6kQC3roPYstoH2xFBoyQ5Wczpt5jPt`. Use the same pinned Program Metadata tool that previously published the V27 IDL. Inspect `--help` and verify package provenance before allowing it access to the local signer. Confirm the metadata writes are for the intended program, seed and authority.

```bash
npx @solana-program/program-metadata@0.11.0 write idl "$PROGRAM" "$REL/ghost_markets.json" --keypair "$AUTH" --rpc "$RPC"
npx @solana-program/program-metadata@0.11.0 write security "$PROGRAM" "$REL/security-publication.json" --keypair "$AUTH" --rpc "$RPC"
npx @solana-program/program-metadata@0.11.0 fetch idl "$PROGRAM" --rpc "$RPC" --output /tmp/ghost-v33-published-idl.json
python3 - "$REL/ghost_markets.json" /tmp/ghost-v33-published-idl.json <<'PY'
import json,sys
with open(sys.argv[1]) as a, open(sys.argv[2]) as b:
    assert json.load(a)==json.load(b), 'Published IDL differs; inspect before proceeding'
print('Published IDL matches V33')
PY
```

V33 includes embedded Security.txt already. The supplemental public security metadata is not a security audit; review the contact link and enable private vulnerability reporting before publishing it. Explorer caches may take time to reflect the metadata.

## Repeat OtterSec verification

Run Docker Desktop. Supply the actual commit containing the exact published release source. Preserve the original `public-pilot` feature flag, which is essential for reproducing V33 (the default binary is locked). Check the repo, commit, path and feature before approving an on-chain verification record.

```bash
read -r -p 'GitHub commit SHA: ' COMMIT
solana-verify verify-from-repo -u "$RPC" --program-id "$PROGRAM" https://github.com/ghostrings/zolana --commit-hash "$COMMIT" --library-name ghost_markets --mount-path deployments/mainnet/v33-release/source -k "$AUTH" -- --features public-pilot
solana-verify remote submit-job --program-id "$PROGRAM" --uploader J4JRQza7JXnkct6kQC3roPYstoH2xFBoyQ5Wczpt5jPt
```

Check https://verify.osec.io/status/5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n. After success publish the actual V33 commit/job/hash receipt. Do not advertise V27's verification as applying to V33.

## Website integration and first launch

This refresh fixes the outdated V27-only website summary and the local co-sign helper's early clearing of its signing key bytes. The read-only status API, wallet connection, launch intent, actual staged transaction builders, signature verification and approval file validation remain. The independent approval is still absent: `reviewedRelease()` returns null, and no deployment-state response can bypass that. No actual new public signing workflow, browser test or independent audit is claimed by this refresh.

Run `npm ci`, `npm run markets:production:check`, `npm run markets:production:client-check`, `npm test`, and `npm run build` before publishing to Render. Verify `/ghost-markets` and `/native-launch` distinguish active program from disabled site signing. Preserve all existing launchpad and wallet routes. To complete public signing, obtain independent approval covering this exact executable, application, custody and launch flow; fix any findings; test the approved browser/administrator flow with controlled wallets on a local validator, including short-lived approvals (use a separately tested durable nonce workflow if needed). Do not fabricate an approval reference. A preliminary code review or verified build cannot approve customer funds.

The first native token requires a creator wallet distinct from the administrator and treasury, the creator's chosen name (max 32 UTF-8 bytes), uppercase symbol (1–10 letters/digits), and a 2%, 3%, or 4% fee choice. In `/native-launch` you can prepare and export an unsigned launch intent now. After the review gate is satisfied in the actual released client, the creator signs the canonical launch, the administrator reviews and co-signs, and the fully signed transaction can be submitted with explicit confirmation. No automatic creator premint or first buy. Verify final market PDA, mint, supply, authority revocation, fee tier and transaction before any announcement. Keep customer funds out pending review. Native settlement is public; do not advertise anonymous launches.

References: https://solana.com/docs/programs/verified-builds ; https://github.com/solana-program/program-metadata .
