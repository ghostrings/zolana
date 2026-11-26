The [Swap](/swap) page buys a token that was **not launched on this site**: any token Jupiter can find a route for. What you pay leaves your private balance, Jupiter swaps it, and what you bought arrives in your private balance, in one transaction. Selling works the other way round.

{{swap_sentence}}

A token launched here is not bought on that page. It has a page of its own, with its curve or pool and [Ghost fill](/docs/ghost-desk): see [Trading](/docs/trading).

## What is private about it, and what is not

The swap itself is a public trade on public pools. Anybody can see that your wallet swapped this much SOL for this much of that token. What nobody can see is what you held before and what you hold afterwards.

:::observer Buying a token that was not launched here
Your wallet | public
Both tokens and the trade size | public
The balance it came from | hidden
The balance it goes into | hidden
:::

So this is for holding a token out of sight after buying it in the open. It does not hide that you bought it, or how much. What you do with it later is seen the way it always is here: a [private transfer](/docs/private-transfers) shows the two wallets and neither the token nor the amount, and unshielding it or selling it is public again. To build the swap, Jupiter's service is told your wallet address, the two tokens and the amount; this site's server asks on your behalf, so Jupiter sees the server's network address, not yours.

## How to buy

:::steps
Paste the token's address | Not its name: its address, often called its mint or contract address. The page reads the token from chain and shows what it found.
Read what the page found | Its program, decimals and supply, whether more can be created, whether accounts can be frozen, and whether anybody holds it privately yet.
Choose what to pay with, and from where | SOL or USDC, from your **private balance** or your **public balance**.
Enter an amount and read the quote | What you receive, the least that will go into your private balance, what you pay, and the route.
Press once | One transaction, one signature. If you left the box ticked, a second, small one follows to move in what was left over.
:::

A link of the form `/swap?mint=` followed by a token's address opens the page on that token, so a token can be sent to somebody as a link.

## The token's name is not the token

Anybody can create a token and give it any name and ticker, including the name of a well-known one. The page shows what a token **calls itself**, and says so in those words. What identifies a token is its address, which is shown whole on the card with a link to an explorer. Check the address against a source you trust before you buy.

Names are cleaned before they are shown: characters that do not show, and ones that change the direction of the text around them, are taken out.

## What the page reads before you trade

Everything on the token's card comes from the token's own account on Solana, read by your browser just now. Nothing comes from a list somebody keeps, and none of it says whether the token is worth anything.

| Line | What it means for you |
| --- | --- |
| **Token program** | SPL Token, or Token-2022. Both are bought here; see below for which Token-2022 tokens are not. |
| **Can more be created** | If yes, the key shown can create any amount at any time, which lowers what yours is worth. |
| **Can accounts be frozen** | If yes, the key shown can freeze any account that holds the token. That includes the Rings vault behind every private balance of it, which would lock those balances in place. |
| **Held in Rings** | Whether anybody has deposited this token before. If not, your buy is the first: see [The first private holder](#the-first-private-holder). |

A token whose issuer can freeze it or create more of it is still bought if you choose to. Well-known stablecoins are such tokens. The page tells you; the decision is yours.

## Tokens that are not bought here

Buying is a swap followed by a deposit of an amount that is fixed before you sign. That only holds for a token whose transfers are plain transfers. A **Token-2022** token is bought when all its mint carries is its own description: its name and picture, and the group it belongs to. One that carries anything else is refused, and the page names what it carries:

- **A transfer fee.** What is sent is not what arrives, so the amounts would not agree.
- **A transfer hook.** Somebody else's program runs in the middle of every transfer.
- **A permanent delegate.** A key that can move the token out of any account, yours included.
- **Frozen by default, not transferable, pausable, interest-bearing, confidential.** Each changes what a balance is or what a transfer does.

Rings itself decides which tokens it holds. If it refuses one this page would have bought, the trade fails when the page runs it against the chain, before you sign, and the message says so.

## One transaction, all or nothing

| A buy | A sale |
| --- | --- |
| What you pay leaves your private balance | The tokens leave your private balance |
| Jupiter swaps it for the token | Jupiter swaps them for SOL or USDC |
| The least the swap can return goes into your private balance | The least the swap can return goes into your private balance |

If any step fails, every step is undone. A trade that would fail is normally not sent at all, because the page runs the whole transaction against the chain first.

Paying from your **public balance** skips the first step: the swap spends your wallet's ordinary SOL or USDC. It is for a wallet that has not shielded anything yet. Selling from your public balance sells what sits in your wallet's ordinary token account.

## What is left over

A swap says exactly what it pays in. What it returns is "at least this much", and usually a little more. A deposit has to name its amount before you sign, so it is made for the least the swap can return. With a 1% slippage limit and a quiet market, about 1% of what you bought lands in your wallet's public token account instead.

- **With the box ticked** (it is, unless you untick it), a second transaction follows at once: it deposits that part into your private balance and closes the token account, which returns its rent. With a wallet extension you are asked to sign twice.
- **With the box unticked**, that part stays in your public token account. The result shows a button that moves it whenever you like, and the [Wallet](/wallet) page lists it with a **Shield** button.

After a sale, what the swap returns above its guarantee arrives as public SOL or USDC. Nothing is lost either way: it is yours, in your wallet, in public.

## The first private holder

A token can be held privately once Rings has a registry entry and a vault for it. Whoever deposits a token first creates both and pays their rent: about **0.0033 SOL**, once, for everybody after them. The quote says so before you press, the page checks that your public SOL covers it, and the result says so afterwards. The rent is not returned: those accounts belong to Rings.

If Rings is not letting just anyone add a token at that moment, a token nobody holds privately cannot be bought into a private balance, and the page says so instead of offering to.

## What it costs

- **Nothing to this site**, and no fee to Jupiter for this kind of swap. The pools on the route take their own fee inside the price you are quoted.
- **Network fees**, in SOL, from your public balance. Keep at least 0.018 SOL public, more for a first private holder.
- **Rent for token accounts**, about 0.002 SOL each. The account for what you bought is closed again when what was left over is moved in. A route that passes through another token opens an account for it in your wallet, which stays open and stays yours.
- **The first private holder's rent**, about 0.0033 SOL, as above.

{{trade_cap_sentence}} On the Swap page the limit applies to the SOL or USDC side of a trade.

## The price is Jupiter's

The quote comes from Jupiter. The page checks that the swap does what the quote says. It cannot tell you whether the quote is a good price, or whether there will be anybody to sell to later.

- **Price impact** is Jupiter's own estimate of how far your trade moves the price. It is shown from 1% up, and called out from 5% up: a large impact means you pay well above the current price, because the token's pools are small next to your trade.
- **Slippage limit** is how far the price may move between the quote and the trade before the trade is refused. The limit is the swap's own. New and thinly traded tokens often need more than the usual {{slippage_default}}%; the most this site allows is {{slippage_max}}%.
- **A token that can be bought cannot always be sold.** Whoever put up the pools a token trades in can take them away, and an issuer who can freeze accounts can stop a holder from selling. The checks on this page read what a token's mint allows; they cannot see what somebody will do. Buy a small amount first, and sell a little of it, before trusting a token nobody you know has traded.

## What your browser checks before you sign

The swap's instructions are written by Jupiter's service, not by this site, so nothing from them is used until it has been read:

- They must be for the same two tokens, the same amount and the slippage limit that were asked for.
- The swap must run in Jupiter's own program, spend exactly the amount asked from your own account and pay into your own account. It may carry no fee for anybody else, keep nothing back from a better price, and pass nothing on to a third account.
- Each token must be moved by the token program its mint belongs to, which your browser reads from chain itself.
- Around the swap, only three things are accepted: opening a token account that belongs to your wallet, wrapping exactly the SOL being swapped, and unwrapping it again.
- Nobody but your wallet may be asked to sign.

Then the finished transaction is run against the chain, and what it would leave in your wallet is compared with what the trade allows. If a public balance would end lower than that, nothing is signed and nothing is sent.

A quote is for your wallet's address, so the page asks you to unlock a wallet before it shows one. A press never trades on numbers that were not on screen: when the price has moved past your limit since the quote, the new quote is shown instead and you press again.

## When there is no route

Jupiter may have no route: the token is not traded anywhere Jupiter reaches, the amount is too small or too large for its pools, or the route is too long to share a transaction with the deposit. The page says that there is no route, or that the route does not fit; Jupiter does not say why there is none. Another amount often finds one.

## Afterwards

What you bought is a private balance like any other. From the [Wallet](/wallet) page you can [send it privately](/docs/private-transfers), [unshield it](/docs/deposit-withdraw), or press **Swap** on its card to come back and sell it. It appears in your [statements](/docs/statements) with its own decimals, under its address cut short: a statement names a token launched elsewhere by its address, not by what it calls itself.
