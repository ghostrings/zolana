Everything on this site happens in the **Default Ring** of Solana Privacy Rings: the open pool that anyone can use, where a private transfer hides its token and its amount and shows the two wallets.

A **custom ring** is a different thing. It is a separate program, run by a business, that sets its own rules for the private balances held inside it. The [Rings page](/rings) lists every custom ring registered on Solana mainnet under **Custom rings**. This page says what that list means.

> [!NOTE] This site runs no custom ring
> privacycash.fun does not operate a custom ring and does not put your funds in one. The list is read from the chain's public accounts, the same way an explorer would read it.

## What a custom ring is

According to Helius, who build Rings, a custom ring is meant for businesses that need compliance controls. Its program checks its own rules before anything inside the ring moves. Those rules can include:

- a list of wallets that may take part, or a list that may not;
- freezing one participant;
- a second signature for chosen operations;
- pausing the whole ring;
- an **auditor**: a key that can read what happens inside the ring, without being able to move anything;
- a **delegate**: a key that can move balances inside the ring without their owners signing.

So a custom ring is not a more private version of the Default Ring. It is a supervised one: what it hides from the public, it shows to its auditor, and its operator has switches the Default Ring does not have.

## What the list shows

Each ring is one card, read from the account the ring registered with the Solana Privacy Program.

| On the card | What it means |
| --- | --- |
| Active | Activated and not paused. Transfers inside the ring can go through. |
| Not activated | Registered, and waiting for Rings governance. Nothing can move in it. |
| Paused | Stopped by its own operator. Nothing moves until it is resumed. |
| Moves notes without their owners | Whether the ring's program may move a balance inside the ring without its owner signing. Set by Rings governance. |
| Who can change this entry | The address that may pause the ring or hand its registration on. "Given up" means nobody can. |
| Transactions read here | How many of the ring's transactions this site has read. Not what they moved. |

Above the cards the page says how a new ring starts out on mainnet: active from the moment it registers, or only once Rings governance activates it.

An account is listed only when it checks out: it has to sit at the one address the ring's own program can sign for. An account that merely looks like a registration is left out.

## What it does not show

- **Who uses a ring.** This site does not read who was paid inside a custom ring, and does not show it.
- **What anyone holds in one.** That is encrypted, as everywhere in Rings.
- **Who the auditor is, or what the ring's rules are.** Those live in the ring's own program, not in its registration. Ask the business that runs it.
- **Whether a ring is safe to use.** A ring being listed says that it exists, nothing more. Its operator's keys can do what the card says they can.

## In the live feed

A transaction that ran through a custom ring shows on the [Rings page](/rings) as "moved funds inside a custom ring", with the wallet that signed. This site does not read the rest of it.

## What you can do with one from here

Nothing yet. Paying into a custom ring, or holding a balance in one, is not something this site does today. Your private balance here is in the Default Ring, where no auditor has a key and nobody can pause or move it.
