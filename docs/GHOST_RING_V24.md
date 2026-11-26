# GHOST v24 — research integration and release notes

Historical v24 foundation record. For the engineering edition and current test results, see [validation](engineering/VALIDATION.md) and [roadmap](engineering/ROADMAP.md).

Date checked: November 26, 2026. This is a **source candidate**, not a deployed Custom Ring or an audited release. The existing mainnet platform remains the actual execution environment. There is no new Solana program, ring identifier, deployed devnet instance, ZK circuit, anonymous relayer, operational auditor, registration, or real Custom Ring balance in this release.

## Products and routes

| Product | Route | Actual implementation |
|---|---|---|
| GHOST Launch | `/create` and `/token?mint=...` | Existing Meteora + Default Ring; linked to research hub and public Intelligence. No change to launch instructions, pool, fees, supply or first buy. |
| GHOST Wallet | `/wallet` | Existing self-custodial wallet. Adds a clearly unavailable Custom Ring balance notice. |
| GHOST Ring | `/ghost#lab` | In-memory fictional policy simulator with no network execution or wallet connection. |
| GHOST Intelligence | `/ghost-intelligence` | Read-only public index metrics; per-mint view; synthetic aggregate preview in `/ghost#lab`. No live auditor data. |

`/ghost` connects the four products. `GET /api/custom-rings/status` exposes release readiness; every other route or mutation under that prefix returns an unavailable response. The target JSON is available via the page's export control and `config/ghost-ring.research.json`; the TypeScript constant mirrors it exactly. No environment setting can activate network execution in this release.

## Target versus simulation

The requested target is anonymous mode, all supported assets, open membership, blocklist, freeze, co-signing, auditor, pause and **no permanent delegate**. `environment: devnet-research` is an intent label, not a network connection. This configuration is not upstream CLI input. Do not use it to infer a live ring address or create a deposit.

The lab models twelve fictional participants and two fictional assets (`TEST-SOL`, `TEST-TOKEN`). All state is local and ephemeral. Deposits and withdrawals move test units between two in-memory ledgers. Transfers move test units between fictional participants; two-leg test fills commit both legs or neither. The switches for owner and co-signer approval are booleans, not signatures. Blocklist rejects incoming simulated ring funds, freeze rejects simulated outgoing ring funds, pause rejects all modeled operations. Co-signing is modeled on deposit, transfer and withdrawal. This scope and exact semantics are development assumptions, not verified upstream policy behavior. The lab only admits its finite test fixtures; the target's open membership and all assets do not turn it into a real enrollment or asset registration system. There is no permanent-delegate operation. Receipts contain generic results and a local sequence, not transaction signatures or an auditor log.

## Intelligence data boundaries

The live-data view consumes the **existing** read-only `/api/rings/overview` and `/api/rings/token/:mint` API. Its fields describe the shared Solana Privacy Program vault and configured index history, not GHOST Ring. The index can be disabled, partial or stale; the interface shows unknown or unavailable rather than inventing data. The public record is not a signed finalized snapshot. Its public transaction count is not a count of unique holders.

The lab computes synthetic supply share and concentration in integer units. It suppresses holder count and top-10 concentration below 12 positive test balances; creator holdings are always unavailable. This demonstrates a reporting interface, not a privacy guarantee against differencing or re-identification. No individual balances are exported as analytics. The simulated operator and test balance are visible in the local UI by design. No personal data should be entered in the lab.

For real reports, require a separately verified ring/program/network identity, finalized slot, asset mint and supply, explicit coverage and reconciliation with the ring state, independently controlled auditor attestation and publication policy reviewed for re-identification and repeated-query leakage. Define declared insider ownership and disclose limits; no claim about beneficial ownership of unknown wallets or off-ring balances. The current version accepts no live audit uploads, private keys, viewing secrets or user-level balance snapshots.

## Source map

- `shared/src/custom-rings/config.ts`: exact target and permanently disabled network readiness.
- `shared/src/custom-rings/lab.ts`: pure test-only policy model, atomic rollback, bounded receipts.
- `shared/src/custom-rings/intelligence.ts`: pure synthetic aggregate calculations.
- `server/src/custom-rings/routes.ts`: read-only status, closed execution paths.
- `web/ghost.html`, `web/ghost-intelligence.html`, `web/src/pages/ghost*.ts`, `web/src/custom-rings/ghost.css`: product interface.
- `ops/check-ghost.mjs`, `tsconfig.ghost-check.json`, `tests/ghost-lab.node.mjs`: independent policy and wiring checks.

## Local run instructions (Node 22.13+)

Extract the ZIP into a fresh directory. Do not replace the production working tree or production environment with an unverified source candidate. No secrets or `.env` are shipped. The old deployment's configuration and persistent data are unchanged.

```sh
npm ci
npm run ghost:check
npm run test
npm run build
```

To preview the local app without configuring mainnet credentials, start the server and Vite in separate terminals:

```sh
npm run dev:server
npm run dev:web
```

Open `http://localhost:5173/ghost.html` and `http://localhost:5173/ghost-intelligence.html` (or their extensionless routes on the built server). The research lab runs without the API; public metrics correctly show unavailable without a configured existing Rings indexer. Use the [original platform reference](../PLATFORM.md) and mainnet runbook for existing platform configuration, including origin rules. Do not import a production key into a development browser profile or copy production data into a local experiment. No extra Render service or production secret setting is needed to display the new read-only research interface.

## Verification and release gates

Standalone check: `npm run ghost:check` compiles the three pure research modules with an available TypeScript compiler and runs Node's test runner. It can run with a compatible global compiler if the rest of the dependency tree is unavailable. It is not a replacement for the full project's typecheck, Vite build or Vitest regression suite. The development environment here did not have the full npm dependencies and the install could not complete. See `docs/GHOST_VALIDATION.md` for exact results.

Before any real devnet integration, confirm Helius's final supported SDK and audit results, correct program identity and governance activation, and officially supported transaction semantics. Before any mainnet deployment, run the full original tests and build, review the diff, stage the read-only UI with a separate origin, and verify that no old routes, transaction validation, fees, key handling or network checks have changed. No real ring execution should be enabled solely by changing this configuration. A separate independently reviewed implementation and approval process is needed for any live Custom Ring and its governance/auditor policies.

## Official references checked

- https://www.helius.dev/docs/privacy/concepts/overview#custom-rings — mode and auditor model.
- https://www.helius.dev/privacy/demo/customize — anonymous mode listed as coming soon; policy controls.
- https://www.helius.dev/docs/privacy/security — Custom Ring audits expected to conclude December 2026.
- https://github.com/helius-labs/custom-privacy-rings — evolving reference implementation.
