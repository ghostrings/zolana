Burning destroys tokens. They are not sent anywhere and nobody receives them: they stop existing, and the token's supply drops by exactly that amount. It cannot be undone.

## Can a burn be private?

No, and it is worth knowing why. A burn only means something because everyone can check that the supply fell. That makes the burn itself public by nature: the wallet that burned, the token and the amount.

What this site does is burn **straight out of your private balance**, in one transaction, so nothing else about you is exposed along the way.

:::observer A burn from your private balance
Your wallet | public
Which token, and how much was burned | public
The new, lower supply | public
What you still hold in your private balance | hidden
:::

An observer learns that your wallet burned that amount. They do not learn how much you had before or how much you have left.

## How it works

A burn from the private balance is one atomic transaction with three steps:

1. The tokens leave your private balance for your own token account.
2. The very next instruction burns exactly that amount from it.
3. If that token account was created for this, it is closed again and its rent returned.

Either all three happen or none do. The tokens are never left sitting in public.

You can also burn tokens that are already in your **public** balance. That is a plain token burn with no Rings step, and nothing private is touched.

## Burning from a token's page

:::steps
Open the token and find "Send or burn" | Pick the Burn tab.
Choose where to burn from | Your private balance, or your public balance when you hold some there.
Enter the amount | The panel shows the supply now, the supply after, and what share of the supply this burn is.
Type BURN to confirm | The burn is refused until you do.
Press the burn button and sign | Before it is sent, the transaction is run against the chain. One that would fail is never sent.
:::

## Burning from the Wallet page

Under **Move funds**, choose **Burn**. The asset list offers each token you can burn, marked private or public. Every holding of a token launched here also has a **Burn** button that opens the form on it.

## What a burn changes

| | Before | After |
| --- | --- | --- |
| Supply | As it was | Lower by the amount burned |
| Burned so far | As it was | Higher by the amount burned |
| Price in the pool | As it was | **The same.** A burn does not trade. |
| Market cap | Price × supply | Lower, because the supply is |
| Your share of what exists | Balance ÷ supply | Each remaining token is a larger share |
| Graduation progress | As it was | The same. It counts the pair token in the curve, not tokens. |

A burn pays you nothing. It is a decision to hold less of a smaller supply.

## Where burns show up

- On the token's page: **Supply now** and **Burned** under the price chart, in **Token facts**, and as a tag by the token's name.
- On the market: a burned token's card says how much of the supply is gone.

These figures come from the token's mint account on chain. They count every burn, whoever made it and with whatever tool, because the supply is the supply. The listing picks a new burn up within about 20 seconds; the token's own page reads the chain directly.

## Why the supply can only fall

Every token launched here starts with 1,000,000,000 and has no mint authority, so nobody can create more, the creator and this platform included. Each token page shows this under **Can more be minted**, read from chain, not assumed.

## What it costs

- No fee to this site.
- The Solana network fee, from your public SOL. Keep at least {{gas_reserve}} SOL there.
- Any protocol fee Solana Privacy Rings charges, when burning from the private balance.

## Limits and safeguards

- **Only tokens launched here** can be burned from this site. SOL cannot be burned, and neither can other tokens you hold: burning USDC by mistake helps nobody.
- **You confirm by typing.** A burn asks for the word `BURN` every time.
- **The amount is exact.** The burn instruction names the token and its decimals, so it cannot burn anything else or any other amount.
- **Your balance is read first.** A burn from the private balance waits until that balance has been read from chain.

## Questions

**Can I get burned tokens back?** No. Not from this site, not from the creator, not from anyone.

**Does burning raise the price?** Not by itself. The pool's price moves only when someone trades. A burn leaves fewer tokens in existence at the same price.

**Can the creator burn the unsold supply?** No. Tokens a curve has not sold belong to the curve, not to the creator. Anyone, creator included, can only burn tokens they hold.

**Can the locked liquidity be burned?** It does not need to be. After graduation the pool's liquidity is locked permanently and nobody can withdraw it.

**How does it look in my private history?** As a withdrawal of that token, because that is the step that took it out of Rings. The burn itself is on the public record.

**I launched a token and a few units stayed in my public account.** That can happen when a first buy rounds by a unit. You can deposit them, or burn them from the public balance.
