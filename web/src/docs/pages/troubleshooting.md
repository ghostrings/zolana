What the messages on this site mean, and what to do about each.

## My private balance says "Not read"

The page could not fetch or decrypt your notes this time. Your funds are on chain under your keys and are not affected.

Press **Try again**. If it keeps failing, reload the page. The message under it gives the reason the request was refused, when there was one.

## My private balance shows less than I expect

- **Just after a transaction:** if the page said it settled but could not refresh the balance, reload.
- **With a wallet extension:** make sure the same account is selected as before. A different account has a different private balance.
- **At a different address:** a browser keeps each site address apart. A ghost wallet made at one address shows only there until its key is imported at the other.

## "Keep at least {{gas_reserve}} public SOL"

Fees and temporary account rent are paid from your public balance. Send a little SOL to the wallet's address, or withdraw some from your private balance.

## "Your private balance does not cover this buy", for a token not priced in SOL

A token is paid for in its pair token unless you choose otherwise. If it is priced in USDC, a Shielded buy spends private USDC, and private SOL does not count. Deposit the pair token on the [Wallet](/wallet) page, use **Public entry**, which spends it from your public balance, or choose SOL under **Pay with** where this site converts. See [Pair tokens](/docs/pairs) and [Pay with SOL or USDC](/docs/converting).

## "The converter's answer was not what this site expects"

You chose to pay with, or receive, SOL or USDC, and Jupiter's answer failed one of the checks your browser makes before anything is signed. The words in brackets say which. Nothing was built from it, nothing was signed and nothing moved. Try again; if it repeats, trade with the pair token itself and tell the operator what the message said.

## "Jupiter has no route for this conversion"

There is no way to swap that amount between those two tokens right now, or none short enough to share a transaction with the trade. Try another amount. Very small amounts often have no route. Otherwise trade with the pair token itself.

## "The converter is busy"

Conversions are quoted by Jupiter under an allowance this site shares between all its visitors. Wait a few seconds and try again.

## "This trade was not sent: it would leave your public … lower than this trade allows"

Before a converted trade is signed, the page runs it against the chain and checks what it would leave in your wallet. This run would have taken more than the trade should. Nothing was signed. Try again, and if it repeats, tell the operator.

## "This token cannot be bought here"

The [Swap](/swap) page read the token from chain and found something it does not handle: a Token-2022 token whose mint carries a transfer fee, a hook, a permanent delegate or another feature that changes what a transfer does. The message names what it found. It is not a fault of your wallet, and trying again will not change it. See [Buy any token](/docs/buy-any-token#tokens-that-are-not-bought-here).

## "Jupiter has no route for this token"

The token is not traded anywhere Jupiter reaches, or not in that amount, or the only route is too long to share a transaction with the deposit. Try a smaller amount. A token that has only just been created may not have a pool Jupiter knows yet.

## "Rings does not take this token"

The page ran your trade against the chain before asking you to sign, and Rings refused the token. Nothing was signed and nothing moved. The token cannot be held privately as it is; it can still be bought in an ordinary wallet.

## "Nobody has held … privately before"

A token can be held privately once Rings has a vault for it, and the first deposit of a token creates that vault and pays its rent, about 0.0033 SOL. Your public SOL did not cover that on top of the trade's fees. Send the wallet a little more SOL and try again. See [The first private holder](/docs/buy-any-token#the-first-private-holder).

## "An account this needs has been frozen"

The token's issuer has frozen an account the trade or the move needs. Only tokens whose issuer kept that power can do this; the Swap page says so on the token's card before you buy. Nothing was sent. This site cannot undo a freeze.

## "This is more than a single trade through this site may be for now"

The operator has set a limit on a single trade. On the Swap page it applies to the SOL or USDC side. Enter less. See [Limits and pauses](/docs/limits).

## A pair token is greyed out on the Launch page

That pair is not switched on. Point at it to see why: the operator has not set it up yet, or the site read something about the token on chain that it will not build on. Launch against a pair that shows **Live**.

## "The graduation would fail, so it was not sent"

The page ran the transaction against the chain first and it did not pass. Most often somebody else, or Meteora's keeper, moved the curve a moment earlier: reload the page. Nothing was sent and nothing was paid.

## "That address has not registered a private wallet"

The recipient cannot receive a private transfer yet. They open the [Wallet](/wallet) page here and press **Register**, once. Or unshield to them instead, which is public. See [Send privately](/docs/private-transfers).

## "Your private balance does not cover this right now"

Either it does not, or the part of it this would spend is set aside. When a transaction that spends from your private balance has been sent and has not settled yet, what it spends is held for up to two minutes, so that a second transaction is not built on the same funds. Your balance still shows them. Wait for the first to settle, or two minutes, and try again. A try that was never sent holds nothing: it gives back what it took at once.

## "Your private balance is split across too many notes"

One transaction can spend only so many notes. Open the Wallet page and press **Consolidate** on that holding, then try again.

## "The price moved past your slippage limit"

Nothing was traded. Quote again. If it keeps happening on a thinly traded token, raise the limit a step, knowing that it is also the most a sandwich can cost you.

## "The curve changed before this landed"

Somebody else traded first. Nothing moved. Quote again.

## "The transaction expired before it landed"

The network was busy and the transaction ran out of time. Nothing moved. Try again.

## "You declined the request in your wallet"

The wallet's approval window was closed or rejected. Nothing was sent.

## "The prover did not answer"

The proof for a private transaction could not be built just now. Nothing was sent. Try again in a moment.

## "The site has reached its proving budget for today"

Private transactions through this site wait until the budget resets. Deposits, Public entry buys and burns from the public balance need no proof and still work. See [Limits and pauses](/docs/limits).

## "This site does not work at this address"

You opened the site at an address its server does not answer at. Pages load there, but nothing can be sent. Use the address in the banner at the top of the page.

## My wallet extension is not listed

It has to support the Wallet Standard, message signing and version 1 transactions. If it cannot sign a version 1 transaction, use the ghost wallet. See [Your own wallet](/docs/external-wallets).

## Ghost fill is greyed out

Either the desk is switched off on this site, or you are using a wallet extension. Ghost fill needs the built-in ghost wallet. The Shielded route makes the same trade against the pool.

## A token's logo does not load

The page shows the token's generated pixel mark instead. The token itself is unaffected: artwork is only a picture.

## "That address is a token account", "a program", or "an account run by a program"

A send or an unshield goes to a wallet's address. The page looked the address up and found something else there, where funds would often be stuck for good, so nothing was sent. Ask for the wallet's own address. See [Several wallets](/docs/wallets#what-a-send-refuses).

## "That would leave less in this wallet than an account may hold"

A Solana account has to hold either nothing or at least about 0.0009 SOL. Send a little less, or press **MAX** to send all of the public SOL and leave exactly zero.

## My vaults look empty, and I filled them

You are almost certainly looking at the wallet's other set of vaults. One key leads to two sets: the standard set, which opens from a wallet extension and from a ghost wallet holding the same key, and a ghost-only set from before the two were brought together. Nothing has moved between them.

- In a ghost wallet: open [prvmax](/prvmax), then **Keys**, and show the other set. The page also says so above the table when the set it is not showing has been used.
- With a wallet extension: vaults a ghost wallet made in its ghost-only set open from the ghost wallet. Import the key on the Wallet page, then open prvmax.

See [prvmax](/docs/prvmax#one-wallet-two-sets-of-vaults).

## One of my wallets says "Could not be opened"

It is an imported wallet whose saved copy in this browser is damaged, or was saved under a different first wallet. Its funds are on chain and untouched. Remove it from the list and import it again from its own secret key. Your other wallets are not affected.

## My other wallets are missing on a new device

The list of wallets is kept in the browser, not on chain. Import your first wallet's secret key, then press **Look for my wallets** on the Wallet page. Imported wallets come back from their own secret keys. See [Several wallets](/docs/wallets#on-another-device).

## A burn is refused

A burn needs the word `BURN` typed into the confirmation box, an amount no larger than the balance you are burning from, and, for the private balance, that balance to have been read.

## Something else

If a message says a transaction settled, it did, even if the next line says the balance could not be refreshed. If a message says nothing was sent, nothing was. When in doubt, open the transaction link: the explorer is the record.
