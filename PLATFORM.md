# v24 — GHOST research integration

See [GHOST v24 research integration](docs/GHOST_RING_V24.md) for the four-product hub, exact requested research target, local fictional policy lab, read-only public Intelligence, test commands and deployment blockers. **No Custom Ring is deployed and no real Custom Ring transaction is supported.** Existing mainnet functions are unchanged.

---

# privacycash.fun

A Solana token launchpad where balances, transfers and (optionally) fills run through
**Solana Privacy Rings**, and tokens launch on **Meteora** bonding curves with a fee that is
fixed for the life of the token: 2%, 3% or 4%, the same before and after graduation.

- Domain: `privacycash.fun` · X: <https://x.com/privacycashfun>
- Independent software. Not affiliated with Helius, Meteora, the Solana Foundation, or the
  existing Privacy Cash protocol at privacycash.org.

## Read this first: what is and is not private

This runs on the **Default Ring**, the one that is live on mainnet. The Default Ring is
*confidential, not anonymous*.

| Action | Wallets | Token | Amount |
| --- | --- | --- | --- |
| Hold a private balance | n/a | hidden | hidden |
| Private transfer | public | hidden | hidden |
| Ghost fill (trade with the desk) | public | hidden | hidden |
| Shield / unshield (deposit into Rings, withdraw) | public | public | public |
| Send from the public balance | public | public | public |
| Shielded route (trade the pool) | public | public | public |
| Swap page (buy or sell a token not launched here) | public | public | public |
| Burn tokens | public | public | public |
| Launch, first buy, reward claim | public | public | public |

A Meteora pool is a public account, so any trade that touches it shows its size. No design
changes that. The only way to trade with a hidden size on today's mainnet is to not touch the
pool in that transaction, which is what **Ghost fill** does: the trader and the platform's desk
swap two confidential transfers in one co-signed transaction. Ghost fill is this project's own
design, it puts a hot wallet at risk, and it is **off by default**.
[docs/PRIVACY_MODEL.md](docs/PRIVACY_MODEL.md) has the full account.

## More than the launchpad: the Rings page

`/rings` shows what anyone can read of Solana Privacy Rings, for every token and wallet, not
only the ones launched here: how much of each token is held privately and how that moved over
a day and a week, a live list of shields, unshields, pool trades and private transfers, and one
page per wallet with its public activity and the wallets it dealt with. It is read from public
chain data by a follower on the server that holds no key and sends nothing. It never shows a
private balance, or the token or amount of a private transfer, because nobody can read them.
[docs/MAINNET_RUNBOOK.md](docs/MAINNET_RUNBOOK.md), Part N, is how to check it after a deploy.

## Wallet extras

Five things on the wallet page that a private balance otherwise makes hard. All of them are
worked out in the browser; the server gains no new knowledge and holds nothing new.

- **Ask for a payment.** A link that fills in Send for whoever pays: the address, the token,
  the amount and a note. The request sits after the `#` of the link, which a browser sends to
  no server. The note does not travel on chain (the Rings SDK has no field for one on a
  private transfer): it lives in the link and then in the payer's browser.
- **Statements.** The private history for a period as a CSV file, with dates, the other wallet
  of each private transfer and per-token totals.
- **Read-only access.** A viewing pass lets somebody read one wallet's private balance and
  history at `/view` and move nothing. It holds the signature the wallet's viewing and
  nullifier keys are derived from, sealed with a passphrase of its own, and no key that signs.
  It cannot be taken back.
- **Alerts.** Off by default. While a tab is open with the wallet unlocked, the browser reads
  the wallet's history every minute or two and says when something arrives.
- **Check-up.** What the wallet's own public Rings rows let an onlooker work out: a private
  transfer right after a shield, an unshield right after a payment, a balance anyone can add
  up.

[docs/MAINNET_RUNBOOK.md](docs/MAINNET_RUNBOOK.md), Part O, is the first run.

## Buy any token

`/swap` buys a token that was **not** launched here: any token Jupiter can find a route for.
Paste the token's address. What is paid (SOL or USDC) leaves the private balance, Jupiter
swaps it, and the token arrives in the private balance, in one transaction the wallet signs
once. Selling is the same the other way round. It can also pay from, or sell out of, the
public balance, for a wallet that has shielded nothing yet.

- **The swap is public, like any swap.** The wallet, both tokens and both amounts are on
  chain. What is private is the balance the payment came out of and the balance the token
  goes into. A later private transfer of it shows the two wallets and neither the token nor
  the amount; unshielding or selling it is public again.
- **A token is found by its address, never its name.** The page reads the mint from chain
  and shows what it found: its token program, decimals and supply, whether more can be
  created, whether accounts can be frozen, and whether anybody holds it privately yet. What
  a token calls itself is shown as that, cleaned of characters that do not show.
- **SPL Token mints, and Token-2022 mints that carry only their own description.** A
  Token-2022 mint with a transfer fee, a hook, a permanent delegate or anything else that
  changes what a transfer does is refused, by name.
- **Jupiter's instructions are read before the wallet sees them** (`shared/src/jupiter.ts`),
  the finished transaction is run against the chain, and what it would leave in the wallet
  is compared with what the trade allows. Then it is signed.
- **What is left over.** A swap returns "at least" an amount, and a deposit must name its
  amount first, so the deposit is for the least the swap can return. The rest, about the
  slippage limit's worth, lands in the public token account; a second transaction moves it
  in and closes the account, unless the box is unticked.
- **The first private holder** of a token pays the rent of the token's vault in Rings, about
  0.0033 SOL, once. The quote says so.
- No fee to this site and none to Jupiter. The operator's per-trade limit applies to the SOL
  or USDC side, on the page and on the server.

It needs `JUPITER_API_KEY` and is on whenever that is set; `SWAP_ANY_TOKEN=NO` switches it
off. [docs/MAINNET_RUNBOOK.md](docs/MAINNET_RUNBOOK.md), Part P, is the first run.

## Mainnet only

This project runs on Solana mainnet and nothing else. There is no devnet, testnet or test mode:

- the network is a one-member type in the code, so no path can carry another value;
- the server refuses to start if `SOLANA_NETWORK` is anything but `mainnet`, or if an RPC
  override points at a test network;
- before it reads, relays or signs anything, the server and every script check that the RPC's
  genesis hash is mainnet-beta's;
- the relay serves only the mainnet prover policy, and a wallet extension is only ever asked to
  sign for `solana:mainnet`.

Every transaction is real and permanent. Read [docs/MAINNET_RUNBOOK.md](docs/MAINNET_RUNBOOK.md)
before sending the first one.

## Status

What has been checked, and what has not:

- `npm run typecheck`, `npm test` (934 tests) and `npm run build` pass.
- **Buying any token is new and has never run on chain.** Its outer shape is the Shielded
  route's, which the operator has reported from mainnet: a withdrawal from Rings, a swap and
  a deposit into Rings in one transaction. What has not run on mainnet in any form is the
  swap in the middle, Jupiter's instructions inside a transaction of this site: a converted
  trade has not been reported either. Also new: the deposit sized on what the swap
  guarantees, the creation of a place in Rings for a token this site did not create (a
  launch creates one for its own token, and that has run), Token-2022 mints, and the second
  transaction that tidies up.
  Checked offline: Jupiter's answers for an SPL Token mint bought and sold and for a
  Token-2022 mint bought, read live on 2026-11-25 and kept as fixtures; every altered copy
  of them that should be refused; which mints are taken, on mint accounts built byte for
  byte; a buy and a sale from the public balance built in full with the Rings SDK's own
  deposit builder, the vault's creation included, for both token programs; every shape
  measured to fit one transaction with room to spare; and the relay's rule, limit and
  switch (86 tests).
  Checked in a headless browser with the chain, the indexer and Jupiter stood in for and
  everything else real: tokens looked up and refused, quotes, a first buy from the public
  balance signed by the wallet and sent (wrap, open the account, swap, unwrap, create the
  vault, deposit, as read back from the bytes that were sent, with a good signature), the
  second transaction, the same for a Token-2022 token paid in USDC, a sale, a price that
  moved, no route, the wallet page with such tokens in it, and the page at six widths.
  **Not run: a buy or a sale from the private balance**, which needs the prover, and
  anything on mainnet. Jupiter was reached only to read its answers, never to trade.
- **A try that was never sent no longer ties up the private balance.** The Rings SDK sets
  the notes a spend is built on aside for two minutes, so that a second transaction is not
  built on them while the first is on its way. Until v23 a trade, a withdrawal or a private
  send that was built and then not sent (the run against the chain refused it, the wallet
  declined to sign) left them set aside, and a second try inside two minutes was told
  `Your private balance does not cover this`, by a wallet whose balance plainly did. This
  was found by reading the SDK while building the swap page, whose second try at a shorter
  route it would have failed every time for a balance held in one note. Now a try that
  fails with nothing sent gives back what it took, and once a transaction has gone out, or
  may have, nothing is given back. Checked offline against the installed SDK on wallets
  with real notes (13 tests). Neither the fault nor the fix has been seen on mainnet.
- **The Rings page's follower reads the real chain now, and its rows have not been compared
  with an explorer yet.** v22 is deployed. On 2026-11-25 the live site's feed
  (`/api/rings/feed`) was read from outside: fifty rows, the private transfers among them
  naming their wallets as addresses, which is what v21 got wrong. That shows the follower
  running and the v22 correction holding on real transactions. It does not show that every
  row is right: Part N of the runbook is that check, a shield, an unshield and a private
  transfer of your own compared with an explorer, and it has not been reported. The follower
  only reads, so it cannot move funds; what it can do is show a wrong row. Offline it is
  tested on transactions built with the Rings SDK, on legacy, version 0 and version 1
  messages, and through whole passes against a scripted chain.
- **v21 had a mistake in that follower, found before it was deployed and put right in v22:**
  it wrote the wallets a private transfer paid as lists of numbers instead of addresses. The
  offline tests fed the decoder ready-made addresses and so never met it. The server's read
  of the indexer is now tested through the real SDK client against a canned answer, and a
  server that ever ran v21 drops the rows it stored and reads history again by itself.
- **The wallet extras are new and have never run on chain.** Checked offline: the pure rules
  of each (119 tests); that the keys rebuilt from a viewing pass are the wallet's own
  viewing and nullifier keys, against Node's Ed25519 and the SDK's keypair; and a reader with
  only a pass following a payment in and a spend out, on real SDK ciphertexts, to the lamport.
  Checked in a headless browser with the chain and the indexer stood in for, the indexer
  serving real SDK-made transfers: the wallet reading them, a request made and paid up to the
  point of sending, a statement built and downloaded under the site's content policy, a pass
  made and opened at `/view`, an arrival announced once, and every new screen at eight widths.
  **Not run: an actual send from a payment request** (it needs the prover), and anything on
  mainnet. None of the extras can move funds by itself: a request only fills in a form.
- **How a Ghost fill is priced and settled changed in v21** (proof first, price second, a
  signing window, and a settled answer after sending). The rules are tested offline; a fill
  has still not been reported from mainnet. `npm run desk:check` is a dry run of the desk on
  mainnet that sends nothing.
- The fee guarantee is tested offline with Meteora's own curve arithmetic for all three tiers,
  and so is the buy that completes a curve.
- The Ghost fill mechanics are tested offline against the real Rings SDK: the transfer codec,
  decrypt-and-verify by each side, the two-signer transaction (1,683 bytes, 7 accounts in the
  test case), and rejection of every tampered variant tried.
- **This code was written without network access to Solana**, so the chain is where each part
  of it is first run. As of this version the operator has reported these working on mainnet:
  creating the fee tier configs, a launch, Shielded buys and sells, and a curve fee claim into
  a private balance. **Not yet reported from mainnet: withdrawals, private sends,
  consolidation, burns, Ghost fills, graduation and pool fee claims.** Try each of those first
  with an amount you would not miss. The runbook's first run covers all of them.
- **Fee modules are new and have never run on chain.** Buyback and burn, and fee sharing,
  are built and tested offline: the settings and their memo, the arithmetic, the wallets
  derived from the seed, every instruction of a payout replayed against a ledger, and a whole
  keeper pass against a scripted chain. What has not happened yet: one hand-over of a creator
  role, one payout and one buyback landing on mainnet. Part J of the runbook starts with a dry
  run, in which every transaction is run against the chain and none is sent, and then one
  token of your own.
- **Several wallets under one passphrase are new and have never run on chain.** What has
  been checked: the key derivation and the sealing of imported keys against fixed vectors,
  against a second implementation (Node's HMAC and AES-256-GCM) and against the Rings SDK's
  own signer, offline; and, in a headless browser against a faked chain: a wallet exactly as
  the previous version left it opening unchanged as the first wallet, making, naming,
  importing, switching, removing and putting back wallets, locking and unlocking, a wallet
  whose saved copy is damaged leaving the others usable, a switch in the middle of a read,
  and public sends of SOL and of a token (decoded, signatures verified, a MAX send leaving
  exactly zero) with every refusal the page makes. What has not: a shield, an unshield or a
  private transfer from a wallet made this way, and anything at all on mainnet. A wallet
  made this way is an ordinary keypair handed to the same flows as the first wallet, so
  those flows are the ones already reported above; Part L of the runbook is the first run.
- **prvmax (vaults): the operator has reported Get ready, a spread and a buy from five vaults
  on the Shielded route, on mainnet.** A sell, a Ghost fill from a vault and a recall have not
  been reported. What was checked here before that: the key derivation against fixed vectors
  and against the Rings SDK's own signer, the arithmetic, and every instruction of its four
  plain transactions, offline; and, in a headless browser against a faked chain, opening the
  vaults, Get ready (the funding transaction and each vault's own registration, decoded and
  their signatures verified) and a recall of vaults holding public SOL and token leftovers
  (each sweep leaving exactly zero).
- **One key's two sets of vaults were found the hard way.** Until this version a wallet opened
  through an extension and the same key opened as a ghost wallet showed two unrelated sets of
  vaults, and the operator met the empty one. Nothing was lost: both sets are derived from
  the same key. A ghost wallet now makes the signature an extension gives and opens the same
  vaults (the standard set), keeps its earlier ghost-only set reachable, and the page shows
  whichever has been used. Checked offline: that the Rings SDK's signer and Node's Ed25519
  give the same signature for the vault message, and the addresses it leads to, pinned. In a
  headless browser against a faked chain: a fake extension holding a key (signing with the
  browser's own Ed25519) and a ghost wallet holding the same key arrive at the same ten
  addresses; a ghost wallet in a browser that had recorded its empty ghost-only set finds
  the vaults an extension filled; both-used, neither-used, a recalled set and a silent chain
  each do what `chooseVaultSet` says. Not run: any of it on mainnet.
- **The new look, the market's three layouts and the wallet panel are new.** They change
  what is drawn and what is read. No transaction is built differently, and the panel builds
  none: its Shield, Unshield and Send open the forms on the wallet page. Checked offline: the
  chart's shape, the 24-hour change and the thinning of the price history they are made
  from. Checked in a headless Chrome against a faked chain and a database filled with made-up
  tokens: the market as cards, a grid and a table from 320 to 1920 pixels wide with nothing
  running off the side, its pages, orders and search, figures brought up to date in place,
  the choice of layout kept; the wallet page and the panel on a desktop and a phone (import,
  a new wallet, every tab, Receive, unlock, a wrong passphrase, switch and lock from the
  panel with the page under it following); and every other page at four widths. Not checked:
  any of it against mainnet, in Safari or Firefox or on a real phone, with a wallet extension
  in the browser, or with real token artwork. Part M of the runbook is what to look at after
  deploying.
- **The volume the pages show is the volume since launch**, not the last day's: a token's
  lifetime fees, which its curve and its pool keep on chain, over its fee rate. Trending is
  still ordered by the last 24 hours, and a Volume order ranks by the total. Checked offline:
  the arithmetic for the three tiers, both orders, and the front-page total across tiers and
  pairs. Not checked: the figure against a live pool's own numbers on mainnet.
- **Keeping old configs next to a new set** (`DBC_CONFIGS_PREVIOUS`, for a change of fee
  split) is new as well. It only reads: which configs a token may be found under. Part I of
  the runbook says what to check after each step.
- **Pair tokens other than SOL** are switched on on the live site, and the operator has
  reported a launch against one of them. A token can be launched and traded against USDC,
  bridged ZEC and NEAR, wrapped XMR, RENDER or hSOL, and against a tokenized share (ANT) once
  that pair is switched on (see [Pair tokens](#pair-tokens)). The routes are the SOL routes
  with the pair token in SOL's place and are covered by offline tests. Trades, claims and
  payouts against each pair are still best tried first with an amount you would not miss.
  `npm run doctor` reads every pair's mint from chain and says whether it can be used. A
  Token-2022 mint, or one whose decimals are not the listed ones, is refused.
- **The "Graduate it now" button** on a completed curve's page is new and likewise unrun.
- **Paying with SOL or USDC for a token priced in something else** (converting through
  Jupiter inside the trade) is built and has never run on chain either. What has been checked:
  Jupiter's live answers for version 1 instructions were read while this was written, three of
  them are kept in the tests, and every refusal the pages make is tested against altered
  copies. What has not: one converted trade landing. It is off until `JUPITER_API_KEY` is set;
  `npm run doctor` then asks Jupiter for every conversion the site could be asked for and
  reads each answer the way the pages do. See [Pair tokens](#pair-tokens).
- `@heliuslabs/spr` is pinned at `0.9.0-alpha`. It is pre-release software.
- This code has not been audited.

## Quick start

Requires Node 22.13 or newer, a Helius mainnet key, and a Pinata JWT if you run it from your
own machine. This is the short form of the runbook's first run; use the runbook itself.

```bash
npm ci
cp .env.example .env          # HELIUS_API_KEY, PUBLIC_ORIGIN, PARTNER_WALLET, PINATA_JWT;
                              # for the first run also the small curve settings
npm run build
npm test
npm run doctor                # read-only: checks everything this project assumes about mainnet
npm run configs:plan          # prints the three fee tiers; sends nothing
npm run configs:apply yes mainnet           # needs DEPLOYER_KEY; permanent
# paste the three DBC_CONFIG_* lines it prints into .env
npm run configs:verify
npm start                     # http://localhost:8080
```

For development, run `npm run dev:server` and `npm run dev:web` in two terminals and open
<http://localhost:5173>. Development also talks to mainnet.

To host it, see [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md): build and start commands, the
disk, every environment variable, and what to check after the first deploy. `render.yaml` is a
Render Blueprint with the same settings.

The commands are the same in bash, cmd and Windows PowerShell. Commands that send something are
confirmed with plain words (`yes`, `yes mainnet`) rather than `--` flags, because PowerShell's
npm wrapper drops flags written after `--`. The runbook shows how to set a secret key in each shell.

## What a holder can do with a token

Everything on this list is on the token's own page and on the wallet page.

- **Send it privately.** A private transfer to another registered wallet. The chain shows the
  two wallets, not the token or the amount. The form checks, as the address is typed, whether
  the recipient has registered with Rings, and refuses before building anything if not.
- **Burn it.** One transaction straight out of the private balance: Rings withdraw to the
  wallet's own token account, `burnChecked` for exactly that amount, and the temporary account
  closed again. A burn is public by nature, because it lowers the supply everyone reads; what
  the wallet still holds stays encrypted. Tokens in the public balance can be burned too.
  Only tokens launched here can be burned from the site, and each burn is confirmed by typing
  `BURN`.
- **See the supply.** The indexer reads every listed mint's supply with the pools, so the
  listing, the market cap (price times the supply now) and the "burned" figure follow any
  burn, whoever made it. A token's page also reads its mint account directly and shows
  whether anyone could still mint more.

## The site

Eight pages: the market (twenty-four tokens to a page as cards, a grid or a table, each with
its 24-hour change, a small chart and its volume since launch, with search, five orders and
a pager whose state lives in the address bar), launch, a token's page, swap (a token that was
not launched here, by its address), the wallet, prvmax (a wallet's vaults), the protocol
summary, and the docs. The wallet is also a panel that opens from the header on
every page: unlock, lock, switch wallet, copy or show the address, and read what the wallet
holds. The panel sends nothing; its Shield, Unshield and Send lead to the wallet page.

Every page is laid out for a phone as well as a desk. On a phone the market is its four
figures, the search and the tokens, the table is a list of strips with a chart in each, a
token's trading panel comes straight after its chart, the wallet page is its card and then
what the wallet holds (the Move form comes out when asked for), and the wallet panel rises
from the bottom of the screen. Nothing on any page is wider than the screen from 320 pixels
up.

The interface is black and white, set in Archivo (one variable font, used at three widths)
with IBM Plex Mono for addresses. Both fonts are built into the site from npm packages and
served from its own origin: no page asks a font service for anything. The docs are at `/docs` and `/docs/<page>`: a
sidebar, search that runs in the browser, and 35 pages written in `web/src/docs/pages/*.md`. Figures they quote (fee shares,
curve sizes, limits, addresses) are filled in from `/api/status`, so they describe the
deployment that serves them.

## Commands

| Command | What it does |
| --- | --- |
| `npm run doctor` | Read-only checks on mainnet: genesis hash, programs, Rings config, prover attestation, priority fee, tiers, every pair token (what its mint is, whether it can be used, where its setup stands), desk. |
| `npm run configs:plan [PAIR]` | Prints exactly what each tier's config would contain, for every pair in use or for one. Offline for SOL; another pair's mint is read from chain. |
| `npm run configs:apply yes mainnet [PAIR]` | Creates the configs that have no address yet, and a pair token's Rings interface if it has none. Permanent. |
| `npm run configs:verify` | Reads every config back from chain and compares it field by field with the environment. Configs kept from an earlier set are checked too. |
| `npm run configs:retire [write <share>]` | Prints how to change the fee split for new launches: which line keeps today's configs for their tokens, and which lines to clear so that `apply` creates a new set. With `write 80` it makes that edit in a copy, `.env.next`, with the creator share set. It first asks the live site (`PUBLIC_ORIGIN`) which pairs and configs it uses, and writes nothing while this `.env` lacks one: it prints the missing lines instead. Sends nothing and never touches `.env`. |
| `npm run verify:graduated <mint>` | Checks a graduated pool still charges the tier fee. |
| `npm run migrate <mint> [yes]` | Graduates a completed curve. Meteora's keeper does this itself for the curves it covers; the rest need it, or the button on the token's page. |
| `npm run fees:status` / `npm run fees:claim yes` | The platform's claimable fees, curve and pool. A pool claim pays the creator's share in the same transaction. It says which pairs it is looking at, and prints, ready to paste, the `CURVE_*` and `DBC_CONFIG_*` lines the live site has and this `.env` does not. |
| `npm run modules:new` / `modules:status` | Fee modules: make the seed and the gas tank address that belongs to it; read what the live site's modules are doing and what the gas tank holds. |
| `npm run desk:new` / `desk:address` / `desk:register` / `desk:status` | Ghost desk operations: make its key, show its address, register it with Rings, read its balances. |
| `npm test` / `npm run typecheck` / `npm run build` | The usual. |

## Operator controls

Set in `.env`, applied on restart. See `.env.example` for all of them.

| Setting | Effect |
| --- | --- |
| `MAX_TRADE_LAMPORTS` | Largest single trade or first buy through the site. A cap for the early days. |
| `JUPITER_API_KEY`, `JUPITER_RPS` | Turns on paying with SOL or USDC for a token priced in something else, and how many requests a second the key allows. |
| `SWAP_ANY_TOKEN` | With the Jupiter key set, the Swap page buys and sells tokens that were not launched here. On unless set to `NO`. |
| `PAUSE_LAUNCHES`, `PAUSE_TRADING` | Stop new launches or trades from the site. The wallet page is never affected. |
| `PRIORITY_FEE_MIN_MICROLAMPORTS`, `PRIORITY_FEE_MAX_MICROLAMPORTS` | Bounds for the priority fee, which follows Helius's live estimate. |
| `PROOFS_PER_MINUTE_PER_IP`, `PROOFS_DAILY_LIMIT` | Bound the Helius credits visitors can spend through your key. |
| `DISCOVERY_MINUTES` | How often Meteora is scanned for pools the server has not seen. |
| `DBC_CONFIGS_PREVIOUS` | Configs kept from an earlier set after the fee split changed. Their tokens stay listed with the split they launched with; nothing new launches on them. |
| `MODULES_ENABLED`, `MODULES_SEED`, `MODULES_GAS_TANK`, `MODULES_DRY_RUN` | Fee modules: buyback and burn, and fee sharing, run from a creator's fees. Off by default. |

## Layout

```
shared/src   Logic used by browser, server and scripts alike
  quotes.ts    the pair tokens, and how tokens on different pairs are compared
  mint.ts      what a mint is on chain, whether it can be a pair token, and whether it can be bought at all
  token-names.ts  what a token calls itself, read from chain and cleaned before it is shown
  curve.ts     the tier configs of each pair and the fee guarantee
  meteora.ts   bonding curve + DAMM v2: reads, quotes, instructions
  modules.ts   fee modules: the settings, their text form, and the arithmetic of a payout and a buyback
  privacy.ts   Solana Privacy Rings: client, deposits, withdrawals, transfers
  routes.ts    Shielded route, launch, rewards, graduation, converted trades, and tokens bought through Jupiter alone
  jupiter.ts   converting through Jupiter: the request, and the check of every answer before it is used
  ghost.ts     Ghost fill: codec, checks, the co-signed transaction
  tx.ts        version 1 transaction assembly and inspection
  vaults.ts    prvmax: how vault keys are derived, the arithmetic, and its four plain transactions
  keyring.ts   several wallets under one passphrase: derived and imported keys, and the book of names, icons and contacts
  transfers.ts an ordinary transfer out of a public balance, and which addresses may be sent to
  trend.ts     a card's small chart and its 24-hour change, from a token's recorded prices
server/src   Express server: RPC relay, listing indexer, priority fees, uploads, Ghost desk
  trend.ts     reads a token's recent prices, thinned, for the market's charts
  pairs.ts     reads each pair token from chain before it is used
  convert.ts   the relay to Jupiter's Swap API: what may be asked, and how often
  modules.ts   fee modules: the wallets derived from the seed, and the keeper that pays out and buys back
web          The site (Vite, vanilla TypeScript, no framework)
  src/style.css, app.css, market.css, walletpop.css, docs.css, fonts.css   the look: the system, the working pages, the market, the wallet panel, the docs, the two typefaces
  src/pages/index.ts, src/spark.ts, src/chips.ts   the market: its three layouts, the small chart, the change and pair marks
  src/wallet-pop.ts, src/wallet-pop-data.ts, src/session-bus.ts   the wallet panel: the frame, what it reads, and how it and the page under it keep in step
  src/docs     the docs: pages/*.md, the Markdown subset they use, search
  src/pages/swap.ts, src/outside.ts, src/swap-flows.ts, src/swap.css   a token that was not launched here: the page, reading the token from chain, and the buy, the sale and the tidy-up
  src/subwallets.ts, src/vault-flows.ts, src/pages/prvmax.ts   prvmax: opening vaults, the steps, the page
  src/wallet.ts, src/vault.ts, src/wallet-panel.ts, src/wallet-icons.ts   the wallets: keys and sessions, what the page shell reads, the list and address book, the pixel icons
  src/ghost.css  the room: the light, the dust, the grain, the ghost mark, the unlock scene
ops          Operator scripts (configs, doctor, migrate, fees, modules, desk)
tests        Offline tests
docs         Privacy model, architecture, mainnet runbook
```

## How a trade works

**Shielded route.** One atomic transaction, built and signed in the browser: withdraw from the
private balance, swap on Meteora, deposit the result back. No counterparty and no custody. The
swap is public. A buy for more than a curve has left is sized to exactly what is left, which
completes the curve; the token then graduates to its Meteora pool.

**Ghost fill.** The browser asks the desk for a quote, proves a confidential transfer to the desk
and sends it as data. The desk rebuilds it, decrypts it, checks it pays the quoted amount, and
answers with its own transfer. The browser does the same checks in the other direction, and
checks the transaction holds exactly those two transfers, before it signs. The desk signs last.
Both transfers settle together or not at all.

**Public entry.** A buy paid with public SOL whose tokens land directly in the private balance.

**A token that was not launched here** has no pool this site knows. It is bought through
Jupiter alone: withdraw what is paid, swap, deposit the least the swap can return, in one
transaction; a second one deposits what the swap returned above that. See "Buy any token"
above and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), "Outside tokens".

**A token priced in another pair token** trades the same three ways, with that token in SOL's
place. It leaves and re-enters the private balance as an SPL token, through the wallet's
ordinary token account for it, where anything a trade does not use stays, in public. Ghost
fill is for tokens priced in SOL only.

## Pair tokens

A creator picks what a token is priced and traded in at launch: SOL, or another pair token
the operator has switched on. It is written into the token's Meteora config, so each pair has
its own config per fee tier and the choice is permanent.

| Pair | Mint | Notes |
| --- | --- | --- |
| SOL | native | Always on. |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | |
| ZEC | `A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS` | Bridged. |
| NEAR | `3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG` | Bridged. |
| XMR | `WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp` | Wrapped. |
| ANT | `ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe` | Tokenized share. |
| RENDER | `rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof` | |
| hSOL | `he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A` | Liquid staking token. |

**Switching a pair on** (Part G of the runbook has the checklist):

1. `npm run doctor` shows what the mint is on chain and suggests a curve size worth what the
   SOL curve is.
2. Set `CURVE_INITIAL_MARKET_CAP_<ID>` and `CURVE_MIGRATION_MARKET_CAP_<ID>`, in whole pair
   tokens. Permanent once the configs exist.
3. `npm run configs:plan <ID>`, read it, then `npm run configs:apply yes mainnet <ID>`. It
   creates the pair's Rings interface if there is none, then the three configs, and prints the
   `DBC_CONFIG_*_<ID>` lines.
4. Put the five lines in `.env` and in the hosting platform's settings, and deploy.

**What the server checks before it uses a pair.** At start it reads each sized pair's mint
and Rings registry from chain. The pair is used only if the mint is an SPL Token mint with
the decimals this build expects and Rings has an interface for it; its tiers take launches
only if each config is, field by field, the one this environment would create against that
mint. Anything else leaves the pair or the tier off, with the reason in the log, in
`/api/status` and on the launch page. The browser reads the pair token's decimals from chain
itself before it prices anything in it.

**Paying with SOL or USDC.** With `JUPITER_API_KEY` set, the token page offers a "Pay with"
choice (and "Receive", for a sell): SOL or USDC in place of the pair token. The conversion is
asked of Jupiter's Swap API (`/swap/v2/build`, version 1 instructions) by this server and
placed in the same transaction as the Meteora swap and the Rings deposit, so a converted trade
is still one atomic transaction with one signature:

- a buy: [withdraw what is paid, on the Shielded route] → Jupiter → Meteora, for an exact
  number of tokens → deposit them;
- a sell: withdraw the tokens → Meteora → Jupiter, for exactly what the pool guarantees →
  deposit exactly what Jupiter guarantees.

Jupiter's instructions are somebody else's, so the page reads them before anything is built
(`shared/src/jupiter.ts`): same tokens, same amount, the slippage asked for; a swap in
Jupiter's program, in a layout the code can read, from the wallet's own account into the
wallet's own account with no fee to anyone else; around it only the opening of the wallet's
own token accounts and the wrapping of exactly the SOL being converted; no signer but the
wallet. Then the finished transaction is run against the chain and what it would leave in the
wallet is compared with what the trade allows, before the wallet is asked to sign. The
slippage limit is split between the two swaps, and what either returns above its minimum
stays in the wallet, public: after a buy, about that much of the pair token.

**What is not built.** Token-2022 pair mints. Ghost fill for pairs other than SOL, and for
converted trades. Paying with anything but SOL, USDC or the pair token.

**Comparing across pairs.** Each token's own numbers are in its pair token. For one order by
size or volume, for the front-page totals and for `MAX_TRADE_LAMPORTS`, a pair token counts
at a fixed rate against SOL: its curve's starting market cap over the SOL curve's. That is a
sizing ratio, not a price, and it drifts with the market.

**Graduation.** Meteora's keeper moves completed SOL curves of 10 SOL or more and USDC curves
of 750 USDC or more by itself. For other pair tokens it does so only when Jupiter lists the
token as verified with an organic score above 50 and the curve raises over 750 dollars'
worth. A curve it does not cover waits until somebody sends the permissionless graduation:
anyone can from the token's page, or the operator with `npm run migrate`.

## Fees

Each tier is one immutable Meteora DBC config. The config fixes the curve fee with a schedule
of zero periods, disables dynamic fees, and sets the graduated pool's fee to the same basis
points. 100% of graduated liquidity is locked permanently. The app re-reads the config and the
pool from chain before quoting and refuses a token whose terms differ from its tier.

**On the curve**, Meteora's protocol takes 20% of each fee and the rest is split on chain
between creator and platform (default 30/70), so with defaults: creator 24%, platform 56%,
Meteora 20%. Creators claim their share into their private balance from the site.

**After graduation**, all of the pool's liquidity sits in one locked position, and that
position belongs to the platform. Creators hold none of it. The platform's position collects
every pool fee, and `npm run fees:claim yes` sends `CREATOR_POOL_PAYOUT_PCT` (default 30%) of
what it claims to each token's creator, in the same transaction as the claim. That payment is
the platform's own: nothing on chain enforces it, and it happens when the operator runs the
claim. The site says so to creators in those words.

**Changing the split.** A config cannot be edited, so a new split means a new set of configs
for new launches. The old set moves to `DBC_CONFIGS_PREVIOUS`: its tokens stay listed and keep
the split they launched with, which each token's page reads from its own config. Part I of the
runbook is the procedure; `npm run configs:retire write 80` makes the `.env` edit in a copy.

## Fee modules

Optional, off by default (`MODULES_ENABLED`). A creator can have their share of the fees
handled automatically instead of claiming it by hand:

- **Buyback and burn**: a share buys the token on the curve (or on the pool after graduation)
  and burns what it bought, in one transaction.
- **Fee sharing**: a share is paid to up to four wallets, each with a fixed percentage.

The shares add up to 100% and are permanent. Only the creator's share of the fees is touched.

How it works: Meteora pays the creator's curve fees to whoever holds a pool's creator role.
The creator signs one transaction, right after the launch or any time later, that hands that
role to a wallet the server derives for that token, with the settings on chain as a memo. The
server offers such a wallet only for a token it lists, to the wallet the chain names as its
creator. The wallet's address is
derived from the settings themselves, so the chain's record of who holds the role settles
which settings apply; the server cannot run a token under any others. Every
`MODULES_EVERY_MINUTES` the server claims the fees and divides them in one all-or-nothing
transaction, then buys back and burns from what the buyback share has built up. Each
transaction is run against the chain before it is sent.

What it costs in trust: the server holds one secret, `MODULES_SEED`. Whoever reads it can take
creator fees not yet paid out and the buyback pots, and nothing else. Losing it locks those
fees for good, so it is backed up offline and never changed. Part J of the runbook switches it
on with a dry run first. `shared/src/modules.ts` is the arithmetic and `server/src/modules.ts`
the keeper.

## The wallet

`/wallet` is a wallet in its own right, inside the site. It is not a browser extension and
does not connect to other sites; every wallet in it is an ordinary Solana keypair that can be
exported and used anywhere.

- **Several wallets, one passphrase.** Up to 24 in a browser. The first is stored as a ghost
  wallet always was: `pcf.vault.v1`, unchanged, so a wallet made by an earlier version opens
  as before. A wallet made in the app is derived from the first wallet's seed
  (`HMAC-SHA256(seed, "privacycash.fun/wallets/v1/" + n)`), so the first wallet's secret key
  brings it back. A wallet imported from another key is sealed with AES-256-GCM under a key
  derived from the first wallet's seed, and has its own backup.
- **Names, icons, contacts.** Kept in the browser (`pcf.wallets.v1.<first wallet>`), never
  on chain or on the server. Names are unique within a browser.
- **The wallet in use** is the one every page signs with. Its seed is the one in the tab's
  session storage, exactly where the single wallet's seed was, so no other page had to
  change: trading, launching and prvmax follow whichever wallet is in use.
- **Shield, unshield, send, burn.** Shield is a deposit into Rings and unshield a withdrawal;
  both are public. Send is a private transfer out of the private balance, or an ordinary
  transfer out of the public one, to another of your wallets, a contact or any address. A
  destination that is not a wallet (a token account, a mint, a program) is refused before
  anything is signed.
- **An animated lock screen**, a QR code of the address, and a search for wallets made on
  another device ("Look for my wallets"). For that search the relay passes one more
  read-only method, `getSignaturesForAddress`, at most ten entries a call: it answers
  whether anything ever happened at an address and does not serve a wallet's history.

`shared/src/keyring.ts` holds the keys and the book and is pure; `web/src/wallet.ts` the
sessions; `web/src/wallet-panel.ts` the list. The two labels in `keyring.ts` define keys and
are pinned by `tests/keyring.test.ts`: changing either makes existing wallets unreachable.

Not in this version: buying a token that was not launched here. That needs a swap through
Jupiter for any mint and, for the token to be held privately, a Rings interface for it. It
is the next piece of work.

## prvmax: vaults

`/prvmax` gives one wallet up to ten vaults. A vault is an ordinary Solana keypair with its
own private balance in Rings, derived in the browser from the wallet it belongs to: from the
wallet's signature over a fixed message. An extension gives that signature; a ghost wallet
holds the key and makes the same one itself, so both open the same vaults (the standard
set). A ghost wallet also has a ghost-only set, derived from its seed directly, which is
what it was given before the two were brought together; it stays reachable, and the page
shows whichever set has been used (`chooseVaultSet`). Nothing about a vault reaches the
server, and there is nothing to configure: prvmax has no setting and no server code.

- **Get ready**: the wallet sends each vault public SOL for fees in one transaction, and each
  vault registers with Rings.
- **Spread**: an amount from the wallet's private balance is split across vaults as private
  transfers. The chain shows the two wallets, not the token or the amount.
- **Trade**: each vault buys or sells from its own private balance, on the Shielded route
  (a public pool trade) or as a Ghost fill with the desk (token and size encrypted).
- **Recall**: every vault is emptied into one wallet, privately or by withdrawal, including
  what trades left in its token accounts and its public SOL, down to zero.

What it is not: a disguise. The wallet funds each vault in public, so anyone can see which
vaults belong to it, and every pool trade shows the vault, the token and the size. A wallet
cannot use vaults with a token it created, or one created by another wallet kept in the same
browser. The page and `/docs/prvmax` say both.

A vault is handed to the same flows a wallet uses, so there is no second copy of the trading
or transfer code: `shared/src/vaults.ts` is the key derivation, the arithmetic and the four
plain transactions that are prvmax's own (fund, move a token, close accounts, sweep);
`web/src/subwallets.ts` opens the vaults; `web/src/vault-flows.ts` runs the steps;
`web/src/pages/prvmax.ts` is the page. The derivation labels and the signed message in
`shared/src/vaults.ts` define the keys and are pinned by `tests/vaults.test.ts`: changing
either makes every existing vault unreachable.

prvmax was written, like the rest, without network access to Solana. The operator has since
run Get ready, a spread and a five-vault buy on mainnet; Part K of the runbook has the steps
that are still to be run, a recall first among them.

## Security notes

- The server never receives a user's key, passphrase or viewing key. All user transactions are
  built and signed in the browser.
- The Helius API key stays on the server. The relay allows a fixed list of JSON-RPC methods and
  passes Rings prover traffic through untouched; that traffic is encrypted in the browser to
  the prover's attested enclave key, so the relay sees ciphertext.
- The built-in ghost wallet stores its seed encrypted with the user's passphrase
  (PBKDF2-SHA256, 310,000 iterations, AES-256-GCM). While unlocked, the seed of the wallet in
  use and the first wallet's seed sit in the tab's session storage, and every other wallet
  can be made or opened from the second. A script-injection bug on the site could therefore
  steal all of a browser's wallets: the content security policy allows scripts from this
  origin only, and it must stay that way.
- `DESK_SECRET_KEY` is a hot key on a server. Fund it with what you can afford to lose.
- `npm audit` reports high-severity advisories that come with the Solana SDK stack
  (`bigint-buffer` through `@solana/spl-token`, `toml` through `@coral-xyz/anchor`). They are
  inherited from Meteora's SDKs and have no fixed release to move to at the time of writing.
  Re-check them when you upgrade.
- Report vulnerabilities privately to the operator before disclosing them.

## License

No license has been chosen yet. Until the owner adds one, all rights are reserved.
