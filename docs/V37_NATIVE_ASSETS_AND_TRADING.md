# V37 — Native asset onboarding and trading checks

Application-only update of V36. The deployed V33 executable, authority addresses, Rust source, pinned npm/Rust lockfiles and existing Render settings are unchanged. No new market, buy, registration or other mainnet transaction was submitted by the preparer. ZOL's first issuance was reported by the operator's finalized native market page; the exact transaction signature and current registry state were not independently accessible.

## ZOL: check registration, then use Wallet

Market: `AqwuGpwStiafXGnwqxEQ1sdqnPodnytvWrzU71odCrrg`

Mint: `2P2pLKSZr48zr7M3GQWEC4uwNgRv9JbJn3Ja2a9DutgX`

Direct page: https://privacycash.fun/native-token?market=AqwuGpwStiafXGnwqxEQ1sdqnPodnytvWrzU71odCrrg#native-asset

1. Open the native token page; refresh finalized market state. Use **Check Default Ring registration**. This is a read-only call to the pinned mint, registry and protocol configuration. If the interface is already verified, no new registration transaction is necessary.
2. If permissionless interface creation is available, connect a compatible public Wallet Standard payer account. Read its public balances if desired. Select an estimated-debit budget (lamports, maximum 100000000 = 0.1 SOL). Tick the separate acknowledgment in Encrypted holdings. Click **Register asset with connected wallet**. Inspect the real mint, registry, fee payer and simulation-derived debit before explicitly approving. The debit budget is an estimate check, not an on-chain maximum. This transaction creates the Default Ring asset interface, not a token purchase, liquidity contribution or deposit.
3. After successful finalization, the app rechecks the registry using the finalized transaction slot as a minimum context slot. The page displays the verified asset ID and provides the encrypted-wallet link. If creation is restricted, obtain the authorized registration path. If status is unavailable, do not infer missing registration; resolve RPC/registry verification. Never retry a possibly submitted transaction without inspecting its signature.
4. To shield, use the existing Wallet route, which requires a supported public token holding and explicit confirmation. A freshly issued market can have zero circulating tokens. Registering the asset alone does not acquire tokens or create encrypted notes. The existing wallet reads its own private holdings using the existing SDK; the native token page only reads public associated accounts and never queries private balances.

A read-only fallback using the already installed V36/V37 CLI is:

```sh
npm run markets:native-asset -- status AqwuGpwStiafXGnwqxEQ1sdqnPodnytvWrzU71odCrrg
```

## Market activity and quotes

The existing token page has a compact quote summary (inputs, exact minimum output, total fee and the platform/creator portions). The new Read recent activity button fetches no more than ten finalized market signatures per request, following the existing relay bound. It decodes the V33 MarketCreated, SwapExecuted and Graduated event layouts from the sealed IDL/source. It only accepts matching market bytes and logs in the GHOST program's active invocation in successful finalized transactions. Missing, truncated, failed, wrong-release and unavailable records are not treated as evidence of zero volume. The feed is a bounded recent window, not a complete index or price chart; quote-side amount is gross input for a buy and net output for a sell. No private wallet history or market-manipulation inference is computed.

Read my public balances checks only the selected public account and its canonical SPL associated token accounts for the current mint and WSOL. Absence of a canonical ATA is a zero for that account, not an assertion that the wallet has no holdings elsewhere. A stale/malformed/substituted account or RPC error returns unavailable. These explicit reads expose the requested public wallet address to the existing RPC relay.

The staged public market client now simulates unsigned trade/graduate/claim instructions before preparing an approval, checks fee availability, blockhash validity and state version, and polls for finalized receipt after an explicit submission. It never automatically re-sends. Successful simulation is not an execution guarantee. **The `reviewedRelease()` gate still returns null. Public trade, graduation and fee-claim signing are not enabled by this package.** The owner-approved first issuance remains a one-market exception, not unrestricted issuance. Obtain genuine independent security/economic/custody review before allowing customer trading. No privacy proofs or Custom Ring are introduced.

Native issuance and market execution, fee transfers, deposits and withdrawals are public; eligible Default Ring balances and supported transfers conceal asset/amount under the existing protocol's guarantees, not counterparty addresses. No creator ownership, coordinated trades, or public reserve information is concealed by the native market integration.

## Verify and install

Use Node 22 and the unchanged npm lockfile. Extract into a clean directory, preserve the live Render service environment and persistent disk, and do not upload keys, approval envelopes, local databases, build directories, or wallet backups.

```sh
npm ci
npm run markets:live:check
npm run markets:live:client-check
npm run markets:browser:check
npm run markets:browser:client-check
npm run markets:production:check
npm run markets:production:client-check
npm test
npm run build
```

Preparation environment ran 112 standalone checks (23 historical observer, 20 production, 45 market, 8 lab, 7 browser policy, 9 recent-event/finality/UI checks). Dependency-backed public ATA tests and full browser/build verification are pending: npm offline install failed because required packages were not cached. RPC DNS and the explorer were inaccessible here. No independent security review or production signing readiness is asserted.
