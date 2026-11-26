A short glossary. Every other page leans on these words.

## Public balance and private balance

A wallet on this site has two balances.

The **public balance** is what any Solana wallet has: SOL and tokens that anyone can look up on an explorer. Network fees are paid from it.

The **private balance** lives inside Solana Privacy Rings. On chain it is a set of encrypted notes mixed into one pooled account with everybody else's. Only your wallet can tell which notes are yours and what they hold.

## Note

One piece of a private balance: an amount of one asset, encrypted to its owner. Every deposit, every incoming transfer and the change from every spend creates a note. A balance of 1,000 tokens can be one note of 1,000 or ten notes of 100.

A single transaction can only spend a limited number of notes. When a balance is spread over many, the Wallet page offers **Consolidate**, which merges them into one. See [Private balance](/docs/private-balance).

## Viewing key

The key that decrypts your notes. It is derived from your wallet and stays in your browser. Reading a private balance means downloading encrypted notes from the chain and trying this key on them, which is why a balance takes a moment to appear and why nobody else can produce it.

## Registration

A one-time, public step that publishes a wallet's encryption key in the Rings registry. A registered wallet can be sent private transfers by its ordinary Solana address. An unregistered wallet can still deposit, withdraw and trade; it just cannot receive from others yet.

## The boundary

Crossing between public and private is always visible. A **deposit** (public to private) and a **withdrawal** (private to public) both show the wallet, the asset and the amount. What is hidden is everything that happens between two crossings.

The Wallet page calls a deposit **Shield** and a withdrawal **Unshield**. They are the same two things.

## Wallet in use

One browser can keep several ghost wallets under one passphrase. The one in use is the one every page signs with, and it is shown in the bar at the top. See [Several wallets](/docs/wallets).

## Bonding curve

The Meteora pool a token starts on. It sells tokens at a price that rises as its pair token comes in, and buys them back along the same curve. There is no order book and no counterparty to find.

## Graduation

When a curve has taken in its target amount of its pair token it is complete. Its liquidity moves into a standard Meteora pool, where it is locked permanently, and trading continues there with the same fee. See [Curve and graduation](/docs/graduation).

## Fee tier

The trading fee a creator picks at launch: 2%, 3% or 4%. It is fixed for the life of the token, before and after graduation. See [Fees](/docs/fees).

## Route

How a trade travels between a private balance and the pool.

- **Shielded route**: private balance, to the pool, back to the private balance, in one transaction. The pool trade in the middle is public.
- **Ghost fill**: a swap of two private transfers with the platform's desk. It never touches the pool, so the token and the size stay encrypted.
- **Public entry**: a buy paid from the public balance whose tokens land in the private balance.

## Private transfer

Moving a token or SOL from one private balance to another. The chain shows the two wallets and nothing about what moved. See [Send privately](/docs/private-transfers).

## Burn

Destroying tokens for good. The token's supply drops by the amount burned, in public. See [Burn tokens](/docs/burning).

## Supply

How many of a token exist. Every token here starts with 1,000,000,000 and no way to make more, so the supply can only stay the same or fall.
