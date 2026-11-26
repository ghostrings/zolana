A payment request is a link. Whoever opens it lands on their own Wallet page with Send already filled in: your address, the token, the amount and your note. They check it, press the button, and you are paid privately.

It saves the payer from copying an address and typing an amount, which is where payments go wrong.

## Making one

:::steps
Open your Wallet and press Receive | The panel shows your address as a QR code, and under it, Ask for a payment.
Choose the token | SOL, or any token this wallet holds or has launched.
Enter an amount, or leave it empty | Empty lets the payer choose.
Add a note if you want | Up to 140 characters: an invoice number, what it is for.
Press Make the link | You get the link as text and as a QR code. Send it however you like.
:::

Your wallet has to be registered with Rings before anyone can pay it privately. If it is not, the form says so and the Register button is on the card above it.

## What the link holds

Everything sits after the `#` of the link:

`https://privacycash.fun/wallet#pay?to=YOUR_ADDRESS&amount=1.5&note=Invoice%2012`

A browser never sends that part of an address to a server. So the request reaches the payer's page and nobody else: not this site's server, and nobody watching the connection. Whoever you send the link to can read it, of course, and so can any chat or mail service it passes through.

## What the payer sees

A card at the top of Send with the amount, your full address, the token and your note. The form below is filled in to match. Three things are worth knowing:

- **Nothing is sent by opening a link.** The payer reads the card and presses Send privately themselves.
- **The form only fills in what it can stand behind.** If the payer holds none of that token privately, the amount is left empty and the card says what is missing. An amount meant for one token is never left standing next to another.
- **The card says when the form no longer matches the request.** Change the token, the amount or the recipient and it tells you.

> [!WARNING] Anyone can make a link
> A link proves nothing about who made it. Before you pay one, check the address on the card with the person who asked you, by another route. If the address is one of your contacts, the card shows the contact's name.

## The note does not travel on chain

The Rings software this site is built on has no field for a note on a private transfer. So the note lives in the link, and once the payment is sent, in the payer's own browser beside the transaction. It shows in the payer's Activity and in their [statement](/docs/statements).

You, the one being paid, are not sent the note back with the payment. What arrives is a private transfer of a token and an amount, from a wallet.

## Which request was paid

The requests you made are listed under the form, in this browser only. When a private transfer of exactly the token and amount of a request arrives after you made it, the list points it out, with the transaction.

That is a likeness and no more. The chain does not say what a payment was for. If you need to tell payers apart, ask each for a slightly different amount.

## What is public

:::observer Paying a request
The payer's wallet and yours | public
That one paid the other | public
Which token | hidden
How much | hidden
The note | hidden | NOT ON CHAIN
:::

It is an ordinary [private transfer](/docs/private-transfers). The payer can also choose their public balance under Send from, and then everything about the payment is public.
