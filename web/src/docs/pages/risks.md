Read these before using the site with more than you can afford to lose.

## Tokens here are experimental

Anyone can launch one. Most will go to zero. A fixed fee and locked liquidity say nothing about whether a token is worth anything. Nothing on this site is advice.

## A pair token is someone else's promise

A token priced in SOL depends on SOL. A token priced in another pair token also depends on that asset: on the bridge or issuer behind a wrapped or bridged token, on an issuer who can freeze accounts that hold it, on a supply that can grow. If the pair token fails, so does every price quoted in it. This site reads what a pair token's mint allows and says so, and cannot change it. See [Pair tokens](/docs/pairs).

## A token from elsewhere is nobody's promise

The [Swap](/swap) page buys any token Jupiter can route, and nobody has looked at those tokens for you. A name proves nothing: anybody can create a token called anything. A token's creator may be able to create more of it or freeze the accounts that hold it, the Rings vault included. Whoever put up the pools it trades in can take them away, after which there is nobody to sell to. The page reads what the token's mint allows and says so; it cannot see the rest, and it cannot tell you whether a price is fair. The price and the route are Jupiter's. See [Buy any token](/docs/buy-any-token).

## Privacy is partial

Wallets are public. Pool trades, deposits, withdrawals, burns and claims are public. Amount and timing can link a deposit to what follows it. Read [What is private](/docs/what-is-private) and take it literally.

## The software is new

Solana Privacy Rings is new, its developer kit is a pre-release, and this site's own code has not been audited. Bugs in any of the three could cost money or reveal information.

## Programs this site does not control

Meteora's, Jupiter's and Solana Privacy Rings' programs are run, and can be upgraded, by their own teams. The guarantees in these docs describe what a creator and this platform can and cannot do. They cannot promise what an upgrade to someone else's program might change.

## The prover is trusted with private inputs

Proofs are built inside an attested enclave run by Helius. The contents of a private transaction are protected by that enclave as well as by the cryptography on chain.

## Pool trades can be sandwiched

A Shielded or public trade is an ordinary swap that others can see coming. Bots can trade around it and cost you up to your slippage limit. A Ghost fill does not touch the pool and cannot be sandwiched.

## The desk is a counterparty

It cannot take your funds, but it learns the trades it fills, it can run out of inventory, and it can be switched off. The Shielded route does not depend on it.

## Creator earnings after graduation depend on the platform

On the curve a creator's share is theirs on chain. After graduation the platform holds all of the locked liquidity, and the creator's share of pool fees is a payment the platform makes. No contract enforces it.

## Fee modules are run by the platform's server

A token's [fee modules](/docs/fee-modules) are carried out by a wallet this platform's server holds the key to, not by a contract. If that key were stolen, creator fees not yet paid out and the contents of buyback pots could be taken. If the platform stopped running, they would stop being paid out. Switching modules on is permanent: the creator cannot take the fees back into their own hands.

## Burns and transfers are final

A burn cannot be undone by anyone. A private transfer can only be returned by the person who received it. Check amounts and addresses before you sign.

## A ghost wallet lives in one browser

Clearing site data deletes it. Losing the passphrase locks it for good. The exported secret key is the only backup, and anyone who gets hold of it controls the funds.

With several wallets, the first wallet's secret key covers the first wallet and the ones made from it. An imported wallet is covered only by its own secret key. Names, icons and contacts are kept in the browser alone and are not backed up by any key. See [Several wallets](/docs/wallets#backing-up).

## A send goes where the address says

A send to a wrong address cannot be called back, in public or in private. The page refuses addresses that are plainly not wallets, and shows a name for the ones it knows. It cannot tell whether an address that is a wallet is the right one.

## The operator can pause this site

Launches and trading through this site can be paused or capped. The Wallet page cannot, so funds can always be unshielded. See [Limits and pauses](/docs/limits).

## An independent project

Not affiliated with or endorsed by Helius, Meteora, the Solana Foundation, or the Privacy Cash protocol at privacycash.org.
