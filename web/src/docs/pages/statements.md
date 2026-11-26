A statement is your private history for a period, as a file a spreadsheet or an accountant can open. It has what an explorer cannot show: the token and amount of every private transfer.

It is on the Activity tab of your [Wallet](/wallet).

## What is in it

One line for each entry of your private history:

| Column | What it holds |
| --- | --- |
| Date (UTC) | When the transaction's block was made |
| Type | Shield, Unshield, Private transfer, Consolidation |
| Direction | In, Out, or Self for a move within the wallet |
| Token, Token address | The ticker, and the mint it stands for |
| Amount | How much moved |
| Change | The same with its sign: what it did to your private balance |
| Amount on chain | Public for a shield or an unshield, Hidden for a private transfer |
| Traded for | The token on the other side, when one transaction moved two tokens opposite ways |
| Counterparty | The other wallet of a private transfer |
| Note | The note this browser kept with a payment you sent |
| Transaction, Slot | For looking the transaction up |

Under the form the page also adds up, for each token, what came in, what went out and the difference.

## How it is put together

In your browser. Your wallet's keys decrypt your notes there, and the statement is built from what they open. This site's server never sees a line of it.

Three public things are looked up along the way, through the same relay every wallet read uses:

- **The date** of each transaction, from the chain.
- **The other wallet** of each private transfer. A private transfer shows both wallets on chain, so this is public for everyone.
- **How each token writes its amounts.** If the decimals of a token cannot be read, the statement is not built, and the page says which token. It never guesses one.

Dates and wallets are kept in this browser after the first read, so a second statement is quick.

## Periods

All time, this month, last month, this year, last year, or any two days. Months, years and days are counted in UTC, like the dates in the file.

> [!NOTE] A transaction that could not be dated
> If the chain does not give a date for a transaction just now, the transaction is kept: it goes at the top of the file with an empty date, and the page says how many there are. Leaving a transaction out without saying so is the one thing a statement must not do. Build again in a moment and it is dated.

## What it cannot hold

- **Prices.** The file has amounts, not what they were worth. This site has no record of past prices it could stand behind.
- **Where an unshield went, when it was sent from another browser.** The destination of an unshield is public on chain, but it is not part of your private history. This browser keeps it for unshields it sent itself.
- **Notes from another browser.** Notes are kept in the browser that sent the payment. They are not on chain.
- **Public transfers.** Something sent from your public balance never touched your private one. An explorer lists those.

## Opening the file

It is a plain CSV file. Text that somebody else wrote, such as a token's ticker, is written so a spreadsheet shows it as text and never runs it as a formula.

## For somebody else to read

To let an accountant build the statement themselves, straight from the chain, give them a [viewing pass](/docs/read-only-access). They see the same history, and cannot move anything.
