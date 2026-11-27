# V36 native browser release

This application candidate is an additive integration of the operator-reported active V33 program `5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n` at slot `474345522`. Its binary SHA-256 is `bb7545ae08ab37a83f6785f21a019103953c0d43a3e8a47d0162969193e5e411`. The supplied V33 executable, Rust source, historical release evidence and lockfiles are unchanged. No deployment, upgrade, activation or mainnet issuance was performed during packaging. A matching build is not an audit.

## Install and verify before uploading

Extract the ZIP into a fresh folder. Keep the existing Render service environment, persistent disk and metadata/pinning settings; do not replace local keys or databases. Node 22 and the existing lockfile are required.

```sh
npm ci
npm run markets:browser:check
npm run markets:browser:client-check
npm run markets:production:check
npm run markets:production:client-check
npm test
npm run build
```

Upload the source to the existing Render application repository after checks pass; preserve existing production settings. Do not upload local dependencies, target directories, credentials, keypairs or signed approval files. The new native page reads the exact finalized V33 program, and will fail closed if the deployment changes. Inspect the actual deployed pages. Real native signing is restricted to `https://privacycash.fun`.

## First native issuance through the browser

1. Open `https://privacycash.fun/create?rail=native`. Connect a creator Wallet Standard account that supports legacy sign-only transactions and differs from the administrator, treasury and pauser. Enter name, ticker, artwork, public description/links and 2%, 3% or 4% fee. Use the existing artwork uploader. The metadata URI (up to 200 UTF-8 bytes) is written to the native Market account. It is not a Metaplex metadata account and external wallets may display the mint address instead of its branding. The mint authority is revoked by the deployed program.
2. Prepare the launch, inspect its exact accounts and rent/fee estimate, acknowledge the unaudited public issuance, sign as creator and save the approval file. No initial purchase or privacy proof is included. Existing durable nonce `76BAU3ShJYNYqHogKomsoBa3kXKTGrez3vuP7cXCM7Fa` must be initialized under the pinned administrator. The creator pays account rent and transaction fee. Never share the approval publicly; it remains usable until the nonce changes.
3. A connected Wallet Standard administrator can import and sign in the same page. For the current CLI-held administrator, start the operator-only signer once from the installed Linux checkout:

```sh
npm run markets:admin:browser
```

Open `http://127.0.0.1:17831/`. Import the creator-approved file, inspect the intended public issuance, and type the matching `APPROVE <market>` phrase. This local service binds exclusively to loopback, requires explicit approval, validates exact transaction/message, reads only the configured local administrator key and signs locally. It never submits transactions or serves the key. Stop it after use; do not deploy it to Render or expose its port publicly. If the key was moved, restore local operator configuration; never export it into the public site.

4. Return to `/create?rail=native`, import the completed approval file, check the displayed metadata, signatures and cost. Only then select **Submit fully signed launch**. The page reports the expected transaction signature before sending and checks finalization and the actual Market and mint accounts. Do not automatically retry an uncertain submission; inspect the signature and chain state. The review exception is limited to a first issuance on the pinned empty active pilot with no purchase, not a general production approval. It fails closed after a native market exists, or if the configured role, mode, deployment, nonce or account state changes.

## Native token pages, registration and fees

- `/native-markets`: finalized native listing and current marginal prices, curve progress and reserves. No invented historical trades or private-holder statistics.
- `/native-token?market=<market>`: public identity, artwork, creator/treasury, current fees, exact integer quote, graduation and locked-LP accounting. It also includes the reviewed transaction client for trades, graduation and beneficiary claims, but those signing controls remain disabled while the independent-review record is null. An empty market has no circulating token balances; the first issuance is not a first buy or market opening to customer funds.
- From the native token page use **Check asset**. Only permissionless, verified Privacy Rings asset-interface registration is offered; a restricted protocol requires authorized registration. The SDK builds the public registration instruction, validates the payer/mint/registry, simulates and presents a debit estimate (not an on-chain debit cap), requests explicit wallet approval and verifies the registry after finalization. Registration itself neither deposits nor trades. The wallet link appears after verified registration. Use the original wallet's Shield, Unshield and private transfer flows once you hold supported assets. Existing wallet logic is retained; the native wallet recognizes native market identities and checks asset registration before native deposits.
- `/native-fees`: reads outstanding platform and creator WSOL fees from actual market accounts. Each beneficiary signs its own claims once the review gate allows signing. No claim redirects or custodial treasury keys. V33 uses 80/20 curve fees, 100% platform graduated pool fees, 100% locked genesis liquidity under upgradeable code, 0% creator premint, 0.2 SOL graduation and 1 SOL accounted reserve/unpaid fee cap per market.

## Privacy and remaining limitations

Native issuance, ownership outside Rings, buys/sells, reserves, fees and pool activity are public SPL transactions. Supported registered assets can be held in Default Ring encrypted balances; transfers hide token and amount, not wallet counterparties. Deposits/withdrawals are public. No Custom Ring, anonymous swaps, private AMM, or verified security approval is introduced. Do not advertise full privacy or accept customer trading funds merely because the program is active. General trading, graduation and fee claims on the website need a genuine independent review of this exact release and the production signing integration. The single native mint workflow and asset registration are not evidence of reviewed production trading readiness.

## Packaging evidence

The 103 standalone checks (7 native browser policy, 23 historical observer, 20 production checks, 45 market/math and metadata, 8 lab checks) pass in the preparation environment. Syntax checks and copied candidate checksums pass. Dependency-backed browser envelope tests, added relay regression, full npm test/build, actual browser wallet behavior, artwork and mainnet registry calls have not been run end-to-end here; npm dependency installation is blocked by registry connectivity. Perform those checks on the existing installed toolchain before use. No keys are included. This is a browser integration release candidate, not a new on-chain release.
