# privacycash.fun V35 — native issuance and Default Ring asset readiness

**Application-only update. No deployed program bytes changed.** V33 was reported active by the operator at finalized slot 474351235, with deployment slot 474345522. The operator subsequently reported V33 publication/verification and application checks complete, but did not supply the new remote-verification job receipt or an independent security audit. The package retains the exact previous V33 release and its original build/activation records. No transaction has been sent while preparing this update.

The native market program creates ordinary, fixed-supply, six-decimal SPL tokens. It does not implement private swaps, anonymous launch, a Custom Ring, or a shielded AMM. The separate Default Ring can hold supported SPL assets after their actual asset registry interface is created. Asset registration is **not** itself a private balance, a deposit, a transfer or evidence of anonymous trading. A public pool trade or deposit/withdrawal remains publicly observable, including asset and amount. Default Ring transfers conceal the amount and asset but not counterparties. Preserve creator/allocation disclosures. Do not use these features to misrepresent token distribution.

## What changed

- `/create` and `/native-launch`: preserve the existing operational Meteora route, allow unsigned native launch intents, and link to native markets. No public signing gate removed. `/native-launch` can read each observed native mint's actual SPL mint and Privacy Rings registry/protocol configuration through the existing RPC relay. A missing interface is distinguished from an RPC or decoding failure. `Open wallet` appears only after verified registration; existing wallet operations and proof generation remain untouched.
- Operator-only first native launch: reconstruct the exact V33 `create_market` instruction, using the existing dedicated administrator-controlled durable nonce account. This is deliberately restricted to an empty market scan, a separate creator, and one public launch with no initial buy. The creator pays market/mint/vault account rent and transaction fees. The locally held administrator signs only after explicit approval of that market address. No private keys in the browser, server, approval or ZIP. The loopback signing page is excluded from production build inputs. The public website's independent-review gate remains intact.
- Separate optional operator-only asset-interface registration using the same pinned official SPR SDK instruction that the existing application uses for its other SPL interfaces. It checks the actual mint, registry and permission bit; fails if restricted, unknown, invalid or not a V33 market; requires explicit confirmation of the mint and a successful simulation under the chosen estimated-debit budget. The estimate is **not an on-chain spending cap**. No deposit or trade is included. No proof API changes or automatic registration.
- Fixed V33 profile: initial supply 1,000,000, no creator premint, WSOL quote, 0.1 SOL virtual reserve, 0.2 SOL graduation threshold, 1 SOL accounted quote reserve/fee-liability cap per market. 2/3/4% fee choices; curve fees 80/20 platform/creator; all graduated pool fees platform; genesis principal locked by upgradeable code. No new token metadata program or external LP issuance. All existing Meteora pools, fee modules, Ghost desk, wallet, Render settings, npm lockfile and V33 program artifacts are unchanged.

## Verify before uploading to Render

Use a fresh directory and the existing Node 22 dependency lock. Keep production `.env`, API keys, validator data, wallets and pending approvals outside the upload tree.

```sh
npm ci
npm run markets:production:check
npm run markets:production:client-check
npm run markets:owner-launch:check
npm test
npm run build
```

The new dependency-backed launch-envelope tests use ephemeral keys and no network. The operator-only nonce/registry tools have **not** been exercised on a validator or mainnet in the packaging environment. Full end-to-end wallet verification and independent review are outstanding. Inspect the exact transactions and test with controlled wallets before operating them. Do not solicit customer funds or represent the candidate as audited. The observer and signing gate in the public application remain intact.

When checks pass, manually upload the clean application files to your existing website repository and use Render Manual Deploy. Preserve existing environment and persistent disk; no new production credentials or server key files. The local signing page is not in the Vite production input list. Do not upload your Ubuntu checkout or any signed approval JSONs. Do not deploy a new program, change the upgrade authority, or reinitialize the protocol.

## First owner-controlled native mint (optional, real mainnet rent)

This is a deliberately bounded owner-only launch, not public trading authorization. It creates the public mint and empty curve, without a purchase. Because the program is active, outside traders could directly invoke it after a market exists; do not advertise or onboard customers before independent review. If you need zero customer exposure, do not create a mainnet market until review is complete. This helper refuses a second native market, unknown executable, changed slot/authorities, non-active mode, reused account, incorrect nonce or insufficient creator funds. It reuses the nonce account created during initialization; if that account is missing or its authority/nonce changed, inspect status instead of regenerating keys or overriding checks.

First check:

```sh
npm run markets:owner-launch -- status
```

The result must show initialized active V33, deployment slot 474345522 and an empty `scan.markets`. Choose a **creator wallet you control that is distinct from the administrator, treasury and pauser**; V33 does not allow the treasury or administrator to be the creator. Use the wallet's public address only. The browser page signs with the selected Wallet Standard wallet (legacy `signTransaction` support required). No need to export a wallet secret. For the website route, open `/native-launch`, connect the chosen creator, choose name, uppercase ticker and fee, review and save the unsigned intent. On your local machine, use that file to prepare the exact launch:

```sh
D=/mnt/c/Users/akanb/Downloads
DRAFT="$D/ghost-v33-first-$(date +%s).json"
npm run markets:owner-launch -- draft-intent "$DRAFT" "$D/ghost-unsigned-launch-intent.json"
```

Or create the same unsigned draft directly from the terminal with your chosen values:

```sh
read -r -p 'Creator public address: ' CREATOR
read -r -p 'Token name: ' NAME
read -r -p 'Uppercase ticker: ' SYMBOL
read -r -p 'Fee in basis points (200, 300 or 400): ' TIER
D=/mnt/c/Users/akanb/Downloads
DRAFT="$D/ghost-v33-first-$(date +%s).json"
npm run markets:owner-launch -- draft "$DRAFT" "$CREATOR" "$NAME" "$SYMBOL" "$TIER"
```

The output lists the exact creator, approver, predicted public mint and market, fee tier, creator SOL balance, and estimated account rent and network fee. Do not fund an unknown address. No key is read and no transaction sent by either draft command. The nonce is durable: ordinary recent-blockhash time limits do not apply, but any competing use of the nonce invalidates the draft. Never approve more than one pending launch with the same nonce.

Start the loopback-only dev server (stop any previous Vite instance using this port first):

```sh
npm run dev:web -- --host 127.0.0.1 --port 17829 --strictPort
```

Open `http://localhost:17829/v33-owner-launch.html`, load the new unsigned file, connect the correct creator, and review the exact public issuance. The page saves `ghost-v33-launch-<market>-creator.json`. It signs only, does not broadcast. In the second Ubuntu terminal, use the **exact newly downloaded filename**:

```sh
cd ~/src/ghost-native-v35
D=/mnt/c/Users/akanb/Downloads
read -r -p 'Creator-signed JSON filename (including .json): ' SIGNED
npm run markets:owner-launch -- submit "$D/$SIGNED"
```

This is a real mainnet operation and spends creator SOL for issuance rent and transaction fees. Check the full printed summary and type the requested `LAUNCH <market address>` only if you intend that specific public issuance. The administrator signs locally with the existing authority key file, which is never exported. The script prints the expected signature before sending, polls finality, verifies the observed market and base mint authorities, then prints the receipt. If the outcome is uncertain, check the signature and `status` before retrying. Do not publish pending signed files. A new market becomes visible to everyone; the mint's program metadata is the V33 market record, not newly created Metaplex metadata.

## Enable supported encrypted holdings for the native mint

Only after the market exists and the mint is verified, run the following read-only check (use the actual public market address, not the mint or program):

```sh
read -r -p 'Finalized native market address: ' MARKET
npm run markets:native-asset -- status "$MARKET"
```

`registered`: verified existing interface; no transaction is necessary. `registration-available`: current mainnet protocol permits creation. `registration-restricted`: ask Helius/protocol governance for the authorized path. `unavailable`: inspect mint/registry/RPC, do not guess. For an absent interface that the protocol permits, the separate optional operator action is:

```sh
# Example maximum acceptable *estimated* debit: 0.05 SOL = 50,000,000 lamports.
npm run markets:native-asset -- register "$MARKET" 50000000
```

This uses the exact pinned SDK interface instruction, checks its public accounts, simulates it before asking to confirm, and requires typing `REGISTER <mint address>`. The administrator pays account rent and fees. An estimate is not a debit limit enforced by the program; review current state, the official SDK and transaction before approving. If the amount or permissions are unexpected, stop. A successful command re-reads the registry at finalized commitment. It never performs a buy, private deposit, withdrawal, transfer or Custom Ring activation.

The public `/native-launch` page can then display `Default Ring asset interface verified` based on a fresh check. Supported holders may use the existing wallet's normal explicit Shield/Unshield controls for eligible assets. The operator must not solicit customer funds pending review. The interface does not make the native market's trades confidential. Native buy/sell and fee claim builders remain staged behind the public review gate; no new anonymous or automated settlement path has been added.

## Reproduction boundary

No new on-chain binary, Cargo.lock or IDL. Do not repeat the V33 build verification just because the application has changed. Preserve the actual remote verification receipt in GitHub if you have it, and record a new release only if the executable changes. See `V33_MAINNET_PUBLICATION.md` for historical publication instructions and `V34_RELEASE_HANDOFF.md` for independent-review scope. The actual first mainnet launch and asset registration remain unexecuted by this package's author.
