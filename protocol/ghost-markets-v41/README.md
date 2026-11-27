# GHOST Markets V41 candidate

New markets: permissionless creator-signed public SPL issuance, initial fixed supply 1,000,000 (6 decimals), 3.5 SOL virtual quote reserve, nominal pre-burn FDV target 69 SOL. Nominal real reserve threshold = `ceil(sqrt(69e9 * 3.5e9)) - 3.5e9 = 12040270268` lamports. Fees collected separately. Integer rounding and the trade path can cause small deviations from the nominal valuation. A graduation burn reduces circulating supply; neither the valuation nor a future price is guaranteed. The 25 SOL accounted quote + unpaid fees cap is a proposed new-market risk bound, not an independently approved economic limit. Old V33 markets preserve their existing 0.1 SOL virtual reserve, 0.2 SOL graduation reserve and 1 SOL cap; account layouts and instruction discriminators are unchanged. 2/3/4% immutable fee tiers, 80/20 curve fee split, 100% platform pool fees, no premint, locked genesis LP, soft pause, and exact quote version/deadline protections are retained. A treasury creating a token can claim both of its distinct fee ledgers.

This separate workspace has not replaced the existing native program. Default build remains locked; the `public-v41` feature is the public-SPL review candidate. `local-market-testing` must never be deployed. No private swap implementation is added to this program.

```sh
npm run markets:v41:check
npm run markets:v41:local
npm run markets:v41:compat
```

The first command exercises reference arithmetic. The second builds both the locked and new variants and tests all fee tiers with ephemeral local wallets. The third builds V33 and V41 against a fresh shared local program identity, seeds funded V33 curve and graduated market fixtures, performs a local upgrade and checks unchanged account bytes and old trading behavior. It also creates a new single-signer V41 market. The actual Rust/SBF and loopback tests still need execution; passing standalone Node tests is not approval of the upgrade.

Once local tests pass, `npm run markets:prepare:v41` prepares a Docker-built, checksum-sealed candidate, not a deployment. Preserve V27/V33 historical evidence. No upgrade should be executed before independent security/economic review, compatibility test, operational review and rollback/custody plans for already-funded markets. A new, exact release record must match the new executable and observed deployment slot before the browser will use it. The V33 owner authorization cannot be reused to authenticate the new executable.
