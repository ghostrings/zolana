A creator can have their share of the trading fees handled automatically instead of claiming it by hand. That is what fee modules are. {{modules_sentence}}

## The two modules

| Module | What it does |
| --- | --- |
| **Buyback and burn** | A share of the creator's fees buys the token on the open market and burns what it bought. The supply only ever falls. |
| **Fee sharing** | A share is paid to up to four wallets, each with its own fixed percentage. |

They can be combined. The shares must add up to exactly 100%: for example 50% bought back and burned, 30% to one wallet and 20% to another. The smallest share is 1%.

Only the creator's share is touched. The platform's share, Meteora's and every trader's funds are not.

## How they are switched on

Meteora pays the creator's share of each curve fee to whoever holds the pool's **creator role**, and only that address can claim it. Switching modules on hands that role to a wallet this platform's server runs for that one token.

- **At launch.** Choose them on the second screen of [Launch](/create). As soon as the new token is listed, a second transaction hands the role over. If that second step does not go through, the token is live all the same, with its fees yours to claim, and you can switch modules on from its page.
- **Later.** The token's page shows **Automate your fees** to the wallet that holds the creator role, and to nobody else. It works while the curve is open and again after graduation, but not in the short time a completed curve is moving to its pool.

Either way it is a transaction of its own that the creator signs, and the settings go on chain in it as a memo anyone can read. The server offers a module wallet only for a token it lists, and only to the wallet the chain names as that token's creator.

> [!WARNING] Permanent
> Once on, a token's modules cannot be changed or switched off, by the creator or by the platform. The creator no longer claims those fees by hand.

:::observer Switching modules on
Your wallet | public
The wallets you share with, and every percentage | public
What each wallet is paid, and what is burned | public
:::

## What happens then

{{modules_schedule}} Each time, for each token:

:::steps
Payout | One transaction claims the creator's fees and divides them exactly as set: each wallet's share to that wallet, the buyback share to the token's buyback pot. All of it or none of it.
Buyback and burn | One transaction buys the token with what the pot holds and burns what it bought, in the same transaction. On the curve before graduation, on the pool after it.
:::

Amounts are in the token's [pair token](/docs/pairs). For a token priced in SOL the wallets are paid public SOL. For another pair token they are paid into their ordinary token account for it. If a wallet has none, the platform opens one for it, once. If that account is closed later, the payout waits, all of it, until the wallet holds such an account again: sending the wallet any amount of the pair token opens one. The token's page says so while it waits.

Small amounts wait. Nothing is paid until enough has built up to be worth a transaction, and in SOL each wallet's share must reach 0.001 SOL before it is sent. Fees that wait are not lost: they stay in the pool, still the creator's, until a pass can pay them.

A buyback is an ordinary public market buy at the pool's price. It pays the token's normal trading fee like any other trade.

## After graduation

The creator role still matters after graduation: the platform's payment of pool fees to the creator goes to whoever holds it. For a token with modules that is the module's wallet, so those payments are divided the same way. They arrive when the platform claims the pool's fees. See [Creator rewards](/docs/rewards#after-graduation).

## Why the settings cannot be swapped

The address of a token's module wallet is worked out from the settings themselves. Change one percentage and it is a different address, which does not hold the creator role. So the chain's own record of who holds the role settles which settings apply, and the server cannot run a token under any others.

A token's page shows its modules, the wallet that holds the creator role, the buyback pot, and every payout and buyback with a link to its transaction.

## What you are trusting

> [!WARNING] The server holds these wallets' keys
> The module wallets are run by this platform's server. What the modules do is carried out by that server, not by a contract.

- If the server is offline, nothing is lost. Fees keep accruing on chain and are paid out when it is back.
- If the server's key were stolen, a thief could take creator fees that have not been paid out yet and what sits in buyback pots. Never a trader's balance and never liquidity.
- If the platform shut down for good, fees not yet paid out would stay where they are.

Each pass pays out everything that is waiting, so little ever sits in these wallets.
