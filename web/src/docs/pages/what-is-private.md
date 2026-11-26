This is the page to read before trusting the word "private" anywhere on this site.

## Confidential, not anonymous

This site uses the **Default Ring** of Solana Privacy Rings, the one that is live on mainnet. It hides how much a wallet holds and what a private transfer carries. It does not hide who sent or who received.

Rings that also hide the wallets are not available on mainnet for general use. When they are, this page changes.

## Every action, and what the chain shows

| Action | Wallets | Token | Amount |
| --- | --- | --- | --- |
| Hold a private balance | — | ==Hidden== | ==Hidden== |
| Private transfer | ++Public++ | ==Hidden== | ==Hidden== |
| Ghost fill (trade with the desk) | ++Public++ | ==Hidden== | ==Hidden== |
| Consolidate notes | ++Public++ | ==Hidden== | ==Hidden== |
| prvmax: spread to a vault, recall privately | ++Public++ | ==Hidden== | ==Hidden== |
| Shield (deposit into Rings) | ++Public++ | ++Public++ | ++Public++ |
| Unshield (withdraw from Rings) | ++Public++ | ++Public++ | ++Public++ |
| Send from the public balance | ++Public++ | ++Public++ | ++Public++ |
| Shielded route (trade the pool) | ++Public++ | ++Public++ | ++Public++ |
| Public entry (buy) | ++Public++ | ++Public++ | ++Public++ |
| Swap page: buying or selling a token not launched here | ++Public++ | ++Public++ | ++Public++ |
| Burn | ++Public++ | ++Public++ | ++Public++ |
| Launch a token, first buy | ++Public++ | ++Public++ | ++Public++ |
| Claim rewards | ++Public++ | ++Public++ | ++Public++ |
| Fee modules: switching on, every payout and buyback | ++Public++ | ++Public++ | ++Public++ |
| prvmax: giving a vault SOL for fees, a public recall | ++Public++ | ++Public++ | ++Public++ |
| Register with Rings | ++Public++ | — | — |

For the rows that are public all the way across, what stays hidden is everything around the action: the balance the funds came from, the balance they went to, and what the wallet still holds.

## Two things no design changes

**A pool is public.** A Meteora curve or pool is a public account whose reserves change with every swap. Any transaction that trades against it shows the wallet, the token and the size. Wrapping the trade in a withdrawal and a deposit hides the balances on either side of it, not the trade.

**A token here is an ordinary token.** Anyone can also buy and hold it the plain, public way, from any wallet or aggregator, and those balances are as visible as any other. What is hidden is what is held in Rings.

## What gives things away anyway

- **Timing.** A deposit and, a minute later, a private transfer from the same wallet are easy to connect.
- **Amounts.** A public deposit of 3.2 SOL followed by a Ghost fill suggests a trade of up to 3.2 SOL.
- **Being the only one.** In a quiet market, a public trade by the desk shortly after your Ghost fill hints at which way you traded.
- **Your counterparty.** The person you send to knows what you sent. The desk knows the trades it fills.
- **Your own wallets.** Nothing on chain says two wallets were made in the same browser. Sending from one to the other does: in public it shows everything, and privately it still shows that the two dealt with each other. See [Several wallets](/docs/wallets).

Depositing ahead of time and in round amounts helps with the first two. Nothing here makes a wallet unlinkable.

## Who learns what

| Party | Learns |
| --- | --- |
| Anyone reading the chain | Wallets; every deposit, withdrawal, pool trade, burn and claim with amounts; that a private transfer happened |
| This site's server | IP addresses and the requests it relays; which tokens a browser looks at; everything the desk learns, when the desk is on |
| The Ghost desk | Every Ghost fill it takes part in, in full |
| Helius | RPC traffic from this site's key; Rings indexer queries |
| The Rings prover enclave | The private inputs of each proof it builds |

The server never receives a secret key, a passphrase or a viewing key. See [Keys, proofs and the server](/docs/keys-and-proofs).

## Holders

Nobody can list a token's holders. The chain shows the wallets that hold it in ordinary token accounts, and one pooled Rings account with a total. Who owns what inside that pool is encrypted, which is why this site shows no holder counts.
