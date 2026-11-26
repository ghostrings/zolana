A token's creator earns a share of its trading fees. The creator is the wallet that signed the launch, recorded on chain.

## On the curve

For a token launched today, {{creator_pct}}% of every trading fee accrues to the creator on chain, trade by trade. Only the creator's wallet can claim it. A token keeps the share it was launched with, so an older token's may differ: its page states it under **Token facts**.

A claim withdraws what has accrued and deposits it into your **private balance** in the same transaction.

:::observer A claim
Your wallet | public
The token and the amount claimed | public
The balance it lands in | hidden
:::

Rewards are paid in the token's [pair token](/docs/pairs): SOL for a token priced in SOL, which is what the examples here use. The claim is paid out of a public pool, so it is a public event. From that moment the proceeds are an encrypted balance, and you can send them on privately.

## Where to claim

- On the token's page, **Your rewards on this token** appears when you are its creator.
- On the [Wallet](/wallet) page, **Rewards** lists the tokens you launched with what each has earned.

A claim needs at least {{min_claim}} SOL waiting, or about as much in another pair token. Below that it would cost more in fees than it is worth, so let it build.

## After graduation

Once a token graduates, the creator holds no liquidity. The pool's one position is the platform's, and that position collects the pool's fees.

From what it collects, {{payout_sentence}}.

- It arrives as **public SOL** in the creator's wallet, in the same transaction in which the platform claims. For a token priced in another pair token it arrives as that token, in the creator's ordinary token account, which the platform opens if the creator has none.
- It happens when the platform claims, not on a schedule the creator controls.
- A share smaller than {{min_payout}} SOL is not sent yet. It stays in the pool, still accruing, until it is large enough. For another pair token the smallest payout is about 0.01 SOL's worth.

> [!WARNING] This payment is not enforced on chain
> The curve share is yours by the token's config. The post-graduation share is the platform's payment to you. The site says so wherever it states the percentage, and so do these docs.

## Not claiming by hand

A creator can hand this over to [fee modules](/docs/fee-modules): the fees are then bought back and burned, shared between wallets, or both, automatically. For such a token there is nothing to claim here, and its page shows what the modules have paid instead.

## Fees you earned before graduation

They do not expire. Whatever accrued on the curve stays claimable after the token graduates.

## Arithmetic, not a forecast

On a 3% token launched today, 100 SOL of curve volume produces 3 SOL of fees, and {{creator_pct}}% of that is the creator's. The [Launch](/create) page has a calculator for this. Volume is not something anyone can promise.
