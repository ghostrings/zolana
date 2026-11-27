# V39 — Owner-authorized public native trading

## Release decision and limitations

The platform owner requested enabling native purchases and sales for all compatible connected wallets, while preserving protections and unaudited disclosures. `shared/src/ghost-markets/v33-owner-market-record.ts` contains that source-controlled owner decision, pinned to program `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n`, V33 SHA-256 `bb7545ae08ab37a83f6785f21a019103953c0d43a3e8a47d0162969193e5e411` and deployment slot `474345522`. It is not a signed independent review attestation. `v33-review-record.ts` stays null. No new on-chain deployment, audit, transaction or actual public trade is asserted by the package.

The owner decision covers `buy`, `sell`, `graduate`, and `claim` only. An initialized, exact finalized V33 deployment with the original loader, ProgramData, upgrade authority, administrator, treasury and pauser is required. A changed deployment, roles, pending administrator nomination, unavailable RPC, or locked mode refuses signing. In paused mode, the site refuses buys and permits only eligible sells, graduation and beneficiary claims in accordance with the unchanged program. New market creation still uses the existing two-signature path and first-market restrictions; initialization and additional issuance are not enabled by this market decision. Fee claims require the actual beneficiary; graduation is subject to phase and reserve checks. No administrator signature or approval JSON is required to buy or sell.

**Unaudited, upgradeable code. Real funds can be lost.** There is no guarantee of exit price, liquidity or recovery. The 1 SOL cap covers accounted quote reserves plus unpaid fee liabilities per market, not all possible deposits, losses, or the entire protocol. The published IDL and reproducible verification do not certify security. The red Rings badge still requires a validated current asset-interface registration. Trades, creator addresses, token amounts, fees, deposits and withdrawals remain public. Shielding is a distinct action through Wallet; a public trade never spends shielded SOL or private tokens. Sells return public WSOL to the user's associated account, not automatic unwrapping. Existing Meteora trading, Default Ring wallet, desk and all on-chain binaries are unchanged.

## Checkout

1. Open a native token page on `https://privacycash.fun`, connect a compatible Wallet Standard account, read its public balances and get an exact quote.
2. Choose Buy or Sell. The program's existing checked integer pricing, fee arithmetic, exact minimum output, market state version, deadline and reserve cap remain binding. The website verifies canonical vaults/mints and reads public SOL and associated-token accounts. Estimate the new ATA rent and network fee, check sufficient SOL and sell-token balance, and simulate the exact transaction. If the balance, version, deployment, or estimated debit no longer permits the reviewed transaction, rebuild instead of silently changing it.
3. Review the amounts, minimum output, costs, risks and public settlement in the confirmation. Approve exactly one wallet signature. Wallet-signed message bytes are checked cryptographically; only the approved transaction is sent. Preflight remains enabled. There is no automatic resend. A finalized failure is not a successful trade; an uncertain result is not a failed trade. Inspect the displayed signature before retrying. Reload for a fresh transaction after the previous result is established.
4. After a finalized purchase, the received tokens are in the public associated account. If desired, move tokens to the public address used by the existing encrypted Wallet, then shield separately. This is not a private swap. Do not use this workflow to misrepresent creator holdings, market activity or the privacy guarantees.

## Install, verify and publish

Extract V39 into a clean directory. `npm ci` and run:

```sh
npm run markets:owner-trading:check
npm run markets:unified:check
npm run markets:production:check
npm run markets:production:client-check
npm run markets:live:check
npm run markets:live:client-check
npm run markets:browser:check
npm run markets:browser:client-check
npm test
npm run build
```

Check a fresh browser build against the deployed source and do not assume a working mainnet checkout from these tests alone. Preserve current Render environment and persistent disk, and upload only the clean source ZIP contents; no keypairs, credentials, signed approvals, node_modules or target directories. Check the footer reads `v39`. The read-only status API should report signing eligibility when the exact initialized release is observed. The site still requires canonical HTTPS for live signing; localhost is not a production signing origin. Before broad public use, obtain independent security review and verify a small owner-funded round trip, exact balances, fee accrual, and exit behavior. V39 does not perform those transactions.

## Incident / rollback

Setting `V33_OWNER_MARKET_RECORD` to `null` and rebuilding disables the owner-authorized web checkout (no independent approval is recorded). This is only an application control: already deployed clients and direct callers can reach the active on-chain program. For an actual incident, use the authorized on-chain pauser, preserve eligible exits, and verify finalized protocol mode and account state. Do not revoke or transfer authorities as part of ordinary website publication. No new private key is needed for V39.
