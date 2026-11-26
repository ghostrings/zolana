A viewing pass lets someone read one wallet's private balance and history, and do nothing else. It is for an accountant, an auditor, or you on a device you would not trust with your secret key.

You make one on the Keys tab of your [Wallet](/wallet). The reader opens it on the [read-only page](/view).

## What a pass holds

Your wallet's viewing key and nullifier key, in the form they are derived from: one signature of your wallet over a fixed message. The viewing key decrypts your notes. The nullifier key tells which of them are spent. Together they are everything needed to read a private balance.

It is the same thing a wallet extension hands this site when it connects.

## What its holder can and cannot do

| | With a pass |
| --- | --- |
| See private holdings, token by token | Yes |
| See the private history, with tokens and amounts | Yes, from the wallet's first day |
| See what the wallet does from now on | Yes, for as long as the wallet is used |
| Build and download a [statement](/docs/statements) | Yes |
| Send, unshield, trade or burn | No |
| Sign anything as the wallet | No |
| Open the wallet's [prvmax vaults](/docs/prvmax) | No |

A spend is authorised by the wallet's signature over the transaction. A pass holds no key that signs, so there is nothing its holder could send. The read-only page goes further and attaches no prover, so it cannot build a transaction of any kind.

One thing the protocol allows any holder of a wallet's nullifier key: to merge that wallet's notes into one, if the wallet has consolidation switched on, as wallets registered here do. That moves no funds and changes no owner. This site's read-only page cannot do it.

> [!WARNING] A pass cannot be taken back
> Your wallet's keys come from its secret key and never change. A pass you handed out keeps working for as long as you use the wallet. The only way to end it is to move to another wallet: make a new one on the Wallets tab and send your balance there. That transfer shows the two wallets on chain, as every private transfer does.

## Making one

:::steps
Open the Keys tab of your Wallet | Viewing pass is the second section.
Choose a passphrase for the pass | At least 10 characters, and not your wallet's passphrase.
Type VIEW and press Make a viewing pass | The pass is made in your browser.
Copy it, or save it as a file | This site keeps no copy.
Give the reader the pass one way and the passphrase another | The pass by mail, the passphrase by phone.
:::

The pass is sealed with its passphrase. Without the passphrase it shows only which wallet it is for. With a weak passphrase it can be guessed by anyone who gets hold of it, so choose a long one.

## Opening one

The reader goes to the [read-only page](/view), pastes the pass or chooses its file, and types the passphrase. The page reads the wallet's notes from chain and decrypts them there.

The opened pass is kept in that page's memory and nowhere else. It is not stored and not sent to this site's server. Closing the tab closes the view.

## What the reader does not see

- **Notes kept with payments.** Those are in the browser that sent the payment, not on chain.
- **Your public balance history.** It is public: any explorer shows it.
- **Other wallets of yours.** A pass is for one wallet. Make one for each wallet you want read.
- **prvmax vaults.** Each vault is a wallet of its own.

## A pass or a file

A [statement](/docs/statements) you download and send is a file you made: the reader has to trust it. A pass lets the reader build the statement themselves, straight from the chain. A statement covers the period you chose and ends there. A pass covers everything, and does not end.
