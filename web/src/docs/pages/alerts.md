Alerts have this browser tell you when something arrives in your wallet's private balance: a payment, or a shield into it.

They are off until you turn them on, at the foot of the Activity tab of your [Wallet](/wallet).

## How they work

While a tab of this site is open and the wallet is unlocked, the page reads the wallet's private history again about every minute and a half, and every four minutes when the tab is in the background. Anything that was not there before is announced at the corner of the screen:

- **Private payment received**, with the token and the amount.
- **Shielded into your wallet**, when a shield lands in it.

If the payment is exactly the token and amount of a [payment request](/docs/payment-requests) you made, the alert says which.

Your own actions are not announced. A trade you made, or a shield you sent from this browser, is yours already.

## What is and is not sent

Reading is done by your wallet's own keys, through the same relay every wallet read uses. Nothing is registered anywhere. There is no account, no address list on a server, and nobody is told that a wallet is being watched.

That is also why alerts only work while this site is open. There is nothing on a server that could reach you when it is closed.

## System notifications

You can also have a system notification when the tab is in the background. It says that something arrived, never what or how much, because a notification can show on a locked screen. The amount is on the page when you come back to it.

Your browser asks for permission the first time. If it is blocked there, the box unticks itself and says so.

## Good to know

- **One wallet, one browser.** Alerts are for the wallet in use, and the setting is kept in this browser. Turn them on wherever you want them.
- **Turning them on starts from now.** Nothing already in your history is announced.
- **After time away,** the first look announces what arrived meanwhile: up to three lines, then how many more.
- **It is a convenience, not a record.** Your Activity tab and your [statement](/docs/statements) are the record.
