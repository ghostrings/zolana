One trading fee, chosen at launch and fixed for the life of the token. Nothing else is charged by this site.

## The three tiers

| Tier | Fee on every trade | Config |
| --- | --- | --- |
| 2% | 2% on the curve, 2% after graduation | {{config_200}} |
| 3% | 3% on the curve, 3% after graduation | {{config_300}} |
| 4% | 4% on the curve, 4% after graduation | {{config_400}} |

The fee is taken in the token's [pair token](/docs/pairs) from each trade: in SOL for a token priced in SOL. On a 1 SOL trade of a 3% token it is 0.03 SOL.

## Where a fee goes on the curve

| Share of each fee | Goes to | How |
| --- | --- | --- |
| {{creator_pct}}% | The token's creator | Accrues on chain. Only the creator can claim it. |
| {{platform_pct}}% | The platform | Accrues on chain. |
| {{protocol_pct}}% | Meteora's protocol | Set by Meteora's program, not by this platform. |

These are the shares of a token launched today. The split is written into a token's config when it is launched and cannot change afterwards, so a token launched under earlier settings keeps the split it started with. Each token's page states its own under **Token facts**.

A creator who would rather not claim by hand can have that share bought back and burned, or shared between wallets, automatically. See [Fee modules](/docs/fee-modules).

## Where a fee goes after graduation

The pool charges the same tier. Meteora's protocol takes its share, which is set by Meteora and stored on the pool. The rest accrues to the pool's one liquidity position. That position is locked permanently and held by the platform.

From what it collects, {{payout_sentence}}.

> [!NOTE] Two different kinds of promise
> On the curve, the creator's share is the creator's on chain: it accrues to the creator's wallet and only that wallet can claim it. After graduation, the creator's share is a payment the platform makes when it claims the pool's fees. No contract enforces that payment. See [Creator rewards](/docs/rewards).

## How the fee is held in place

| Rule | What enforces it |
| --- | --- |
| The fee never decays on the curve | The config's fee schedule has zero periods: the starting fee and the ending fee are the same number. |
| The fee is the same after graduation | The config sets the graduated pool's fee to the same basis points, so migration creates the pool with it. |
| No dynamic or volatility fee | Dynamic fees are disabled in the config for both phases. |
| Nobody can change it | A config cannot be edited once created, and the graduated pool's liquidity is locked permanently, so it cannot be moved to a cheaper pool. |
| This site refuses anything else | Before every quote the app reads the pool and its config from chain and rejects a token whose fee terms differ from its tier. |

## Other costs

- **Solana's network fee**, with a priority fee that follows the network's going rate. It is paid from your public SOL.
- **Temporary account rent.** Some transactions open a token account for a moment. It is closed in the same transaction and the rent comes straight back.
- **Solana Privacy Rings' own protocol fee**, when it charges one on a private transaction.
- **The desk's spread**, on a Ghost fill only. It is shown in the quote before you sign.
- **At graduation**, Meteora's program takes its own fee from the liquidity that moves into the pool. It is set by Meteora.

## What this site does not charge for

Opening a wallet, deposits, withdrawals, private transfers, consolidating, burning, claiming rewards and launching a token. Each costs only what the network and the protocols underneath charge.
