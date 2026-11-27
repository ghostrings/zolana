# Render integration: GHOST Markets

Application release **v26**, independent native protocol release **V27 (locked)**. Built on the owner-supplied `privacycash-main.zip` (application v24). This is not the experimental GitHub workspace and does not replace its on-chain program sources.

## Recorded deployment

- Network: Solana mainnet-beta
- Program: `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n`
- ProgramData: `J4iCsaLM24bBqjWGXvtB6N3LzUiJNJWwKAqLtXUzTXxt`
- Upgrade authority: `J4JRQza7JXnkct6kQC3roPYstoH2xFBoyQ5Wczpt5jPt`
- Deployment slot: `474265505`
- Executable bytes: `533632`
- SHA-256: `2fba22c284791879f003aec3118c74fbd271f808f91b39e394e2654f9cc80d7d`
- [Deployment transaction](https://explorer.solana.com/tx/5TMpEwE2XkjWTfY42XShQPks3UoYrVEDWiHFdAzcCXeJcZ1wnu6AXyEaXefQn3cx3geMixMHjKtziSe6vtXaANjT)
- [Program explorer](https://explorer.solana.com/address/5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n)

The release identity and owner-reported finalized observations are recorded under `deployments/mainnet/`. The owner's CLI verified the binary and returned `protocol: null`, `marketExecution: false`, `privateSettlement: false`, and an empty market scan. The exact deployed binary, private release workspace and signing keys are not included. No independent audit or fresh mainnet deployment is claimed by this package.

## What this application actually integrates

- `/ghost-markets`: a live read-only release observer with a real RPC verification path and the existing public Custom Rings registry snapshot.
- `/create`: existing Meteora/Default Ring launch form, plus a clearly disabled GHOST-native option. Public creation and first-purchase visibility are stated explicitly. Existing transaction signing remains unchanged.
- `/swap`, `/protocol`, market landing page and footer: clear route labels and links to the native program.
- `GET /api/ghost-markets/status`: a fixed, server-side read of the pinned release. Uses the existing `SOLANA_RPC_URL` or configured Helius RPC. No new credentials or input addresses required. A 60-second success cache, 20-second failure cache, coalesced reads and per-client rate limit bound RPC work. The response never contains the provider URL or provider errors. If the release, slot, authority or hash changes, or the check is unavailable, the new route remains disabled. An observed status is a snapshot, not a claim of immutable code. No mutation endpoints or transaction builders are included in the native integration.
- `npm run markets:observe -- status|scan|history|market ADDRESS`: read-only CLI from the V28 SDK. The CLI uses a trusted HTTPS RPC (public Solana RPC by default) and does not access keys. RPC limitations are reported as errors, never invented empty scans.

The native endpoint is independent of `/api/status` and does not block application startup or health checks. The existing launchpad remains the available execution path subject to its configured tiers, limits and network state. The optional Ghost desk remains subject to the existing operator setting; this release does not enable it.

## Privacy boundaries

| Action | Route | Actual visibility |
| --- | --- | --- |
| Launch / optional first buy | Meteora + Default Ring | Creator, asset and amount public; deposited balance encrypted |
| Pool swaps | Existing Meteora / Jupiter | Execution public; shielded balances encrypted |
| Existing confidential transfers | Default Ring | Token and amount encrypted; counterparties public |
| Existing optional Ghost fills | Default Ring desk | Trade contents encrypted; counterparties public and desk knows trade |
| GHOST native launch / swap | Locked V27 | Not executable |
| GHOST Custom Ring settlement | Not integrated | No privacy claim |

## Before deploying the website

From the extracted application root, using Node as pinned in `.node-version`:

```sh
npm ci
npm run markets:check
npm test
npm run build
```

Then start as usual with `npm start` (existing environment settings). Check `/api/status`, `/api/ghost-markets/status`, `/ghost-markets`, `/create` and `/swap` in a staging service or local browser. When configured against mainnet, a successful `/api/ghost-markets/status` returns `verification: "verified-locked"`; otherwise it returns `unavailable`. Both states return `marketExecution: false` and `privateSettlement: false`.

Render's existing `render.yaml`, dependencies, lockfile, start command, persistent disk, API key configuration and original execution paths are retained. Use the normal manual repository upload and Render deploy workflow only after checks pass. Do not overwrite the persistent disk, reconfigure fee tiers, upload private keypairs, or deploy/upgrade the Solana program as part of a website release.

## Public-market pilot candidate

V29 adds `protocol/ghost-markets-pilot/`, a separate source workspace for the first reviewed public native launch. It is not included in the web application's signing or settlement paths. See [pilot implementation and release gates](../protocol/ghost-markets-pilot/README.md). The observer continues to verify the original V27 hash, so a future upgrade cannot silently enable trading. Mainnet execution, protocol initialization and private settlement remain unchanged by this website package.

## What is still required to offer native private launches

A program ID is not a settlement implementation. The deployed V27 default binary rejects every market operation. It needs a separate, reviewed upgrade before it can accept funds, and the locally enabled variant settles ordinary public SPL transfers. A production native privacy integration therefore needs:

1. An independently reviewed market program with explicit activation, authority and exit semantics and vetted assets; reliable recovery for stalled markets.
2. Supported Solana Privacy Program integration with reviewed circuits/proving artifacts and an authorized Custom Ring if required. Registration alone is not privacy settlement.
3. A reviewed market-specific proof and settlement interface enforcing economic invariants, asset conservation, slippage, replay protection and binding the exact market transition to both sides of an authorized trade. Public reserve updates still reveal trade information; a fully shielded AMM is a different cryptographic design.
4. Local-validator conformance, release identity verification, scoped operator/auditor access and applicable legal/compliance review. Public token issuance, disclosed insider allocations and other material market information must not be misleadingly obscured.
5. Only after these gates: production client transaction builders, quote/index adapters and real wallet integration, distinct from the existing Meteora routes.

Primary upstream resource: [Helius Privacy Rings announcement, November 10, 2026](https://www.helius.dev/blog/solana-privacy-rings). Its Custom Rings section states that audits are ongoing and the target mainnet release is Q4 2026. This package does not assume early-access permission or claim Helius approval.

## Validation at packaging

The standalone verifier and status tests passed (23/23). Existing transaction and wallet source files, npm lockfile and Render blueprint are unchanged; see `docs/NATIVE_MARKETS_VALIDATION.md`. Full dependency installation, Vitest/HTTP tests, full TypeScript build, browser smoke tests and fresh Render RPC observations remain pending. No deployment or on-chain transaction was performed.

## V31 native fee policy

The separate loopback-only pilot now has the fee structure documented in [V31 native fees](V31_NATIVE_FEES.md). Existing production Meteora configuration, privacy modules and V27 read-only observer are unchanged. The new candidate must not be treated as deployed or audited.
