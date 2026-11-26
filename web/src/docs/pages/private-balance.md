Your private balance is what you hold inside Solana Privacy Rings. This page covers how it is read, why it sometimes needs tidying, and what the status messages mean.

## How it is read

A private balance is not a number stored somewhere. It is the sum of the notes on chain that your viewing key can open. To show it, the page:

1. fetches the encrypted notes that may be yours from the Rings indexer;
2. decrypts them in your browser and checks each against its commitment on chain;
3. drops the ones that have already been spent.

That is why a balance says **Syncing** for a moment, and why it is right to say nobody else can list what you hold.

## "Not read" is not zero

If a read fails, the page shows **Not read**, the reason, and a **Try again** button. It never shows 0 for a balance it could not read.

> [!NOTE] Nothing is lost when a read fails
> What you hold privately is on chain under your keys. A failed read means this page could not fetch or decrypt it this time. Actions that spend from the private balance wait until it has been read.

After a transaction lands, the page reads the balance again. If that second read fails, the transaction is still reported as settled, with a note that the balance on screen may be out of date. Reload to see it.

## Registration

Registering publishes your wallet's encryption key in the Rings registry so that others can send to your Solana address privately. It is one press of **Register** on the Wallet page, it is public, and it is needed once.

You are registered automatically the first time you take a Ghost fill or consolidate a balance. Deposits, withdrawals and Shielded trades do not need it.

## Notes, and why balances fragment

Each deposit, each incoming transfer and the change from each spend is its own note. The Wallet page shows how many notes each holding is made of.

A single transaction can spend only a limited number of notes. If a holding is spread across more than that, an action can fail with a message that the balance is split across too many notes.

**Consolidate** on a holding merges its notes into one. It moves nothing to anyone and changes no balance: it only tidies. It is a private transaction between you and yourself, so the chain shows that your wallet did something in Rings and nothing else.

## What stays public

Your private balance always needs a small public one beside it. Network fees and temporary account rent are paid from public SOL, and most actions refuse to start with less than {{gas_reserve}} SOL there. About 0.02 SOL is a comfortable floor.

## What you can hold privately

SOL, every token launched on this site (each is opened to Rings in its launch transaction), and other tokens that have a Rings interface. A token without one cannot be deposited.

## Private history

The Wallet page, on its **Activity** tab, rebuilds a history from your own notes: shields (deposits), unshields (withdrawals), private transfers in and out, and consolidations, with amounts. It is decrypted locally and exists nowhere else. The wallet panel in the header shows the last few entries of the same list.

A burn from the private balance appears there as an unshield, because that is the step that takes the tokens out of Rings.
