privacycash.fun is a token launchpad on Solana where what you hold is encrypted. Tokens launch on Meteora bonding curves. Balances and transfers run through Solana Privacy Rings, so what you keep there cannot be read off the chain, and a private transfer does not show which token moved or how much.

These docs say what each button does, what it costs, and exactly what someone reading the chain can and cannot see afterwards.

:::cards
/docs/quickstart | Quickstart | From nothing to a private balance in a few minutes.
/docs/private-transfers | Send tokens privately | Move a token to another wallet without showing which token or how much.
/docs/burning | Burn tokens | Destroy tokens for good, straight out of a private balance.
/docs/what-is-private | What is private | Every action on this site, and what the chain shows for it.
:::

## The one rule to remember

> [!GHOST] Confidential, not anonymous
> What you hold and what a private transfer carries are encrypted. Wallet addresses are not hidden: every transaction still shows which wallets took part.
>
> Anything that touches a public pool is public too. A trade against a Meteora pool shows its size, whatever happens before or after it.

## What you can do here

| You want to | Where | What the chain shows |
| --- | --- | --- |
| Hold SOL or a token unseen | [Wallet](/wallet) | ==Nothing about how much== |
| Send a token to another wallet | Token page, or Wallet | ++The two wallets++ and ==not the token or the amount== |
| Buy or sell from a private balance | Token page | ++Wallet, token and size++ on the Shielded route; ==token and size hidden== on a Ghost fill |
| Burn tokens | Token page, or Wallet | ++Wallet, token and amount++ |
| Launch a token | [Launch](/create) | ++Creator, name, artwork, first buy++ |
| Claim creator rewards | Token page, or Wallet | ++Wallet and amount++, then it is private |
| Move in or out of Rings | Wallet | ++Wallet, asset and amount++ |

## What it is built on

- **Solana Privacy Rings**, built by Helius, keeps balances as encrypted notes and moves them with zero-knowledge proofs. This site uses the Default Ring, the one that is live on mainnet.
- **Meteora** runs the bonding curve every token starts on and the pool it graduates to. Both are ordinary public programs.

This site is the interface between the two. It holds no funds and no keys: every transaction is built and signed in your browser. It is independent software, not affiliated with Helius, Meteora or the Solana Foundation.

## Where to go next

- New here: [Quickstart](/docs/quickstart), then [Key ideas](/docs/key-ideas).
- Holding a token already: [Send privately](/docs/private-transfers) and [Burn tokens](/docs/burning).
- Launching: [Launch a token](/docs/launching), [Fees](/docs/fees) and [Creator rewards](/docs/rewards).
- Deciding whether to trust any of it: [What is private](/docs/what-is-private), [Keys, proofs and the server](/docs/keys-and-proofs) and [Risks](/docs/risks).
