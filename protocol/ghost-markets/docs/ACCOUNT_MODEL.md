# Program B account model and accounting contract

Status: on-chain source candidate, uncompiled. All state and trades in this release are public. This design is intentionally independent of Program A (Custom Ring).

## Accounts and authority

Market PDA seeds are `market`, creator pubkey, and a little-endian u64 nonce. Child addresses are derived from the market key with the public prefixes shown below. The creation instruction initializes each under the original SPL Token program or this Anchor program, as appropriate. Subsequent instructions check stored account keys, market PDA seeds/bump, token mints and token account authorities.

| Account | PDA prefix | Role |
| --- | --- | --- |
| Market | `market` | Phase, state version, immutable asset pair and configuration, reserves, public metadata and graduation records |
| Base mint | `base-mint` | Newly created six-decimal market token; all initial supply minted to vault, mint authority revoked |
| Quote mint | external | Existing classic SPL mint; no freeze authority accepted |
| LP mint | `lp-mint` | Six-decimal proportional shares, market PDA mint authority |
| Base vault | `base-vault` | Actual inventory and subsequent pool base reserve |
| Quote vault | `quote-vault` | Actual quote proceeds and pool quote reserve |
| Locked LP vault | `lp-lock` | Genesis LP shares and any voluntarily donated LP shares; no supplied withdrawal instruction |

No direct creator withdrawal, freeze, delegate, emergency sweep or fee extraction instruction exists. Any creator can buy/sell under the same public rules. Zero premint does not establish beneficial ownership or prevent coordination; no claims about creator anonymity or decentralization are warranted. Upgrade authority and external quote-mint economics remain trust assumptions.

The market stores **accounted** reserves. SPL vault amounts must be at least the accounted reserve before economic operations. Unsolicited token transfers to vaults are not incorporated into pricing, not credited as LP deposits, and not redeemable in this release. This avoids reserve donation price changes at the expense of potentially stranded surplus; a production policy for surplus recovery must be designed and reviewed. LP mint supply is read live from SPL because holders may independently burn LP tokens; the current LP lock balance, not just its original value, bounds redeemable shares.

## Lifecycle

`Curve (0)` → `Ready (1)` → `Pool (2)`. State versions begin at zero and increase on each successful economic operation. Every operation other than creation requires the current version and a deadline slot. Transactions failing validation or any token CPI do not commit state changes. External donations and LP burns do not change market version, so users also need explicit min/max bounds.

Creation: base mint has six decimals, no freeze authority, no initial creator allocation. The quote reserve starts at zero. `virtual_quote >= 1000`; `graduation_quote >= virtual_quote`; initial base supply >= 2000; fee <= 100 bps. A reachability sanity check rejects configurations whose ideal curve cannot meet the 1000-base-unit reserve floor at the target. This is not a proof of economic viability under discrete trade sizes or adversarial demand.

### Exact-input pricing

For input real reserve X and output real reserve Y, add virtual offsets only in the curve: the quote side has V, the base side has none. Pool offsets are zero.

```
f = ceil(gross_input * fee_bps / 10000)
net = gross_input - f
out = floor((Y + virtual_out) * net / (X + virtual_in + net))
next_X = X + gross_input
next_Y = Y - out
```

The fee stays in the input reserve. Math rejects overflow, zero input/output, fee dust, unmet minimum output and output at/above the real reserve. Curve base reserve cannot drop below 1000 base units. Quote may begin empty; no sell payout is possible until actual quote funds exist. The effective constant-product invariant is nondecreasing within each phase.

### Graduation

After a successful curve buy brings accounted quote `Q` to or above threshold, phase becomes Ready. Swaps pause in both directions; anyone can submit `graduate`. The transition uses the same vaults and creates a zero-offset pool. Let `B` be the unsold accounted base, and `V` the fixed virtual quote.

```
B_pool = floor(B * Q / (Q + V))
base_to_burn = B - B_pool
initial_lp = floor(sqrt(B_pool * Q))
```

Only surplus **unsold inventory** is burned (from the base vault). All actual quote stays in the pool. All genesis LP shares are minted into the lock vault. This eliminates the large marginal price step that would otherwise come from simply dropping the virtual offset. Integer floor rounding makes the new quote-per-base price equal to or slightly above the terminal theoretical curve price. It does not guarantee identical executable trade prices, no price volatility, or profitability. The issuance record and actual mint supply distinguish original issuance from remaining supply. Supply can also decrease if holders voluntarily burn tokens.

Genesis liquidity has no claimable creator position. Later providers receive LP tokens, not access to the locked shares. All existing program-controlled LP shares remain locked by the supplied instruction set, subject to the program upgrade risk. No platform revenue is allocated; this is a candidate economic design requiring operator and community review. If graduation is never reached, there is no refund/recovery mechanism beyond curve selling under real reserve constraints. Do not use with real funds.

### Liquidity accounting

With reserves B,Q and current total LP supply S, let max deposit amounts be b,q. `shares = min(floor(b*S/B), floor(q*S/Q))`. Actual deposits are `ceil(shares*B/S)` and `ceil(shares*Q/S)`; shares must be positive and meet the requested minimum. When withdrawing `l` shares, outputs are `floor(l*B/S)` and `floor(l*Q/S)` with both minimums enforced. `l` cannot exceed user balance or total supply minus live locked shares. Reserve and share arithmetic is checked, and all transfers/mint/burn/state changes settle atomically. Rounding favors the pool, so a same-state LP add/remove round trip cannot generate free assets.

## Scope restrictions

- Token-2022 extensions (including transfer fees, permanent delegate, transfer hooks) are not admitted. Original SPL accounts are typed and the token program address is fixed by Anchor's `Program<Token>`.
- Quote mint with non-null freeze authority is rejected to reduce freeze risk. Quote mint may still have a mint authority; an issuer that prints quote assets can compromise market economics. Production assets require a vetted listing policy; no such list is implemented here.
- Market names/symbols/URI are stored in the market account, not as a Metaplex Token Metadata account. Wallet display and external indexers require separate integration. URIs are untrusted.
- No admin pause, emergency exits, protocol fees, external pool migration, oracle, market maker subsidy, metadata verification, per-trader position report, confidential transfer or anonymity support.
- Localnet scripts are operational guardrails, not an on-chain cluster restriction. The source could be deployed elsewhere by a party with tooling; that would not be an approved or validated release.
