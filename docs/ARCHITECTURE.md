# Architecture

## Principles

1. **The browser builds and signs every user transaction.** The server cannot move a user's
   funds because it never has a key, and it cannot alter a transaction because it never sees
   one before it is signed. The one exception is a Ghost fill, where the server's desk is the
   counterparty; there the browser inspects what it is about to sign (see
   [PRIVACY_MODEL.md](PRIVACY_MODEL.md), section 3).
2. **One implementation of each rule.** The fee guarantee, the Ghost fill checks and the
   route builders live in `shared/` and are imported by the browser, the server and the
   operator scripts. There is no second copy to drift.
3. **Read back, do not assume.** Configs are compared with the plan after creation. Pools are
   checked against their tier before every quote. Decrypted notes are verified against their
   on-chain commitment.
4. **Fail closed.** If a tier's config, a pool's fee terms, the network's genesis hash or a
   Ghost fill check is not exactly what is expected, the action stops with a message.
5. **Mainnet only.** There is one network. `Network` is a one-member type, so no code path can
   carry another value, and nothing is trusted about the RPC until its genesis hash has been
   read and matched.

## Components

```
                    ┌──────────────────────────── browser ────────────────────────────┐
                    │  pages (market, launch, token, wallet, protocol, docs)          │
                    │  wallet.ts   ghost wallet (encrypted seed) / Wallet Standard    │
                    │  trade.ts    flows: buy, sell, ghost fill, launch, claim, move, │
                    │              send, burn                                         │
                    │  shared/*    curve, meteora, privacy, routes, ghost, tx         │
                    └───────────────┬──────────────────────────────┬──────────────────┘
                                    │ /api/helius (JSON-RPC)       │ /api/desk/*
                                    │ /api/helius/v1/spr (Rings)   │ /api/tokens, /api/uploads
                    ┌───────────────▼──────────────────────────────▼──────────────────┐
                    │  server (Express)                                               │
                    │  proxy.ts    relay with a method allowlist; hides the API key   │
                    │  chain.ts    mainnet guard, tier checks, listing indexer        │
                    │  priority.ts live priority fee, between operator bounds         │
                    │  uploads.ts  artwork + metadata (disk or Pinata)                │
                    │  artwork.ts  own copy of pinned files, served at /ipfs/<cid>    │
                    │  desk.ts     Ghost desk (optional, hot wallet)                  │
                    └───────────────┬──────────────────────────────┬──────────────────┘
                                    │                              │
                          Helius RPC + Rings (/v1/spr)     Meteora DBC / DAMM v2 (on chain)
```

### `shared/`

| File | Responsibility |
| --- | --- |
| `constants.ts` | The network (mainnet, and its genesis hash), program ids, limits, compute budgets. |
| `tiers.ts` | The three tiers, launch economics, a curve's size, the fee split. |
| `quotes.ts` | The pair tokens: the list, a pair as trading code uses it (with the mint's own decimals), the environment names of a pair's settings, the fixed rate that compares pairs, and which completed curves Meteora's keeper graduates. |
| `mint.ts` | What a mint is on chain (program, decimals, authorities, extensions), and why one can or cannot be a pair token. |
| `curve.ts` | `buildTierConfig` (the config parameters, for one tier of one pair), `assertFeeGuarantee`, `planTier`, `configMismatches` (an on-chain config against the environment's settings and the pair's mint). |
| `meteora.ts` | `loadMarket` (one batched read over every config's candidate pool; rejects pools on unknown configs, with drifted fee terms, or priced in something other than their pair), quotes, the buy that completes a curve, swap/claim/create/migrate instructions for DBC and DAMM v2, graduated position fees, batched pool reads for the indexer. |
| `privacy.ts` | Rings client construction, sync, deposit / withdraw / transfer / merge builders, registration, protocol facts, simulation. |
| `routes.ts` | Compositions, for a SOL pair and for an SPL pair alike: Shielded buy and sell, public entry, launch, claim-to-private, burn, graduation. |
| `ghost.ts` | The Ghost fill wire format, the leg and message checks, the co-signed transaction. |
| `tx.ts` | Version 1 message assembly with size and account limits, the priority fee, decompilation, signing helpers. |
| `units.ts` | Exact decimal/integer conversion and basis-point arithmetic. No floats for money. |

### Transactions

All Rings transactions are **version 1** messages: up to 4,096 bytes and 64 accounts, compute
limit and priority fee in the header, no address lookup tables. `tx.ts` refuses to produce a
message that exceeds either limit, so an oversized composition fails in the browser with a
clear error rather than on chain.

**Priority fees.** The server asks Helius for a live estimate every 20 seconds
(`getPriorityFeeEstimate`, level High, for the bonding-curve and Rings programs), clamps it
between `PRIORITY_FEE_MIN_MICROLAMPORTS` and `PRIORITY_FEE_MAX_MICROLAMPORTS`, and publishes
the result in `/api/status`. The browser, the desk and the operator scripts price every
transaction from it: price per compute unit times the flow's compute limit. Without an
estimate the floor is used.

**Landing.** A signed transaction is sent once with a preflight simulation, then re-sent
every two seconds without one until it confirms or its blockhash expires.

**Notes set aside.** The Rings SDK sets the notes a spend is built on aside for two minutes
(`DEFAULT_RESERVATION_TTL_MS`), and a second build on them in that time fails as if the
balance were short. That is right while a transaction is on its way and wrong when it was
never sent. So `markSpend` (`shared/src/privacy.ts`) is taken before a spend is built, and
when the try fails with no transaction of that wallet handed to an RPC since, it releases
what the try set aside. `sendSigned` and `sendAndSettle` count a hand-over when the first
send returns, and also when it fails with anything other than the RPC's own preflight
refusal: a dropped connection does not say whether the transaction went out, and then
nothing is released. `tests/spending.test.ts` holds the installed SDK and this rule to that
on wallets with real notes.

| Flow | Instructions, in order |
| --- | --- |
| Shielded buy | Rings withdraw (SOL) → Meteora swap, exact output → Rings deposit (tokens) → close temporary token account |
| Shielded sell | Rings withdraw (tokens) → Meteora swap, exact input → Rings deposit (minimum SOL) → close temporary token account |
| Public entry | Meteora swap, exact output → Rings deposit (tokens) → close temporary token account |
| Buy, a token not launched here | [Rings withdraw (SOL or USDC)] → Jupiter swap → [Rings create interface] → Rings deposit (the least the swap can return). Then, in a second transaction: Rings deposit (the rest) → close the token account |
| Sell, a token not launched here | [Rings withdraw (tokens)] → Jupiter swap → Rings deposit (the least SOL or USDC the swap can return) → [close temporary token account] |
| Launch | Meteora create pool (+ first buy) → Rings create interface → Rings deposit → close temporary token account |
| Claim | Meteora claim (curve fee, or pool position fee) → Rings deposit (SOL) |
| Private send | Rings transfer (sender → recipient's registered address) |
| Burn, from the private balance | Rings withdraw (tokens, to the owner's own token account) → SPL `burnChecked` → close the token account if this transaction created it |
| Burn, from the public balance | SPL `burnChecked` → close the token account if the burn empties it |
| Ghost fill | Rings transfer (trader → desk) → Rings transfer (desk → trader); fee payer and last signer: desk |

A launch is simulated against the chain before the wallet is asked to sign. The first buy is
sized with the curve's own arithmetic and the deposit names that exact amount; if the chain
disagrees by a rounding unit, the app falls back to a variant that accepts slightly less and
leaves the surplus in the public token account, and tells the creator.

**Burning.** `burnInstructions` is pure: the checked form of the SPL burn, which names the
mint and its decimals, on the owner's associated token account. `buildBurnFromPrivate` puts
it directly after a Rings withdrawal of the same amount to that account, so the tokens are in
public for the length of one transaction and no longer. The burn is public by nature (it
lowers the mint's supply), which the interface and the docs state wherever a burn is offered.
The site only offers it for tokens it lists, whose decimals and token program it knows.

**Supply.** A burn shows up as a lower supply on the mint. The indexer's refresh pass reads
every listed mint next to its pool (`loadMintSupplies`, 100 accounts a call) and stores it;
market cap is the price times that supply, and "burned" is the launch supply less it. A read
that fails keeps the last value. A token's page reads its own mint account as well, for the
supply and for the mint authority, which it reports as found.

**Completing a curve.** A curve stops selling at its graduation price, and a buy for more SOL
than it has room for cannot be filled as asked. Because a shielded buy is exact-out, sized a
little inside its quote, ordinary buys would approach the end of a curve without reaching it.
`closingBuy` handles the last one: when the amount entered covers everything the curve has
left, the plan is an exact-out buy for exactly those tokens, which ends on the graduation
price. If somebody else buys first the tokens are no longer there and the transaction fails
without moving anything.

### The fee guarantee

`buildTierConfig` produces, for a tier of `f` basis points:

- curve base fee: linear scheduler, starting fee `f`, ending fee `f`, zero periods;
- dynamic fee: disabled;
- fees collected in the quote token (the pair token: SOL, or the SPL token the pair is);
- migration: DAMM v2 with customizable pool fee `f`, dynamic fee disabled, fees in the pair token;
- liquidity: 100% permanently locked, all of it in the platform's position, none in the creator's;
- token: 1,000,000,000 supply, 6 decimals, SPL Token, immutable.

**Who is paid.** On the curve the config splits each fee on chain: Meteora's protocol share,
then `CREATOR_FEE_SHARE_PCT` of the rest to the creator and the remainder to the platform.
After graduation there is one locked position and it is the platform's, so it collects every
pool fee. `ops/fees.ts` claims a position and sends `CREATOR_POOL_PAYOUT_PCT` of the claim to
the token's creator in the same transaction, so a claim never lands without its payout and no
ledger of amounts owed exists. A position whose creator part is below the smallest payout is
left unclaimed and keeps accruing. This payout is an operator action, not a contract: the site
and the docs say so wherever they state the percentage.

`assertFeeGuarantee` checks those properties on the parameters (offline) and on the account
read back from chain. `loadMarket` runs it for every token before anything is quoted, and
`assertGraduatedFee` does the equivalent on the DAMM v2 pool's own fee bytes.

### Pair tokens

A config is priced in one quote mint, so a pair is a set of three configs, one per tier,
created against that mint. Nothing else distinguishes a USDC token from a SOL token on chain,
and the code follows that: a `Market` carries its `pair` (id, ticker, mint, decimals), and
every quote, price and amount is computed with `pair.decimals` where it used to assume nine.

**What is trusted, and from where.** The list in `quotes.ts` is addresses somebody typed, so
nothing is built on it directly:

- *Decimals* come from the mint account. The server reads it at start (`server/src/pairs.ts`),
  the operator scripts read it before planning, and the browser reads it again itself before
  pricing anything (`assertPairMint`), because the number that turns a typed "10" into base
  units is the one mistake here that could move the wrong amount.
- *Usability*: the mint must be owned by the SPL Token program (a Token-2022 mint is refused,
  with or without extensions), must have the decimals the list pins where it pins any, and
  Rings must have an interface for it.
- *Configs*: each is compared field by field with `buildTierConfig(tier, economics, { pair,
  size })`, and its `quoteMint` with the pair's mint. A mismatch turns launches off on that
  tier; trading tokens that already exist depends only on the pair itself being usable.
- A pool is accepted only when its config's own `quoteMint` is the mint of the pair that
  config is listed under (`marketFromAccounts`).

`Chain.allowedConfigs` starts with the SOL configs and gains a pair's when its mint has been
confirmed; the listing serves tokens under exactly those configs.

**Routes with an SPL pair token.** The Rings withdrawal of the pair token lands in the
wallet's associated token account (opened if missing), the Meteora swap reads and writes that
account, and a deposit takes from it. The account is left open, because what a trade does not
use, or a pool pays above the guaranteed minimum, is only known when the transaction runs. A
curve fee claim is exact, so there the account is closed again when the transaction opened it.

**Comparing pairs.** `unitsPerSol` is a pair's starting market cap over the SOL curve's.
The indexer stores each token's cap, reserve, fees and volume in SOL terms at that rate next
to the real figures; ordering, the front-page totals and the per-trade cap use the SOL terms,
and nothing that moves money does. Database columns were only added (`pair`, `*_sol`), so the
previous build can still open the file.

**Graduation.** `migrationInstructions` wraps the SDK's permissionless `migrateToDammV2`. The
operator script and the token page's button both use it; the page simulates before signing.

### Converted trades

Paying with SOL or USDC for a token priced in something else, or being paid in them.

**Why it can be one transaction.** Jupiter's `GET /swap/v2/build` with `transactionVersion=1`
returns the swap as plain instructions with every account inline and no lookup tables, which
is exactly what a Rings (version 1) transaction can carry. `maxAccounts` caps the distinct
accounts of the swap instruction, which leaves room for the rest: 44 when the trade is paid
from the public balance, 36 when a Rings withdrawal shares the transaction
(`CONVERSION_ACCOUNTS`). If a composed transaction still does not fit, the page asks once for
a shorter route before giving up; nothing has been signed at that point.

**The relay** (`server/src/convert.ts`). `GET /api/convert/build` takes six parameters and
forwards exactly those plus `transactionVersion=1`, with the operator's key. One side must be
SOL or USDC and the other SOL, USDC or a pair token the chain has confirmed. Requests are
spaced to `JUPITER_RPS` for all visitors together, limited per visitor, cached for two
seconds, refused while trading is paused and refused to other websites' pages.

**The check** (`shared/src/jupiter.ts`, `readBuild`). Pure, and run in the browser on what
the relay returned. It accepts the two swap instructions `/build` answers with (`route_v2`
and `shared_accounts_route_v2`), reads the amount, quote, slippage and platform fee out of
their data and the wallet's source and destination accounts out of their account lists, and
compares each with what was asked. Any other instruction must be the opening of one of the
wallet's own token accounts, a transfer of at most the converted SOL into the wallet's own
wrapped-SOL account, a `SyncNative` on it or a `CloseAccount` of it back to the wallet.
Anything else throws, naming what it was. `tests/jupiter.test.ts` holds this to three live
answers and to every altered copy of them it should refuse.

**Sizing** (`web/src/trade.ts`). The slippage limit is halved between the two swaps. A buy
converts exactly what was entered and sizes the pool's exact-out buy on the conversion's
guaranteed minimum; a sell converts exactly the pool's guaranteed minimum and deposits
exactly the conversion's. What either swap returns above its minimum stays public.

**The run before signing** (`settleConverted`). The transaction is compiled with the largest
compute budget and no priority fee and simulated, asking for the wallet's own accounts back.
`floorsBroken` compares them with floors worked out from what the wallet held just before:
the public balance being spent may fall by what is spent (plus rent and fees, for SOL), and
no other public balance may fall at all. Then the transaction is compiled again with the
compute it used plus a fifth, and signed.

### Outside tokens

A token that was not launched here has no pool this site knows, so it is bought and sold
through Jupiter alone, on `/swap`. The pieces are the ones converted trades already use; what
differs is what stands around the swap.

**One swap, not two.** A buy is `[withdraw what is paid] → Jupiter → deposit`; a sale is
`[withdraw the tokens] → Jupiter → deposit → [close the temporary token account]`
(`buildOutsideBuy`, `buildOutsideSell` in `shared/src/routes.ts`). A swap names what it
spends, never what it returns, and a Rings deposit names its amount before anything is
signed, so the deposit is for the least the swap can return (`ConversionSwap.minimumOut`).
What it returns above that stays in the wallet's public token account. `buildShieldRest` is
the second, ordinary transaction that deposits that remainder and closes the account; the
page sends it right after a buy unless the box is unticked. The slippage limit is the swap's
own, since there is no second swap to share it with.

**Which tokens** (`shared/src/mint.ts`, `outsideMintProblems`). The mint is read from chain by
the page. An SPL Token mint is taken as it is. A Token-2022 mint is taken only when every
extension it carries is descriptive (`DESCRIPTIVE_EXTENSIONS`: its metadata and its group).
Anything else is refused before Jupiter is asked, whatever Rings itself would accept: a
transfer fee breaks "what is sent is what arrives", a hook runs somebody else's program
inside the trade, a permanent delegate can empty any account. Rings has its own list
(`create_spl_interface` in its program); where it is stricter, the run before signing fails
with its error, which the page words. A freeze or a mint authority is told, not refused.

**The token program is part of the check.** A wallet's token account for a mint lives under
the mint's own token program, so `BuildRequest` carries `inputProgram` and `outputProgram`
(never sent to Jupiter), and `readBuild` holds the swap's source and destination accounts,
and the two program accounts beside them, to those. An answer built for the other program is
refused. Two more things are refused that were not looked at before, for every conversion:
a swap that keeps back part of a better price (`positive_slippage_bps`), and a `route_v2`
whose optional pass-it-on account is anything but absent or the wallet's own.
`tests/jupiter-fixtures.ts` has three more live answers for this: an SPL Token mint bought
and sold, and a Token-2022 mint bought, whole.

**A token's place in Rings.** A mint can be deposited once Rings has a registry entry and a
vault for it. The SDK's deposit builder puts their creation in front of the first deposit of
a mint, paid by the depositor: 48 bytes and a token account, 3,264,240 lamports. The builder
reads whether that will happen and adds `RINGS_INTERFACE_RENT_LAMPORTS` to what the wallet's
SOL may fall by, the page says so in the quote and checks the public SOL first, and a first
buy is refused outright while Rings does not let just anyone add a token.

**Room.** With one swap in the transaction, Jupiter may name 50 accounts from a public
balance and 44 from a private one (`OUTSIDE_ACCOUNTS`). `tests/outside.test.ts` builds each
shape with the real SDK deposit, the creation included, and a Rings instruction of a
withdrawal's real accounts, and holds them to at least six and nine accounts to spare and
300 bytes.

**The relay.** With `anyToken`, the side of a request that is not SOL or USDC may be any
address. For such a request the operator's per-trade limit is applied on the server too: to
what is paid before Jupiter is asked, and to what a sale pays out from Jupiter's answer.

**The wallet.** A token bought this way has to be movable afterwards, so the wallet's own
moves take the token program too: `deposit`, `withdraw` and `sendPublic` (a Token-2022 send
is a `TransferChecked` under that program), the public balances are listed for both
programs, and a Token-2022 balance whose mint carries more than its description is shown
and not moved. An amount of a token whose decimals could not be read is neither written nor
accepted anywhere on the wallet page.

### Server

- **Mainnet guard** (`chain.ts`). `assertNetwork` reads the RPC's genesis hash and compares it
  with mainnet-beta's. A different hash stops the process at start and stays refused for its
  whole life; an RPC that merely does not answer is retried. Market loads, tier checks, both
  indexer loops, the desk and the relay all wait on it.
- **Tier checks** (`chain.ts`). At start the server reads each configured tier's config from
  chain and compares it, field by field, with what its own environment would create. A tier
  that differs is not live: launches on it are refused and `/api/status` says why. This is what
  catches a server left on the first run's curve settings, or the reverse.
- **Relay** (`proxy.ts`). `POST /api/helius` accepts a fixed list of JSON-RPC methods.
  `getProgramAccounts` passes for the two Meteora programs, and only with filters, and for
  one scan of the Rings program: its list of token registrations, in exactly the shape the
  SDK sends. A wallet that holds a token its local state has not seen cannot finish a sync
  without that list, so refusing it makes the wallet read as empty. `tests/relay.test.ts`
  holds the rule to the request the installed SDK really builds. Scans are limited per visitor.
  `getSignaturesForAddress` passes with a limit of at most ten: the wallet asks for one entry,
  to learn whether anything ever happened at an address its first wallet can derive, and the
  relay is not a way to page through somebody's history.
  `/api/helius/v1/spr/*` forwards Rings indexer and prover traffic, replacing any client
  `api-key` with the server's. Nothing is relayed until mainnet is confirmed. Proof requests
  are limited per IP address and per day, because each one is billed to the operator's key.
  `/api/tee-policy/*` serves the signed mainnet prover policy, and no other, from its origin
  so the page's content security policy can stay at `connect-src 'self'`.
- **Indexer** (`chain.ts`). Two loops. *Refresh*, every 20 seconds, re-reads the pools it
  already knows in batches of 100 accounts, so its cost follows the number of listed tokens
  and not the size of Meteora's program. *Discovery*, at start and every `DISCOVERY_MINUTES`,
  scans Meteora for pools under the configured configs that the server has not seen; a token
  launched through the site does not wait for it, because the page asks for it to be indexed.
  Only tokens on the configured configs are listed. Volume is fees over the fee rate
  (`shared/src/volume.ts`): the pools keep their lifetime fees on chain, in the pair token and
  through graduation, so the volume since launch, which is the figure the pages show, needs no
  history and no column of its own. The 24-hour figure is the growth of the same count against
  a snapshot, and only orders Trending. It indexes pools, not people, and keeps no holder
  table.
- **Listing API** (`index.ts`, `db.ts`, `trend.ts`). `GET /api/tokens` serves the market a
  page at a time: twenty-four tokens, never more, ordered and searched in SQL (`page`, `sort`,
  `q`), with the total and the page count. A page past the end answers with the last page.
  Each token on a page carries its last day: `spark`, up to 32 evenly spaced prices for the
  small chart on its card, and `change24h`, the price now against the price a day ago (or
  against its first price, for a token seen for less than a day). Both are made from the
  price points the indexer already keeps (`snapshots`), thinned in SQL to one point per
  stretch of time and remembered for 30 seconds per token while its price has not changed.
  The rules are in `shared/src/trend.ts` and are tested there. Two lookups serve
  a wallet without sending it the whole list: `?mints=` (the listed tokens among up to 100
  mints, to name what it holds) and `?creator=` (the tokens a wallet launched, for rewards).
- **Operator limits** (`env.ts`, `/api/status`). An optional per-trade cap and two pause
  switches, for launches and for trading. The pages enforce them and the desk and the upload
  endpoint honour them. They are a brake on this site, not on the chain: the pools stay open
  to anyone on Meteora, and the wallet page is never affected, so a pause never holds funds.
- **Uploads** (`uploads.ts`). Images are identified by their bytes, not their name or declared
  type; SVG and HTML are refused. Metadata is validated and served as JSON, or pinned. A
  server whose public origin is `localhost` refuses uploads unless pinning is configured,
  because a token's metadata address is permanent.
- **Artwork copies** (`artwork.ts`, `/ipfs/<cid>`). A pinned file's address names an IPFS
  gateway, and a visitor's network may not reach it: public gateways are throttled, and some
  networks refuse them. So every file this server pins is also written to `DATA_DIR/ipfs` and
  served from this origin under the path a gateway uses. The listing hands pages that path,
  whichever gateway the token's metadata names, and a picture that still fails to load is
  replaced by the token's pixel mark. A missing copy is restored on request, but only for
  identifiers this server recorded: metadata is written out again from the database, artwork
  is fetched from IPFS and accepted only if its bytes are an image of at most 4 MB. It is not
  an open gateway. If no gateway answers the server, the request is redirected to the gateway
  the token names, never to any other address. The copies have a disk budget
  (`ARTWORK_CACHE_MB`) and a takedown list (`ARTWORK_BLOCKLIST`).
- **Desk** (`desk.ts`). Serial queue, one pending fill at a time, simulation before proving
  and before signing, signs last. A bare quote reserves no inventory. A wallet that has the
  desk prepare a fill and then never signs it gets a cooldown that doubles with each repeat,
  because every prepared fill costs the desk a proof. Inventory policy and limits are
  described in PRIVACY_MODEL.md, section 3.
  - *Time.* A quote holds a price for `DESK_QUOTE_TTL_MS`. The page makes the trader's proof
    first and asks for the price it trades at afterwards (`ghostFill` in `web/src/trade.ts`),
    accepting it only at or above a floor the trader saw, so the proof's seconds are not taken
    from the price's. Preparing a fill restarts the clock: the trader has
    `DESK_SIGN_WINDOW_MS` (`shared/src/desk-rules.ts`) from the moment the desk's own side is
    done, and the quote's row in the ledger carries that later expiry so a sweep cannot expire
    a fill that is being signed.
  - *Outcome.* `sendAndSettle` (`shared/src/privacy.ts`) sends the fill and stays with it
    until the chain has decided: confirmed, failed on chain, or not seen and more than
    `EXPIRY_MARGIN_BLOCKS` past its last valid block. It reads the height and the status
    separately and rides out an RPC that stops answering; only when the RPC never answers does
    it return "pending", and the desk then tells the trader it does not know yet rather than
    that nothing moved. `outcomeOf` is the pure rule and is tested on its own.
  - *Staying up.* A start during an RPC outage retries every 30 seconds and quotes nothing
    until the wallet has been read once. Registration is looked at again on every pass, so
    registering the wallet needs no restart. Anything that fails on the desk's own side of a
    fill is logged with its cause and reaches the trader as one plain "use the Shielded route".
  - *Upkeep.* A pass considers what the desk holds and what it is told to stock, not a scan
    of the listing. Rings asset numbers are read once each. A balance split across more notes
    than a fill can spend is reported, and merged when `DESK_AUTO_CONSOLIDATE` is on.
  - `npm run desk:check` (`ops/desk.ts`) is the operator's dry run: every precondition, then
    one and two real private transfers proved and simulated, nothing sent.
- **Rings explorer** (`server/src/rings/`). A read-only follower of the Solana Privacy Program
  behind the `/rings` page. Off with `RINGS_EXPLORER=NO`. It holds no key and sends nothing.
  - `decode.ts` reads one transaction from three public sources: the message (signers, fee
    payer, programs, decoded here from raw bytes for legacy, version 0 and version 1), the
    balance changes of the Rings vaults (the amount of a shield or an unshield, whatever
    instruction caused it), and the indexer's owner tag for each output (on the Default Ring,
    the owning wallet's address). It reads no instruction data past the first byte, so a
    layout it has not seen cannot make it misread an amount. A transaction it cannot read
    throws; it is stored without detail and never guessed at.
  - `indexer.ts` runs passes: the token registry, new signatures oldest first (a transaction
    the RPC lists and cannot serve is waited for, then passed over), earlier history a batch
    at a time back to `RINGS_BACKFILL_DAYS`, the receiving side of transfers the indexer had
    not caught up with, vault balances for the tokens a transaction touched (and all of them
    every 15 minutes), a count of registered wallets, and token names. Each part fails on its
    own. What the routes serve is rebuilt after each pass.
  - `store.ts` keeps it in `rings.sqlite`, apart from the site's database. `chain.ts` is the
    only part that talks to the RPC and the indexer; the tests replace it with a script.
  - `routes.ts` answers `/api/rings/*` from what is stored. A visitor's request makes no RPC
    call, except whether a wallet is registered: cached ten minutes, rate limited per visitor.
- **Release stamp.** `RELEASE` in `shared/src/constants.ts` is in `/api/status` and in every
  page's footer, and a test holds the two together.
- **Fee modules** (`modules.ts`, with the arithmetic in `shared/src/modules.ts`). Off unless
  `MODULES_ENABLED`. Meteora pays a pool's creator fees to whoever holds its creator role. A
  creator switches modules on by handing that role to a wallet this server derives for the
  token, in a transaction of the creator's own that also carries the settings as a memo.
  - *Keys.* One secret, `MODULES_SEED`. HMAC-SHA256 of the seed over a label gives each
    keypair: one gas tank, and per token a fee wallet and a buyback pot. The label for a
    token's two wallets is the settings' own canonical text, which names the token. So a
    wallet exists for exactly one set of settings, and the chain's record of who holds the
    creator role settles which settings apply. The server offers a wallet only for a token it
    lists, to the wallet the chain names as its creator.
  - *A pass*, every `MODULES_EVERY_MINUTES`, per token. Payout: one legacy transaction claims
    the creator's curve fees and divides them, with whatever the fee wallet held, to the
    sharing wallets and the pot; the fee wallet ends it empty. Buyback: one transaction swaps
    what the pot holds (curve, or DAMM v2 pool after graduation) and burns the guaranteed
    output. Amounts are read from chain each time; there is no ledger. Every transaction is
    simulated before it is sent, and the gas tank is the fee payer of all of them.
    The two steps are independent: one that cannot go ahead does not hold the other back. A
    sent transaction is sent again every two seconds until the chain confirms it or its
    blockhash expires, and an RPC that does not answer is asked again rather than believed.
  - *What the gas tank pays for, and what it does not.* Network fees, and the rent of token
    accounts. An account the server itself owns is opened once and cannot be closed by anyone
    else. A sharing wallet's account for a pair token can be closed by its owner, who then
    keeps the rent, so the server opens one per wallet per token once and never again
    (`module_opened`); after that the payout waits until the wallet holds such an account,
    and the token's page says so. Accounts are opened only once the fees waiting are worth
    four times their rent: at a 64/16 split the platform has by then earned that rent from
    the same trades, and at 24/56 several times over.
  - *Why two servers cannot pay twice.* A payout names exact amounts worked out from what the
    fee wallet holds plus a claim capped at what was read. A second copy finds the wallet
    empty and its transfers fail, taking the whole transaction with them.
  - *Finding modules again.* The settings are in the memo of the hand-over. A token with no
    record is matched against the offers this server made, then against module memos in its
    creator's recent history; a memo counts only if the wallet derived from it is the
    creator on chain.
- **Static files** (`index.ts`, `http.ts`). Pages and plainly named files are cached for five
  minutes. A script, stylesheet or font that the build named after its own contents
  (`assets/trade-DuNGBhnK.js`) is served `immutable` for a year: its address never means
  anything else, so the browser does not ask again. `isHashedAsset` decides which is which.
- **Storage** (`db.ts`). One SQLite file under `DATA_DIR` (Node's built-in `node:sqlite`):
  tokens, price snapshots, metadata, upload counters, desk quotes, and for fee modules the
  offers, the modules, what each has done, its running totals, and which sharing wallets it
  has opened a token account for.

### Web

Seven static pages built with Vite; vanilla TypeScript modules, no framework. The market,
protocol and docs pages load no SDK (the docs' script is mostly their text). The launch, token,
wallet and prvmax pages load the SDKs (about 1.8 MB compressed; the Rings hasher ships its
WebAssembly inlined).

**The look.** Black and white only. `web/src/style.css` is the system: the colours, the type,
the header, controls and the pieces every page shares. `app.css` is the working pages (launch,
token, wallet, prvmax, protocol), `market.css` the market, `walletpop.css` the wallet panel,
`docs.css` the docs. `ghost.css` holds the room and its ghost: the light from the top of the
screen, the dust drawn on a canvas, a little grain, the mark (`/assets/ghost.svg`, the logo's
own pixel grid, used as a mask so it takes any colour), and the rule that puts the page's
background on the root so the layer behind the content can be seen at all. Motion stops under
`prefers-reduced-motion`. Shared page chrome lives in `web/partials/` and is inlined at build
time.

**Type.** Archivo, one variable file with a width axis, used at three widths: extra-condensed
and heavy for tickers, figures and headings, wide for the market's title line, and normal for
everything that is read. IBM Plex Mono for addresses, keys and signatures. Both come from npm
(`@fontsource-variable/archivo`, `@fontsource/ibm-plex-mono`), are declared in
`web/src/fonts.css` and are served from this origin, which the content security policy
requires (`font-src 'self'`); the build inlines nothing (`assetsInlineLimit: 0`) for the same
reason, and adds a preload for the main file to every page.

**The market's pages.** The page, the order and the search live in the address bar
(`web/src/paging.ts`), so a view can be shared and Back works. The server does the ordering
and the search; the page asks for one page at a time and refreshes the one on screen. A
refresh that changes only figures writes them in place, so a card being read does not jump;
the list is rebuilt only when a token, its order or the layout changes. The layout (cards,
grid, table) is a preference kept in the browser. The small chart is drawn by
`web/src/spark.ts`, which is pure and tested.

**Narrow places.** A card answers to its own width, not the screen's (a container query on
`.tk`): under 330 pixels it writes the pair token once instead of twice. The ticker is never
the part that gives way: on a card it has the first line to itself, and in a phone's list the
row keeps room for it by its length (`--len`, set per row) before the chart gets any. On a
phone the table's rows are laid out as strips with CSS alone (`display: grid` on the row), so
there is one markup for both, and the line under a strip is the token's progress (`--p`).
Rows of buttons that do not fit scroll sideways and fade at the edge that hides some
(`data-more`, kept by the page). On a token's page the left column dissolves under 900
pixels (`display: contents`), which lets the trading form be placed straight after the chart
and before the long read. On the wallet page the Move form is put away under 900 pixels until
`openMove` is called (a class on the column, read by the styles), so the holdings follow the
card. Before release all of this was looked at in a headless
browser with ten-letter tickers, 32-letter names, eight pair tokens and amounts in the
billions, at thirteen widths from 320 to 1920 pixels.

**The wallet panel.** The header's wallet button opens a panel on every page
(`web/src/wallet-pop.ts`). That file is the frame and loads no SDK, so the market, protocol
and docs pages stay as light as before; what needs the keys is `wallet-pop-data.ts`, fetched
the first time the panel has a wallet to work with. The panel unlocks, locks and switches,
copies and shows the address, and reads balances. It sends nothing: its Shield, Unshield and
Send are links to the forms on the wallet page (`/wallet#shield` and so on), which remains
the one place a transfer is built and signed. It reads through a view of the wallet that is
its own (`readerSession` in `wallet.ts`): the same keys, separate note state, so a read in
the panel never touches the notes a page is building a transaction from, and on a page that
works with the wallet it does not write the saved snapshot either. Panel and page keep in
step through `web/src/session-bus.ts`: a page registers whether it is busy and what to do
when the wallet changed; the panel refuses to unlock, lock or switch while the page is busy,
and tells it afterwards. The wallet page reads its state again, the launch page keeps the
form and changes only who would sign, the token page takes an unlock in place and loads
again on a lock or a switch, and prvmax loads again.

**Send and burn.** `web/src/moves.ts` holds what the token page and the wallet page both say
and check about a private send and a burn: who can be sent to, what an observer sees, what a
burn does to the supply. Whether a recipient has registered with Rings is public, so it is
asked as the address is typed and again before anything is built. A registered address is
remembered; an unregistered one is asked about each time, since its owner may have registered.

**Docs.** `/docs` is one page that draws each of its own (`web/src/pages/docs.ts`); the server
answers every `/docs/<page>` with it. Pages are Markdown files rendered by a small renderer
written for them (`web/src/docs/markdown.ts`): it escapes everything first and emits only its
own tags. Search is an index of sections built and queried in the browser. Live figures are
placeholders filled from `/api/status` (`web/src/docs/vars.ts`). `tests/docs.test.ts` holds
the pages to it: every link resolves, every placeholder exists and is used, and no page claims
anonymity.

Content security policy: scripts from this origin only (plus WebAssembly), connections to this
origin only. Token artwork is loaded from this origin too (`/ipfs/<cid>`, `/u/<file>`); an
image address that is neither is the one cross-origin resource class, and only over https.

The site works at the addresses the operator names and at no others: `PUBLIC_ORIGIN`, the main
one, and any listed in `EXTRA_ORIGINS`. Every request that changes something must come from a
page opened at one of them. A page opened elsewhere still loads; it reads the list from
`/api/status`, says it is at the wrong address and links to the main one. Browser storage is
kept per address, so a ghost wallet made at one address is not visible at another until its
secret key is imported there.

A private balance is shown only after it has been read from chain in that page. When a read
fails, the page says it could not be read, gives the reason this site's relay gave if it
refused a request, and offers to try again: it never shows zero for a balance it did not
read. A transaction that has landed is reported as settled even if the balance cannot be
re-read afterwards, because somebody told "failed" tries again and pays twice.

### Wallets

- **Ghost wallet.** A 32-byte seed generated with `crypto.getRandomValues`, stored as
  PBKDF2-SHA256 (310,000 iterations) → AES-256-GCM ciphertext in `localStorage`. While
  unlocked, the seed is in `sessionStorage` for that tab. The Rings wallet state (decrypted
  note set) is cached encrypted with a key derived from the keypair.
- **Several ghost wallets.** One browser keeps up to 24 under the one passphrase
  (`shared/src/keyring.ts`, pure; `web/src/wallet.ts`). The first is the vault above,
  unchanged. Derived wallet `n` has the seed `HMAC-SHA256(first seed,
  "privacycash.fun/wallets/v1/" + n)`. An imported wallet's seed is sealed with AES-256-GCM
  under `HMAC-SHA256(first seed, "privacycash.fun/wallets/v1/import-key")`, with the wallet's
  address as additional data, so a sealed seed moved under another entry does not open. What
  the browser remembers (which wallets exist, names, icons, sealed seeds, contacts) is one
  record per first wallet, `pcf.wallets.v1.<address>`; it holds no usable secret, and a
  damaged one reads as a fresh one, so it can never keep the first wallet shut.
  While unlocked the tab holds four things: the seed of the wallet in use
  (`pcf.session.seed`, the key every page has always signed with, which is why no other page
  changed), the first wallet's seed (`pcf.session.root`), the address in use, and the
  addresses of imported wallets that could not be opened. Another wallet's seed is derived or
  unsealed at the moment it is needed, checked against the address on record, and wiped. The
  seed is what signs, so when the stored address disagrees with it the address is corrected.
  A tab unlocked by an earlier version holds only `pcf.session.seed`; it is the first
  wallet's, and is treated as such. A removed derived wallet is only hidden, so its number
  is never given to another. A new wallet takes the lowest free number, and a search
  (`searchDerived`) adds every derived address at which anything ever happened, stopping
  eight numbers past the last hit: between them, every wallet a first wallet ever made can
  be brought back on another device. On the wallet page every read belongs to the wallet it
  began for: a result that arrives after a switch is dropped.
- **Public sends.** `shared/src/transfers.ts`: a system transfer, or an idempotent creation
  of the recipient's associated token account followed by a token transfer. Before one is
  built the destination account is read, and anything not owned by the System program is
  refused; the same check guards an unshield to another address. The transaction is
  simulated before it is signed.
- **External wallet.** Wallet Standard. Privacy keys are derived from the wallet's signature
  over the Rings derivation message; the app checks the wallet signed exactly that message.
  Signing uses `solana:signTransaction` with the version 1 wire format, and the app checks the
  returned message is byte-identical to the one it built. Marked beta: extension support for
  version 1 transactions is recent. Ghost fill is not offered to external wallets because the
  pre-signing check needs to decrypt with the wallet's own viewing key in-process.

- **One key, two sets of vaults.** The two roots below give one key two unrelated sets. A
  ghost wallet holds the key, so `signWithSeed` makes the signature an extension gives
  (Ed25519 has no randomness; pinned against Node's implementation) and
  `web/src/subwallets.ts` derives both: `signature`, the standard set, which is also what an
  extension opens, and `seed`, the ghost-only set. `chooseVaultSet` (pure, tested) picks:
  what the person asks for; a set they pinned; else the set that has ever been used when
  only one has (one of its ten holds SOL, or its first vault has a transaction);
  else the browser's record; else the standard set for a wallet that used neither. A choice
  made without the chain's answer is never recorded. The record is the first vault's address
  plus, from now on, which set it is of, so that an extension is not held to a ghost-only
  record. A read belongs to the set it was made for: one that finishes after a switch is
  dropped.
- **Vaults (prvmax).** Up to ten further keypairs per wallet, derived in the browser and
  never stored. A ghost wallet's root is `HMAC-SHA256(seed, "privacycash.fun/prvmax/v1/root")`;
  a wallet extension's is the same HMAC keyed with its signature over a fixed message, asked
  for twice on first use so that a wallet which does not sign deterministically is refused
  before anything is sent to a vault. Vault `i` is `HMAC-SHA256(root, "vault/i")` used as an
  Ed25519 seed. A vault is then an ordinary session (`sessionFromKeypair`) and is handed to
  the same flows as any wallet, so prvmax adds no trading or transfer code of its own: only
  four plain transactions (fund the vaults, move a token account's balance, close token
  accounts, send the SOL back so the account is left at exactly zero). The browser keeps the
  number of vaults and the first vault's address, and refuses keys that do not lead to that
  address. Every run goes one vault at a time; a spread or a trade stops at the first failure,
  because repeating a transaction whose confirmation was not seen could pay twice, while a
  recall carries on, because recalling twice cannot move anything twice.

### The Rings page

`web/rings.html` and `web/src/pages/rings.ts`: one page with four views kept in the address
bar (tokens, live, one wallet, one token). `web/src/rings-render.ts` holds every sentence the
page writes about a row, apart from the page, so the wording is tested: it must never say more
than the chain shows. The page loads the market's styles and none of the trading code.

### Wallet extras

Everything here is worked out in the browser. The only server change that goes with it is in
the explorer's read of the indexer (`shared/src/ring-tags.ts`, below).

- **Rules, pure and tested** (`shared/src/`): `paylink.ts` (a payment request as the fragment
  of a link, and everything read from one checked before use), `payrecords.ts` (notes kept
  with payments, requests made, which history rows are new arrivals, which payment fits which
  request), `statement.ts` (rows, periods in UTC, totals, CSV with spreadsheet formulas
  defused), `checkup.ts` (what a wallet's own public rows give away), `viewpass.ts` (sealing
  and opening a viewing pass: PBKDF2-SHA256 then AES-256-GCM, the address, date and work
  factor bound to the secret), `viewkeys.ts` (the reading keys from a pass, with no prover
  attached), `ring-tags.ts` (an output tag as an address, for the server's explorer and the
  browser's statement alike).
- **Looked up, public, cached in the browser** (`web/src/chain-facts.ts`): block times, in
  batches of forty through the relay, and the wallets a transaction named, by signature from
  the indexer, about five a second. `web/src/token-facts.ts` gives a token's decimals or
  throws: a statement never assumes them.
- **Kept in the browser, per wallet address** (`web/src/local-records.ts`,
  `alert-settings.ts`): payment notes, requests, alert settings, what was already announced,
  the slots this browser sent in. Removed with the wallet. None of it is a key.
- **Alerts** are in two halves so that a page pays nothing until they are on: `alerts.ts`
  (every page; a timer and nothing else) and `alerts-run.ts` (loaded on demand; reads through
  the header panel's own view of the wallet, so it never touches the notes a page is building
  a transaction from).
- **`/view`** (`web/view.html`, `web/src/pages/view.ts`) opens a pass in memory. It has no
  signer and builds no transaction.
- Wording that must not overstate is kept apart from the pages and tested:
  `web/src/checkup-words.ts`, `web/src/alert-words.ts`.

## What is deliberately not here

- No server-side custody, order book, or user accounts.
- No list of tokens, vetted or otherwise, and no search by name on the swap page. A token is
  found by its address, and what is shown about it is read from its mint just then. A name
  identifies nothing, and a list would be this site vouching for what is on it.
- No platform fee on a swap. The request to Jupiter names no fee account, and an answer that
  carries one is refused.
- No holder lists and no leaderboards of wallets. The Rings page lists a wallet's public Rings
  activity because the chain does; it ranks nobody and counts no private holders.
- No server-side watch list, push service or stored statements: alerts and statements run in
  the visitor's own browser, so there is nothing about a wallet for the server to keep.
- No fee switch. The platform's share is fixed in the configs like everything else.
- No use of Helius's example swap/escrow programs. Their own repository marks them as not for
  production.
