# GHOST Markets — V34 release handoff (V33 program)

> Historical pre-upgrade handoff. For the later operator-reported active V33 state and current publication steps, see [V33 mainnet publication](V33_MAINNET_PUBLICATION.md).

**Decision: pending independent approval. No deployment, signing, initialization or activation has been authorized by this package.** This is the existing application V34 with its release stamp synchronized and the review material consolidated; it is not a new program version. The reviewed-candidate executable has not been rebuilt or modified. No authority keys, wallet backups, signed approvals, local build caches or live credentials should be included in any public upload.

## Exact release

| Field | Value |
| --- | --- |
| Program | `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n` |
| ProgramData | `J4iCsaLM24bBqjWGXvtB6N3LzUiJNJWwKAqLtXUzTXxt` |
| Protocol PDA | `423vt8vZMJs5ToVjUtbHQFtXDVQ7AccAVHk7vh6P6vWK` |
| Last observed executable | V27 locked; slot 474265505 |
| Historical verified V27 source | https://github.com/ghostrings/zolana/tree/b723d275bda85bac40ed9c9f4f7d3c479c5758d7 |
| Proposed executable | V33, `public-pilot`, 547816 bytes |
| Raw candidate SHA-256 | `bb7545ae08ab37a83f6785f21a019103953c0d43a3e8a47d0162969193e5e411` |
| Solana Verify candidate hash | `33a41e48d76fe0bbf936aa41e926a6ebb9005034cfcbf3651318a1ff0e8e9ec5` |
| Build tools | Solana 2.3.0, Anchor 0.32.1, Solana Verify 0.5.2 |
| Candidate location | `deployments/review/v33-candidate/` |
| Application | V34; signing disabled pending independent review |

The V27 build-verification receipt is historical and must not be presented as approval or verification of V33. See [the preliminary source review](V33_RELEASE_REVIEW.md) and [the integration contract](V33_PRODUCTION_INTEGRATION.md).

## Latest evidence and limitations

- Owner reported V31 and V32 validator tests for all three fee tiers, V33 local market and independent-wallet tests, V33 Docker candidate preparation, and successful V34 application checks after correcting the release footer. V34 preflight and unsigned initialization plan were supplied in the conversation. See `evidence/native-production/v34-owner-preflight.json`. These are owner-reported observations, not independently retrieved logs or an audit.
- This handoff reran 98 dependency-free checks (15 production, 23 observer, 45 pricing/metadata, 8 lab, 7 wallet-wire); all passed. The exact V33 14 release checksums and eight source hashes passed. The dependency-backed checks and browser/extension end-to-end execution were not rerun here. The owner's report that application checks worked is not evidence that mainnet signing or the cross-device production approval path executed.
- The last finalized preflight (slot 474341702) showed empty V27, no initialized protocol and no markets, unchanged upgrade authority, and 3.324702588 SOL. The estimated buffer plus extra allocation was 2.855798200 SOL, leaving 0.468904388 SOL before fees. Refresh these values immediately before any approved release action. Do not treat this as a current balance or funding guarantee.

## Independent review request

Please review the exact V33 source/binary and the V34 production client and approval-file workflow together. The proposed pilot is publicly settled on Solana, with administrator-approved issuance, canonical WSOL, initial supply 1,000,000 tokens, zero creator premint, 1 SOL accounted reserve cap per market, 2/3/4% selectable fee tiers, 80/20 curve fee split, and 100% platform graduated-pool fees. Genesis LP principal is locked by the supplied upgradeable code, not immutable against future upgrades. Native private settlement does not exist in this release.

Request a written decision that identifies the source revision, artifact hashes, reviewed application revision, findings and remediation evidence, accepted economic and operational risks, authority custody, and any conditions for a limited mainnet pilot. Request separate confirmation of the upgrade/rollback, initialization and activation procedure. An independent build reproduction is valuable but is not a security or economic review.

Specific review scopes:

- Account constraints and PDA authority bindings; mint and vault invariants; integer pricing, fee liabilities, rounding, reserve limits, graduation, donations, paused exits and economic stress cases. Check that ordinary holders are not misled about liquidity or guaranteed exit prices.
- Upgrade, administrator, treasury and pauser separation, authorized signers, recoverability of treasury access (markets pin treasury), incident handling and rollback limitations once market state or liabilities exist. The 1 SOL cap is per market, not total exposure.
- Browser Wallet Standard integration with actual chosen wallets, canonical instruction construction, multi-signer portable approval, blockhash expiry, message and signature tampering, RPC staleness, WSOL account handling, role binding and confirmation. Exercise the full production client path in a controlled test environment before live signing.
- Reproducible `public-pilot` build with exactly the published source/lockfile and correct program ID, and the matching IDL/security metadata. Compare both raw file and Solana Verify hashes using their respective methods.
- Operational disclosures: public market trades, upgradeable liquidity lock, creator/treasury fees, token risk, administrator-approved launches and no claim of anonymous markets or hidden issuer ownership.

## Release order (conditional on real approval)

1. Preserve the sealed V27 executable/source/IDL, historical verification commit and V33 candidate. Publish only reviewed public source. Do not upload Ubuntu workspaces, `.config`, keypairs or approval envelopes.
2. Obtain written independent approval of exact source, binary, client and custody, with all blocking findings resolved. Where the reviewer calls for changes, require fresh evidence for the changed artifact. No approval record is included in this handoff.
3. Refresh read-only `npm run markets:production:preflight`. Confirm V27 is still empty and compatible, roles and hashes unchanged, adequate funding, and no unknown release. Review the CLI-specific allocation/upgrade procedure; V33 is 14184 bytes larger. Use the existing upgrade authority, not a newly generated program identity. The official CLI supports same-address upgrades; confirm flags for the installed version (see https://solana.com/docs/programs/deploying). A reviewed operator procedure must explicitly target the exact candidate file and the existing program, not an Anchor rebuild. Do not remove the upgrade authority.
4. Execute the approved upgrade with no initialization or activation bundled into it. Verify finalized new slot, executable/hash and unchanged upgrade authority and empty protocol/markets. Publish matching IDL/security information and register remote verification against the exact source revision and `public-pilot` build feature. See https://solana.com/developers/docs/programs/verified-builds. A successful verification is not a security approval.
5. Have the source-reviewed application record the genuine approved release and actual finalized deployment slot. `reviewedRelease()` currently returns null; no environment toggle enables it. A hash, local tests or this handoff cannot substitute for the written independent approval. Verify the updated application against the actual deployment. `upgradeAuthorized:false` in the read-only preflight is intentional.
6. Review and independently sign the initialization with the existing administrator/upgrade authority and Jupiter treasury using the exact schema-2 instruction. Verify locked mode and each authority after finalization. Do not export the treasury private key. Do not combine initialization and activation. The unsigned initialization plan is not itself a signable transaction.
7. Separately approve and exercise the activation procedure (V34 does not supply an activation transaction builder), monitor the first restricted public market and its exits/fee accounting, and record transaction evidence. Maintain working Meteora and Default Ring routes and emergency controls. This is a restricted public pilot, not unrestricted issuance, and no privacy proof has been implemented.

No changes to the live program, wallet, Render service, GitHub or on-chain metadata were made while preparing this handoff.
