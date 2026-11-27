# V33 wallet signing integration candidate

This is a separate client-side signing boundary for the existing V33 Rust instructions, not a new on-chain version. It is intentionally not connected to the production routes yet. Those routes still verify locked V27 and fail closed. No application server may hold the upgrade, administrator, treasury or customer signing keys. No private settlement is implemented.

## Implemented

- Fresh loopback ledger, exact executable bytes, loader, program account and PDA checks before drafting.
- Read schema-2 protocol and market accounts, derive and bind all market PDAs, check public mint and vault balances.
- Create native market with creator and current administrator as distinct required signers. Independent signatures over the same legacy Solana message are retained and cryptographically checked. A returned message, existing approval or other signer slot cannot change.
- Native SOL buy: explicit wrap into caller-owned WSOL ATA, exact quote/version/deadline, base-token ATA delivery. Sell: public token ATA to caller-owned WSOL ATA. No implicit conversion back to SOL or automatic WSOL account closure.
- Graduation, creator and treasury claim drafts, pinned beneficiary and canonical WSOL ATA. No LP withdrawal instruction or hidden fee route.
- Optional Wallet Standard sign-only adapter for extensions that explicitly advertise localnet and legacy transactions; it never labels a local transaction as mainnet. Browser extension connection is not wired into the production site.
- V33 reference pricing and fee logic reused, not rewritten.

## Tests

From the extracted repository root: `npm run markets:wallet:check` (Node 22 WebCrypto real signatures, no RPC). `npm run markets:wallet:local` builds V33 in an isolated new test workspace, uses generated local-only wallets and executes launch/approval, buy/sell, graduation, paused exit and separate fee claims against the actual program. It does not require Docker or real SOL. The integration test uses callbacks backed by ephemeral test keypairs to represent two distinct wallets; it is not a browser extension or production user-wallet test. No mainnet transaction or upgrade command is provided. All generated keys and the local validator ledger must remain private; only the named test log can be shared after review.

## Remaining work before real funds

Independent security and economic review, final custody/recovery policy, fresh finalized mainnet scan, approved upgrade and sufficient ProgramData allocation, secure signer integration (including selected-wallet/account binding and user approval UI), native market listing and dashboards, end-to-end browser tests, updated exact-byte observer and verification, approval handling and incident response. The existing program is upgradeable and treasury is pinned per market. No automatic upgrade, activation, launch approval or mainnet submission is added here. The per-market 1 SOL limit does not cap total platform exposure. V33 has no private settlement. Never use real wallet keys in local tests.
