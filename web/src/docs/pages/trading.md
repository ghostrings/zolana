Every token page has one trading panel with **Buy** and **Sell**, and up to three routes. A route decides how your funds get from a balance to the pool and back, and that decides what the chain shows.

## The three routes

| Route | From | To | Token and size on chain | Needs |
| --- | --- | --- | --- | --- |
| Shielded | Private balance | Private balance | ++Public++ | Any wallet |
| Ghost fill | Private balance | Private balance | ==Encrypted== | The ghost wallet, and the desk switched on |
| Public entry (buy only) | Public balance | Private balance | ++Public++ | Any wallet |

{{desk_sentence}}

A token is bought and sold in its **pair token**: SOL for most, another token for some. The examples below say SOL; for a token priced in something else, read that token in its place. [Pair tokens](/docs/pairs) covers what differs.

Where this site converts, the panel also has a **Pay with** choice (or **Receive**, when selling): SOL or USDC in place of the pair token, converted on Jupiter inside the same transaction. See [Pay with SOL or USDC](/docs/converting).

All of this is for tokens launched here. A token that was not has no page of its own: it is bought and sold on the [Swap](/swap) page. See [Buy any token](/docs/buy-any-token).

## Shielded route

One atomic transaction: funds leave your private balance, trade on the Meteora curve or pool, and the result returns to your private balance. There is no counterparty and nothing is held for you in between.

:::observer A Shielded trade
Your wallet | public
Token and trade size | public
The balance it came from | hidden
The balance it returns to | hidden
:::

Two details follow from doing it in one transaction:

- A **buy** asks the pool for an exact number of tokens, so the deposit that follows can name that number. Your private balance releases the most the trade may cost. Whatever the trade does not use stays in your wallet as public SOL, or in your wallet's token account when the pair token is not SOL.
- A **sell** deposits the guaranteed minimum into your private balance. If the pool pays more, the difference arrives the same way, in public.

Both can leave a small public remainder. Deposit it from the Wallet page whenever you like.

## Ghost fill

You and the platform's desk swap two private transfers inside one transaction that you both sign. The pool is not touched, so the token and both amounts stay encrypted. It is offered for tokens priced in SOL only, and up to the desk's limit per trade. When the desk cannot take an order, the page uses the Shielded route for it instead. See [The Ghost desk](/docs/ghost-desk) for what the desk learns and what your browser checks before it signs.

## Public entry

A buy paid from your public balance of the pair token (public SOL, for a token priced in SOL) whose tokens go straight into your private balance. It is the Shielded route without the first step, for a wallet that has not deposited yet. The purchase is public; what you hold afterwards is not.

## Reading a quote

- **You receive, exactly**: for a buy, the number of tokens you will get. Not an estimate.
- **You pay at most**: the ceiling, including your slippage limit.
- **Trading fee**: the token's tier, shown in the pair token, and where it goes.
- **Venue**: the bonding curve, or the graduated pool.

Before sending, the page reads the pool again and re-plans the trade, so a quote that sat on screen for a minute is not what gets signed.

## Slippage

The slippage limit is how far the price may move against you between quoting and landing. It starts at {{slippage_default}}% and cannot be set above {{slippage_max}}%. If the price moves past it, the transaction fails and nothing is traded.

On a Ghost fill the same limit says how far the desk's price may move between the quote on screen and the fill. Past it, nothing is sent and you are shown the new price. See [The Ghost desk](/docs/ghost-desk).

> [!WARNING] Pool trades can be sandwiched
> A Shielded or public trade is an ordinary swap that others can see coming. Bots can trade around it and cost you up to your slippage limit. Keep the limit as tight as the token's liquidity allows. A Ghost fill does not touch the pool and cannot be sandwiched.

## The buy that completes a curve

A curve stops selling at its graduation price. If you enter more than a curve has room for, the plan becomes the buy that takes every token it still sells, for less than you entered. The quote says so. That token then graduates, and trading pauses while it moves.

## Limits

{{trade_cap_sentence}} {{pause_sentence}} These are the operator's settings for this site. They never apply to the Wallet page: deposits, withdrawals, private transfers and burns always work. See [Limits and pauses](/docs/limits).

## What a trade costs

The token's trading fee, the Solana network fee, any protocol fee Solana Privacy Rings charges, and on a Ghost fill the desk's spread. See [Fees](/docs/fees).
