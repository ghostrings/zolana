## Is this anonymous?

No. It is confidential. Balances and the contents of private transfers are encrypted; wallet addresses are public on every transaction. [What is private](/docs/what-is-private) has the full table.

## Can anyone see how much of a token I hold?

Not what you hold in your private balance. What you hold in your public balance is as visible as in any Solana wallet.

## Can I send a token to someone privately?

Yes. Their wallet has to be registered with Rings, which takes them one press on the Wallet page. Then use **Send privately** on the token's page, or **Send** on your Wallet page. The chain shows that your two wallets dealt with each other, not which token or how much. See [Send privately](/docs/private-transfers).

## Can I burn tokens privately?

You can burn straight from your private balance, and what you still hold stays hidden. The burn itself is always public, because it lowers the supply that everyone reads. See [Burn tokens](/docs/burning).

## Does the person I send to need this site?

They need a wallet registered with Rings, and something that can read a Rings balance to see what arrived. This site's Wallet page does both, with the built-in wallet or a supported extension.

## Can I use a token from here on other apps?

Yes. Unshield it to your public balance and it is an ordinary Solana token. Its pool is an ordinary Meteora pool that other apps and aggregators can trade.

## Can a token be priced in something other than SOL?

Yes, when the operator has switched that pair on. A creator picks the pair token at launch and it never changes. Buying, selling, fees and rewards are then all in that token. See [Pair tokens](/docs/pairs).

## A token is priced in a token I do not hold. Can I pay with SOL?

Yes, where this site converts. Choose SOL or USDC under **Pay with** on the token's page: it is converted to the pair token on Jupiter inside the same transaction as the buy, and the same works for selling under **Receive**. See [Pay with SOL or USDC](/docs/converting), which also says whether it is switched on here. Where it is not, swap for the pair token in your own wallet first, then buy with **Public entry**, or deposit it and use the Shielded route.

## Can I buy a token that was not launched here?

Yes, where the operator has switched that on. Paste the token's address on the [Swap](/swap) page: it is bought through Jupiter and delivered into your private balance in one transaction, and sold the same way. The swap itself is public; what you hold before and after is not. See [Buy any token](/docs/buy-any-token), which also says whether it is switched on here and which tokens are refused.

## A curve is complete but still says MIGRATING. What now?

It is waiting for the instruction that moves it into its pool. Meteora's keeper sends it for the curves it covers. If it has not arrived, the token's page has a **Graduate it now** button that anyone can press. See [Curve and graduation](/docs/graduation).

## Why do I need public SOL if my balance is private?

Solana's network fees are paid from the public balance, and some transactions open an account for a moment and need its rent up front. Keep at least {{gas_reserve}} SOL public.

## What does it cost?

A token's trading fee, 2%, 3% or 4%, on each trade. Beyond that only what the network and the underlying protocols charge. This site takes no fee on deposits, withdrawals, private transfers, burns or launches. See [Fees](/docs/fees).

## Can the fee on a token change?

No. It is fixed in the token's Meteora config, which cannot be edited, and the same number is written into the pool the token graduates to.

## Can a creator pull the liquidity?

No. After graduation all of the pool's liquidity is locked permanently. The creator holds none of it, and the platform, which holds the locked position, cannot withdraw it either.

## Can more of a token be minted?

No. Tokens here launch with no mint authority. Each token's page reads that from chain and shows it.

## Why is there no holder count?

Because it would be wrong. Balances in Rings sit in one pooled account, and who owns what inside it is encrypted.

## What is the Ghost desk?

A wallet run by the platform that swaps private transfers with you so your trade never touches the pool. It hides the token and the size from the chain, and it learns your trade. See [The Ghost desk](/docs/ghost-desk).

## Can I have more than one wallet?

Yes, up to 24 in one browser under one passphrase. Make a new one or import one on the Wallet page, name them, and switch with one press. See [Several wallets](/docs/wallets).

## Can this wallet connect to other sites, like a wallet extension?

No. The ghost wallet is part of this site and signs only here. Every wallet in it is an ordinary Solana keypair, though: export its secret key and import it into any Solana wallet to use it elsewhere.

## Can I shield and unshield whenever I want?

Yes. Nothing is locked up and nobody approves it. Each crossing is one transaction you sign, it is public, and it needs a little public SOL for the fee. See [Shield and unshield](/docs/deposit-withdraw).

## I forgot my passphrase. Now what?

It cannot be reset. If you saved the secret key, remove the wallets from this browser and import the key with a new passphrase. That key also brings back the wallets made from it. An imported wallet needs its own secret key. If you saved none of them, the wallets cannot be recovered.

## Is my wallet stored on your server?

No. A ghost wallet is encrypted and kept in your browser. The server never receives a key or a passphrase.

## What if this site is down?

Your public funds are in a normal Solana wallet. Your private balance is on chain under your keys, and reaching it would need other software built on Solana Privacy Rings. Keep your secret key backed up.

## Which network is this?

Solana mainnet only. Every transaction is real and permanent.

## Who is behind this?

An independent project. It is not affiliated with Helius, Meteora, the Solana Foundation, or the Privacy Cash protocol at privacycash.org.
