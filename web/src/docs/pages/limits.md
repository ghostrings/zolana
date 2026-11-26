The operator of this site can slow it down or pause parts of it. None of these controls can hold your funds.

## Right now

- {{trade_cap_sentence}}
- {{pause_sentence}}

A banner at the top of the Market, a token's page and the Wallet page says so whenever a limit or a pause is in force.

## What can be limited

| Control | What it does |
| --- | --- |
| Per-trade limit | Caps the size of a single trade or first buy made through this site. It is set in SOL. For a token priced in another [pair token](/docs/pairs) it applies at the fixed rate the site uses to compare pairs, so it is approximate there. On the [Swap](/swap) page it applies to the SOL or USDC side of a trade. |
| Pause launches | New tokens cannot be created through this site. Existing tokens trade as usual. |
| Pause trading | Buys and sells through this site stop, on the Swap page too. |
| Buying tokens not launched here | The operator can switch the Swap page off altogether. Tokens launched here are not affected. See [Buy any token](/docs/buy-any-token). |

## What is never limited

The Wallet page, and everything that only moves your own funds:

- deposits and withdrawals;
- private transfers;
- burning;
- consolidating;
- exporting your key.

A pause therefore cannot trap a balance. You can always withdraw to your public balance and take the tokens anywhere.

## These are limits on this site, not on the chain

The pools are public Meteora accounts. A pause here does not close them: anyone can still trade them directly on Meteora or through an aggregator, with tokens held the ordinary, public way.

## Request limits

To keep the site usable for everyone, the server limits how fast a single visitor can make certain requests, uploads and proofs among them. If you run into one, the message says to wait a minute.

Private transactions need a proof, and each proof is billed to this site's key. The site has a daily budget for them. If it is ever used up, private transactions through this site wait until it resets. Actions that need no proof are not affected: deposits, Public entry buys and burns from the public balance.

## The status pill

The light beside the wallet button in the header is lit while everything is up, and a hollow ring otherwise. On a wide screen it also reads:

| It says | It means |
| --- | --- |
| Mainnet | Everything is up. |
| Mainnet / setup | The site is reachable, but new launches are not open yet. Existing tokens trade. |
| Not configured | The server has no connection to Solana, so nothing on chain can be reached. |
| Offline | The page could not reach this site's server. |
