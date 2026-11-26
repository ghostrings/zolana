# Mainnet runbook

This project runs on **Solana mainnet only**. There is no devnet, testnet or test mode anywhere
in it: the server refuses to start with any other network setting, checks the chain's genesis
hash before it reads or relays anything, and the scripts do the same. Every step below that
sends a transaction spends real SOL and leaves a permanent public record.

That makes one fact important. **This code has never been executed against a chain.** It was
written and tested offline. The first transactions you send are the first time it meets
mainnet. So the first run is done with small amounts, on a small curve, from throwaway
wallets, and only then are the production fee tiers created.

## What is permanent

- **A fee-tier config.** Its fees, curve, fee split and fee claimer cannot be edited, and the
  account cannot be closed. A mistake is fixed by creating a new config and abandoning the old.
- **A token.** Name, ticker, artwork address, supply, the creator's wallet and the tier it was
  launched on. Nothing about it can be changed and it cannot be removed.
- **Graduated liquidity.** 100% is locked for good.
- **Everything you do in the first run.** The test configs and test tokens stay on mainnet,
  visible to anyone, and strangers and bots can trade them.

## What you need

- Node 22.13 or newer.
- A Helius **mainnet** API key on a plan that includes Solana Privacy Rings. Rings calls are
  billed in credits (about 10 per read and 1,000 per proof at the time of writing). Every proof
  a visitor's browser requests is paid by your key.
- A Pinata JWT. Token artwork and metadata are then pinned to IPFS instead of living on your
  server. It is required for running the first run from your own machine, because a token's
  metadata address is permanent and must not point at `localhost`.
- Wallets, kept separate:
  - **Deployer.** Pays for creating configs and for graduating first-run curves by hand.
  - **First-run partner.** A fresh hot wallet used as `PARTNER_WALLET` during the first run
    only, so fee claiming can be tested without touching the real partner key.
  - **Partner.** Receives the platform's share of fees and owns the platform's locked
    liquidity positions, for good. It is written into the production configs. Use a wallet you
    will still control in years. `npm run fees:claim` signs with a plain key; if the partner
    is a multisig, you will need your own way to submit the same instructions.
  - **Desk.** Only if you run Ghost fill (Part E). A hot key on the server.
  - **Modules gas tank.** Only if you run fee modules (Part J). Derived from a seed on the
    server; it pays the modules' network fees.
- **About 4 SOL for the first run**, split roughly: deployer 0.3, first trader 3.5, second
  trader 0.05, first-run partner 0.02. Most of it is working capital for completing one small
  curve. By this project's own arithmetic (not yet measured on chain), completing the small
  curve on the 3% tier costs about 2.48 SOL, and selling everything back into the graduated
  pool returns about 1.77 SOL. About 0.58 SOL stays in the pool as locked liquidity for good.
  If other people trade the token those numbers move. Treat the whole amount as spent.

Keep secret keys out of your shell history. Set them for one command and remove them after.

bash, zsh:

```bash
read -rs DEPLOYER_KEY && export DEPLOYER_KEY     # paste the key, press Enter
# ... run the command that needs it ...
unset DEPLOYER_KEY
```

Windows PowerShell:

```powershell
$key = Read-Host "Deployer key" -AsSecureString          # paste the key, press Enter
$env:DEPLOYER_KEY = [System.Net.NetworkCredential]::new('', $key).Password
# ... run the command that needs it ...
Remove-Item Env:DEPLOYER_KEY
```

The same pattern is used for `PARTNER_KEY`. A key is accepted as base58 or as a JSON array of
bytes.

The commands in this runbook are the same in every shell. In PowerShell, use
`Copy-Item .env.example .env` for the copy. Commands that send something are confirmed with
plain words (`yes`, `yes mainnet`), not with `--` flags, because PowerShell's npm wrapper drops
flags written after `--`.

Everything the scripts and the server print is passed through a filter that hides your API
key and secret keys. Still read anything you are about to paste somewhere before you paste it.

## Part A — before any transaction

Nothing in Part A sends a transaction or spends SOL.

### A1. Build and offline checks

- [ ] `npm ci`, then `npm run build`, then `npm test`: all succeed (372 tests).

### A2. Environment for the first run

Copy `.env.example` to `.env`, then set:

```
HELIUS_API_KEY=<your mainnet key>
PUBLIC_ORIGIN=http://localhost:8080
HOST=127.0.0.1
PINATA_JWT=<your Pinata JWT>
DATA_DIR=./data-first-run
PARTNER_WALLET=<the first-run partner wallet's address>
CURVE_INITIAL_MARKET_CAP_SOL=1
CURVE_MIGRATION_MARKET_CAP_SOL=10
MAX_TRADE_LAMPORTS=2000000000
GHOST_DESK_ENABLED=NO
```

Leave the three `DBC_CONFIG_*` lines empty. Do not set `SOLANA_NETWORK`.

Why a small curve: the production curve needs about 88.6 SOL to complete, and roughly a fifth
of that would stay locked. A curve from 1 to 10 SOL of market cap completes at about 2.4 SOL,
so launch, trading, completion, graduation and the fee guarantee after graduation can all be
exercised for a few SOL. It is below the 10 SOL at which Meteora's keeper graduates curves by
itself, so in the first run you graduate by hand with `npm run migrate`.

### A3. What this project assumes about mainnet

- [ ] `npm run doctor` prints no `✗`. This is the first contact with the chain, and it only
      reads. It checks, on mainnet:
  - the RPC's genesis hash is mainnet-beta's;
  - the Rings program, registry and state tree exist;
  - **"anyone may create a Rings interface for a new mint"**. If this is `✗`, a launched token
    could not be held privately and the app refuses to launch. Nothing below can proceed
    until it is `✓`;
  - the prover attests against the signed mainnet policy;
  - whether the RPC gives a live priority fee estimate (a `!` if it does not).
- [ ] Expected at this point: one `!` per tier saying its config is not set.

If the doctor fails, stop here. Nothing has been spent.

## Part B — the first run, on mainnet, with small amounts

Tick every box. Where a step fails, stop and fix it before going on; later steps depend on
earlier ones. Every script simulates its transaction before sending it, and the site's first
send of every transaction runs a preflight simulation, so a wrongly built transaction is
normally rejected before any fee is paid.

### B1. First-run fee tiers

- [ ] `npm run configs:plan`. For all three tiers: the fee is the same on the curve and after
      graduation, no schedule, no dynamic fee, the curve split you expect, 100% of liquidity
      locked and "held by the platform 100% · the creator 0%", the creator's share after
      graduation that you intend to pay, "SOL in the curve at graduation" about 2.4, and
      graduation "By hand".
- [ ] Fund the deployer with 0.3 SOL.
- [ ] `npm run configs:apply yes mainnet` with `DEPLOYER_KEY` set. Each config's
      address is printed before it is sent and is re-read and compared with the plan after.
- [ ] Paste the three `DBC_CONFIG_*` lines it prints into `.env`.
- [ ] `npm run configs:verify` shows `✓` for all three.
- [ ] `npm run doctor` again: no `✗`. It now warns, once per tier, that these curves are below
      the keeper's 10 SOL. That warning is expected for this set.

### B2. Start the site on your own machine

- [ ] `npm start`. The log says `network: the RPC is Solana mainnet`, then
      `tiers: … verified against the chain` three times.
- [ ] Open exactly `http://localhost:8080` (not `127.0.0.1`: the API only answers its own
      origin). The pill in the header says Mainnet. The launch page offers all three tiers.

### B3. Wallet

- [ ] Wallet page: create a ghost wallet. Copy the secret key and store it. Lock and unlock.
- [ ] Send it 3.5 SOL from wherever you hold SOL. The public balance shows it.
- [ ] Register. Shield (deposit) 0.05 SOL. After the sync the private balance shows 0.05 SOL.
- [ ] Reload the page: the private balance comes back from the encrypted cache, then re-syncs.
- [ ] Watch the server log and the browser's network tab for `403 METHOD_NOT_ALLOWED` from
      `/api/helius`. If the Rings SDK needs an RPC method the relay does not list, add it to
      `ALLOWED_METHODS` in `server/src/proxy.ts` after checking what it does, and rebuild.
- [ ] Unshield (withdraw) 0.01 SOL back to the public balance.

### B4. Launch

Give the token a name that says it is a test. It is public and permanent, and people may buy it.

- [ ] Launch on the 3% tier with a 0.02 SOL first buy.
- [ ] On an explorer, the launch is **one** transaction containing: pool creation, the first
      swap, the Rings interface creation, a Rings deposit, and the token account close.
- [ ] The token appears on the market page. The creator's private balance shows the tokens.
- [ ] The success panel does **not** say that rounding units stayed public. If it does, the
      first-buy arithmetic differs from the chain by a unit. The fallback handled it, but note
      it, because the exact path is the intended one.
- [ ] Launch a second token on the 2% tier with no first buy.

### B5. Shielded route

- [ ] Deposit 0.2 SOL, then buy 0.05 SOL of the first token from the private balance. The
      quoted token amount arrives exactly. Unused SOL, if any, shows as public SOL.
- [ ] Sell half. The guaranteed minimum arrives in the private balance.
- [ ] Buy 0.02 SOL with "Public entry".
- [ ] Set slippage to 0.5% and trade right after another trade moved the price: the transaction
      is rejected and nothing moves.
- [ ] On an explorer, note these transactions' size in bytes, their account count, the
      compute units they used and the priority fee they paid. They must be under 4,096 bytes
      and 64 accounts; the app refuses to build one that is not.
- [ ] Compare the compute units used with the budgets in `COMPUTE_UNITS`
      (`shared/src/constants.ts`). The budgets follow the Rings SDK's own allowance and have
      not been measured for these compositions. If a transaction is refused for running out
      of compute, it failed in simulation and cost nothing: raise the matching budget and
      rebuild. If one uses far less than its budget, you may lower it, because the priority
      fee is priced on the budget.
- [ ] Try a buy above 2 SOL: refused, with the per-trade limit named (`MAX_TRADE_LAMPORTS`).

### B6. Private transfers

- [ ] Create a second ghost wallet in another browser profile. Send it 0.05 SOL. Register it.
- [ ] Send tokens privately from the first wallet to the second. The second sees them after
      its sync.
- [ ] On an explorer the transfer shows the two wallets and no token or amount.
- [ ] Send to an address that is not registered: refused with a clear message.
- [ ] Make three small deposits, then "Consolidate" the notes.
- [ ] Unshield to the public balance, and to a different address.
- [ ] On the token's page, under "Send or burn", type the second wallet's address: the line
      under the field says it is registered. Type an unregistered one: it says so, and sending
      is refused before anything is signed.

### B6b. Burning

- [ ] On the token's page, burn a small amount from the private balance. The form asks for the
      word `BURN`.
- [ ] On an explorer the burn is **one** transaction: a Rings withdrawal to your own token
      account, a `burnChecked` for exactly that amount, and the token account closed again.
      Your public balance of the token is unchanged.
- [ ] The page's "Supply now" and "Burned" change at once, and "Can more be minted" says no.
      Within about 20 seconds the market card for the token says how much is burned.
- [ ] Note the compute units used and compare them with `COMPUTE_UNITS.burn`
      (`shared/src/constants.ts`).
- [ ] Withdraw a few tokens to the public balance, then burn them from the wallet page's Burn
      tab, choosing the public balance. One transaction, no Rings instruction in it.
- [ ] In the wallet's private history the first burn reads as a withdrawal. That is expected.

### B7. Rewards, completing the curve, graduation

- [ ] As the creator, claim curve rewards on the token page. They land in the private balance.
- [ ] Deposit 2.6 SOL. Buy 1.5 SOL of the first token.
- [ ] Enter 2 SOL. The quote now says **"This buy completes the curve"** and costs less than
      you entered: it takes every token the curve still sells. Confirm it.
- [ ] The token page shows `MIGRATING` and trading is unavailable.
- [ ] `npm run migrate <mint>` shows the pool as complete. Then
      `npm run migrate <mint> yes` with `DEPLOYER_KEY` set.
- [ ] `npm run verify:graduated <mint>` passes: the same fee, no schedule, no dynamic fee,
      100% locked, and the locked liquidity held by the platform with none held by the creator.
      Note the "Meteora protocol share" it prints.
- [ ] The token page shows `GRADUATED`. Buy and sell through the Shielded route against the
      pool, at least 0.4 SOL in total, so the pool's fees are worth claiming. The fee shown is
      still the tier's.
- [ ] As the creator, the rewards panel no longer offers pool rewards: it says the platform
      holds the locked liquidity and pays the creator's share when it claims.

### B8. Platform fees

- [ ] Send the first-run partner wallet 0.02 SOL.
- [ ] `npm run fees:status` lists the curve fees, the pool position's fees, and how each pool
      claim would be divided between the creator and the platform.
- [ ] `npm run fees:claim yes` with `PARTNER_KEY` (the first-run partner's key) set.
- [ ] On an explorer, the pool claim is **one** transaction that both claims the position's
      fees and transfers the creator's part to the creator's wallet. The creator's wallet shows
      that amount as public SOL. The partner wallet rose by the rest.
- [ ] `ops/records/mainnet-creator-payouts.jsonl` has one line for that payout.

### B9. Controls

- [ ] Set `PAUSE_TRADING=YES`, restart: the token page says trading is paused, the wallet page
      still deposits, withdraws and sends. Set it back.
- [ ] Set `PAUSE_LAUNCHES=YES`, restart: the launch page refuses. Set it back.

### B10. External wallet (optional)

- [ ] Connect a Wallet Standard wallet. If it cannot sign version 1 transactions the app says
      so. If it can: deposit, shielded trade, private send.

### B11. Close the first run

- [ ] Sell or withdraw whatever you want out of the test tokens **now**. After the switch to
      the production configs this site neither lists nor trades them (their pools keep working
      on Meteora itself).
- [ ] Keep `ops/records/mainnet-*.json`. There is one file per config ever created.
- [ ] Save this `.env` as `.env.first-run` and keep `./data-first-run`. Putting them back
      brings the test tokens back, for instance to claim fees on them later.
- [ ] Keep the first-run partner wallet's key. The first-run configs exist for good, anyone can
      create a pool on them through Meteora, and the platform share of any fees on such pools
      is claimable by that wallet.

If any box could not be ticked, do not go on to Part D.

## Part C — decisions before the production configs

All of these, not most:

- [ ] Part B passed completely, on the exact code you will deploy.
- [ ] The launch economics. They are permanent per config: `CURVE_INITIAL_MARKET_CAP_SOL`,
      `CURVE_MIGRATION_MARKET_CAP_SOL`, `CREATOR_FEE_SHARE_PCT`. The defaults (30 and 420)
      complete at about 88.6 SOL, which is above the keeper's 10 SOL, so those curves graduate
      without you. With the default split, each curve fee goes 24% to the creator, 56% to the
      platform and 20% to Meteora.
- [ ] What you pay creators after graduation: `CREATOR_POOL_PAYOUT_PCT`. The platform holds
      all locked liquidity and collects every pool fee; this is the share of it you pass on.
      It is not on chain. The site tells creators the percentage and that the platform pays
      it, so set it to what you will in fact pay, and run `npm run fees:claim yes` on a
      schedule you can keep.
- [ ] The partner wallet is one you control long-term, and you have a way to sign with it.
- [ ] Someone other than the author has reviewed `shared/src/routes.ts`,
      `shared/src/meteora.ts` and `shared/src/privacy.ts`. This code has not been audited.
- [ ] You have checked the `@heliuslabs/spr` changelog for a release newer than `0.9.0-alpha`.
      If you upgrade, re-run the tests and Part B.
- [ ] Legal: confidential transfers and token launches are regulated differently by
      jurisdiction. Get advice for yours. Decide whether to geo-restrict.
- [ ] The name: an unrelated Solana privacy protocol called Privacy Cash already exists
      (privacycash.org). The site carries a non-affiliation notice. Decide whether that is enough.

## Part D — production

1. `.env`:
   - clear the three `DBC_CONFIG_*` lines;
   - `PARTNER_WALLET=<the real partner wallet>`;
   - your economics (`CURVE_*`, `CREATOR_FEE_SHARE_PCT`);
   - `PUBLIC_ORIGIN=https://privacycash.fun`, `HOST=0.0.0.0`, `TRUST_PROXY` to match your
     proxy chain, `DATA_DIR=./data`. The site works only at that address; if it has a second
     one, list it in `EXTRA_ORIGINS`;
   - keep `PINATA_JWT`, keep `MAX_TRADE_LAMPORTS` for the first days, keep `GHOST_DESK_ENABLED=NO`.
2. `npm run configs:plan`. Read it twice. Graduation must now say "Automatic".
3. `npm run configs:apply yes mainnet`. Paste the three addresses.
4. `npm run configs:verify`, then `npm run doctor`: no `✗`, and no keeper warning.
5. `npm run build`, then `npm start`, behind TLS. Serve only over https. Run one server process.
   On Render, follow [DEPLOY_RENDER.md](DEPLOY_RENDER.md) instead of this line.
6. From the deployed site, with a real wallet: one launch with a small first buy, one buy, one
   sell, one private transfer, one reward claim. This is the check that the deployed origin,
   your proxy and the pinned metadata work together.
7. When the first real token graduates, run `npm run verify:graduated <mint>` on it.
8. Announce only after step 6.

The server checks at start that each config was created with the economics in its environment
and refuses launches on a tier where they differ, so step 1 cannot be half done unnoticed.

## Part E — the Ghost desk (optional)

The desk is a hot wallet that takes the other side of users' trades. It is this project's own
design, it has never traded, and it can lose money. Its first run is also on mainnet, so keep
it small. The site works without it.

1. Someone other than the author reviews `shared/src/ghost.ts` and `server/src/desk.ts`. If you
   will fund the desk with meaningful amounts, get an independent audit of those two files first.
2. Make a key for the desk on your computer:

   ```
   npm run desk:new
   ```

   It prints an address and a secret key once and saves nothing. Put the secret in a password
   manager. Never reuse the partner or deployer key, and never paste the secret into a chat.
3. Send the address **1 SOL**. The desk keeps 0.3 SOL public for fees and trades only from its
   private balance, which it fills with whatever it holds above that. It does so only once it
   holds more than 0.6 SOL, so a desk sent less has nothing to trade with.
4. Register the wallet with Rings, once, from your computer. The key is given to this one
   shell and not written to a file.

   ```powershell
   $key = Read-Host "Desk secret key" -AsSecureString          # paste the secret, press Enter
   $env:DESK_SECRET_KEY = [System.Net.NetworkCredential]::new('', $key).Password
   npm run desk:register
   npm run desk:status
   Remove-Item Env:DESK_SECRET_KEY
   ```

   ```bash
   read -rs DESK_SECRET_KEY && export DESK_SECRET_KEY          # paste the secret, press Enter
   npm run desk:register && npm run desk:status
   unset DESK_SECRET_KEY
   ```

   `desk:status` must say `registered with Rings: yes`. A server that is already running
   notices the registration by itself within a few minutes and says so in its log
   (`desk: the wallet is registered with Rings now. Ghost fill is on.`); no restart is needed.
5. On the server, set these and restart (on Render: the Environment page, then deploy):

   ```
   GHOST_DESK_ENABLED=YES
   GHOST_DESK_MAINNET_ACK=YES
   DESK_SECRET_KEY=<the secret from step 2>
   DESK_MAX_ORDER_LAMPORTS=50000000
   DESK_TARGET_INVENTORY_LAMPORTS=50000000
   DESK_STOCK_MINTS=<the mint address of one token>
   ```

   `DESK_STOCK_MINTS` is what the desk keeps in stock, so that buys can be filled: it buys
   about `DESK_TARGET_INVENTORY_LAMPORTS` worth of each on the pool. A token still on its curve
   works. A graduated token with real depth is the calmer choice once you have one. Stock only
   tokens you are willing to hold: the desk loses when their price falls.
6. Watch the log for the first few minutes:

   ```
   desk: ready at <address>, private SOL 0 lamports
   desk: moved public SOL into the private float (<signature>)
   desk: restocked <TICKER> (<signature>)
   ```

   Each line after the first comes on a later pass, a minute or two apart. A line that says the
   desk has no private SOL to trade with means step 3 was too little.
7. Check, with a ghost wallet (Ghost fill needs the built-in wallet):
   - [ ] The token page offers Ghost fill, and `/api/status` shows `"desk":{"enabled":true`.
   - [ ] `npm run desk:status` (as in step 4) shows private SOL and tokens.
   - [ ] A Ghost buy and a Ghost sell of about 0.02 SOL each settle in one transaction.
   - [ ] On an explorer the fill has exactly two Rings instructions, the desk as fee payer, two
         signers, and no token or amount in the clear.
   - [ ] Type a buy above `DESK_MAX_ORDER_LAMPORTS`: the page moves to the Shielded route by
         itself and says under Ghost fill that the desk passed on the order, and why. Type a
         size the desk can take: it moves back. Pick Ghost fill by hand with the large size:
         it stays on Ghost fill and shows the refusal.
   - [ ] A fill shows "At least" under the amount you receive. Pressing the button proves first,
         then asks the desk for its price again; the fill settles at that second price when it
         is within your slippage limit of the first.
   - [ ] Sell the desk a token that is **not** in `DESK_STOCK_MINTS`: the log shows it unwinding
         that token to the pool over the next passes.
   - [ ] Stop the server after "prepare" and before "submit". Nothing settles, the trader's
         funds are untouched, and after a restart the desk works again.
8. Run the desk's own check, from your computer, with the key in the shell as in step 4:

   ```
   npm run desk:check <the desk's address>
   ```

   It sends nothing. It confirms the key in the shell is that address's key, that the wallet
   is registered and set up for consolidation, that it has public SOL for fees and private SOL
   to pay sellers, and what it holds of each stocked token. Then it does a dry run: it makes
   up to two real proofs (each costs what any private transfer costs on your Helius plan) and
   has the chain run them without recording anything. One private transfer must pass, and, once
   the desk holds two notes, two in one transaction must pass too, which is the shape of a
   fill. It prints the compute units and the size against their limits. Every line marked ✗ is
   something to fix. What it cannot show is a fill with a second wallet: that is step 7.
9. Raise the limits slowly. Watch `npm run desk:status` and the log daily. The desk's profit
   and loss is its total value against what you funded it with. If it trends down, widen
   `DESK_SPREAD_BPS`, lower `DESK_MAX_IMPACT_BPS`, or switch it off.

**How the desk loses money.** It buys from sellers at the pool's price without moving the
pool. A holder who is about to sell a lot can sell the first part to the desk at the full
price and the rest to the pool, which then drops: the desk is left to sell what it took at
the lower price. The spread does not cover that. What bounds it is `DESK_MAX_ORDER_LAMPORTS`
(one trade), `DESK_TARGET_INVENTORY_LAMPORTS` (the desk never holds more than twice this of
one token) and how much SOL the desk has at all. A token's own creator is the wallet best
placed to do this. Keep those three small, and treat what the desk holds as money at risk.

**What the desk tells a trader after sending.** Only what the chain decided. It follows a
fill until it has landed, been rejected, or its blockhash is too old to land, and answers
with that. If the RPC stops answering in between, it says the fill was sent and is not yet
confirmed, and the log has `was sent and has not been seen to land or to expire`: look the
signature up, and expect either both transfers or neither.

**Timing.** A quote holds a price for `DESK_QUOTE_TTL_MS`. The page proves the trader's side
before it asks for the price it trades at, so that time only has to cover the request. Once
the desk has prepared its side the trader has 15 seconds to check, sign and return it.

**Balances split across notes.** A fill can spend five notes of an asset. When one of the
desk's balances is split across more than four, the log says so, hourly. Consolidate it from
the wallet page (import the desk key in a private window), and once you have seen that work
on mainnet, set `DESK_AUTO_CONSOLIDATE=YES` to have the server do it, one balance per pass.

**Fee money.** The desk pays every fill's network fee from its public SOL and refills
nothing by itself. Below 0.075 SOL the log says `only … public SOL left for fees`, hourly.
Send it SOL then: fills stop when it runs out.

**If the server starts while the RPC is down** the desk keeps trying every 30 seconds and
stays off until it has read its wallet once (`desk: not up yet … Trying again`).

**Costs to expect.** Every fill and every pool trade the desk makes needs proofs, which are
billed to your Helius key like a visitor's. The desk also pays the transaction fee of every
fill. If the hosting platform restarts the service for running out of memory, move up one
instance size.

**Switching it off and taking the funds out.** Set `GHOST_DESK_ENABLED=NO` and restart, so
the server stops using the key. Then open the site's wallet page in a browser where no ghost
wallet exists (a private window works), choose Import, and paste the desk's secret key. The
desk's private SOL and tokens are there: withdraw them to any address. Remove the wallet from
that browser when you are done.

## Part F — operating

- **Priority fees.** The server follows Helius's live estimate, between
  `PRIORITY_FEE_MIN_MICROLAMPORTS` and `PRIORITY_FEE_MAX_MICROLAMPORTS`, and every transaction
  the site or the scripts build pays it. If transactions are slow to land, raise the floor. The
  browser re-sends a signed transaction every two seconds until it confirms or expires.
- **Pause and cap.** `PAUSE_LAUNCHES`, `PAUSE_TRADING` and `MAX_TRADE_LAMPORTS` take effect on
  restart. They stop new launches or trades made through the site. They cannot stop anyone
  trading the pools on Meteora directly, and they never touch a visitor's own funds: deposits,
  withdrawals, private transfers and burns always work, on the wallet page and on a token's.
- **Listing.** Tokens launched through the site are listed at once. Every `DISCOVERY_MINUTES`
  the server also scans Meteora for pools under your configs that it has not seen. Only tokens
  on the configs in the environment are listed.
- **Graduation.** Production SOL curves are graduated by Meteora's keeper. If a completed
  curve has not graduated after a few minutes, press **Graduate it now** on its page with any
  wallet, or run `npm run migrate <mint> yes`. It is permissionless and gains the payer
  nothing. Curves priced in a pair token the keeper does not cover always need one of the two:
  see Part G.
- **Back up `DATA_DIR`.** It holds the listing cache, which can be rebuilt from chain, and the
  server's copies of pinned artwork (`ipfs/`), which are fetched from IPFS again if lost.
  Without `PINATA_JWT` it also holds every token's artwork and metadata, which cannot be
  recovered. Keep pinning on.
- **Decide where token logos are addressed** before many tokens exist: `PINATA_GATEWAY_URL`
  in `.env.example`. It is written into each token's metadata for good. This site's own pages
  show logos from the server's copies whatever you choose.
- **Watch Helius credits.** `PROOFS_PER_MINUTE_PER_IP` and `PROOFS_DAILY_LIMIT` bound what
  visitors can spend through your key. Set the daily limit from your plan.
- **This computer must know every pair.** `fees:status`, `fees:claim`, `migrate` and
  `verify:graduated` only see tokens on the configs in this computer's `.env`. `fees:status`
  and `fees:claim` name, in their first lines, the pairs they are looking at, and warn about
  any the live site has that they do not. Keep the `.env` here in step with the server's
  `CURVE_*`, `DBC_CONFIG_*` and `DBC_CONFIGS_PREVIOUS`.
- **Claim fees, and pay creators,** with `npm run fees:status` and `npm run fees:claim yes`.
  Run it on your own computer, with `PARTNER_KEY` set in that shell only. The partner key never
  goes on the server. Where the script finds no token list it reads the pools from chain.
  Each pool claim sends the creator's share in the same transaction, so creators are paid
  exactly when you run it and not otherwise. Run it on a regular schedule. A pool whose
  creator share is still under 0.002 SOL is skipped and keeps accruing. Every payout is
  appended to `ops/records/mainnet-creator-payouts.jsonl`.
- **Upgrades.** After changing dependencies, re-run the tests. A change to the Rings or
  Meteora SDKs deserves Part B again on the first-run set (`.env.first-run`).
- **Incident: something looks wrong with trades or launches.** Set the matching pause switch
  and restart. Users keep full access to their own funds through the wallet page.
- **Incident: suspected desk problem.** Set `GHOST_DESK_ENABLED=NO` and restart. Fills stop;
  the Shielded route is unaffected. Move the desk's funds with its key from a clean machine.
- **Incident: suspected site compromise.** Take the site down. A script-injection bug could
  read an unlocked ghost wallet's seed from the page. Tell users to move funds to a new wallet.

## Part G — pair tokens other than SOL (optional)

A token can be priced in USDC, ZEC, NEAR, XMR, ANT, RENDER or hSOL instead of SOL. Each pair
is switched on separately. **None of this has run on chain yet**: the first token you launch
against a pair is the first time that pair's routes meet mainnet. Do G1 to G3 for one pair,
with small amounts, before you offer it to anyone. USDC is the natural first one.

What stays true for every pair: network fees are paid in SOL; the fee tiers are the same 2%,
3% and 4%; all graduated liquidity is locked to the platform. What changes: buyers pay the
pair token, sellers and creators are paid in it, and your own fee claims arrive in it.

### G1. Read the token from chain

- [ ] `npm run doctor`. Under **Pair tokens**, the pair you want says "It can be a pair
      here". If it says it cannot (a Token-2022 mint, other decimals than listed, no mint at
      that address), stop: this build will not use it, and the reason is on that line.
- [ ] Read the two lines under it: who can mint more of the token, and who can freeze accounts
      that hold it. A freeze authority can freeze a pool's account and the Rings vault. Decide
      whether you accept that for tokens launched on your site.
- [ ] Note whether Rings has an interface for it. If not, `configs:apply` creates one first and
      pays its rent. If the doctor says creating one is restricted, the pair cannot be used.

### G2. A first run of the pair, with a small curve

The same idea as Part B: a set of configs sized so a whole life, graduation included, costs
little. It runs on your own computer, against mainnet, and does not touch the deployed site.

- [ ] On your own computer, keep a copy of your production `.env` (as `.env.production`) and
      put the first-run one back: copy `.env.first-run` to `.env`, with
      `PUBLIC_ORIGIN=http://localhost:8080` and `DATA_DIR=./data-first-run` as in Part A.
- [ ] In that `.env`, size the pair small, for example for USDC:
      `CURVE_INITIAL_MARKET_CAP_USDC=30` and `CURVE_MIGRATION_MARKET_CAP_USDC=420`. That curve
      completes at about 88.6 USDC.
- [ ] `npm run configs:plan USDC`. Read all three tiers: "priced and traded in" names the
      right mint and decimals, the fee lines are as for SOL, and "graduation" says by hand
      (under 750 USDC the keeper does not act, which is what this run wants to exercise).
- [ ] `npm run configs:apply yes mainnet USDC` with `DEPLOYER_KEY` set. Paste the lines it
      prints into `.env`. `npm run configs:verify USDC` shows three `✓`.
- [ ] Start the site on your own machine. The log says the pair was confirmed on chain and
      each of its tiers verified. On the Launch page, the pair shows **Live**.
- [ ] With a wallet that holds a few USDC and 0.1 SOL, publicly: launch a token against USDC
      with a first buy of 1 USDC. The first buy lands in the private balance.
- [ ] **Public entry**: buy with 2 public USDC. Then deposit 5 USDC on the Wallet page and buy
      on the **Shielded route**. Then sell half on the Shielded route. After each: the private
      balances are right, and what was not used shows as public USDC in the wallet.
- [ ] Claim the creator's curve fees from the token's page: they arrive as private USDC.
- [ ] Complete the curve (the page plans the last buy). The page shows **MIGRATING** and the
      **Graduate it now** box. Press it. `npm run verify:graduated <mint>` then passes, and
      the token trades on its pool: one buy, one sell.
- [ ] `npm run fees:status`, then `npm run fees:claim yes` with `PARTNER_KEY`: the platform's
      fees arrive as USDC in the partner wallet, and the creator's part of a pool claim is
      sent to the creator as USDC in the same transaction.

- [ ] Save this `.env` as `.env.first-run` again, and put `.env.production` back as `.env`.

Where any of these fails, stop and keep the pair off in production. The error and the
transaction signature are what a fix needs. If you skip this part and go straight to G3, do
its last step with amounts you would not miss, and know that graduation for this pair will
first be exercised when a real curve completes.

### G3. Production size

- [ ] Choose the two sizes. The doctor suggests ones worth what your SOL curve is at today's
      prices. They are permanent, and they also set the rate at which this pair is compared
      with SOL for ordering, totals and `MAX_TRADE_LAMPORTS`.
- [ ] In `.env`: set the two `CURVE_*_<ID>` lines, leave the three `DBC_CONFIG_*_<ID>` unset.
- [ ] `npm run configs:plan <ID>`, read it twice, `npm run configs:apply yes mainnet <ID>`,
      paste the lines, `npm run configs:verify`.
- [ ] Put the same five lines in the hosting platform's settings and deploy. The log names
      the pair as confirmed and its tiers as verified.
- [ ] From the deployed site: one launch against the pair with a small first buy, one buy,
      one sell.

### G4. Operating a pair

- **Graduation.** For USDC curves of 750 USDC or more Meteora's keeper acts by itself. For
  the other pair tokens it acts only if Jupiter lists the token as verified with an organic
  score above 50 and the curve raises over 750 dollars' worth; you cannot rely on that.
  Completed curves it leaves alone wait for the button on the token's page, which any visitor
  can press, or for `npm run migrate <mint> yes`. Check the market for **MIGRATING** tokens.
- **Fees.** `npm run fees:status` shows totals per pair token. Claims pay out in the pair
  token, into the partner wallet's token account for it. A creator payout in a pair token
  opens the creator's token account if they have none, and that rent (about 0.002 SOL) is
  yours; such a payout is not sent until it is worth about 0.01 SOL.
- **Switching a pair off.** Remove its `CURVE_*` and `DBC_CONFIG_*` lines and deploy. Its
  tokens leave the listing and can no longer be traded through the site. The pools remain on
  Meteora, and holders keep full access to their balances through the Wallet page.
- **The pair token itself.** If a bridged or wrapped pair token fails, or its issuer freezes
  an account, tokens priced in it are affected and nothing on this site can undo that. The
  launch page and the docs tell creators so.

## Part H — paying with SOL or USDC (optional)

With a Jupiter API key the token page offers **Pay with** (and **Receive**): SOL or USDC in
place of a token's pair token, converted on Jupiter inside the same transaction as the trade.
**None of this has run on chain yet.** It needs nothing created on chain and can be switched
off again by removing the key.

### H1. Switch it on, on your own computer first

- [ ] Get a key at developers.jup.ag/portal. Put `JUPITER_API_KEY=<key>` in `.env`. Leave
      `JUPITER_RPS` unset on a free key (1 request a second); set it to your plan's number
      otherwise.
- [ ] `npm run doctor`. Under **Converting (Jupiter)** every line is a `✓`: SOL → USDC,
      USDC → SOL, and four lines for each pair token in use. Each `✓` means Jupiter answered
      and the answer passed the same check a browser makes before signing.
      - A `✗ … the site would refuse this answer` line means Jupiter's instructions are not
        in a shape this build reads. Converting would be refused for that direction, safely.
        Send that line to whoever maintains the code.
      - A `! … No routes found` line is about the market, not your setup: that pair token has
        no route short enough at that size. People can still trade it with the pair token.
- [ ] Start the site on your own machine. The log says `convert: on`.

### H2. One of each, with amounts you would not miss

Use a token you launched for a first run (Part B, or Part G for a pair), with a wallet that
holds a little SOL and a little USDC, publicly.

- [ ] **Public entry, pay with the other token.** On a token priced in SOL choose USDC under
      **Pay with**; on one priced in USDC choose SOL. Enter a small amount. Read the quote:
      what you pay, what it converts to, what the pool takes, what is left over. Press. One
      signature. The tokens are in your private balance, and the left-over pair token is in
      your public balance as the quote said.
- [ ] **Shielded route, pay with the other token.** Deposit a little of it first on the
      Wallet page, then the same buy on the Shielded route.
- [ ] **Sell, receive the other token.** Sell half. The proceeds arrive in your private
      balance in the token you chose.
- [ ] After each: open the transaction in an explorer. It is one transaction, with Jupiter's
      program and Meteora's in it, and it paid nobody you do not recognise.
- [ ] Try an amount far too small (a few lamports' worth). The page says there is no route or
      that the amount is too small, and sends nothing.

Where any of these fails, the message and the transaction signature (if there is one) are
what a fix needs. Until then remove `JUPITER_API_KEY`: the choice disappears and everything
else works as before.

### H3. Production

- [ ] Put `JUPITER_API_KEY` (and `JUPITER_RPS` if not 1) in the hosting platform's settings
      and deploy. The log says `convert: on`.
- [ ] Watch for `convert: Jupiter refused this server's API key` in the log, and for visitors
      being told the converter is busy: that is the key's allowance. A paid plan and a higher
      `JUPITER_RPS` is the fix.

## Part I — changing the fee split for new launches

`CREATOR_FEE_SHARE_PCT` is written into every config when it is created, and a config can
never be edited. So the split changes like this: the configs you have are **kept** for the
tokens already launched on them, and a **new set** is created for launches from now on.

- A token launched before the change keeps its old split for good. Its page states its own.
- Tokens launched afterwards get the new split.
- Nothing about an existing token, its pool or its fees is touched.

The number is the creator's share of what is left of each curve fee **after Meteora's 20%**:

| `CREATOR_FEE_SHARE_PCT` | Creator | Platform | Meteora |
| --- | --- | --- | --- |
| 30 (the default) | 24% | 56% | 20% |
| 80 | 64% | 16% | 20% |

`CREATOR_POOL_PAYOUT_PCT`, what you pay creators after graduation, is a separate setting.
**Left unset it follows `CREATOR_FEE_SHARE_PCT`**, so set it yourself, in the same step, to
what you mean (30, for instance).

Do it in this order. Each step says what you should see.

- [ ] **I1. Deploy this version first, with the settings unchanged.** An older version does not
      know `DBC_CONFIGS_PREVIOUS` and would stop listing your tokens at step I9. Open the
      site: every token is there.
- [ ] **I2. Copy the server's current settings.** In the hosting platform's settings, copy
      every `DBC_CONFIG_*`, `CURVE_*`, `CREATOR_*` and `PARTNER_WALLET` line into a text file
      you keep. That file is your way back (see "If something is wrong" below).
- [ ] **I3. Make this computer see every pair.** The `.env` on this computer must hold every
      `CURVE_*` and `DBC_CONFIG_*` line the server has, with the same values. You do not have
      to copy them by hand: with `PUBLIC_ORIGIN` in this `.env` set to your site's address,
      `npm run fees:status` asks the live site and prints, ready to paste, every such line this
      `.env` lacks. They are public addresses and sizes, not secrets. Paste them into `.env`
      and run it again, until there is no "NOT looking at" line and no line starting with `!`.
- [ ] **I4. `npm run configs:retire write 80`** (the number is the new `CREATOR_FEE_SHARE_PCT`).
      It sends nothing and does not touch `.env`. It asks the live site the same question
      first, and **writes nothing while this `.env` lacks a pair or a config the site uses**:
      it prints the missing lines instead (back to I3). Then it writes a copy, `.env.next`, in
      which:
      - every `DBC_CONFIG_*` line has become a comment (`apply` only creates a config where
        there is no address);
      - one new line, `DBC_CONFIGS_PREVIOUS=...`, holds all of those addresses;
      - `CREATOR_FEE_SHARE_PCT` is the number you gave;
      - `CREATOR_POOL_PAYOUT_PCT` is written down as it is today, if the file did not state it.

      It says how many lines it retired: **21 for seven pairs**. A smaller number means a pair
      is missing here. Open `.env.next` and read its last lines. `npm run configs:retire` alone
      prints the same edit to make by hand instead. If the site cannot be asked at all it
      stops and says how to go on (`unchecked`), which you should only do after comparing the
      two sets of settings yourself.
- [ ] **I5. Put the new file in place**, keeping the old one:

      ```powershell
      Copy-Item .env .env.before-split
      Copy-Item .env.next .env -Force
      ```

      (bash: `cp .env .env.before-split && cp .env.next .env`.) Neither file is ever committed:
      `.gitignore` covers `.env` and `.env.*`.
- [ ] **I6. `npm run configs:plan`.** Read it. For every pair and tier, the lines
      `curve fees: creator` and `curve fees: platform` show the new split, and
      `creator after graduation` shows the payout. Nothing was sent.
- [ ] **I7. `npm run configs:apply yes mainnet`**, with `DEPLOYER_KEY` set in this shell only
      (the PowerShell lines are at the top of this runbook). It creates one config per tier
      per pair: 21 for seven pairs, about 0.17 SOL of rent plus fees, so the deployer needs
      about 0.25 SOL. Before it pays anything it checks two things and stops if either fails:
      that the curve sizes in this `.env` are the live site's (the server refuses launches on
      configs made with other sizes), and that every config in `DBC_CONFIGS_PREVIOUS` is still
      recognised as yours under this `.env` (which catches a different `PARTNER_WALLET`).
      Each config's `DBC_CONFIG_...=` line is printed as it is created, and at
      the end one block holds everything the server needs: the new addresses,
      `DBC_CONFIGS_PREVIOUS`, `CREATOR_FEE_SHARE_PCT` and `CREATOR_POOL_PAYOUT_PCT`.
      Put the new `DBC_CONFIG_*` lines in `.env` here.
      - If it stops partway (the RPC timed out, the deployer ran dry): put the
        `DBC_CONFIG_...=` lines printed so far into `.env` first, then run it again. It skips
        what is set and creates the rest.
- [ ] **I8. `npm run configs:verify`.** Every new config is a `✓`, and every old one is a
      `✓ kept:` line with its old creator share.
- [ ] **I9. The server.** In the hosting platform's settings, set every line of that block:
      each `DBC_CONFIG_*` gets its new address, `DBC_CONFIGS_PREVIOUS` is added, and
      `CREATOR_FEE_SHARE_PCT` and `CREATOR_POOL_PAYOUT_PCT` are set. All of them together,
      then deploy: with only some of them the server refuses launches and says why in its log.
- [ ] **I10. Check the live site.**
      - The log has a `tiers: kept config ... confirmed` line for each old config and a
        `tiers: ... verified against the chain` line for each new one.
      - The market shows every token it showed before.
      - An old token's page, under **Token facts**, still states its old split.
      - The Launch page states the new one.
      - `npm run fees:status` here lists every token, old and new.

**If something is wrong** after I9: put the settings from your text file (I2) back on the
server and deploy, and on this computer `Copy-Item .env.before-split .env -Force`. The old
configs take launches again exactly as before, and the new ones simply sit unused. Nothing on
chain needs undoing.

Later changes work the same way: `configs:retire write <share>` adds the current set to the
kept ones.

## Part J — fee modules (optional)

With modules on, a token's creator can have their share of the trading fees **bought back
and burned**, **shared between up to four wallets**, or both, automatically. The creator
signs one transaction that hands the pool's creator role to a wallet this server derives for
that token, with the settings on chain as a memo. From then on the server claims the
creator's fees on a schedule and pays them out exactly as set. It is permanent per token.
At launch it is a second transaction, sent as soon as the new token is listed; the launch
transaction itself is the same one as without modules.

**None of this has run on chain yet.** The first payout and the first buyback you see are the
first time these transactions meet mainnet. So: a dry run first, then one token of your own.

What it puts on the server: **one secret, `MODULES_SEED`**. Whoever reads it can take creator
fees that have not been paid out yet, the buyback pots, and the gas tank. Never a trader's
money, never the platform's share, never liquidity. **Losing it is worse than leaking it**:
the creator fees of every token with modules can only ever be reached with that exact seed.

### J1. The seed and the gas tank

- [ ] On your own computer: `npm run modules:new`. It prints two lines and saves nothing.
- [ ] Put **both** lines in the hosting platform's settings: `MODULES_SEED` (secret) and
      `MODULES_GAS_TANK` (an address, not secret).
- [ ] Put a second copy of the seed in a password manager. Not in a file in this folder, not
      in a chat. Clear the terminal.
- [ ] Send about **0.1 SOL** to the `MODULES_GAS_TANK` address. It pays the network fee of
      every module transaction and the rent of the token accounts modules need (about 0.002
      SOL each, between two and eight per token, once).

The server works the gas tank's address out from the seed and refuses to run modules if it is
not the one in `MODULES_GAS_TANK`. That is what catches a seed pasted incompletely, or
replaced by a new one. **Never change the seed once a token has modules.**

### J2. Switch it on as a dry run

- [ ] In the hosting platform's settings: `MODULES_ENABLED=YES`, `MODULES_MAINNET_ACK=YES`,
      `MODULES_DRY_RUN=YES`. Deploy.
- [ ] The log says `modules: on (DRY RUN: ...)` and names the gas tank.
- [ ] The Launch page, on its second screen, now offers **Run my fees through fee modules**.

In a dry run the server works every pass out and runs each transaction against the chain,
and sends nothing. What creators do is real all the same: switching modules on is their own
signed transaction.

### J3. One token of your own

- [ ] With a wallet of yours, launch a token on the live site with modules ticked: for
      instance 50% buyback and burn and 50% to a second wallet you own, and a small first
      buy. The launch lands first. Then the page asks for a second signature, which switches
      the modules on. It runs that transaction against the chain before your wallet signs.
      - **FEE MODULES ARE ON**: both went through.
      - **FEE MODULES WERE NOT SWITCHED ON**, with a reason: the token is live and nothing
        else happened. Send that reason to whoever maintains the code. Creators can launch
        without modules meanwhile, and nothing is lost.
- [ ] Open the token's page. **Fee modules are on** lists your settings, the fee wallet and
      the buyback pot.
- [ ] Open that second transaction in an explorer. It contains Meteora's
      `TransferPoolCreator` and a memo that starts `pcf:modules:1|`.
- [ ] Trade the token until enough creator fees are waiting: `MODULES_MIN_LAMPORTS`, 0.02 SOL
      by default. On a 3% token whose creator share is 64%, that is about 1.1 SOL of volume.
      Each wallet's share must also reach 0.001 SOL before anything is sent.
- [ ] Wait for a pass (`MODULES_EVERY_MINUTES`; the first one runs about a minute after the
      server starts). In the log:
      - `modules: DRY RUN, not sent: $TICKER: paying out ... It passed its run against the
        chain.` The payout was built and the chain's own simulation accepted it.
      - A line with `it would fail, so it was not sent:` instead means it was refused, with the
        chain's reason after it. Nothing moved. That line is what a fix needs.
      - A dry run exercises the payout only. The buyback spends what a payout has really put
        in the pot, so it is first run, against the chain and then for real, in J4.

### J4. Go live

- [ ] `MODULES_DRY_RUN=NO`, deploy.
- [ ] After the next pass the log has `modules: $TICKER: paying out ... <signature>` and then
      `modules: $TICKER: buying back with ... and burning ... <signature>`.
- [ ] Open both in an explorer. The payout: each wallet received exactly its share and the
      rest went to the pot. The buyback: a swap, then a burn of the token.
- [ ] The token's page lists both under **Fee modules are on**, and its **Burned** figure
      rose. `npm run modules:status` on your computer shows the same and the gas tank's
      balance.
- [ ] On a token of yours launched **without** modules, open its page with the creator's
      wallet: **Automate your fees** is offered, to that wallet only. Switch one on that way
      too, so both ways in have been seen.

### J5. Operating

- **Keep the gas tank funded.** `npm run modules:status` shows its balance. Below about 0.003
  SOL the server sends nothing and says so in the log; nothing is lost meanwhile.
- **After graduation** the platform's payout of pool fees goes to whoever holds the creator
  role. For a token with modules that is its fee wallet, so `npm run fees:claim yes` pays it
  there and the next pass divides it. You do nothing different.
- **A token whose page says "the last pass could not finish"** is tried again on the next pass. The
  reason is in the log, on a line starting `modules:`. Fees stay where they are meanwhile.
  The payout and the buyback are separate steps: one that cannot go ahead does not hold the
  other back.
- **"payout waiting on token accounts"** concerns tokens priced in something other than SOL.
  Their sharing wallets are paid into a token account, and the gas tank opens that account
  once per wallet. An owner can close it and keep the rent, so the server never opens it a
  second time; otherwise that rent could be collected from the gas tank again and again. The
  token's page tells its creator what to do: send that wallet any amount of the pair token,
  which opens the account. The payout then goes ahead with everything that built up.
- **To stop sending** without losing anything: `MODULES_DRY_RUN=YES` and deploy.
  `PAUSE_TRADING=YES` stops buybacks only; payouts continue.
- **Switching modules off** (`MODULES_ENABLED=NO`) stops new ones being offered and stops the
  passes. Tokens that already have modules keep them on chain: their fees wait until modules
  run again. Do not leave it off for long.
- **If the server's disk is lost**, the modules are found again from chain: the server reads
  each token's creator and looks for the memo in that address's history (the latest 5,000
  transactions). A token it cannot find that way is restored by sending its memo to
  `POST /api/tokens/<mint>/refresh` as `{"memo":"pcf:modules:1|..."}`. The memo is in the
  transaction that switched the modules on. It is accepted only if the chain agrees with it.
- **Incident: suspected leak of `MODULES_SEED`.** Set `MODULES_DRY_RUN=YES` at once. What is at
  risk is what sits in fee wallets and pots right now, which each pass keeps small. The seed
  cannot be replaced for existing tokens. Get help before doing anything else.

### J6. What modules do not do

- Settings cannot be changed or switched off for a token, by anyone.
- They pay public wallets. A private balance in Rings cannot be paid by a module.
- A curve whose last buy overshoots its target keeps the excess as a surplus, which Meteora's
  program splits: 20% to Meteora, and the rest between the platform and the creator in the
  same proportion as curve fees. Modules do not collect the creator's part of it yet. It
  stays in the pool, where only the fee wallet can collect it, so a later version can.
- Holder rewards and a lottery are not built: balances held in Rings sit in one pooled
  account, so the chain cannot say who holds how much.

## Part K — prvmax (vaults)

prvmax is a page, `/prvmax`. It has no setting, no server code and no key on the server:
everything happens in the visitor's browser, through the same relay the wallet page uses.
Deploying the version that contains it is all there is to switching it on.

### K1. What it does to this server

- **Proofs.** Every private transfer, Shielded trade, Ghost fill and private recall needs one
  proof, and each proof is billed to this server's Helius key. A full round over ten vaults
  (spread, buy, sell, recall) is about forty. The page spaces its proofs six seconds apart so
  that one visitor stays under `PROOFS_PER_MINUTE_PER_IP` (12). The hourly allowance is ten
  times that, 120: about three full rounds an hour for one address. Raise
  `PROOFS_PER_MINUTE_PER_IP` if real users run into it, and watch `PROOFS_DAILY_LIMIT` (5000):
  it is shared by the whole site, and when it is used up nobody can make a private
  transaction until it resets.
- **The desk.** A Ghost fill from a vault is an ordinary Ghost fill: the same limits, the same
  one-at-a-time settlement, the same inventory. Ten vaults can ask ten fills in a row.
- **Nothing else.** No table, no new endpoint, no background work.

### K2. First run, with small amounts

Do this yourself, with a ghost wallet you control, before telling anyone the page exists.
Use 2 vaults and amounts you would not miss. After each step, compare the page with an
explorer.

1. Wallet page: deposit 0.1 SOL into the private balance and keep about 0.1 SOL public.
2. `/prvmax`: open the vaults with **2** in use. Write down both vault addresses.
3. **Get ready** with 0.03 SOL. On an explorer: one transaction from your wallet with two
   transfers of 0.03 SOL, then each vault's registration. The table shows both vaults as
   Registered with about 0.03 public SOL, a little less after registering.
4. **Spread** 0.04 SOL across both. On an explorer: two transactions, each naming your
   wallet and one vault, with no amount. The table shows 0.02 private SOL in each vault.
5. **Buy** a token priced in SOL from both vaults, 0.01 SOL each, on the Shielded route. On
   an explorer: each vault's swap, in public. The table shows the token in each vault.
6. If the desk is on: **Buy** again with the Ghost fill route, 0.005 SOL each. Check that the
   quote appears first and nothing is sent until the second press.
7. **Sell** all of it from both vaults.
8. **Recall** to this wallet, privately. The table shows both vaults at 0 public SOL and
   nothing private, and your wallet's private balance holds what came back.
9. **Keys**: copy vault 1's secret key, open a private browser window, import it on the
   Wallet page, and check that it shows the same address. Then close that window.

If a step stops, the page says where. Read the table before pressing anything again: spread
and trades are not repeated automatically, because a transaction whose confirmation was not
seen may still have settled.

### K3. What to tell people

Say what the page says: vaults keep amounts and holdings private, the vaults themselves are
public, a pool trade is public, and only a Ghost fill hides a trade's token and size, from
everyone but the desk. Do not call vaults untraceable or separate identities: the wallet funds
each one in public. A wallet cannot use vaults with a token it created, nor with one created
by another wallet kept in the same browser, and the page refuses
it; that check runs in the browser and is a rule of this site, not of the chain.

### K4. If someone loses access

- **"My vaults are empty, and I filled them."** One key leads to two sets of vaults: the
  standard set (a wallet extension's, and a ghost wallet's from this version on) and the
  ghost-only set (what a ghost wallet was given before). Until this version the same key
  showed one set through an extension and the other as a ghost wallet, with nothing to say
  so. Nothing moves between them and nothing is lost. A ghost wallet now shows whichever
  set has been used, says above the table when the other one has been used too, and
  switches by hand under **Keys**. An extension shows the standard set; vaults in a ghost
  wallet's ghost-only set are opened from the ghost wallet (import the key).
- A ghost wallet's vaults come back with the wallet's secret key, on any device.
- A wallet extension's vaults come back when the same wallet signs the same message. If the
  page says the keys do not match the vaults it set up, it opens nothing: the user reconnects
  the same account in the same wallet. It does open them when the chain shows those vaults
  are already in use, since they were then reached with this signature before.
- Any vault's secret key, exported from the Keys tab, works on its own in any Solana wallet.
- This server holds nothing that can recover a vault, and nobody at this site can.

## Part L — the wallet: several wallets

From this version a browser keeps several ghost wallets under one passphrase, and the wallet
page calls a deposit **Shield** and a withdrawal **Unshield**. There is no setting:
deploying the version is all there is. The server changes in one place: the relay now also
passes `getSignaturesForAddress`, at most ten entries a call, which **Look for my wallets**
uses to ask whether anything ever happened at an address. `npm install` is needed once when
updating, because the QR code on the Receive panel uses a new package (`qrcode-generator`).

### L1. What changes for a wallet that already exists

Nothing about how it is stored. The record `pcf.vault.v1` is read and never rewritten, so a
wallet made by any earlier version opens with the same passphrase and shows as "Wallet 1",
the first wallet. A tab that was already unlocked when the new version went live keeps
working without unlocking again. Its prvmax vaults are the same ten as before.

The first thing to check after deploying, before anything else:

- [ ] Open the site in the browser that holds your own ghost wallet. Unlock. The address on
      the card is the address you know, the balances are the ones you expect, and `/prvmax`
      opens the same vaults.

If any of that is not so, stop and do not use the page: redeploy the previous version from
Render's list of deploys. Nothing has been changed in the browser by looking.

### L2. First run, with small amounts

Use your own wallet and amounts you would not miss. Compare each step with an explorer.

1. **New wallet.** Press it, name it. The card shows a new address and "Made from your
   first wallet". Press **Secret key** on its tile and save the key somewhere: for this
   first run, treat it as a wallet with its own backup.
2. **Fund it in public.** Press **Use** on Wallet 1, choose **Send**, set **Send from** to
   the public balance, press the new wallet's button under the address field, send 0.05 SOL.
   On an explorer: one plain transfer between the two addresses.
3. **Use the new wallet.** Press **Register**, then **Shield** 0.02 SOL. The private balance
   shows 0.02 SOL after the sync, and the history lists a Shield.
4. **Send privately between them.** Register Wallet 1 if it is not registered. From the new
   wallet, **Send** 0.01 SOL from the private balance to Wallet 1. On an explorer: the two
   wallets and no amount. Switch to Wallet 1: its private balance shows it after the sync.
5. **Unshield** what is left in the new wallet to its own public balance.
6. **Empty it.** Send from the public balance to Wallet 1 with **MAX**. On an explorer the
   new wallet is left with exactly 0 SOL.
7. **Refusals.** Try to send public SOL to a token's mint address (copy one from a token's
   page): refused, "not a wallet", nothing to sign. Try an amount that would leave a few
   thousand lamports behind: refused with the 0.0009 SOL sentence.
8. **Lock and unlock.** The wallet that was in use comes back, with its name and icon.
9. **Another browser profile.** Import Wallet 1's secret key there as the first wallet and
   press **Look for my wallets**. The new wallet is found, because transactions have
   happened at its address. Watch the network tab for a `403` on `getSignaturesForAddress`:
   there should be none.
10. **Import.** Paste any other secret key under **Import a secret key**. It shows as
    Imported. Lock, unlock, use it. Then remove it, typing `REMOVE`.
11. **Trade from the new wallet.** Open a token, buy a little on the Shielded route. The
    header shows the new wallet's name, and the explorer shows the new wallet's address.
12. **prvmax.** With the new wallet in use, `/prvmax` shows ten vaults that are not
    Wallet 1's.

### L3. What to tell people

- It is a wallet inside this site. It does not connect to other sites the way an extension
  does; every wallet in it can be exported and used in any Solana wallet.
- Shielding and unshielding are public. What is hidden is the balance in between, and the
  token and amount of a private transfer.
- A send from the public balance is an ordinary, fully public transfer.
- The first wallet's secret key brings back the wallets made from it, through this site's
  rule (`/docs/wallets` states it). An imported wallet needs its own key. Names, icons and
  contacts live in the browser and are lost with it.
- Separate wallets are not separate identities once funds move between them.

### L4. If someone loses access

- The passphrase cannot be reset by anyone. With the first wallet's secret key: type `FORGET`
  on the locked screen, import the key and press **Look for my wallets**. If a wallet is
  still missing, **New wallet** makes the lowest-numbered one that is not on the list, so
  pressing it brings missing wallets back in the order they were first made.
- An imported wallet that says "Could not be opened" is repaired by removing it and
  importing it again from its own secret key.
- This server holds nothing that can recover a wallet, and nobody at this site can.

## Part M — the new look, the market's layouts and the wallet panel

From this version the site has a new look, the market lays tokens out as cards, a grid or a
table with a chart and a 24-hour change for each, and the wallet opens as a panel from the
header on every page. Nothing about keys, vaults, fees or how a transaction is built changed.
There is no setting. `npm install` is needed once when updating, because the two fonts are
new packages; Render's own build installs them by itself.

What changed on the server, all of it read-only:

- `GET /api/tokens` serves 24 tokens to a page instead of 12, and adds `spark` and
  `change24h` to each. They are read from the `snapshots` table that already exists. No table
  was added and nothing is migrated.
- Scripts, styles and fonts whose file name carries a hash are served with a one-year
  `immutable` cache. Pages keep their five minutes, so a new deploy is still picked up.

### M1. After deploying

- [ ] Open the site in a private window. The market shows tokens within the first screen on a
      phone and on a desktop. Switch between the three layouts; reload: the choice is kept.
- [ ] Open the browser's network tab and reload. No script, style or font is asked of
      another origin: the fonts come from `/assets/`. (A token's artwork may be.) A file such
      as `assets/trade-XXXXXXXX.js` answers with
      `cache-control: public, max-age=31536000, immutable`; `/` answers with `max-age=300`.
- [ ] On a phone: the market opens on the four figures, the search and the tokens as a list
      of strips, each with its chart; a token's page has the trading panel straight under the
      chart; the wallet button opens the panel from the bottom of the screen; the Wallet page
      shows the card and then the tokens, and **Shield**, **Unshield** and **Send** bring out
      the Move funds form.
- [ ] A token that has traded in the last day shows a chart that is not level and a change
      that is not a dash. Right after a first deploy onto an empty disk both are empty: that
      is the server having no price points yet, not a fault.
- [ ] Open the site in the browser that holds your own ghost wallet. The header button says
      **Unlock**. Press it, type the passphrase: the panel shows the address you know, and
      the private balance you expect once it has been read. The Wallet page shows the same.
- [ ] In the panel press **Send**: the Wallet page opens with the form on Send. Press
      **Lock** in the panel: the page under it locks too.
- [ ] `/prvmax` opens the same vaults as before.

If the wallet's address or balance is not what you expect, stop and redeploy the previous
version from Render's list of deploys. Nothing has been changed in the browser by looking.

### M2. What to tell people

- The panel is the same wallet as the Wallet page, shown smaller. It is not a browser
  extension: it works on this site only.
- A token's artwork is shown in black and white in the market's list and in colour under the
  pointer and on the token's own page.
- "24h" on a token younger than a day means "since launch".

## Part N — the Rings page, and telling which release is live (v21, corrected in v22)

v21 adds a page, `/rings`, that shows what anyone can read of Solana Privacy Rings, and a
read-only follower of the Rings program on the server that fills it. It changes how a Ghost
fill is priced and settled (Part E has that). And it adds a release stamp, so which release a
server runs is read off the site instead of guessed.

**Do not deploy v21 itself.** Its follower wrote the wallets a private transfer paid as lists
of numbers instead of addresses, so every private transfer on `/rings` would have named a
garbage recipient. v22 reads them as addresses. If a server did run v21, v22 notices on its
first start, drops the rows v21 stored and reads history again; the log says so once
(`rings: the rows on disk were read by an earlier release…`). Nothing needs deleting by hand.

**The follower only reads.** It holds no key and sends no transaction. A mistake in it can
show a wrong row; it cannot move anybody's funds. It keeps what it reads in a database of its
own, `rings.sqlite` in `DATA_DIR`, apart from the listing and the desk's ledger. Deleting that
file makes it read everything again.

**It has never read the real chain.** It was written without network access to Solana, like
the rest of this project. What has been checked offline: reading legacy, version 0 and version
1 transactions; every kind of row, from transactions built with the Rings SDK itself and from
balance changes; the indexer's passes against a scripted chain (new transactions in order, a
transaction the RPC lists and cannot serve, history read back and stopped, the receiving side
of a transfer arriving late, vaults and mints read from their bytes); the routes; and the page
in a headless browser at eight widths. Its first read of mainnet is on your server. N1 is how
to check it.

### N1. After deploying

- [ ] Open `/api/status`. It starts with `"release":"v23"` (or whichever release you
      deployed). The footer of every page says the same. If either says something else, the
      deploy did not happen: on Render, look at the Events tab for a failed build, and at
      which branch and commit it built.
- [ ] The log has `rings: following the Rings program every 45s, reading back 30 day(s) of
      history. Read-only.` and no `rings: … did not finish` line that repeats every hour.
- [ ] Open `/rings`. Within a minute or two the strip at the top shows a number of tokens and
      of wallets, and the list fills. "Still reading earlier history" stays for a few hours.
- [ ] Open Live. Pick one row of each of these kinds and open its transaction in an explorer
      (the short code on the right): a Shield (the wallet, token and amount must match), an
      Unshield (the same), and a Private transfer (the two wallets must be the sender and the
      recipient; the explorer shows no amount either). **Look hard at the Private transfer
      row:** both wallets must be ordinary addresses that link to their own page. This is the
      row v21 got wrong.
- [ ] Do one small shield from your own wallet. It appears in Live within about a minute with
      your address and the exact amount, and the SOL figure in the strip moves by it.
- [ ] Open the Wallet page and follow "See what others can read about this wallet". It opens
      your address on `/rings` with the shield you just made.
- [ ] Pick a token you know is held privately and compare "Held privately" with the balance of
      its Rings vault on an explorer.

If a kind of row is wrong, or the log says `a transaction could not be read and is listed
without detail`, send that signature back with what the explorer shows for it. Nothing needs
switching off meanwhile, but `RINGS_EXPLORER=NO` and a restart takes the page out of service
without touching anything else.

### N2. What it costs, and the switches

Each pass asks the RPC for the program's new signatures (one request), each new transaction
(one request), and for a private transfer the indexer's view of it (one more). Vault balances
are read a hundred accounts at a time: only the vaults that a new transaction touched, and
every vault once every 15 minutes. Token names for tokens launched elsewhere are asked for
once (`getAssetBatch`); if the RPC has no such method the log says so once and those tokens
are shown by address. The first run also reads history back, about sixty transactions a pass.

- `RINGS_POLL_SECONDS` (45): seconds between passes.
- `RINGS_BACKFILL_DAYS` (30): how far back history is read, once.
- `RINGS_EXPLORER=NO`: off. The page says so and the routes answer that it is off.

A visitor's request never becomes RPC calls: the routes answer from what has been stored. The
one exception is whether a wallet is registered, which is read when its page is opened, kept
ten minutes, and limited to twenty a minute per visitor.

### N3. What to tell people

- The page shows what is public on Rings for every wallet and token, theirs included: shields
  and unshields with amounts, and which wallets paid each other privately.
- It cannot show a private balance, or the token or amount of a private payment. Nobody can
  read those, and the page never guesses them.
- It does not count the wallets that hold a token privately, because that cannot be counted.

## Part O — the wallet extras (v22)

v22 adds five things to the wallet page, and a page, `/view`. They are worked out in the
visitor's browser. **None of them needs a setting, a key or a new environment variable, and
none of them can move funds by itself.** The closest any comes is a payment request, which
fills in the Send form; the payer still presses Send.

**None of it has run on mainnet.** What was checked offline is in the README's Status. O1 is
the first run. Do it with the same small amounts as the rest of this runbook.

### O1. First run

You need two wallets of your own on this site, both registered: call them A and B. A second
browser, or a private window, makes it easier to keep them apart.

- [ ] **Ask for a payment.** With wallet A: Receive, then Ask for a payment. SOL, `0.01`, note
      `test 1`, Make the link. The link ends in `/wallet#pay?to=<A's address>&amount=0.01&note=test%201`.
- [ ] **Pay it.** Open that link in the browser that holds wallet B. Send opens with a card
      that shows `0.01 SOL`, A's full address and the note, and the form filled in to match.
      Press Send privately. It settles like any private transfer. The status line says the
      note was kept in this browser.
- [ ] **See it arrive.** Back in A's browser, reload the wallet. Activity lists a private
      transfer, in, 0.01 SOL, and under Receive the request says an incoming transfer of
      exactly this amount arrived.
- [ ] **Alerts.** In A's browser: Activity, then Alerts, tick the first box. From B, send A
      another `0.01` privately. Within about two minutes A's page shows "Private payment
      received: 0.01 SOL." and the balance on the card moves without a reload. It is shown
      once.
- [ ] **Statement.** In B's browser: Activity, Statement, All time, Build statement. The
      totals fit what B did. Download the CSV and open it: each private transfer has a date in
      UTC, the amount, `Hidden` under "Amount on chain", A's address under Counterparty, and
      the first one has `test 1` under Note. Open one transaction from the file in an explorer
      and compare the date.
- [ ] **Check-up.** In B's browser: Privacy, Run the check-up. If B shielded shortly before it
      paid, it says so, with the amount of the shield and the minutes between. Compare the two
      transactions it links with an explorer.
- [ ] **Viewing pass.** In B's browser: Keys, Viewing pass. Choose a passphrase, type VIEW,
      make the pass, copy it. Open `/view` in a browser that has no wallet at all, paste the
      pass, type the passphrase. It shows B's address, B's private balance and the same
      history as B's own Activity tab. There is no button on that page that sends anything.
      Close the view.

If the balance or the history at `/view` differs from the wallet's own, send back both. If a
statement's date or counterparty differs from an explorer, send back that transaction's
signature.

### O2. What it asks of the server

Nothing new is stored, and there is no new route. The relay sees more of two kinds of read:

- **Alerts.** A wallet with alerts on is read again about every 90 seconds while one of its
  tabs is in view, and every four minutes in a background tab. Each read is a few indexer
  requests, the same ones opening the wallet makes. Alerts are off until a visitor turns them
  on, per wallet and per browser.
- **Statements.** Building one asks for the block time of each slot in the history, forty to
  a request, and for each private transfer the indexer's record of it, about five a second.
  Both are kept in the visitor's browser afterwards, so a second statement asks only for what
  is new.

Both go through the limits the relay already has (600 RPC requests and 400 indexer requests a
minute per visitor). If the Helius plan is tight, these are the two places a busy day shows.

### O3. What to tell people

- A payment link proves nothing about who made it. The card shows the full address: check it
  with the person who asked.
- A note on a request is not on chain. The payer keeps it; the one being paid does not get it
  back with the money.
- A statement has amounts, not prices.
- A viewing pass shows everything a wallet does privately, for as long as the wallet is used,
  and cannot be taken back. Its holder cannot move anything.
- Alerts work while the site is open, on the wallet in use. They are a convenience; Activity
  is the record.

## Part P — buying any token (v23)

v23 adds a page, `/swap`, that buys and sells a token that was **not** launched here, through
Jupiter: any token Jupiter can route, paid for in SOL or USDC, into and out of a private
balance. Unlike the wallet extras, **this moves funds.**

It needs `JUPITER_API_KEY` (Part H), nothing else, and is on whenever that key is set.
`SWAP_ANY_TOKEN=NO` switches it off and leaves everything else as it was.

**None of it has run on mainnet.** Its outer shape is the Shielded route's, which you have
seen work: withdraw from Rings, swap, deposit into Rings, in one transaction. The swap in the
middle is Jupiter's instead of the pool's, and Jupiter's instructions have not run inside a
transaction of this site yet, unless you have done Part H. What else is new, and what was
checked offline, is in the README's Status. One thing could not be run offline at all: **a
buy or a sale out of the private balance**, because that needs the prover. P2 is the first
run. Use amounts you would not miss, and do P2 yourself before telling anyone the page is
there.

### P1. Deploy, and see that it is on

- [ ] On your own computer: `npm test`. Every test passes (the count is in the README).
- [ ] If your own `.env` has the Jupiter key: `npm run doctor`. Under **Converting
      (Jupiter)**, after the usual lines, it says `swap: on. Three more requests…` and then
      three `✓` lines: SOL → BONK, BONK → SOL, and SOL → PYUSD. Each `✓` means Jupiter
      answered and the answer passed the check a browser makes before signing. A `✗ … the
      site would refuse this answer` line means Jupiter has changed the shape of its
      instructions: the Swap page would refuse those trades, safely. Send that line back.
      (PYUSD is asked for because it is a Token-2022 token and shows that shape. The page
      itself does not buy PYUSD.) If the key is only on the server, skip this step.
- [ ] **Decide who sees it first.** Where `JUPITER_API_KEY` is already set, the page is open
      to every visitor from the moment v23 is deployed. To try it yourself first, add
      `SWAP_ANY_TOKEN=NO` to the hosting platform's settings before deploying, do P2 on the
      site running on your own computer (Part B2, with the key in your own `.env`), then
      remove the variable and restart the server.
- [ ] Deploy. `/api/status` starts with `"release":"v23"`, and further on has
      `"convert":{"enabled":true,…,"anyToken":true}` (`"anyToken":false` while the switch
      is `NO`).
- [ ] The log has `swap: on. A token that was not launched here can be bought and sold on
      the swap page, through Jupiter.`
- [ ] The header has **Swap** between Launch and Rings, and on a phone the dock at the foot
      of the screen has it too.

### P2. First run

You need one wallet of your own on the site with at least 0.06 SOL in public and 0.03 SOL in
private. For the first token use one that has traded for years and has deep pools, so that
what you are testing is this site and not the token. BONK is one:
`DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`.

- [ ] **Look it up.** Paste the address on `/swap`. The card shows what the token calls
      itself, its whole address, `SPL Token` and `5 decimals`. Under "What this token is"
      read **Supply**, **Can more be created** and **Can accounts be frozen**, and compare
      each with an explorer's page for the same address. They are read from the mint
      account, so they must agree.
- [ ] **Buy from the public balance.** Pay with SOL, Pay from **Public balance**, `0.01`.
      Read the quote: what you receive, the least that goes into your private balance, what
      is left over and where it goes. Press. With the ghost wallet nothing asks you to sign;
      with a wallet extension you sign twice.
      The result says `BOUGHT · SETTLED`, how much is in your private balance, and that the
      rest was moved in and the temporary token account closed. Two links.
- [ ] **Check both on an explorer.** The first transaction has Jupiter's program and the
      Rings program in it and pays nobody you do not recognise. The second is a Rings
      deposit and the closing of a token account. Your wallet's public balance of the token
      is zero afterwards, and its public SOL fell by 0.01 plus a few thousandths.
- [ ] **Check the wallet.** On the Wallet page the token is under Private holdings with the
      amount the two results add up to, and its card has **Swap**, **Send** and **Unshield**.
- [ ] **Buy from the private balance.** Back on `/swap`: Pay from **Private balance**,
      `0.01`. Press. This is the path that could not be run offline. The page says
      `Proving the withdrawal from your private balance…` first, which takes some seconds.
      The result reads as before. On the explorer, the first transaction now also takes
      0.01 SOL out of Rings to your wallet before the swap.
- [ ] **A try that is not sent holds nothing.** Only with a wallet extension: start another
      buy from the private balance and decline to sign it. Press again at once. It proves
      again and asks you to sign. It must not say that your private balance does not cover
      it. (With the ghost wallet there is nothing to decline: skip this.)
- [ ] **Sell.** Sell tab, Sell from **Private balance**, press 50%. The quote says what
      arrives in your private balance, exactly. Press. `SOLD · SETTLED`. Your private SOL
      rose by that amount, and the token account the sale used is closed again.
- [ ] **Untick the box once.** Buy `0.005` with "Then move what is left over…" unticked. The
      result has a button, **Move it into my private balance**. The Wallet page shows the
      remainder under Public balances meanwhile. Press the button: it moves and the account
      closes.
- [ ] **A token nobody holds privately yet.** Look up a small token whose card says `Not in
      Rings yet`. The quote has a **First private holder** line and the rent, about 0.0033
      SOL. Buy `0.005`. The result says this was the first deposit. On the explorer the
      transaction creates two accounts for the Rings program before the deposit. Look the
      token up again: `Held privately already`.
- [ ] **A Token-2022 token.** Look up a coin created on pump.fun after November 2025. The
      card says `Token-2022` and `6 decimals`, and the Token program line names what the
      mint carries: `MetadataPointer, TokenMetadata`. Buy `0.005`. If the result starts
      `Rings does not take this token`, nothing was sent: the Rings program on chain is
      stricter than its published source, and that message is what to send back.
- [ ] **A token that must be refused.** Paste PYUSD,
      `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo`. The page says `THIS TOKEN CANNOT BE
      BOUGHT HERE` and names what its mint carries. The button is shut.
- [ ] **The limit.** With `MAX_TRADE_LAMPORTS` set, type an amount above it (`3`, while the
      limit is 2 SOL). The quote box says `Trades are limited to 2 SOL each for now.` and
      nothing is asked of Jupiter.
- [ ] **No wallet.** Lock the wallet and type an amount. The quote box says to unlock a
      wallet to see the quote. Nothing is asked of Jupiter until a wallet is open, because
      Jupiter builds the swap for the wallet's own address.

If any of these fails, the message on screen and the transaction's signature (when there is
one) are what a fix needs. A trade that fails before it is sent costs nothing. If a buy
settled and the second transaction did not, nothing is lost: the remainder is in your public
token account, the result has the button, and the Wallet page can shield it.

### P3. What it asks of the server, and the switch

- **Every quote is one request to Jupiter**, under `JUPITER_RPS`, which all visitors share.
  A free key allows one a second. The page waits until typing stops, and asks once more when
  the button is pressed. Past the allowance people are told the converter is busy. If the
  page is used, a paid plan and a higher `JUPITER_RPS` is the fix. One visitor gets at most
  forty quotes a minute.
- **Looking a token up** is a handful of RPC reads through the relay: the mint, its name,
  and whether Rings holds it.
- **`MAX_TRADE_LAMPORTS`** applies to the SOL or USDC side of every trade on this page, on
  the page and again on the server. `PAUSE_TRADING=YES` stops the page with the rest.
- **`SWAP_ANY_TOKEN=NO`** and a restart: the page says it is not switched on, and the relay
  refuses any token that was not launched here. Nothing else changes. What people already
  bought stays in their wallets; the Wallet page still sends and unshields it.

### P4. What to tell people

- The swap is public. What they hold before and after is not.
- A token is its address. A name proves nothing; check the address somewhere they trust.
- The page says what a token's mint allows. It cannot say whether a token can be sold again
  or whether the price is fair. Buy a little first and sell a little of it.
- Fees and rent are paid from public SOL: keep at least 0.018 there, and about 0.0033 more
  to be the first to hold a token privately.
- A token that was launched here is traded on its own page, not on this one.

## Known limits

- The wallet extras: a note on a payment request is not on chain, so the one being paid never
  receives it, and a payment is tied to a request only by having the same token and amount. A
  statement has no prices, and no destination for an unshield sent from another browser.
  Alerts stop when the site is closed and cover the wallet in use only. A viewing pass cannot
  be revoked. The check-up reads at most the wallet's 200 latest public rows, only as far
  back as the Rings page has read, and never another wallet's rows.

- The Rings page reads what is public and nothing else. It lists a relayed transfer whose
  owner signed inside the proof as "between" its wallets, without a payer. It does not read
  who was paid inside a ring other than the Default Ring. Amounts of a token whose mint it
  could not read are given in base units. Tokens launched elsewhere have no picture, and no
  name when the RPC gives none. Its lists start where its reading of history has got to.


- Buying a token that was not launched here: nothing of it has run on mainnet. It is found by
  its address only; there is no search by name and no list. A Token-2022 token is taken only
  when its mint carries nothing but its description. Nothing checks that a token can be sold
  again, or that Jupiter's price is a fair one. A quote needs an unlocked wallet. A route
  through another token leaves an empty token account for it in the wallet. The first
  private holder of a token pays about 0.0033 SOL of rent that does not come back. The
  per-trade limit is applied to the SOL or USDC side, at the fixed sizing rate for USDC.

- The wallet: up to 24 wallets in a browser. It is not an extension and signs only on this
  site. A Token-2022 token whose mint carries more than its description is shown and cannot
  be moved from here. A token whose decimals could not be read is held and not written as a
  number until they can. "Look for my wallets" finds a derived wallet by any transaction at
  its address and stops eight numbers past the last one it finds.

- prvmax: a vault trades in its token's pair token only (no converting), one vault after
  another. The creator rule and the list of what vaults traded live in the browser. A wallet
  extension must sign version 1 transactions and sign the same message identically each time.

- A token is paid for in its pair token, or, with converting on, in SOL or USDC. Nothing
  else. A converted trade leaves about the slippage limit's worth of the pair token in the
  wallet, public. Token-2022 pair mints are refused. Ghost fill is for tokens priced in SOL,
  and not for converted trades.
- Across pairs, the market's order by size and volume, the front-page totals and the
  per-trade cap use a fixed sizing rate against SOL, not a price.

- Privacy is confidentiality of balances and amounts, not anonymity. See PRIVACY_MODEL.md.
- A pool trade is public, and a public trade can be sandwiched within its slippage limit. Only
  Ghost fill hides size, and only from everyone except the desk.
- Ghost fill needs the built-in wallet, a registered trader, and desk inventory.
- One Ghost fill is processed at a time. Under load, traders see "the desk is settling another
  fill" and retry.
- A buy that completes a curve fails, without moving anything, if somebody else buys first.
  Quote again and it is sized to what is left.
- Listing volume is estimated from fee growth, on the curve and in the graduated pool.
- A curve's surplus (what a last buy paid above the graduation target) is not collected by
  anything here yet: not the platform's part by `fees:claim`, not a creator's part by the
  site. It is not lost. Each part stays in the curve's pool until its owner withdraws it with
  Meteora's `partner_withdraw_surplus` or `creator_withdraw_surplus`. This site's own buy that
  completes a curve leaves none; a buy sent to Meteora directly can.
- A burn is public: the wallet, the token and the amount. Only tokens this site lists can be
  burned from it. The listing learns of a burn made elsewhere on its next refresh pass.
- The market shows twenty-four tokens to a page. The server never serves a larger page.
- A card's chart and 24-hour change come from the price points this server records. A server
  that was just deployed onto an empty disk has none yet: charts are level lines and changes
  read as none until points have been collected. For a token seen for less than a day, both
  cover the time since it was first seen.
- The wallet panel in the header sends nothing. Shield, Unshield, Send and Burn are on the
  wallet page.
- Volume on the pages is the volume since launch: a token's lifetime fees, which its pools
  keep on chain, over its fee rate. It needs no history on this server, so it is whole from
  the first read, on a fresh disk as well. The last day's volume is still worked out, from
  this server's own price points, and is what Trending is ordered by; on a fresh disk it
  starts from nothing.
- The relay's rate limits are in memory, per process. Run one server process, or put a shared
  limiter in front of several.
