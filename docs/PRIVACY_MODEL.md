# Privacy model

This document states what privacycash.fun hides, what it cannot hide, and why. The site's
Protocol page says the same thing in fewer words. If the two ever disagree, fix the site.

## 1. What Solana Privacy Rings gives us on mainnet

Helius's documentation describes two kinds of Ring:

- **Default Ring** — confidential and permissionless. Live on mainnet.
- **Custom Rings** — confidential or anonymous, with their own rules. Not available on mainnet
  for general use at the time of writing.

Visibility on the Default Ring, per Helius's "Visibility by operation" table:

| Operation | Sender | Recipient | Asset | Amount |
| --- | --- | --- | --- | --- |
| Deposit from a public balance | public | public | public | public |
| Private-to-private transfer | public | public | **private** | **private** |
| Withdrawal to a public balance | public | public | public | public |

So the Default Ring hides *what* and *how much*, never *who*. A balance held in the Ring is a
set of encrypted notes that only the owner's viewing key can read.

Anonymous Rings would also hide the wallets. When they reach mainnet, the transfer legs of a
Ghost fill and ordinary private transfers can move to one, and section 3 changes. Nothing in
this codebase claims anonymity today.

## 2. What a public pool forces

A Meteora bonding curve or DAMM v2 pool is a public account. Its reserves change with every
swap, and the swap instruction names the trader's token accounts. Therefore:

> Any transaction that swaps against the pool reveals the wallet, the token and the size.

Wrapping the swap in a withdrawal and a deposit does not change that. It changes what surrounds
the swap: the funds come out of an encrypted balance and go back into one, so the wallet's
holdings before and after are not readable. That is the **Shielded route**, and the interface
labels it "size public".

## 3. Ghost fill: a trade that does not touch the pool

To hide the size of a trade on today's mainnet, the trade must not touch the pool. Ghost fill
is a co-signed transaction containing exactly two Default Ring transfers:

```
trader  --(confidential transfer: pays)-->  desk
desk    --(confidential transfer: delivers)--> trader
```

On chain this is two encrypted transfers between two public wallets. The token and both
amounts are ciphertext.

**Why it is safe for the trader.** Before signing, the trader's browser:

1. rebuilds the desk's transfer instruction from structured data (it never accepts instruction
   bytes), and requires it to be a plain confidential transfer: one tree, no public legs, no
   attached messages;
2. decrypts the desk's output with its own key and verifies it against the on-chain
   commitment, so a ciphertext that says one thing and a commitment that says another counts
   as zero;
3. requires that decrypted amount to be at least the quoted amount of the quoted asset;
4. decompiles the transaction message and requires: version 1, fee paid by the desk, exactly
   two instructions equal to the two inspected transfers, no account given more privilege than
   those transfers need, and no signer other than the trader and the desk.

The desk does the mirror image before it signs, and it signs last. The two transfers are in
one transaction, so both settle or neither does. The desk never has custody.

`tests/ghost.test.ts` exercises all of this against the real SDK cryptography, including the
tampered cases.

**What Ghost fill does not hide.**

- *The desk knows your trade.* It is your counterparty. It sees the wallet, the asset, the
  amount and the price. This is the same trust you give any OTC desk or market maker, and it
  is the main cost of the design.
- *Your wallet traded with the desk.* The two wallets are public, and the desk's address is
  published. An observer learns that you traded at that moment, not what or how much.
- *The desk rebalances in public.* Tokens it takes from sellers are sold to the pool over the
  following passes, on a jittered timer, in slices of random size. Tokens it keeps stocked are
  rebought the same way. With many traders these public trades do not map to individual fills.
  With one trader in a quiet market, timing gives a good guess at direction and a rough guess
  at size.
- *Amounts and timing elsewhere.* A deposit of 3.2 SOL followed a minute later by a Ghost fill
  suggests a trade of up to 3.2 SOL. Depositing ahead of time, in round amounts, helps.

**What Ghost fill costs the operator.** The desk is a hot wallet that quotes the pool's price
without moving the pool. That is adverse selection by construction, so the desk:

- fills only orders whose price impact on the pool would be small (`DESK_MAX_IMPACT_BPS`);
- caps each order (`DESK_MAX_ORDER_LAMPORTS`) and its holding of any one token (twice
  `DESK_TARGET_INVENTORY_LAMPORTS`);
- never buys a token just because it was listed. It keeps inventory only in the mints the
  operator names in `DESK_STOCK_MINTS`. For every other token it can fill a buy only out of
  what sellers have just delivered, and otherwise answers "use the Shielded route".

The spread (`DESK_SPREAD_BPS`) is its only compensation. Expect the desk to lose money in a
market that moves against its inventory.

## 4. Everything else

| Flow | What is public | What is private |
| --- | --- | --- |
| Launch | creator wallet, name, artwork, pair token, fee tier, first-buy size | the creator's holding afterwards |
| Shielded buy / sell | wallet, token, pair token, size, any unused or surplus of the pair token | source and destination balances |
| Public entry buy | wallet, token, size, what was spent | the holding afterwards |
| Graduating a curve from its page | the wallet that paid for it, and the token | nothing: it is a public instruction anyone may send |
| Private send | both wallets | token and amount |
| Burn, from the private balance | wallet, token, amount burned, the new supply | what the wallet still holds in Rings |
| Burn, from the public balance | wallet, token, amount burned, the new supply, what is left in the token account | nothing |
| Reward claim | wallet, token, amount claimed | the balance it lands in |
| Creator payout after graduation (sent by the platform) | the platform's wallet, the creator's wallet, the token, the amount | nothing: it is an ordinary public transfer |
| Holders | wallets holding the token in ordinary public accounts; the total held in Rings | who owns what inside Rings |
| Send from the public balance (wallet page) | both wallets, the token, the amount | nothing: it is an ordinary transfer |
| Several wallets in one browser | each wallet is public on its own, like any wallet | that they share a browser and a first wallet: nothing on chain says so |
| prvmax: giving a vault SOL for fees | the wallet, the vault, the amount | nothing |
| prvmax: spread, and a private recall | the wallet and the vault | token and amount |
| prvmax: a vault's trade | the same as that trade from any wallet, with the vault as the wallet | the same |
| prvmax: a public recall, a vault's leftovers and its SOL | the vault, the destination, token and amount | nothing |

Two details of the Shielded route are worth knowing:

- A **buy** is an exact-output swap, so the deposit that follows can name its amount. The
  private balance releases the most the trade may cost; whatever the swap does not use stays
  in the wallet as public SOL.
- A **sell** deposits the guaranteed minimum into the private balance. If the pool pays more,
  the surplus stays as public SOL.

Both leave small public remainders. They can be deposited from the wallet page.

A token priced in a pair token other than SOL changes one thing here. The pair token crosses
between the private balance and the pool through the wallet's ordinary token account for it,
and the remainders stay there. So a wallet that has traded such a token shows a public token
account for the pair token, holding those remainders, where a SOL trade would only have
changed its SOL balance. What it holds in Rings is as hidden as before.

A **burn** cannot be made private, and the site does not suggest it can. It only means
anything because the supply everyone reads goes down, so the wallet, the token and the amount
are public whichever balance the tokens come from. Burning out of the private balance in one
transaction keeps the rest of that balance unreadable; it does not hide the burn. Sending
tokens to an address nobody controls inside Rings would be invisible, and for that reason
would not be a burn: the supply would not move and nobody could check it.

**Vaults (prvmax) add no privacy the Default Ring does not have.** A vault is a second
wallet whose key is derived from the first. Because network fees must be paid from public
SOL, the first wallet funds each vault in public, and that transfer links them for anyone who
looks. So ten vaults are ten wallets known to belong to one owner, each with a hidden
balance. What prvmax hides is how a balance is divided between them, and that is all the
page and the docs claim for it. A wallet cannot use vaults with a token it launched, nor
with one launched by another wallet kept in the same browser: the page refuses, because a
creator's trades spread over ten addresses would read as other people's. That refusal is the site's rule, made in the browser; the chain does not enforce
it, and the docs say so by calling it a rule of the site.

**Several wallets add separation, not anonymity.** A wallet made in the app is derived from
the first wallet's seed in the browser. Its address has nothing in common with the first
wallet's, and nothing on chain records the relation. What links two of a person's wallets is
what the person does with them: a public send from one to the other shows both, the token and
the amount; a private transfer between them hides token and amount and still shows the two
wallets; funding both from one source, or using them minutes apart, tells the same story to
anyone who looks. Off chain, the wallet page asks this site's relay for the public SOL of
every wallet on the list in one request, and "Look for my wallets" asks about the next
derived addresses in line, so this server and Helius can see one browser asking about those
addresses together. The docs say all of this on the page about several wallets, and the
wallet page labels a public send as public on every line of its observer box.

The words on the wallet page are **shield** and **unshield**. They are a deposit into Rings
and a withdrawal from it, both public, and the docs define them that way where they first
appear. Neither word claims more than the deposit and the withdrawal do.

## 5. Who learns what

| Party | Learns |
| --- | --- |
| Anyone reading the chain | wallets, every deposit, withdrawal, pool trade, burn and claim with amounts; that a private transfer happened |
| This site's server | IP addresses and the public requests it relays; which tokens a browser looks at; which wallet addresses a browser asks about together; everything the desk learns, when the desk is on |
| The Ghost desk | every Ghost fill it takes part in, in full |
| Helius | RPC traffic from this server's key; Rings indexer queries |
| Jupiter, when converting is on | for each conversion quoted or traded: the wallet address, the two tokens and the amount, sent by this server (so this server's address, not the visitor's) |
| The Rings prover enclave | the private inputs of each proof it builds |

The browser encrypts every prover request to the enclave's key after verifying the enclave's
attestation against a policy signed by keys pinned in the SDK. This server relays those bytes
and cannot read them. It follows that confidentiality depends on that enclave as well as on
the on-chain cryptography. That is a property of Solana Privacy Rings, not of this site.

The server never receives a seed, a passphrase or a viewing key.

A page takes its scripts, its styles and its fonts from this site and sends its requests to
this site, and the content security policy the server sets holds it to that. No other host
is told of a visit by a script or a font. A token's artwork is the one thing a browser may
fetch from elsewhere, when a listing points at a picture this server holds no copy of.

The wallet panel in the header is the wallet page's reading half, shown on every page. It
asks this site's relay the same questions the wallet page asks, about the wallet that is
open, when it is opened. It builds no transaction.

### The Rings page

`/rings` collects what the first row of the table above already says anyone can read, for all
of Rings: shields and unshields with their wallets, tokens and amounts; pool trades made out
of a private balance; and for a private transfer, the wallet that paid and the wallet that was
paid. It adds nothing to what is public. It makes it easy to look at, which is the point: a
user should be able to see what the Default Ring leaves visible about them.

It is built from three public sources: a transaction's signers and programs, the change in
balance of the Rings vaults, and the owner tags of a transaction's outputs, which on the
Default Ring are the owning wallets' addresses. No viewing key is involved, so a private
balance, and the token and amount of a private transfer, cannot be in it. It does not try to
work them out either: it publishes no guess at an amount, no guess at who is behind several
wallets, and no count of private holders. Where the chain does not show who paid (a relayed
transfer whose owner signed inside the proof), it says "between" and names no payer.

Looking an address up sends that address to this site's server, as with any explorer. The
wallet page links to the visitor's own address there; following the link tells the server
which address the visitor asked about, which the relay already learns when that wallet reads
its balances.

### The wallet extras

None of these changes what is public on chain. What each one tells, and to whom:

| | Leaves the browser | Stays in the browser |
| --- | --- | --- |
| Ask for a payment | The link, to whoever it is sent to and any service it passes through. Nothing to this site's server: the request is after the `#`. | The list of requests made. |
| Paying a request | An ordinary private transfer. The note is not on chain. | The note, beside the transaction. |
| Statement | Through the relay: which slots' times and which transactions' named wallets were asked for. Both are public facts about transactions the relay already sees the wallet ask about when it syncs. | The statement itself, and the file. |
| Alerts | The same reads as opening the wallet, repeated while a tab is open. The relay can tell that the wallet is being read, and when. | Whether alerts are on, and what was announced. |
| Check-up | The wallet's address, to this site's explorer routes, as when its public page is opened. | What was found. |
| Viewing pass | Nothing, until the owner hands it to somebody. | Nothing: this site keeps no copy. |

**A viewing pass is the strongest of them, and the only one that cannot be undone.** It holds
the wallet's Rings derivation signature, from which the viewing key and the nullifier key are
rebuilt. Its holder reads every private balance and transfer of that wallet, past and future,
with tokens and amounts. It holds no key that signs: a spend needs the wallet's signature over
the transaction ("required to spend but does not authorize a spend", as the protocol's
specification says of the nullifier key). One thing the protocol lets any holder of the
nullifier key do for a wallet with consolidation switched on, which wallets registered here
have: merge that wallet's notes into one. No balance and no owner changes. The `/view` page
attaches no prover and cannot do it; somebody with the pass and other software could. A
wallet's keys never change, so a pass ends only when the wallet stops being used.

**The check-up reads only the wallet's own rows.** It flags a private transfer close to a
public amount of the same wallet. It does not read the other wallet's rows to see what that
one did next, although that is public too: a tool that follows payments from wallet to wallet
is a different thing from telling somebody what their own activity shows.

**Alerts are a read, not a subscription.** Nothing about a wallet is stored on the server to
make them work, which is also why they stop when the site is closed.

### Buying a token that was not launched here

The swap page changes nothing about what Rings hides. A buy there is three public facts in
one transaction: a withdrawal (wallet, SOL or USDC, amount), a swap on public pools (wallet,
both tokens, both amounts), and a deposit (wallet, token, amount). What it gives is what the
Shielded route gives for tokens launched here: the balance the money came out of and the
balance the token goes into are private. It does not hide that the wallet bought the token,
or how much. What is done with the token afterwards is as visible as section 1 says: a
private transfer shows the two wallets and neither token nor amount, and a withdrawal or a
sale shows everything.

| | Learns |
| --- | --- |
| Anyone reading the chain | The wallet, both tokens, what was paid and what was received. The deposit that follows, and the second one for what was left over. After that, what section 1 says of each later action. |
| Jupiter | The wallet's address, the two tokens and the amount of every quote asked for, whether or not a trade follows. This site's server asks, so not the visitor's network address. |
| This site's server | The same, as it relays the request, and which token addresses a browser looked up, as RPC reads. |

A quote is built for the wallet's own address, so asking for one already tells Jupiter that
this wallet is looking at this token. That is why the page shows no quote until a wallet is
unlocked, instead of quoting for a made-up address first: there is no quote that is not the
real one.

Two further things are public and easy to overlook. **What is left over** sits in the
wallet's public token account between the buy and the second transaction, and stays there
when the box is unticked. And **the first private holder** of a token signs the transaction
that creates the token's vault in Rings, which is a public, permanent record that this
wallet was the first to deposit it.

## 6. Words this project uses, and avoids

Use: *encrypted balance*, *confidential transfer*, *private balance*, *hidden amount*,
*Ghost fill*, *Shielded route*.

Avoid: *anonymous*, *untraceable*, *mixer*, *invisible*, and any claim that a pool trade is
private. They are false today, and "the first real privacy swaps" is only defensible for Ghost
fill, with the caveats in section 3 attached.
