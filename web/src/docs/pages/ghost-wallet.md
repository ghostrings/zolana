The ghost wallet is the wallet built into this site. It is an ordinary Solana keypair that is made, encrypted and kept in your browser.

One browser can keep several under the same passphrase. This page is about the first one, which the others depend on. [Several wallets](/docs/wallets) covers the rest.

## Why a built-in wallet

Solana Privacy Rings uses version 1 transactions and needs a viewing key next to the signing key. The ghost wallet handles both without waiting for a browser extension to support them, and it is the only wallet that can take a [Ghost fill](/docs/ghost-desk). Because it is a plain Solana keypair, you can export it and import it into any Solana wallet at any time.

## Creating one

On [Wallet](/wallet), choose **Create** and enter a passphrase of at least 8 characters, twice.

- The key is generated with your browser's secure random number generator.
- It is encrypted with your passphrase (PBKDF2-SHA256 with 310,000 rounds, then AES-256-GCM) and saved in this browser's storage.
- The secret key is then shown once so you can back it up.

> [!WARNING] Back up the secret key
> The passphrase cannot be reset or recovered, by you or by anyone else. If you lose the passphrase and have no copy of the secret key, the wallet and everything in it are gone. Anyone who has the secret key controls the funds: never paste it into a chat, a form or a website you did not open yourself.

## Unlocking and locking

Unlocking decrypts the key for the tab you are in. It stays unlocked as you move between pages of this site in that tab. Closing the tab or locking the wallet removes it, and another tab asks for the passphrase again. The lock is the padlock on the wallet's card, and **Lock** in the wallet panel.

With several wallets, one passphrase unlocks all of them, and the one that was in use last is the one that opens. Locking closes all of them.

## The wallet panel

The button at the right of the header is the wallet, on every page. With no wallet in this browser it goes to the Wallet page. With one, it opens a panel over the page you are on:

- Locked, the panel asks for the passphrase and unlocks the wallet where you are.
- Unlocked, it shows the wallet in use, its private balance and its public SOL, what it holds, and its last few private transactions. You can copy the address, show it as a QR code, switch to another of your wallets, and lock.
- **Shield**, **Unshield** and **Send** in the panel open the form on the Wallet page. The panel itself sends nothing.

The panel reads your private balance the same way the Wallet page does: from chain, with your viewing key, in this browser. On a page that is in the middle of sending something, the panel will not unlock, lock or switch until that has finished.

On a phone the panel comes up from the bottom of the screen.

## The Wallet page

The card at the top is the wallet in use: its name, its address, its private balance and its public SOL. Under the balance, four round buttons: **Shield**, **Unshield**, **Send** and **Receive**. The first three open the **Move funds** form on that action. **Receive** shows the address as a QR code.

The lists are in tabs: **Tokens** (what the wallet holds, private and public), **Activity** (its private transactions), **Wallets**, **Contacts** and **Keys**.

On a wide screen the Move funds form is always there, under the card. On a phone it is put away, so that what the wallet holds comes straight after the card. A round button, or any button on a holding, brings it out, and the cross at its top right puts it away again. It cannot be put away while it is sending.

## Exporting and importing

**Export secret key**, under **Keys** on the Wallet page, shows the standard 64-byte Solana secret key of the wallet in use, in base58. Click the blurred box to reveal it.

**Import** accepts a base58 secret key or a JSON array of 64 bytes, the two formats Solana wallets export. It is encrypted with a passphrase you choose for this browser and is never sent anywhere.

## If you forget the passphrase

There is no reset. If you saved the secret key, remove the wallet from this browser (type `FORGET` on the locked screen) and import the key again with a new passphrase. Your funds are on chain, not in the browser, so nothing is lost by removing and re-importing.

`FORGET` removes every wallet this browser keeps: the first one, the ones made from it, and any you imported. The first wallet's secret key brings back the first wallet and the ones made from it. An imported wallet comes back only from its own secret key. See [Several wallets](/docs/wallets#backing-up).

## Where the wallet lives

In this browser, on this device, under this site's address.

- Another browser or another device does not have it until you import the key there.
- Clearing this site's data deletes it. With a backup of the secret key that is an inconvenience; without one it is permanent.
- If this site answers at more than one address, a browser keeps each address apart. A wallet made at one shows only there until its key is imported at the other.

## What the server knows

Nothing about the key. The passphrase, the secret key and the viewing key never leave your browser. See [Keys, proofs and the server](/docs/keys-and-proofs).
