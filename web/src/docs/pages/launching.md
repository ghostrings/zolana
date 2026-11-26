Launching a token takes three screens and one signature on [Launch](/create).

## What the launch transaction does

One transaction, all or nothing:

1. **Creates the mint and its bonding curve** on Meteora, with a fixed supply and the fee tier you chose.
2. **Opens the token to Rings**, so anyone can hold it in a private balance from the first block.
3. **Makes your first buy**, if you asked for one.
4. **Deposits those tokens into your private balance** and closes the temporary token account.

Before your wallet is asked to sign, the transaction is run against the chain. If it would fail, it is not sent.

## Step 1: identity

| Field | Rule |
| --- | --- |
| Artwork | PNG, JPG, GIF or WebP, up to {{image_limit}}. Square works best. Leave it empty for a generated pixel mark. |
| Name | Up to 32 bytes. |
| Ticker | 1 to 10 letters or digits. |
| Story | Optional, up to 500 characters. |
| Website, X link | Optional. |

Artwork is identified by its bytes, not by its file name, and SVG and HTML are refused.

## Step 2: launch settings

**Trading fee.** 2%, 3% or 4%. This is permanent: it is written into the token's Meteora config and into the pool the curve graduates to. Nobody can change it later, you and this platform included. [Fees](/docs/fees) explains who is paid from it.

**The pair token.** What the token is priced and traded in. SOL is always offered; the others appear once the operator has switched them on. Right now: {{pairs_live}}. It is permanent, like the fee. See [Pair tokens](/docs/pairs).

**Your first buy.** Optional. It is paid from your public balance of the pair token inside the launch transaction: public SOL for a SOL token, the tokens in your wallet's ordinary token account for any other pair. What you buy goes straight into your private balance. It is an ordinary curve trade, so its size is public. {{trade_cap_sentence}}

**Fee modules.** Optional, and shown when this site runs them. Instead of claiming your share of the trading fees by hand, you can have it bought back and burned, shared between up to four wallets, or both. This is permanent too, and the wallets and their shares are public. It is a second transaction, asked for as soon as your token is listed. Read [Fee modules](/docs/fee-modules) before you tick it.

## Step 3: review and sign

The review lists everything that is about to become permanent. You tick one box to say you understand it, then sign once.

## What it costs

About 0.06 SOL of account rent and network fees, plus your first buy if you make one. The rent and fees always come from your public SOL; the first buy comes from your public balance of the pair token. There is no launch fee to this site.

## What is fixed at launch

| | |
| --- | --- |
| Supply | 1,000,000,000, with 6 decimals |
| Mint authority | None. No more can ever be created. |
| Metadata | Name, ticker and artwork cannot be edited. |
| Trading fee | Your tier, on the curve and after graduation |
| Pair token | The one you picked |
| Starting market cap | {{start_cap}} SOL for a SOL token; another pair's is in its own token |
| Graduation market cap | {{grad_cap}} SOL for a SOL token; another pair's is in its own token |
| Liquidity after graduation | 100% locked permanently, held by the platform |

The token's metadata and artwork are {{metadata_home}}.

## What is public about a launch

:::observer A launch
Your wallet, as the creator | public
Name, ticker, artwork and story | public
The fee tier | public
The size of your first buy | public
What you hold afterwards | hidden
:::

Your wallet is recorded on chain as the token's creator for good. That record is also what entitles you to [creator rewards](/docs/rewards).

## After the launch

- The token appears on the [Market](/) straight away.
- Your first buy is in your private balance. You can hold it, [send it](/docs/private-transfers), sell it or [burn it](/docs/burning).
- Your share of every trading fee starts to accrue with the first trade.

> [!WARNING] A launch cannot be taken back
> There is no edit and no delete. Check the name, the ticker and the artwork on the review screen before you sign.
