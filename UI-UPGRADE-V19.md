# privacycash.fun v19 — CINEMA

A UI-focused upgrade of the supplied v18 source. No changes to launch, trade, signing, custody, fee, privacy-ring or database schema logic are required. Existing deployment configuration, package versions and lockfile are retained.

## What changed

- A slim sticky header, compact cinematic monochrome hero, four-metric strip and prominent market discovery. Neutral black/white surfaces, fine glass highlights, high-contrast typography, reduced-motion support. Token artwork retains its own colors.
- Grid, larger artwork-card and table views, with the selected view remembered locally. Search, sort, pair filter and 12-token server pagination remain functional. Prices, cap and trading volume are shown in the configured quote asset rather than an invented USD equivalent. SOL, USDC, ZEC and other supported pairs use their existing catalog information.
- Market sparklines use at most 32 actual stored observations from the past 24 hours. No invented history: fewer than two usable observations display an explicit missing-history state. The server and frontend must be deployed together to enable the new market history field.
- Native wallet overview dialog from the market header, with a mobile bottom sheet. Reads public SOL, legacy SPL token balances, private holdings and recent private activity via the existing wallet and RPC code. Receive exposes the real address and QR; send, shield and management actions route to the existing full wallet flows. Full wallet layout is also refreshed. Locked/new wallets use the existing onboarding. No new signing or key handling.
- The overview does not invent a portfolio USD value, historical equity chart or private holder counts. Unknown token decimals are reported in base units. Failed balance reads are marked unavailable. Private holding metadata is not individually requested from the public listing endpoint by the new overview. Private artwork uses local avatars. The popup is mounted on the market page; other pages retain the full-wallet link.

## Verification performed

- Actual homepage rendering code transpiled and exercised in an isolated Chromium document using controlled API fixtures and stubbed wallet data/QR module. 27 responsive checks: grid, cards and table at 320, 375, 390, 600, 768, 820, 1024, 1440 and 1920 px. No document-width overflow or uncaught page errors in these checks. Search, pair filter, pagination, dialog opening/closing, Escape/focus restoration, holdings/activity tabs and receive/back navigation were exercised. Preview screenshots use fictional market and wallet fixtures, not live values. Fixture code and data are not included in production source.
- TypeScript syntax transpilation passed for changed TypeScript modules. Ten direct assertions passed for price-history sampling and SVG geometry. A corresponding Vitest regression test is included.
- **Not verified:** npm dependency installation (registry DNS blocked), full semantic typecheck, Vite/server production build, full Vitest suite, live wallet SDK/RPC integrations, actual QR generation, on-chain transactions, Safari/Firefox and physical devices. This is a source upgrade for staging, not a certified production release.

## Before deploying

With Node 22.13+ and registry access, from the project root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Deploy the frontend and server together using the existing deployment workflow. Preserve existing environment variables, keys and database; do not replace them with example configuration. On staging, test the locked/unlocked wallet, receive QR, public/private balances, wallet switches, send/shield/withdraw, pairing, launch/trading flows and market snapshots using suitable test wallets and the existing safe operational procedures before deploying to production. No deployment or mainnet transactions were performed during this upgrade.

## Design basis

The supplied BaseStonk, o1 and Jupiter-style wallet screenshots informed the compact market layout, artwork view and wallet overview. The grayscale ghost brand comes from the original project. The responsive implementation follows the principle of reflow at narrow widths (https://www.w3.org/WAI/WCAG22/Understanding/reflow.html); wallet UI patterns are informed by the user's reference and Jupiter's wallet product (https://jup.ag/wallet). These are design references, not affiliated services or a claim of accessibility certification.
