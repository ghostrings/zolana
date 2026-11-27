# GHOST V30 — native launchpad integration and preliminary review

## Evidence received, November 26, 2026

The supplied `GHOST-V29-review.tar.gz` was inspected directly. Its local ELF executable is 537,352 bytes; SHA-256 `2d9d039286489dc95e35f707b724a8b131b54d5232756599738160e8139e906b`. The bundled Cargo.lock exactly matches the previously supplied working lock. The logs report 3/3 locked and 6/6 public-pilot validator tests passed. The only Rust source difference from the distributed V29 candidate is the generated local `declare_id!`. Anchor.toml contains the local identity and test configuration changes. The local IDL contains 10 instructions and the Market/ProtocolConfig account schemas. These facts are not an independent security audit, proof of a reproducible build, or approval to upgrade on mainnet.

Review manifest, local IDL and sanitized logs: [`protocol/ghost-markets-pilot/evidence/v29-owner`](../protocol/ghost-markets-pilot/evidence/v29-owner/). The local executable is deliberately not included (its ID is not the mainnet identity). No keys or local build workspace are included. Paths in the test logs were redacted; the manifest hashes refer to the original received files.

## Scope of the V30 application

The production application remains the original Render v26 site with the locked V27 observer. The new browser integration is separate: `protocol/ghost-markets-pilot/lab/`. There is no production signing route, automatic upgrade, Render environment change, key export or Custom Ring implementation. The existing market math and Rust code are unchanged.

The lab performs real local-only initialization, launch, public SPL trades, graduation, LP add/remove, and pause/resume. It reads market and vault state from the local validator and quotes exact integer outputs from the tested reference math. It binds confirmation to a quote and state version, rejects stale and expired quotes, enforces the fixed pilot cap, and halts on an uncertain mutation rather than blindly retrying. It deliberately uses disposable local admin and trader accounts; it does not integrate a production user's wallet. Each session creates one market. Only same-origin loopback requests with the lab session token can submit the fixed actions. This is a development convenience, not a production authentication model. Do not expose this port through a proxy, Render or tunnel. No private keys are returned through the HTTP interface.

### Run

Use the same Ubuntu / WSL toolchain (Anchor 0.32.1, Solana CLI 2.3.0, Node 22). Extract the complete ZIP to a new source directory. Run `npm ci`, `npm run markets:check`, `npm run markets:pilot:check`, `npm run markets:lab:check`, `npm test`, and `npm run build`. Then run `npm run markets:pilot:lab` and open `http://127.0.0.1:17828/` when printed. Create a token, quote/confirm a 0.05 test-WSOL buy, try a token sale, and exercise graduation and liquidity operations. The market reaches Ready at 0.2 accounted SOL; the on-chain graduation is a separate instruction. All displayed balances and signatures refer to the temporary local validator only. Use Stop lab to exit. If WSL freezes during shutdown, use Windows PowerShell `wsl --shutdown` after the test logs are saved. Do not upload the lab work directory or any generated ledger/keys. To run the original validator regression suites separately use `npm run markets:pilot:local`.

## Preliminary review findings and production gates

| Area | Finding | Required before live funds |
| --- | --- | --- |
| Build identity | V29 binary is compiled for a temporary local program ID, not the V27 mainnet address. | Build the reviewed source with the permanent identity in an isolated release workspace; verify exact bytecode, IDL, feature flags, dependencies and account allocation. Never reuse this local binary. |
| Pause and exits | `swap` allows paused curve sells, but not pool sells; `remove_liquidity` only returns assets to LP holders. Ready-phase swaps stop until graduation. | Independent review of pause/recovery, stalled market behavior, holder exits, and explicit user disclosures. Do not imply guaranteed redemption. |
| Funds | Quote reserve cap is per-market accounted exposure, not total protocol exposure or actual vault balance. Donations are not credited to reserves and do not have a recovery route. | Review excess funding, donations, closure/recovery, caps and bounded pilot admission. |
| Market economics | Fee retained in reserves, virtual reserves nonspendable, unsold inventory burned at graduation, genesis LP locked by program logic but upgradeable. | Independent economic analysis; specify fee/LP lock and supply disclosures; test adversarial rounding and lifecycle sequences. |
| Asset identity | Original SPL mint, canonical WSOL, revoked base mint/freeze authority; public name and symbol are market state, not Metaplex metadata. | Review mint metadata and listing compatibility; secure asset discovery. |
| Authority | Upgrade authority can replace checks, admin creates markets, separate pauser can halt. | Secure reviewed role custody/multisig, authority lifecycle and incident runbook. |
| Privacy | Ordinary SPL transactions expose participants, token and amount. | Separate supported privacy integration, reviewed market-specific proof binding, transparent market integrity/insider disclosures and authorized ring activation. No privacy claim now. |

## Mainnet upgrade preparation

Retain the recorded V27 identity `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n`. V27 remains locked. Its original hash is `2fba22c284791879f003aec3118c74fbd271f808f91b39e394e2654f9cc80d7d`; the current website observer will fail closed if it changes. An independently reviewed operational release must resolve the findings above and establish a new release identity, reproducible build, approved authority, final account layout and new RPC verification evidence before any mainnet activation. Do not reuse the local IDL address or V27 hash as release authorization. No automatic build for the permanent ID, upgrade command, signer path or activation flag is supplied here. The lab's tested source is unchanged to preserve the evidence and permit a focused independent review. Production transaction integration and actual private settlement remain outstanding.

## Verification at V30 packaging

- Archive and source review performed; owner-reported V29 validator evidence retained with accurate scope.
- V30 lab standalone checks and existing observer/reference checks executed locally; see `protocol/ghost-markets-pilot/evidence/v30-checks.txt`.
- Rust/Anchor toolchain and application dependencies are unavailable here. Browser-to-validator integration, fresh full Vitest/typecheck/build and independent security review remain pending. No mainnet transaction was sent.
