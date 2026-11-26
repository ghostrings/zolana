prvmax gives one wallet up to ten **vaults**. A vault is a wallet of its own, with its own private balance, whose key is worked out from your wallet's key. You spread a balance across your vaults, trade from them, see them together in one table, and recall everything to one wallet when you are done. It is at [prvmax](/prvmax).

## What it hides, and what it does not

Read this part first. A vault uses the same [Default Ring](/docs/what-is-private) as the rest of this site: it hides amounts and tokens, not wallets.

:::observer Your vaults
Each vault's address | public
That your wallet gave it SOL for fees | public
What your wallet sent it privately, and how much | hidden
What it holds | hidden
A trade it makes on a pool | public
A trade it makes with the Ghost desk | hidden
:::

So vaults are not a disguise. Anyone reading the chain can see which vaults a wallet funded, and that those vaults traded. What nobody can read is how much each vault holds, and what moved between you and it.

> [!WARNING] Vaults do not make a wallet look like ten strangers
> Your wallet pays each vault's fees in public, which ties the vaults to it for good. If a tool promises that several wallets of yours will pass as unrelated buyers, this is not that tool, and on a public chain no tool is.

## What a vault is

An ordinary Solana keypair. Nothing about it is special on chain.

- **With a wallet extension**, the ten keys are worked out from one signature your wallet gives this site. The first time, it is asked for twice, to check that your wallet signs the same message the same way every time. A wallet that does not is refused, because it could never find its vaults again.
- **With the ghost wallet**, they are worked out from your wallet's secret key, in your browser. The ghost wallet holds the key itself, so it makes that very signature on its own and arrives at the same ten vaults an extension holding the key does. Restore the wallet from its secret key anywhere and the same vaults come back.
- **With several ghost wallets**, vaults belong to the wallet in use. Each wallet has its own, worked out from its own key, so switching wallets on the Wallet page switches the vaults shown here. See [Several wallets](/docs/wallets).

Nothing about a vault is stored on the server. This browser remembers only how many vaults you use and the first vault's address, which marks the set it shows.

## One wallet, two sets of vaults

A wallet's key leads to two sets of ten vaults.

| Set | Made from | Opens from |
| --- | --- | --- |
| Standard | The wallet's signature over a fixed message | A wallet extension, and a ghost wallet holding the same key |
| Ghost-only | The wallet's secret key directly | The ghost wallet only |

The standard set is the one to use: it is the same however the wallet is opened. The ghost-only set is what a ghost wallet was given before the two were brought together. It still belongs to the wallet, it still opens from the ghost wallet, and nothing in it is lost.

A wallet uses one set, and the page works out which without asking:

- When only one of the two has ever been used, that one is shown, on any browser.
- A wallet that has used neither starts on the standard set.
- When both have been used, the page shows the one this browser showed last, and says above the table that the other exists, with a button to show it.

A ghost wallet can also switch by hand, under **Keys**. A set you chose yourself stays chosen. A wallet extension always shows the standard set, and cannot open the ghost-only one: that takes the ghost wallet.

> [!WARNING] Empty vaults after opening the wallet another way
> If vaults you filled look empty, you are almost certainly looking at the wallet's other set. Nothing has moved. In a ghost wallet, open **Keys** and show the other set. With an extension, the vaults a ghost wallet made in its ghost-only set are reached from the ghost wallet: import the key on the Wallet page.

The page reads all ten vaults through this site's relay, as the Wallet page reads one wallet. For a ghost wallet it also asks whether anything ever happened at the ten of the wallet's other set. So the relay, and Helius behind it, see one browser asking about those addresses. For the vaults you use, that tells them nothing the chain does not already show, since your wallet funds each vault in public.

> [!NOTE] Every vault's key can be exported
> The **Keys** tab shows any vault's secret key. It works in any Solana wallet, and under **Import a secret key** on the Wallet page here, where the vault joins your list as a wallet of its own. That is how you reach a vault without the prvmax page. Whoever has a vault's key controls what it holds.

## The five steps

:::steps
Get ready | Your wallet sends each vault a little public SOL, in one transaction. Each vault then registers with Rings, once, so it can be sent to privately.
Spread | An amount from your wallet's private balance is split evenly across the vaults you tick, as private transfers.
Trade | Each ticked vault buys or sells one token from its own private balance, one vault after another.
Look | The portfolio adds up your wallet and every vault, in your browser.
Recall | Every vault is emptied into one wallet: private balances, leftovers and public SOL.
:::

### Get ready

Network fees are paid from public SOL, so each vault needs some of its own: 0.03 SOL by default, and at least {{gas_reserve}} SOL for anything to run. This transfer is public and is what links a vault to your wallet. The SOL comes back with a recall.

### Spread

Spread takes from your wallet's **private** balance. To spread public SOL or public tokens, [shield](/docs/deposit-withdraw) them first. Each vault receives one [private transfer](/docs/private-transfers): the chain shows your wallet and the vault, and neither the token nor the amount.

The ghost wallet signs these itself. A wallet extension asks you to confirm once for each vault.

### Trade

A vault trades the way a wallet does on a token page, on one of two [routes](/docs/trading):

| Route | Token and size on chain | Limits |
| --- | --- | --- |
| Shielded | ++Public++ | The site's per-trade limit |
| Ghost fill | ==Encrypted== | Tokens priced in SOL, small trades, and only what the desk has in stock |

On the Shielded route each vault's trade is an ordinary swap on the Meteora curve or pool, and it shows the vault, the token and the size. Vaults trade one after another, so each trade moves the price for the next. Whatever a buy does not use stays in that vault in public and returns with a recall.

A [Ghost fill](/docs/ghost-desk) swaps two private transfers between the vault and the desk, and the pool is not touched. The page first shows you the desk's quote. When you press again, every vault gets its own fresh quote, and one that is worse than the quote you saw by more than your limit is refused before anything is signed. The desk sees every trade it fills.

### Recall

A recall checks all ten vaults, whether or not they are in use, and for each one:

1. moves every private balance to the wallet you name, privately when that wallet is [registered](/docs/private-balance#registration), or by a public withdrawal if you choose that;
2. sends on anything a trade left in the vault's ordinary token accounts, in public, and closes those accounts;
3. sends back the vault's public SOL, down to zero.

Recalling a vault twice cannot move anything twice, so a recall that stops partway is simply pressed again.

## What a creator cannot do

A wallet cannot use vaults with a token it created: not spread it, not buy it, not sell it. The same goes for a token created by another wallet kept in the same browser, so switching wallets does not step around it. Buyers watch what a creator holds and sells, and trades from ten vault addresses would read as other people's. A creator trades their own token from their own wallet, on its page. Anything already in a vault can always be recalled.

## What it costs

Nothing to this site. Each step pays what the same step costs anywhere else here:

- each transaction's network fee, from the vault's public SOL, or from your wallet's for Get ready and Spread;
- any protocol fee Solana Privacy Rings charges on a private transaction;
- the token's trading [fee](/docs/fees) on a pool trade, or the desk's spread on a Ghost fill.

A full round across ten vaults is some forty private transactions. They run one at a time, a few seconds apart, because this site limits how many proofs one visitor may ask for in a minute.

## When a step stops

Each step runs vault by vault and says what it is doing. If one fails:

- **Spread, buy and sell stop there.** What settled stays settled, the table is read again from the chain, and nothing is repeated until you press again. Look at the table first.
- **A recall carries on** with the other vaults and tells you which ones to try again.

A vault low on public SOL cannot move its private balance. Top it up with **Get ready**, then try again.

## Risks that are specific to vaults

- **More keys to lose.** A vault lives or dies with the wallet it was made from. Back that wallet up before you send anything to a vault. With a wallet extension, export the keys of vaults that hold anything you care about.
- **More public links.** Ten vaults funded by one wallet are ten public links to that wallet.
- **More fees.** Ten small trades cost ten sets of fees.
- **A list kept in your browser.** "What your vaults traded" is this browser's own record. It is not on chain, and clearing the browser's storage clears it.
