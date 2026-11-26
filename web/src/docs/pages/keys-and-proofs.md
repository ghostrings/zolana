Where your keys are, what runs in your browser, and what this site's server does and does not see.

## Self-custody, stated precisely

Every transaction is built and signed in your browser. The server cannot move your funds, because it never has a key, and it cannot alter a transaction, because it never sees one before it is signed.

The one exception to "never sees" is a Ghost fill, where the server's desk is your counterparty and both sides exchange transfers before signing. There your browser inspects what it is about to sign. See [The Ghost desk](/docs/ghost-desk).

## Your keys

| Key | What it does | Where it is |
| --- | --- | --- |
| Signing key | Approves transactions | Ghost wallet: encrypted in this browser. Extension: inside the extension. |
| Viewing key | Decrypts your notes | Derived in your browser, kept for the tab |
| Passphrase | Unlocks the ghost wallet | Only in your head. It is never stored or sent. |

The ghost wallet's key is stored as ciphertext: PBKDF2-SHA256 with 310,000 rounds turns the passphrase into a key, and AES-256-GCM encrypts the seed with it.

## Proofs

A private transaction carries a zero-knowledge proof that it is valid: that the notes being spent exist, are yours, and add up. These proofs are produced by Helius's prover, which runs inside an attested enclave.

Before sending anything to it, your browser:

1. verifies the enclave's attestation against a policy signed by keys that are pinned in the Rings SDK;
2. encrypts the request to the enclave's key.

This site's server relays those bytes and cannot read them. It follows that the secrecy of a transfer's contents relies on that enclave as well as on the cryptography on chain. That is a property of Solana Privacy Rings, not something this site adds or can remove.

## What this site's server does

- **Relays** your browser's requests to Helius, so the API key stays off the page. It passes only a fixed list of request types.
- **Keeps the public token listing**: prices, reserves and supply, read from chain. It indexes pools, not people, and keeps no table of holders.
- **Stores token artwork and metadata.**
- **Runs the Ghost desk**, when the operator has switched it on.

## What the server sees

- Your IP address, as any website does.
- The public requests it relays: which accounts and which tokens your browser reads.
- Indexer queries your wallet makes while it looks for its notes. These show which addresses a visitor is syncing, exactly as they would to Helius directly.
- Everything the desk learns, when you take a Ghost fill.

## What the server never receives

A secret key, a passphrase, a viewing key, or the contents of a private transfer.

## There are no accounts

No sign-up, no email, no profile. A wallet is the only identity, and it lives in your browser.

## If this site went away

Your public balance is ordinary SOL and ordinary tokens in a wallet you hold the key to. Your private balance lives in the Rings program on chain, under your keys, not on this site. Reaching it without this site would need other software built on Solana Privacy Rings, and your secret key. That is the reason to back the key up.
