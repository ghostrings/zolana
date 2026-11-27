# V41 cutover — exact candidate, same program

This is the same V41 program from the supplied candidate archive (550,056 bytes). The independent review record remains null. The owner record starts null; the operator may explicitly authorize an **unaudited public** release of these exact bytes, after considering independent review, the reported local-validator results, market economics, custody and recovery. Nothing in this package approves an audit or asserts that V41 is already deployed. Preserve the historical V27 and V33 publications.

## Before the upgrade

- Review `GHOST-V41-release-review.md` (also provided separately), local compatibility results, and the candidate. The snapshot supplied by the operator shows one existing V33 pool. Existing market funds are at risk; a successful test is not a guarantee. Do not claim full private execution.
- Verify the source/binary checksums and run the local tests/build. Run `npx --no-install tsx ops/v41-cutover.mjs authorize` only if the owner chooses an unaudited release. This source-controlled record allows the exact V41 bytes after the historical V33 deployment slot, with the unchanged roles and observed on-chain mode. The actual new slot is unknown before deployment; it is not invented. It does not change the chain or create any independent review. The existing V33 release record remains in force. Stage this website on Render first, verify V33 market access, and keep existing Render configuration.
- Global enumeration is bounded to 500 markets, and the provider can fail sooner. V41 does not solve full-scale indexing. The native directory now has direct market-address navigation independent of the snapshot, and the token/trading paths read specific market accounts. Save the ZOL URL. This is not a complete scalable market index. Monitor discovery failures; stop new entry on overload. Because issuance is permissionless, the website alone cannot impose a global launch limit.

## Corrected controlled cutover (10 KiB allocation)

The previous 2,240-byte auto-extension failed because mainnet now requires at least 10,240 bytes. The user reported that V33 remains active, with its original hash, original slot and 547,816-byte capacity, and that the failed buffer does not exist. The exposed temporary recovery phrase must never be reused. The exact V41 binary and historical V27/V33 records remain unchanged. The planned zero-padded V33 capacity is 558,056 bytes; the allocation transaction may advance the ProgramData slot even though the V33 code does not change. Only that exact expected padding/capacity, unchanged executable and unchanged roles qualify for the transition. The original owner record and explicit V41 owner decision are both required for transitional trading. This is not a new audit or a new V33 build verification.

Install this corrected source, run the local tests, explicitly authorize the exact unaudited candidate and deploy the authorized website on Render first. Run `npx --no-install tsx ops/v41-cutover.mjs website` to confirm the deployed server advertises the allocation support, not just the previous owner decision. Do not pause while the website is not ready. Announce the maintenance period.

```bash
npx --no-install tsx ops/v41-cutover.mjs pause && \
  npx --no-install tsx ops/v41-cutover.mjs preflight
```

Pause is a real mainnet transaction. New entry is blocked; sells, graduation and claims remain permitted where the program allows them. The read-only preflight checks the exact paused V33, known market accounts, vault accounting, mint/LP constraints, staged website and funding for the full 10 KiB extension. The website caches its status briefly; if preflight sees a stale active mode, wait for the cache to refresh and rerun only preflight. Do not skip a failed check. It writes a local pre-extension snapshot under `~/.config/ghost-markets/v41-cutover/`. Other parties can still sell or claim, so exact reserves may legitimately change.

After a successful preflight, run:

```bash
npx --no-install tsx ops/v41-cutover.mjs extend
```

This action repeats preflight, requires explicit confirmation, checks the local authority, then submits the 10,240-byte CLI extension with finalized commitment. It checks V33's original bytes, zero padding, new allocation, paused mode and existing market identities. Do not extend twice. If anything fails or finality is uncertain, inspect status before retrying. The original V33 historical verification slot stays in the source-controlled record; the observer verifies the new allocation and code independently.

Once the production website status refreshes to match the extended paused V33, run:

```bash
npx --no-install tsx ops/v41-cutover.mjs preflight
```

Require `PREFLIGHT PASSED — EXTENDED V33, READY FOR GUARDED DEPLOY`. The exact V41 binary still fits; no rebuild. Only after reviewing risks, run:

```bash
npx --no-install tsx ops/v41-cutover.mjs deploy
```

This repeats the checks after confirmation, prevents automatic re-extension, and uses a new local buffer keypair rather than a mnemonic printed in the terminal. It will not automatically retry a surviving previous buffer. The local evidence directory now also contains private buffer files: **never upload the whole directory or its keys**. If the deploy is interrupted, check the mainnet program and the printed public buffer address before retrying or recovering the buffer. The helper runs postflight after successful deployment; keep entry paused on any mismatch. No protocol reinitialization. This operator source has not been exercised against live mainnet here.

Check the program hash:

```bash
solana-verify get-program-hash -u https://api.mainnet-beta.solana.com 5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n
```

Expected V41 Solana Verify hash: `ee9f32d573967169cac33c3510922313e2a8ea418db497d2cfa8dc60d2e5a1df`. Run `npx --no-install tsx ops/v41-cutover.mjs postflight` if needed, inspect the saved snapshots and existing ZOL page. Postflight compares the original and post-extension snapshots against V41, and checks immutable market identities and solvency, not exact reserve equality during legitimate exits.

Before resuming, publish the matching V41 IDL and public source, preserve the V33 historical record, and repeat OtterSec verification with `-- --features public-v41`. Obtain independent review before risking funded markets. After review, verify the staged website recognizes V41 in paused mode and can quote exits. The operator may then explicitly approve `npx --no-install tsx ops/v41-cutover.mjs resume`, which verifies website state and the paused snapshot. No new admin wallet or program address.

## Recovery

A successful upgrade does not mean the program is audited. Pause again on discrepancies (`npx --no-install tsx ops/v41-cutover.mjs emergency-pause`), preserve all records and investigate. If the upgrade is abandoned before any executable change, `resume-v33` can resume the exact unchanged V33 after checking its existing market accounts. This command never rolls back a deployment. Do not revert to V33 after any new-profile market exists, since V33 cannot safely serve those markets. Recovery after new-profile issuance requires a compatible forward fix that retains both profiles. Neither an off-chain flag nor the catalogue cap prevents direct on-chain interaction. No test proving keys may be used with real funds. Private settlement remains false.
