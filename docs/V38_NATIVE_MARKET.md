# V38 — Unified native market, one-wallet checkout

## What changed

- Removed the separate full-width native panel from the homepage. GHOST Native and Meteora share the existing cards/grid/table, search, pair filter and 24-item pager. Native results are grouped first, followed by the original server-ordered Meteora results; cap/graduation native ordering uses snapshot estimates; other native orders use address order. This is not a single globally ranked volume index. Legacy overview totals/ticker remain explicitly Meteora-only.
- Native cards route to `/native-token?market=...`, not the Meteora trading page. The red Rings badge appears only on a verified registered asset interface, not merely because a token is native. The page still states public SPL execution.
- Native supply-based cap estimates use an observed mint supply; unavailable reads show a dash. Recent volume and executions use the last 10 finalized market signatures, with explicit partial or missing history. Chart points use genuine trades; no invented candles or 24-hour performance. The full token page uses actual execution prices (SOL/token including fees), actual timestamps, history/transaction explorer links, on-chain reserves, and beneficiary fee balances.
- Ordinary buys/sells are one connected trader signature. The exact transaction is simulated, the user reviews the explicit cost/output/fee summary, the wallet signs once, signed message bytes are verified, and the same signed transaction is submitted once. Unknown finality is not treated as a failure and never automatically resends. Sells output WSOL; the client does not close a pre-existing WSOL account. Creator + administrator approvals remain necessary for **creation**, because the deployed V33 program enforces them. Claims require the actual beneficiary; graduation is a separate action.
- The original Meteora, encrypted Wallet, Rings, desk and Render deployment code and all V33 release artifacts remain unchanged. Privacy registration is not private market execution. No user keys, signed approval files, or private env files included.

## Public release: exact approval remains required

The current V33 executable is active, but source verification, local validator tests and the first launch do not establish independent security/custody approval. V38 does **not** invent or assert one. The dedicated source file `shared/src/ghost-markets/v33-review-record.ts` intentionally exports `V33_REVIEW_RECORD = null`.

After a real independent reviewer has approved the exact V33 program, V38 application revision, custody and public operation, and blocking findings are resolved, the reviewer/authorized release operator can replace the null value in this file with the actual release decision object using these fields:

- `binarySha256`: exact approved raw binary hash (current candidate: `bb7545ae08ab37a83f6785f21a019103953c0d43a3e8a47d0162969193e5e411`)
- `deploymentSlot`: approved finalized deployment slot (current V33: `474345522`)
- `reviewReference`: real written independent decision reference identifying the approved source/application revision and review scope
- `applicationReviewed`: actual affirmative reviewer decision
- `custodyReviewed`: actual affirmative reviewer decision

Do not use placeholder references, a matching byte hash, or the owner's test report as a review. The parser rejects absent/malformed records and any mismatched hash/slot. This source-controlled record is a release-control mechanism, not cryptographic certification of a reviewer. `signingAllowed` also verifies the finalized executable, network, ProgramData/upgrade authority, protocol roles and mode, for every preparation, signing and submission. The website gate is not a global on-chain freeze: direct calls to the active program can bypass website controls. Maintain independent program review, reserve limits, incident response and controlled risk exposure. This update does not change on-chain authorities or program state.

## Operator steps

1. Extract the ZIP into a fresh directory; do not upload local `node_modules`, `.env`, `.config`, keys or signing approvals.
2. `npm ci`; run `npm run markets:unified:check`, `npm run markets:production:check`, `npm run markets:production:client-check`, `npm run markets:live:check`, `npm run markets:live:client-check`, `npm test`, `npm run build`.
3. Upload source to the existing production website repository and deploy to Render, keeping its environment and persistent disk. Check the unified grid, search `ZOL`, SOL filter, grid/table and token history. If the native RPC is unavailable the Meteora listing remains available and the native index is explicitly marked unavailable.
4. Until the real independent decision is recorded the public trade button is disabled. After reviewer approval, populate the actual record, rerun all tests/build and deploy. On the canonical HTTPS site, connect a wallet, obtain exact quote and choose Buy/Sell; review once, sign in the wallet and observe the finalized signature. Never send another trade on uncertain confirmation. Shield purchased registered tokens separately through Wallet.

## Evidence and limitations

Owner-reported finalized ZOL registration: asset 559, mint `2P2pLKSZr48zr7M3GQWEC4uwNgRv9JbJn3Ja2a9DutgX`, market `AqwuGpwStiafXGnwqxEQ1sdqnPodnytvWrzU71odCrrg`. Runtime badge requires a fresh validated registry read, not this record. No private settlement implemented. No transactions, review approval, remote uploads or Render deployment performed by packaging. Full dependency-backed tests and browser build require the operator's installed dependencies. See `evidence/native-production/v38-unified-checks.txt`.
