One browser can keep up to 24 ghost wallets under one passphrase. Each is an ordinary Solana wallet of its own, with its own address, its own public balance and its own private balance. You name them, give them icons, switch between them, and send from one to another.

All of it is on the [Wallet](/wallet) page, on its **Wallets** tab. The panel that opens from the wallet button in the header can switch between them too.

## The wallet in use

One wallet is in use at a time. It is the one shown in the bar at the top of every page, and every page signs with it: a trade, a launch, a send, a [prvmax](/docs/prvmax) spread.

Press **Use** on another wallet to switch, or pick it from the list in the wallet panel. Nothing moves on chain when you do. The choice belongs to the tab you are in, so two tabs can use two different wallets. After a lock, the passphrase opens the wallet that was in use last.

## The first wallet and the others

The wallet you created or imported first is the **first wallet**. It is stored exactly as a ghost wallet has always been stored: its key encrypted with your passphrase. See [The ghost wallet](/docs/ghost-wallet).

Every other wallet hangs off it in one of two ways.

| Kind | How it is made | What brings it back |
| --- | --- | --- |
| Made from your first wallet | Its key is computed from the first wallet's key and a number: 1, 2, 3 and so on | The first wallet's secret key |
| Imported | You paste a secret key from somewhere else | Only its own secret key |

## Making a new wallet

:::steps
Press New wallet | Give it a name, or leave the field empty for "Wallet 2", "Wallet 3" and so on.
Press Create wallet | It is made at once and you start using it. There is no new key to write down.
Fund it | It is empty, like any new wallet. Send it SOL in public, or register it and send to it privately.
:::

The rule is short. The 32-byte seed of wallet number 1, 2, 3 and so on is HMAC-SHA256 of the text `privacycash.fun/wallets/v1/` followed by that number, keyed with the first wallet's own 32-byte seed, which is the first half of its 64-byte secret key. That is all of it, so the same first wallet always makes the same wallets in the same order, on any device, and other software can compute them too.

## Importing a wallet

Press **Import a secret key** and paste a base58 secret key or a JSON array of 64 bytes. The key is sealed with AES-256-GCM under a key that is itself made from your first wallet's seed, and saved in this browser. It is never sent anywhere.

> [!WARNING] An imported wallet has its own backup
> Your first wallet's secret key does not bring an imported wallet back. Keep the imported wallet's own secret key. Without it, clearing this browser or forgetting the passphrase loses that wallet for good.

## Backing up

- **The first wallet's secret key** restores the first wallet and every wallet made from it.
- **Each imported wallet's secret key** restores that wallet and nothing else.
- **Any single wallet** can also be exported on its own: press **Secret key** on its tile. What you get is a standard Solana secret key that opens in any Solana wallet.

The passphrase cannot be reset. With the secret keys saved, forgetting it is an inconvenience. Without them it is permanent.

## Names, icons and contacts

A name is up to 24 characters. An icon is one of twelve pixel icons, or the automatic mark drawn from the wallet's address. Click the icon on the wallet's card to change it.

**Contacts** are names for other people's addresses. A contact, like each of your other wallets, is offered as a button whenever you fill in a recipient.

Names, icons and contacts are kept in this browser only. They are never on chain and never sent to this site's server. No two things here can share a name, so that a name always means one address.

## Sending between wallets

Under **Move funds**, choose **Send**. The buttons under the address field fill in one of your other wallets or a contact. Then choose what the send takes from.

| Send from | What it is | What the recipient needs |
| --- | --- | --- |
| Private balance | A [private transfer](/docs/private-transfers) | To be registered with Rings |
| Public balance | An ordinary Solana transfer | Nothing |

A wallet registers with **Register** on its own card. It is a one-time, public step. A new wallet you made here is not registered until you press it.

:::observer A send from the public balance
Your wallet and the recipient's | public
Which token | public
How much | public
:::

A send from the public balance hides nothing. It is there because it is the plain way to fund a new wallet or pay an address that is not registered.

For public SOL, **MAX** sends all of it and leaves the wallet at exactly zero, with nothing left for fees. Any other amount has to leave at least about 0.0009 SOL behind, the least a Solana account may hold.

## What a send refuses

Before anything is signed, the page checks the destination on chain and refuses:

- an address that is a token account or a token's mint, where a wallet's address was meant;
- an address that is a program, or an account a program runs;
- SOL to an empty address in an amount too small to open it;
- a token transfer when the wallet has too little public SOL for the fee and, if the recipient has never held that token, the rent of their token account.

The same check runs when you unshield to someone else's address.

## Receiving

**Receive** on the wallet's card shows the address and a QR code of it.

- **In public:** anyone can send SOL or tokens to the address from any wallet or exchange. They arrive in the public balance.
- **Privately:** the sender uses Send on this site, and the wallet has to be registered first.

## On another device

Names, icons and the list itself do not travel. The wallets do, because they are on chain.

:::steps
Import the first wallet's secret key | On the new device, as the first wallet, with a passphrase for that browser.
Press Look for my wallets | It works out the wallets your first wallet can make, lowest number first, and asks the chain whether anything ever happened at each. It stops eight numbers past the last one it finds.
Import the imported ones | Each from its own secret key.
:::

A wallet is found when anything has ever happened at its address: SOL coming in, a registration, a shield. One you made and never used is not found, and holds nothing.

**New wallet** always makes the lowest-numbered wallet that is not on the list yet. On the device where you made your wallets that is simply the next one. On another device it means that, if a wallet is ever missing after a search, pressing New wallet brings the missing ones back in the order they were first made, and a private balance is read as soon as you use the wallet.

## Removing a wallet

- **A wallet made from your first wallet** is only taken off the list. Its number is never given to another wallet, and **Put back** restores it. What it holds stays on chain.
- **An imported wallet** has its saved key deleted from this browser. You are asked to type `REMOVE`. Save its secret key first.
- **The first wallet** cannot be removed on its own. Typing `FORGET` on the locked screen removes all of them together.

## Vaults

[prvmax](/docs/prvmax) vaults belong to the wallet in use. Each wallet has its own vaults, made from its own key, and one wallet's vaults do not show under another. The same vaults open whether the wallet is used here as a ghost wallet or connected through a wallet extension holding its key.

## What several wallets hide, and what they do not

Nothing on chain says that two wallets were made from the same first wallet. The arithmetic happens in your browser, and the addresses have nothing in common to look at.

> [!GHOST] Wallets are linked by what they do
> A public send from one of your wallets to another ties them together for anyone to see. A private transfer between them hides the token and the amount, and still shows that the two wallets dealt with each other. Funding two wallets from the same exchange withdrawal, or always using them minutes apart, tells the same story.

Two more things to know:

- The wallet list reads the public SOL of all your wallets in one request, and **Look for my wallets** asks about the addresses your first wallet can make, one after another. Like every read, these pass through this site's relay to Helius, so both can see that one browser asked about those addresses together.
- This is the Default Ring: confidential, not anonymous. A separate wallet separates balances and activity. It does not hide who a wallet deals with.

## Good to know

- **Each wallet needs its own SOL for fees.** Keep about {{gas_reserve}} public SOL in any wallet you trade or shield from.
- **A private balance is per wallet.** Switching wallets reads the new wallet's notes. Nothing is shared between them.
- **A wallet extension has no list.** Several wallets are a feature of the ghost wallet. With an extension connected, the extension chooses the account.
- **A wallet that "could not be opened"** is an imported one whose saved copy is damaged or was saved under a different first wallet. Remove it and import it again from its own secret key. The other wallets are not affected.
