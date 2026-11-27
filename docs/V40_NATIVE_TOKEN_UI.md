# V40 — Native token page parity

V40 is a website-only update. It retains V39's explicitly owner-authorized,
unaudited public native trading policy, the same V33 program, fee tiers,
authorities, reserve/liability cap, and all existing transaction checks. It does
not provide private swap settlement or an independent audit.

## User flow

1. Open a native token from the unified market grid. The native page shares the
   ordinary token header, chart, segmented graduation bar, statistics, supply
   strip and responsive sticky trade panel.
2. Connect/select a compatible Wallet Standard account. The panel automatically
   reads finalized public SOL, the selected wallet's associated token account,
   and WSOL. The exact public sellable amount is shown next to the side tabs.
   Refresh balances after depositing, transferring, or switching accounts.
3. Select Sell. The 25%, 50%, 75% and 100% buttons populate the exact input using
   integer base units. 100% means the entire **public associated token account**
   balance, not all accounts or encrypted balances. A percentage that rounds
   below one base unit is disabled. No percentage click signs or submits.
4. Get an exact quote, then review and approve the wallet transaction. A changed
   amount/account invalidates the existing quote. The unchanged V39 client
   rechecks funding, simulation, deployment, quote version and signatures.
   After a finalized trade the market, supply, balances and recent history are
   refreshed. Reload before another submission, as in V39.
5. Registered assets keep the red Rings badge and direct encrypted-wallet link.
   Private holdings are not queried by the trade panel. To sell encrypted tokens,
   withdraw to the same connected public wallet first. Native sells return WSOL.

Price charts plot actual observed finalized execution prices in the existing
bounded ten-signature window. Missing or insufficient history is shown as such;
no invented curve or lifetime volume. Market cap is an estimate from the reserve
ratio and the verified current mint supply. Supply and cap remain unavailable if
the mint read fails.

## Verify before publishing

```sh
npm ci
npm run markets:token-ui:check
npm run markets:owner-trading:check
npm run markets:unified:check
npm run markets:production:client-check
npm run markets:live:client-check
npm test
npm run build
```

Check the page on desktop and mobile, connect a test account, switch between
accounts, and verify 25/50/75/100 percentages against the public balance. Verify
missing/zero balances disable sell shortcuts, and check the quote is cleared
on each change. No new program upgrade or key export is required. Do not upload
local dependencies, wallet keys, or signed approval files to GitHub.
