[Pay many](/pay) pays a list of wallets from your private balance: one private transfer per wallet, sent one after another, with a receipt at the end. It is for paying a team, splitting a prize, or settling with several people at once.

:::observer A run of payments
Your wallet | public
Every wallet you pay | public
When each payment was made | public
Which token | hidden
Each amount | hidden
Your notes | hidden
:::

Each payment is the same [private transfer](/docs/private-transfers) the Wallet page sends. Nothing about it is more hidden or less. What is new is that a list is paid without you reading every result, so the page keeps the books for you.

## Before you start

1. **You hold the token privately.** A run pays from a private balance, in one token.
2. **You have public SOL for the fees.** Every payment is its own transaction and pays its own network fee. Keep at least {{gas_reserve}} SOL in public; the run stops by itself when less is left.
3. **Every wallet on the list is registered with Rings.** A wallet that has never opened a private balance cannot be paid privately. The page checks each one and tells you which are not.

A run pays at most 25 wallets. Split a longer list into two runs.

## The list

One payment per line: the address, then the amount, then a note if you want one. Commas, semicolons, tabs or spaces can separate the parts.

```
7xKX…wallet, 12.5
9hTq…wallet, 3, design work in March
```

Three rules keep an amount from being read wrong:

- **A point for decimals, and no thousands separators.** `1250.5`, not `1,250.5` or `1 250,5`.
- **A note starts with a word.** `invoice 1042`, not `1042`. Digits straight after an amount look like the rest of the amount, and the line is refused instead of guessed at.
- **Notes are up to 140 characters.**

Empty lines and lines starting with `#` are skipped. So is one heading line at the top, such as `address, amount`.

## What happens

:::steps
Paste the list and press Read the list | Every line is read back to you. A line that cannot be read is shown with the reason. It is never corrected for you and never dropped in silence.
Wait for the wallets to be looked up | Each address has to be a wallet, and registered with Rings. One that is not is left out of the run, and the receipt says so.
Press Pay | The button says how many wallets and how much in total. Nothing has been sent before this.
Sign each payment | The ghost wallet signs by itself. A wallet extension asks you once per payment.
Download the receipt | A file with every line of your list: paid or not, the transaction, the time and your note.
:::

## A wallet is never paid twice

Before a payment is handed to the network, its signature is written down in this browser. From then on that line is settled only by what the chain says about that signature:

- **Paid**: the chain has it.
- **Not paid**: the network refused it, the chain rejected it, or it grew too old to land. Nothing moved. This is the only state a line is ever sent again from, and only when you ask.
- **Sent, not confirmed yet**: the page lost touch with the network while sending. It does not know, so it does not guess. Nothing else is sent until **Check again** has an answer from the chain.

So you can close the tab, lose your connection or come back tomorrow. The run opens where it stopped.

One tab works on a run at a time. If the same run is open in a second tab, that tab sends nothing while the first is busy, and before every payment a page checks that what it shows is still what is on record.

Payments are started a few seconds apart. Each one needs a proof, and this site limits how many proofs one visitor can ask for in a minute; pacing keeps a full run under that limit. A run of 25 takes about three minutes.

## When a run stops

A run stops as soon as a payment cannot be made, and says why. The usual reasons:

- **Not enough public SOL left for fees.** Add some and press Continue.
- **Your private balance is split into too many small notes.** Consolidate it on the Wallet page, then press Continue. See [Private balance](/docs/private-balance).
- **You declined to sign.** Press Continue when you are ready.
- **The network stopped answering.** Wait a minute and press Check again.

What is marked paid stays paid. Continue goes on with the lines still waiting.

## The receipt

The receipt is a CSV file, made in your browser. It has one row for every line of your list, in the same order, with the status, the transaction, the time in UTC and your note. A line whose outcome is not known says exactly that, so the file never reads as proof of a payment the chain has not confirmed.

Your notes are not on chain. They are in the receipt, and beside each payment in your own [statement](/docs/statements).

## What is kept, and where

The list, the progress of the run and the signatures are kept in this browser, under your wallet's address, until you clear the run. None of it is sent to this site. Clearing the run removes it; download the receipt first.

> [!WARNING] The pattern is public
> Each payment hides its token and its amount. It does not hide that your wallet paid these wallets, one after another, within a few minutes. To anyone looking at your address on the [Rings page](/rings), that reads as one wallet paying a list.

## A token you created

A wallet cannot use Pay many with a token it launched here. Buyers watch where a creator's tokens go, and a run of hidden amounts to many wallets would take that away from them. Sending the token to one wallet at a time, from the Wallet page, is unchanged.
