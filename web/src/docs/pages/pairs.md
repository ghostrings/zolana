Every token here is priced in one other token: its **pair token**. Buyers pay in it, sellers are paid in it, and every fee is taken in it. The creator picks it at launch, and it never changes.

## The pair tokens

{{pairs_table}}

Right now tokens can be launched against: **{{pairs_live}}**.

SOL is always there. Each of the others is switched on by the operator, one at a time, and only after the site has read three things from chain: that the token's mint is an ordinary SPL token with the decimals it is listed with, that Solana Privacy Rings can hold it, and that the pair's fee tiers are exactly the ones this site would create. A pair that fails any of these stays off, and says why on the [Launch](/create) page.

## What the pair token decides

| | |
| --- | --- |
| What a buyer pays with | The pair token |
| What a seller receives | The pair token |
| What fees and creator rewards are paid in | The pair token |
| What price and market cap are shown in | The pair token |
| What the curve must collect to graduate | An amount of the pair token |

Everything else is the same for every pair: one billion tokens, a fee of 2%, 3% or 4% that never changes, liquidity locked for good after graduation.

> [!WARNING] The pair is permanent
> A token's pair is written into its Meteora config and into the pool it graduates to. Nobody can change it afterwards: not the creator, not this site.

## Trading a token that is not priced in SOL

The panel is the same, and so are the routes. The amounts are in the pair token.

- **Shielded route.** A buy spends your private balance of the pair token. A sell returns the pair token to it.
- **Public entry.** A buy paid from your public balance of the pair token: the tokens in your wallet's ordinary token account.
- **Ghost fill** is for tokens priced in SOL only. The desk holds SOL and nothing else. See [The Ghost desk](/docs/ghost-desk).

You still need public SOL. Solana's network fees are always paid in SOL, whatever a token is priced in. Keep at least {{gas_reserve}} SOL public, and a little more the first time you trade against a pair token: a trade opens your wallet's token account for it if you have none, which costs about 0.002 SOL of rent. That account then stays open.

:::observer A Shielded buy of a token priced in another pair token
Your wallet | public
Token, pair token and trade size | public
The balance it came from | hidden
The balance it returns to | hidden
:::

### What stays public afterwards

A Shielded buy releases the most the trade may cost, and a Shielded sell deposits the guaranteed minimum. With SOL, any difference stays in your wallet as public SOL. With another pair token it stays in your wallet's token account for that token, in public. The [Wallet](/wallet) page lists it under your public holdings, with a **Make private** button.

## Paying with SOL or USDC instead

Where this site converts, you do not need to hold a token's pair token at all. Choose **SOL** or **USDC** under **Pay with** on the token's page, and it is converted to the pair token on Jupiter inside the same transaction as the trade. Selling works the same way, under **Receive**. [Pay with SOL or USDC](/docs/converting) has the details, and says whether it is switched on here.

Where it does not, or when Jupiter has no route:

:::steps
Get the pair token | Swap SOL, USDC or anything else for it in your own wallet, for example on Jupiter. The token's page shows the pair token's mint address so you can check it.
Pay with it | Use **Public entry** on the token's page. It spends the pair token straight from your public balance and delivers what you buy into your private balance.
Or hold it privately first | Deposit the pair token on the Wallet page, then trade on the **Shielded route** from your private balance.
:::

> [!NOTE] Check the mint
> Several different tokens on Solana use the same ticker. The pair token is the one whose mint address is shown on the token's page, under **Token facts**. Nothing else is accepted by the pool.

## Graduation by pair

A curve graduates when it holds its target amount of the pair token. Moving a completed curve into its pool is a permissionless instruction that Meteora's keeper sends for the curves it covers:

- **SOL**: curves that collect 10 SOL or more.
- **USDC**: curves that collect 750 USDC or more.
- **Any other pair token**: only when Jupiter lists that token as verified with an organic score above 50, and the curve collects more than 750 dollars' worth.

These are Meteora's own rules, and Meteora can change them. A completed curve the keeper does not reach waits, with trading paused, until somebody sends the instruction. Anyone can, from the token's own page. See [Curve and graduation](/docs/graduation).

## Tokens on different pairs, side by side

A market cap of 4,000 USDC and one of 30 SOL are not numbers in the same unit. So:

- A token's card and page always show its own pair token.
- The [market](/docs/market) can be narrowed to one pair.
- To order tokens by size or by volume across pairs, and for the totals at the top of the front page, the site counts each pair token at a fixed rate against SOL. That rate comes from how the operator sized the pair's curve next to the SOL curve. It is not a live price, so the order and the totals are approximate whenever more than one pair is in use.
- The operator's per-trade limit is set in SOL and applies to other pair tokens at the same rate. See [Limits and pauses](/docs/limits).

## What a pair token brings with it

A token priced in SOL depends on SOL. A token priced in anything else also depends on that asset and on whoever stands behind it.

- **A bridged or wrapped token** is a claim on the original asset, held by a bridge or an issuer. If that fails, the pair token can lose its value, and the price of everything quoted in it means little.
- **An issuer who can freeze.** Some tokens let their issuer freeze any account that holds them. That includes a pool's account and the pooled account behind private balances. The launch page says so for each pair token where the chain shows it.
- **A token whose supply can grow.** Where a pair token's mint still has an authority, more of it can be created.

None of this is a property of this site, and none of it can be removed by it. Read [Risks](/docs/risks).
