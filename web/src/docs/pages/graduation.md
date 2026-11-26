Every token starts on a bonding curve and, if enough of its [pair token](/docs/pairs) comes in, graduates to a standard pool. The rules for both are set when the token is created and are the same for every token here.

## The curve

A bonding curve is a pool that quotes a price from how much it has already sold. Buying moves the price up along the curve; selling moves it back down. Anyone can trade against it at any time, with no order book.

| | |
| --- | --- |
| Supply | 1,000,000,000 tokens |
| Market cap at the first trade | {{start_cap}} SOL, for a token priced in SOL |
| Market cap at graduation | {{grad_cap}} SOL, for a token priced in SOL |
| Fee | The token's tier: 2%, 3% or 4% |

Market cap here means price times supply. A token priced in another pair token has its own two numbers, in that token: they are listed under [Pair tokens](/docs/pairs). Each token's page shows how much of its pair token the curve holds and how much it needs, as `GRADUATION x / y`.

## Completing the curve

A curve stops selling at its graduation price. The trade that takes the last tokens it sells completes it. If you enter more than a curve has room for, the app plans exactly that last buy and tells you. See [Trading](/docs/trading).

## Graduation

Once complete, the curve's liquidity moves into a Meteora DAMM v2 pool. Graduation is a permissionless instruction: anyone can send it once a curve is complete. Meteora runs a keeper that does so for the curves it covers, which include SOL curves of the size used here. For other pair tokens its cover depends on the token: see [Pair tokens](/docs/pairs).

Between completion and graduation the token shows **MIGRATING**, and trading through this site pauses. It resumes on the new pool.

### If a completed curve is still waiting

A token's page shows a **Graduate it now** button for as long as its curve is complete and has not moved. Anyone can press it, with any wallet.

- It sends the same instruction the keeper would. The liquidity goes where the token's config says: into the platform's position, locked.
- The sender pays the rent of the new pool's accounts and the network fee, about 0.06 SOL, and receives nothing for it.
- The page runs the transaction against the chain before asking for a signature. If the curve has just been moved by someone else, nothing is sent.

## After graduation

- **The fee is the same.** The pool is created with the token's tier, and dynamic fees are off.
- **All of the liquidity is locked, permanently.** It sits in a single position held by the platform. Nobody can withdraw it, the platform included.
- **That position collects the pool's fees.** Of what it collects, {{payout_sentence}}. See [Creator rewards](/docs/rewards).
- **Trading works as before.** The same routes, the same panel, now against the pool.

## What graduation does not change

Your balance, private or public, is untouched: the token is the same token. Its supply does not change at graduation. Burns before and after count the same way.

## Why the fee cannot drift

A tier is a Meteora config account that cannot be edited once created. Before every quote the app reads the pool and its config from chain and refuses a token whose fee terms differ from its tier. After graduation it checks the pool's own fee settings the same way.
