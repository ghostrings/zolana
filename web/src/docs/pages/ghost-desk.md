The Ghost desk is a wallet run by the platform that trades with you directly, so that your trade never touches the pool. It is the only way on this site to trade with the token and the size hidden.

{{desk_sentence}}

## What a Ghost fill is

One transaction, signed by you and by the desk, that contains exactly two private transfers:

- yours, paying the desk;
- the desk's, paying you.

On chain it is two encrypted transfers between two public wallets. Either both settle or neither does, so the desk never holds your funds.

:::observer A Ghost fill
Your wallet and the desk's wallet | public
That the two traded privately | public
Which token | hidden
How much, and at what price | hidden
What the desk learns | public | YOUR TRADE
:::

## What your browser checks before it signs

The desk is a counterparty, so the page does not take its word for anything. Before your wallet signs:

1. It rebuilds the desk's transfer from the data it was sent. It never accepts ready-made instruction bytes.
2. It decrypts that transfer with your viewing key and checks it against its commitment on chain.
3. It requires the decrypted amount to be at least the quoted amount, of the quoted asset.
4. It takes the transaction apart and requires exactly those two transfers, nothing else, with the desk paying the network fee and no signer other than you and the desk.

If any check fails, nothing is signed. The desk makes the mirror-image checks on your transfer, and it signs last.

## What it needs

- **The built-in ghost wallet.** Step 2 above needs your viewing key inside the page, which a wallet extension does not hand over.
- **A registered wallet.** You are registered automatically on your first fill.
- **The amount in your private balance.** SOL to buy, the token to sell.
- **A token priced in SOL.** The desk holds SOL and nothing else, so a token priced in another [pair token](/docs/pairs) trades on the Shielded route.

## The price

The desk quotes the pool's current price plus its spread, and the desk pays the network fee.

The desk holds a price for a few seconds only, and your wallet needs a few seconds to prove its side. So a fill is priced twice:

1. The quote on screen, as you type.
2. When you press the button, your wallet first makes its proof, then asks the desk for its price again. That second price is the one you trade at.

The second price is taken without asking you again only if it gives you at least the first one less your **slippage limit**. The quote shows that floor as **At least**. If the desk's price has moved past it, nothing is sent: the new quote is put on screen, and you press again to take it or leave it. What you pay never changes. It is the amount you typed.

The pool's own trading fee is inside the pool price the desk quotes from.

## What the desk can and cannot fill

- It fills orders up to its limit per trade.
- It only fills orders small enough that the same trade would barely move the pool.
- It keeps stock in a short list of tokens the operator chooses. For any other token it can only sell what other traders have just sold to it.

When the desk passes on an order, the page moves that order to the Shielded route by itself and says why under Ghost fill. It moves back when you type a size the desk can take. If you pick Ghost fill yourself, the page stays on it and shows the desk's reason instead. Nothing is lost by asking for a quote.

## After it is sent

The desk tells you only what the chain has decided: the fill landed, or it did not and nothing moved. If the network stops answering in between, the page says the fill was sent and is not yet confirmed. In that case look at your private balance before trading again: the two transfers settle together or not at all, within about a minute.

## What a Ghost fill does not hide

> [!GHOST] The desk knows your trade
> It is your counterparty. It sees your wallet, the token, the amount and the price. This is the same trust you place in any market maker, and it is the main cost of this route.

- **Your wallet traded with the desk.** The desk's address is published, so an observer learns that you traded at that moment, not what or how much.
- **The desk rebalances in public.** What it takes in, it later sells to the pool, and what it runs low on, it buys back, in pieces of varying size at varying times. With many traders those public trades do not map to individual fills. With one trader in a quiet market, timing gives a good guess at direction and a rough guess at size.

## The desk's wallet

{{desk_address}}
