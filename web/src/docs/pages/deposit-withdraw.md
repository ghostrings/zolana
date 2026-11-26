Shielding and unshielding are the two ways across the line between your public balance and your private one. To shield is to deposit into Solana Privacy Rings. To unshield is to withdraw from it. Both are public, and both are on the [Wallet](/wallet) page under **Move funds**. On a phone, press **Shield** or **Unshield** on the wallet's card to bring that form out. You can do either at any time.

## Shield: public to private

:::steps
Choose Shield | Pick SOL or any token in your public balance that Rings supports.
Enter an amount | The 25%, 50% and MAX buttons work from what is available. For SOL, {{gas_reserve}} is kept back for fees.
Press Shield into Rings and sign | It lands in one transaction.
:::

:::observer Shielding
Your wallet | public
Asset and amount | public
Your balance afterwards | hidden
:::

Shielding needs no proof, so it is quick. Tokens sitting in your public balance also have a **Shield** button on their card, which fills the form in for you.

## Unshield: private to public

:::steps
Choose Unshield | Pick the asset from your private holdings.
Enter an amount and a destination | The destination starts as your own address. Change it to pay any Solana address directly.
Press Unshield to public and sign | The page builds a proof first, which takes a few seconds.
:::

:::observer Unshielding
Your wallet and the destination | public
Asset and amount | public
What remains in your balance | hidden
:::

Unshielding to someone else is the way to pay an address that has not registered with Rings, an exchange deposit address for example. If the destination has no token account for that token yet, the transaction creates it.

The destination has to be a wallet. Before anything is signed, the page looks the address up and refuses one that is a token account, a token's mint or a program, because funds sent to those are often stuck for good.

## What it costs

- No fee to this site.
- The Solana network fee, with a priority fee that follows the network.
- Solana Privacy Rings can charge its own protocol fee on a transaction. This site adds nothing to it.

## Lowering what a crossing gives away

Shielding an amount and, a minute later, trading or sending about the same amount is easy to pair up. Two habits help:

- Shield ahead of time, not right before you need it.
- Shield round amounts, and more than one action's worth.

Neither makes a wallet unlinkable. They only make timing and amount less telling. See [What is private](/docs/what-is-private).
