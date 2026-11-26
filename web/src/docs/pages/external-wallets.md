You can use a Solana wallet extension instead of the built-in ghost wallet. This is marked beta, because extension support for the transaction format Rings uses is recent.

## What the extension must support

- The Wallet Standard, which is how this site finds it.
- Signing an arbitrary message.
- Signing **version 1** transactions. Every Rings transaction is one.

Extensions that qualify are listed on the [Wallet](/wallet) page under **Use your own wallet**. If yours is installed but not listed, it does not offer one of the three.

## What happens when you connect

The extension is asked to sign one fixed message. Your privacy keys are derived from that signature, in your browser, and the signature is kept for the tab you are in. It is used to read your private balance and to build proofs. It cannot spend: every transaction still needs its own approval in the extension.

## What works and what does not

| Works with an extension | Needs the ghost wallet |
| --- | --- |
| Shield and unshield | Ghost fill |
| Send privately, receive privately | Several wallets under one passphrase |
| Send from the public balance | |
| Burn tokens | |
| Shielded route and Public entry | |
| Launch a token, claim rewards | |
| Consolidate notes | |

Ghost fill needs the built-in wallet because, before signing, the page decrypts the desk's transfer with your viewing key to check that it pays you. With an extension the Shielded route does the same trade against the pool.

## Differences you will notice

- The private balance is read from the chain again each time a page loads, so it takes a little longer to appear than with the ghost wallet, which keeps an encrypted copy of what it has already read.
- If the extension refuses a transaction with a message about its version, it does not support version 1 transactions yet.

## Moving between the two

Both kinds of wallet derive their privacy keys the same way, from the wallet's signature over the same fixed message. The same Solana key is therefore meant to reach the same private balance whether you use it through an extension or import it as a ghost wallet. If you move a key from one to the other, check that the balance appears before you rely on it.
