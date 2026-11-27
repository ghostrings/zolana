# GHOST Markets V33 — production-facing integration candidate (application V34)

> Historical pre-upgrade handoff. For the later operator-reported active V33 state and current publication steps, see [V33 mainnet publication](V33_MAINNET_PUBLICATION.md).

**This distribution does not authorize an upgrade, activate markets, or allow native mainnet signing.** It preserves the exact V33 `public-pilot` release bytes, source, IDL and Cargo.lock in `deployments/review/v33-candidate/`. The verified historical V27 release is still the last owner-observed mainnet deployment. V33 is a restricted public SPL pilot, not a private exchange or unrestricted token factory. Independent security, economic, operational and integration review is pending.

## Public configuration

| Role | Public address |
| --- | --- |
| Program | `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n` |
| ProgramData | `J4iCsaLM24bBqjWGXvtB6N3LzUiJNJWwKAqLtXUzTXxt` |
| Protocol PDA | `423vt8vZMJs5ToVjUtbHQFtXDVQ7AccAVHk7vh6P6vWK` |
| Upgrade authority / initial administrator | `J4JRQza7JXnkct6kQC3roPYstoH2xFBoyQ5Wczpt5jPt` |
| Treasury | `78XzeLvhyvsgQTirz9LmerGB6PNMDgFhdtHXSWoo83oi` |
| Pauser | `4xbhc9hzcGZpWpyHsguQbB5JdBZzGTcnBouyk1fbTbwF` |

The owner supplied these public addresses, indicated Jupiter as the treasury wallet, and reported 3.324702588 SOL in the deployment wallet. The last reported ProgramData rent was 2.711729400 SOL. The reported rent estimates for 547861 / 547853 bytes were 2.783784120 / 2.783743480 SOL respectively. The calculated additional rent plus temporary buffer estimate is 2.855798200 SOL, leaving 0.468904388 SOL before transaction fees or other allocations. These are historical owner observations, not a current funding guarantee. No key, recovery phrase or wallet file is present in this package.

## What is new

- `/native-launch`: independent public market workspace linked from `/create` and `/ghost-markets`, using the existing privacycash.fun shell. Connect explicitly selected Wallet Standard accounts, review/export a non-signable launch intent, read genuine V33 market and fee snapshots when available. The existing Meteora/Default Ring launch, trade, desk, wallet and privacy routes are unchanged.
- `/api/ghost-markets/v33/status`: bounded read-only finalized snapshot, with per-IP rate limiting and coalesced cache. The V27 endpoint remains compatible. V33 uses the exact candidate binary fingerprint, loader, ProgramData pointer, genesis and role checks; it recognizes schema-2 accounts and fails closed on changes or pending admin nomination. No invented empty market list when a scan is unavailable. Public account observations are not an audit or beneficial-ownership proof.
- `web/src/native-v33/`: separately staged public-SPL transaction client. Actual canonical V33 create, swap, graduate and claim instruction builders, WSOL wrapping into the selected account's ATA, exact version/deadline checks, mint/vault/PDA checks, fresh release checks, independent Wallet Standard sign-only approvals and explicit submission. Output is public SPL/WSOL; a sale does not automatically unwrap or close the account. The mainnet signing client refuses other site origins. No server holds signing keys; no automatic retries or background submission. A submitted signature must be checked before a new draft.
- `web/src/native-v33/envelope.mjs`: portable initialization/launch approval files. An imported transaction is reconstructed from a bounded typed intent and checked against the actual message and all existing Ed25519 signatures. Only exact V33 init or create-market instructions and a pinned compute limit are accepted. Initialization is locked, requires upgrade authority + treasury and never includes activation. For launch, creator + administrator sign the same message. A local administrator can inspect the envelope using `markets:production:approval -- review INPUT.json`; no keys read or transaction sent. The staged co-sign code requires a real approved release, live state, fresh blockhash, first required signature, interactive program-ID confirmation and an explicitly selected local administrator key file. It never broadcasts. Pending approval files may contain executable signatures and must remain private until used/expired; do not commit them.
- `ops/native-production.ts`: read-only operator preflight for exact candidate binary, authority, allocation, existing markets, rent and balance. `initialization-plan` prints the canonical public instruction for review without a blockhash or any signatures. No upgrade/activation transaction builder is supplied.

The checked-in `reviewedRelease()` returns null. There is no environment variable, URL, checkbox, API response or private key that can bypass it. The browser controls for real transactions and portable approvals stay disabled. A future source-reviewed release must record genuine independent approval of both the exact binary and application, verify the actual deployment slot, complete custody/recovery and end-to-end wallet checks, then follow a separately reviewed upgrade and governance procedure. **Do not treat a hash or a successful test as security approval.**

## Reproduce checks

From the extracted repository root, Node 22 and the unchanged npm lockfile:

```sh
npm ci
npm run markets:production:check
npm run markets:production:client-check
npm run markets:check
npm run markets:pilot:check
npm run markets:lab:check
npm run markets:wallet:check
npm test
npm run build
```

The client-check command exercises real `@solana/web3.js` transaction construction, exact IDL metas, ephemeral creator signatures and canonical portable approval validation without any RPC. This command requires dependencies; it has not run in the packaging environment. The new browser extension and production build also remain unverified. The dependency-free production check runs the TypeScript release decoder against synthetic snapshots populated with the actual supplied V33 executable; these are not live on-chain tests. No Rust or Solana build is necessary for this application-only edition. The owner reported prior V33 local wallet tests 5/5; that is separate from this candidate's new browser tests.

For browser preview, use `npm run dev:server` and `npm run dev:web` in separate terminals, with your existing local server configuration (do not add credentials to public source). Open `http://localhost:5173/native-launch.html`. On this origin the signing client refuses mainnet execution; unsigned intents and read-only snapshots can be reviewed. Connect an extension only to share its public account. No signatures, real deposits or upgrades are requested. A missing RPC yields unavailable. Existing lab tests remain available and are not a production signer.

## Read-only mainnet checks

```sh
npm run markets:production:preflight
npm run markets:production:init-plan
```

Preflight verifies the candidate SHA-256 and looks at actual finalized state; if an unknown executable or authority is seen it fails. The estimated buffer and additional rent are not final costs. Initialization-plan is an unsigned review description, not a transaction or approval. The current output deliberately reports `upgradeAuthorized: false`.

## Fee policy (unchanged native V33)

| Total trading fee | Platform curve | Creator curve | Platform graduated pool |
| --- | --- | --- | --- |
| 2% | 1.6% | 0.4% | 2% |
| 3% | 2.4% | 0.6% | 3% |
| 4% | 3.2% | 0.8% | 4% |

All native fees accrue in WSOL. The on-chain contract handles rounding (creator = floor(curve fee / 5), platform receives remainder); the graduated pool gives all accrued fees to platform. Genesis liquidity principal is locked by the supplied code and no outside LP shares are issued in the pilot. Upgrade authority can change these rules, so do not claim immutable locking. Paused curve and pool sells remain possible subject to actual liquidity, account constraints and slippage. The per-market cap is not a total protocol risk limit. Historical existing Meteora fees are not changed by this native policy. Token supply is initially 1,000,000; automatic creator premint is zero. Metadata URI is empty in this restricted candidate; no new Metaplex metadata, social links, price history indexer or external privacy deposit is claimed.

## Production gates still outstanding

1. Run dependency-backed checks and full build; test the browser/extension path with both independent signers and real local validator. The locally tested V33 wallet SDK is separate; the new production client and portable cross-device approval workflow have not executed end-to-end.
2. Independent security/economic review of exact V33 public-pilot binary/source, new client/approval workflow, treasury recovery, role custody, reserve limits, incident policy and upgrade/rollback procedure. Existing OtterSec V27 verification does not cover V33.
3. Approve the actual same-address upgrade only after fresh finalized V27 state, allocation, balance and review gates. Verify the upgraded bytes, publish matching IDL and reproduce the approved source/feature build through OtterSec. The initialization must be reviewed, signed independently and confirmed locked before considering activation. No automatic authorization or activation is included in this application candidate.
4. Complete production monitoring, incident drills and market onboarding before admitting funds. The native settlement remains public. Actual Custom Ring integration and privacy-specific proofs are not present; do not advertise hidden creator ownership, anonymous swaps or private settlement from this upgrade.

Do not upload your Ubuntu workspace, `.config`, generated keys, validator ledger, signed approval files, `.env` or deployment wallet. Upload the clean source ZIP manually if publication rights and credential review are satisfied. No remote service was changed while preparing this package.
