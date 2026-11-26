The [Rings page](/rings) shows what anyone can read of Solana Privacy Rings: every token that can be held privately and how much of it is, what goes in and comes out, and which wallets pay each other. It covers all of Rings, not only the tokens launched here.

It is read from public chain data. Nothing is decrypted and no wallet is connected. That is also its limit: what nobody can read, it cannot show.

## What it can show, and what it cannot

| On the Default Ring | Wallets | Token | Amount |
| --- | --- | --- | --- |
| Shield, unshield | public | public | public |
| Trade through a pool | public | public | public |
| Private transfer | both public | hidden | hidden |
| A balance held privately | not shown | hidden | hidden |

So the page can say that one wallet paid another, and when. It cannot say what was paid or how much, and it cannot say what any wallet holds. That is not a setting. Those numbers are encrypted on chain, and only the wallet's own viewing key opens them. See [What is private](/docs/what-is-private).

## Tokens

One row for each token registered with Rings.

- **Held privately** is the balance of the token's Rings vault. Every unit that anyone holds privately sits in that one account, so the figure is exact.
- **Of supply** is that amount as a share of the token's supply.
- **Net, 24h** and **Net, 7d** are what was shielded less what was unshielded over that time. A filled mark means more went in than came out.
- **7 days** draws the amount held privately over the last week.
- **Moves** counts shields and unshields in the last day.

A token nobody holds privately is listed and stands back. A token with no name on record is shown by its address. `HERE` marks a token launched on this site.

> [!GHOST] What no row can tell you
> How many wallets hold a token privately. A private transfer does not say which token it carries, so a wallet that was paid in a token looks like any other. Nobody can count private holders, and this page does not pretend to.

## Live

The newest activity, newest first. Each row says what the chain shows and, under it, what is public about it.

- **Shield** and **Unshield**: the wallet, the token and the amount.
- **Pool trade**: a wallet took funds out of its private balance, traded on a pool, and put the result back, in one transaction. Both amounts and the venue are public.
- **Private transfer**: the wallet that paid and the wallet that was paid. Nothing else.
- **Private swap**: two wallets paid each other in one transaction. A [Ghost fill](/docs/ghost-desk) looks like this.
- **Own balance**: a wallet rearranged its own private balance. Nothing left it.
- **Private move**: a private transfer whose receiving side has not been read yet. It fills in within a minute or two.

The time on a row is when its block was made. The short code beside it opens the transaction in an explorer.

## A wallet

Paste a wallet's address into the search box and press Enter. The page shows whether the wallet is registered with Rings, when it shielded and unshielded and how much, its pool trades, and which wallets it paid privately or was paid by, with a count for each.

This is the same for every wallet, including yours. Open your own address to see exactly what others can see about you. Your wallet page has a link that does it, and a [check-up](/docs/check-up) that reads the same rows for what would let an onlooker work out a hidden amount.

> [!GHOST] A private payment is a public link between two wallets
> Paying a wallet privately hides the token and the amount. It does not hide that the two wallets dealt with each other. On the Default Ring no tool can change that.

## A token

Click a token's row. The page shows how much of it is held privately, its net movement, its latest shields and unshields, and how many different wallets have shielded it or unshielded it in the history read so far.

## How far back it goes

This site reads the Rings program's transactions itself. When it has not finished reading earlier history, the page says from which day its lists start. Amounts held privately do not depend on history: they are read from the vaults as they stand.

## What is asked of you

Nothing. The page needs no wallet. Looking up an address sends that address to this site's server, as looking it up on any explorer would.
