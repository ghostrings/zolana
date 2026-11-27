# Integration verification record

Owner-supplied application ZIP: `privacycash-main.zip` (v24). Compared SHA-256 for every original regular file.

- 256 of 270 original files unchanged; 14 intentionally modified; zero original files removed.
- Original `package-lock.json`, `render.yaml`, all wallet/key management, transaction builders, privacy and Ghost settlement modules, desk, ring indexer and operator environment configuration unchanged.
- New standalone observer/status checks: 23/23 passed; scoped TypeScript compilation succeeded.
- HTML ID uniqueness and new page script references checked. Existing release stamp updated consistently.
- Full npm install blocked: offline cache lacks yocto-queue 0.1.0; online install attempt timed out. Full Vitest suite, new HTTP integration suite, full build, browser and Render execution remain pending.
- Deployment evidence is transcribed from the owner's earlier RPC results; not independently refreshed here. No real keys, signer calls or chain transactions used during integration.
- No audit, release approval, native market activation or Custom Ring settlement claim.

## Modified original files

- `.gitignore`
- `README.md`
- `package.json`
- `server/src/index.ts`
- `server/src/listing.ts` (restore missing price-sampling export)
- `shared/src/constants.ts`
- `web/create.html`
- `web/index.html`
- `web/partials/footer.html`
- `web/protocol.html`
- `web/src/pages/create.ts`
- `web/src/pages/protocol.ts`
- `web/swap.html`
- `web/vite.config.ts`

## v26 price-history hotfix

The owner's v25 Vitest run reported 1,001 passing and two failing tests in `tests/market-visuals.test.ts`. The original v24 source and the v25 integration both lack `sampleMarketPrices`, although those tests import it. V26 restores that export without changing the existing tests, trade or signing paths. The actual transpiled sampler and sparkline functions passed all assertions from the three original sparkline cases under standalone Node assertions, plus 300 length/endpoint cases and sorting, invalid-value filtering and input-immutability checks. The 23 native-market standalone tests passed again. Full Vitest and production build need a fresh run by the owner; these scoped checks are not a claim that the complete suite passed.

## Commands to verify before Render deployment

```sh
npm ci
npm run markets:check
npm test
npm run build
```
