The check-up tells you what your wallet's own public activity lets an onlooker work out about it. It is on the Privacy tab of your [Wallet](/wallet).

It reads the public rows the [Rings page](/docs/rings-explorer) shows to anyone for your address, and nothing else. It uses no key, and it looks at no other wallet's rows.

## Why there is anything to check

On the Default Ring a private transfer hides its token and its amount, and nothing more. Shields, unshields and pool trades show their amounts. So what gives a hidden amount away is what happens next to it in public.

## What it looks for

**A private transfer that left right after a public amount came in.** You shield 5 SOL and three minutes later send a private transfer. The transfer's amount is encrypted, but an onlooker can guess it was about 5 SOL.

**A public amount that left right after a private transfer came in.** You are paid privately and four minutes later unshield 2 SOL. An onlooker can guess the payment was about 2 SOL.

**A balance anyone can add up.** If every move of your private balance was a shield, an unshield or a pool trade, their amounts add up to what you hold. A private transfer, in or out, is what leaves an onlooker unsure.

"Right after" means within fifteen minutes, with no other move of your private balance in between. For each finding the page links the two transactions.

## What takes a guess away

- Let time pass between a public amount and a private transfer.
- Send, or take out, another amount than the one that just came in.
- Keep a balance that has had private transfers in and out of it, rather than a fresh one for each payment.

None of this is hidden knowledge. It is how the Default Ring works for everyone, and the check-up only shows you where your own wallet stands.

## What it also tells you

- **How many wallets are linked to yours in public.** A private transfer never hides the two wallets. The check-up lists those yours has paid or been paid by.
- **Payments that went out in the open.** An unshield straight to somebody else's address shows both wallets and the amount, like an ordinary transfer.

## What it cannot see

- **What an onlooker knows from elsewhere.** An exchange that knows your address, or a counterparty who tells someone what they paid you.
- **What the other wallet does.** If the wallet you paid unshields the same amount a minute later, that is in its rows, not yours. The check-up does not read other wallets' rows.
- **History this site has not read.** The page says how far back it looked.

> [!NOTE] It needs the Rings page
> The check-up is worked out from what this site's server has read of Rings. If that is switched off, the check-up has nothing to read and says so.
