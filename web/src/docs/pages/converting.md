A token is priced in one [pair token](/docs/pairs). Where this site converts, you can still pay for it with **SOL** or **USDC**, and be paid in them when you sell, whatever it is priced in. The conversion runs on Jupiter, inside the same transaction as the trade.

This page is about tokens launched here. A token that was not is bought on the Swap page, through Jupiter alone: see [Buy any token](/docs/buy-any-token).

{{convert_sentence}}

## How to use it

On a token's page, above the routes, is a choice called **Pay with** (when you buy) or **Receive** (when you sell). It offers the token's own pair token, and SOL and USDC next to it, marked **via Jupiter**.

:::steps
Choose what you hold | Pick SOL or USDC under **Pay with**. The amount box switches to that token.
Choose where it comes from | **Shielded route** spends it from your private balance. **Public entry** spends it from your public balance.
Read the quote | It shows what you pay, what that converts to, what the pool takes and what is left over.
Press once | One transaction, one signature. You receive the tokens in your private balance.
:::

Selling works the same way round: choose SOL or USDC under **Receive**, and the proceeds arrive in your private balance in that token.

## One transaction, all or nothing

A converted trade is a single atomic transaction:

| A buy | A sell |
| --- | --- |
| What you pay leaves your balance | The tokens leave your private balance |
| Jupiter converts it to the pair token | The Meteora pool buys them for the pair token |
| The Meteora pool sells you an exact number of tokens for it | Jupiter converts that to what you chose |
| Those tokens go into your private balance | The proceeds go into your private balance |

If any step fails, every step is undone. A trade that would fail is normally not even sent, because the page runs the whole transaction against the chain first.

:::observer A converted trade
Your wallet | public
Token, trade size and the conversion | public
The balance it came from (Shielded route) | hidden
The balance it returns to | hidden
:::

To build the conversion, Jupiter's service is told your wallet address, the two tokens and the amount. This site's server asks on your behalf, so Jupiter sees the server's network address, not yours.

## What is left over

Two swaps in a row cannot both be exact. The conversion returns **at least** an amount, and the pool is then asked for an exact number of tokens that is certain to be affordable with it. So a converted trade leaves a little behind:

- **After a buy**: a small amount of the pair token, in your wallet's ordinary token account for it. With a 1% slippage limit and a quiet market, expect about 1% of the trade.
- **After a sell**: a small amount of the pair token, and of what you received, both in your public balance.

Nothing is lost: it is yours, in your wallet, in public. The quote shows the amount before you press. The [Wallet](/wallet) page lists it under your public holdings, with a **Shield** button, and the next trade you pay for with that pair token can spend it.

## Slippage, across two swaps

Your slippage limit covers the whole trade. Half of it is given to the conversion and half to the pool. A tighter limit means less is left over and a higher chance that a moving price cancels the trade; a wider one means the opposite. Either way, a trade that moves past the limit fails and nothing is traded.

## What it costs

- **The token's trading fee**, as always: 2%, 3% or 4% of the pool trade, in the pair token.
- **Nothing extra to this site**, and no fee to Jupiter for this kind of swap. The pools Jupiter routes through take their own small fee inside the price you are quoted.
- **Network fees**, in SOL. A converted trade is a larger transaction than a plain one, so its fee is a little higher. Keep at least {{gas_reserve}} SOL public.
- **Rent for a token account**, about 0.002 SOL, the first time your wallet holds the pair token or an intermediate token on Jupiter's route. Those accounts stay open and remain yours.

## What your browser checks before you sign

The conversion's instructions are written by Jupiter's service, not by this site, so nothing from them is used until it has been read:

- They must be for the same two tokens, the same amount and the slippage that were asked for.
- The swap must run in Jupiter's own program, spend exactly the amount asked from your own account, pay into your own account, and carry no fee for anybody else.
- Around the swap, only three things are accepted: opening a token account that belongs to your wallet, wrapping exactly the SOL being converted, and unwrapping it again.
- Nobody but your wallet may be asked to sign.

Then the finished transaction is run against the chain, and what it would leave in your wallet is compared with what the trade allows. If your public balances would end lower than that, it is not sent and nothing is signed.

An answer that fails any of these is refused with a message that says which. See [Troubleshooting](/docs/troubleshooting).

## When there is no route

Jupiter may have no route for a conversion: an amount too small to swap, a pair token with thin liquidity, or a route too long to share a transaction with the trade. The page then says so. You can still trade with the pair token itself: swap for it in your own wallet first, then pay with **Public entry**.

Ghost fill is not offered for converted trades. The desk swaps a token for its pair token and nothing else.
