# Deploying on Render

Render runs one thing: the web service (the site, the relay and the listing) with one
persistent disk. The operator scripts (`doctor`, `configs:*`, `migrate`, `fees:*`) and every
secret key stay on your own computer.

Deploying makes the site reachable by anyone who has the address. If the first run in
[MAINNET_RUNBOOK.md](MAINNET_RUNBOOK.md) is not finished, deploy on the `onrender.com` address
first, do the first run there, and attach your real domain afterwards (step 6).

## The settings, in one table

| Setting | Value |
| --- | --- |
| Service type | Web Service |
| Language / runtime | Node |
| Region | Frankfurt (or the one nearest your users) |
| Branch | `main` |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/status` |
| Instance type | Starter or larger. A disk needs a paid instance. |
| Auto-Deploy | Off. Deploy by hand when you mean to. |
| Disk mount path | `/var/data` |
| Disk size | 1 GB |
| Instances | 1. A service with a disk cannot have more. |

`--include=dev` matters: the build needs TypeScript and Vite, which are development
dependencies, and a production install leaves them out.

## 1. Put the code in a private GitHub repository

Render deploys from a Git repository. Install Git for Windows if you do not have it, create an
empty **private** repository on GitHub, then in the project folder:

```powershell
git init
git add .
git check-ignore .env          # must print ".env": it is ignored and will not be uploaded
git status --short | Select-String "\.env$"     # must print nothing
git commit -m "privacycash.fun"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
git push -u origin main
```

`.env`, `node_modules`, the build output and the data folders are ignored by `.gitignore`.
`ops/records` is uploaded: it holds only public addresses and the terms of your configs.

## 2. Create the service

**With the Blueprint (fewer fields to type).** In Render choose New > Blueprint and pick the
repository. Render reads `render.yaml`, creates the service and the disk with the settings in
the table, and asks for the values in step 3.

**By hand.** New > Web Service, pick the repository, enter the Build Command, Start Command and
instance type from the table. Under Advanced: Health Check Path `/api/status`, Auto-Deploy off,
and Add Disk with mount path `/var/data`, 1 GB. Then add every variable from step 3.

## 3. Environment variables

Set these in the service's Environment page. Copy the ones marked "from your `.env`" exactly.
This prints them:

```powershell
Select-String -Path .env -Pattern '^(DBC_CONFIG_|PARTNER_WALLET|CURVE_|CREATOR_)'
```

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `22.22.0` |
| `DATA_DIR` | `/var/data` (the disk's mount path, exactly) |
| `CLIENT_IP_HEADER` | `cf-connecting-ip` |
| `PUBLIC_ORIGIN` | The site's main address, with `https://` and no trailing slash. First `https://YOUR-SERVICE.onrender.com`, later your domain. |
| `EXTRA_ORIGINS` | Optional. Other addresses of the same site, separated by commas. Once your domain is the main address: `https://YOUR-SERVICE.onrender.com`. See step 6. |
| `HELIUS_API_KEY` | Your Helius mainnet key. Secret. |
| `PINATA_JWT` | Your Pinata JWT. Secret. Treat it as required here: without it a token's permanent metadata address is this service's own address, and its artwork lives on this disk. |
| `JUPITER_API_KEY` | Optional. Your Jupiter API key. Secret. With it, the token page offers "Pay with SOL or USDC" for a token priced in something else, converted through Jupiter inside the trade. Without it that choice is not shown. `JUPITER_RPS` is the requests a second your Jupiter plan allows (1 on a free key). |
| `PARTNER_WALLET` | From your `.env`. |
| `DBC_CONFIG_200`, `DBC_CONFIG_300`, `DBC_CONFIG_400` | From your `.env`. |
| `CURVE_INITIAL_MARKET_CAP_SOL`, `CURVE_MIGRATION_MARKET_CAP_SOL` | From your `.env`: the values the configs were created with. |
| For each pair token you switch on (optional): `CURVE_INITIAL_MARKET_CAP_<ID>`, `CURVE_MIGRATION_MARKET_CAP_<ID>`, `DBC_CONFIG_200_<ID>`, `DBC_CONFIG_300_<ID>`, `DBC_CONFIG_400_<ID>` | From your `.env`, exactly as `npm run configs:apply` printed them. `<ID>` is `USDC`, `ZEC`, `NEAR`, `XMR`, `ANT`, `RENDER` or `HSOL`. Add them under **Environment**, then **Manual Deploy**. The log then names the pair as confirmed on chain and its tiers as verified; if it says the pair is off, it says why. A pair with none of these set is simply not in use. |
| `CREATOR_FEE_SHARE_PCT` | From your `.env`: the value the configs were created with. |
| `CREATOR_POOL_PAYOUT_PCT` | `30`, or what you pay creators after graduation. |
| `MAX_TRADE_LAMPORTS` | `2000000000` for the first days. `0` removes the cap. |
| `PROOFS_PER_MINUTE_PER_IP`, `PROOFS_DAILY_LIMIT` | `12` and `5000`, or what your Helius plan allows. |
| `GHOST_DESK_ENABLED` | `NO` |
| `DBC_CONFIGS_PREVIOUS` | Leave empty. It is filled in only when you change the fee split: Part I of the runbook. |
| `MODULES_ENABLED`, `MODULES_SEED`, `MODULES_GAS_TANK`, `MODULES_DRY_RUN` | Leave empty. Fee modules are off until you follow Part J of the runbook. |
| `PINATA_GATEWAY_URL` | Optional. Where new tokens' logos are addressed for wallets and explorers. See step 7. |

The server compares the three configs on chain with the `CURVE_*` and `CREATOR_FEE_SHARE_PCT`
values it was given. If they are not the values the configs were created with, the site loads
but refuses launches on those tiers, and `/api/status` says which field differs.

**Do not set** on Render:

- `HOST` and `PORT`. Render provides the port and the server already listens on every interface.
  Above all do not copy `HOST=127.0.0.1` from a local `.env`: the service would never pass its
  health check.
- `PUBLIC_ORIGIN=http://localhost:8080` or `DATA_DIR=./data-first-run` from a local `.env`.
- `DEPLOYER_KEY`, `PARTNER_KEY`. They are for scripts on your computer.
- `SOLANA_NETWORK`. There is only mainnet.
- `TRUST_PROXY`. `CLIENT_IP_HEADER` replaces it on Render.

## 4. First deploy

Click Manual Deploy > Deploy latest commit. After the build, the log should contain these
lines, each after a timestamp:

```
network: the RPC is Solana mainnet
privacycash.fun listening on 0.0.0.0:10000 (Solana mainnet)
tiers: 2% verified against the chain (…)
tiers: 3% verified against the chain (…)
tiers: 4% verified against the chain (…)
```

A line that begins `tiers:` and says a config "does not match this server's settings" means
the `CURVE_*` or `CREATOR_FEE_SHARE_PCT` values differ from the ones the configs were created
with. Correct them in Environment and deploy again.

If the deploy stops instead, the log says why:

- `==> Running 'npm ci --include=dev && npm run build'` appears **after** `==> Deploying...`,
  followed by `No open ports detected` and `Application exited early`. The Start Command field
  holds the build command, so the service builds a second time and exits instead of starting.
  In Settings, set Start Command to `npm start` and deploy again.
- `Configuration error: DATA_DIR (/var/data) cannot be created or written`. No disk is mounted
  at that path. Add the disk with mount path `/var/data`, written exactly as `DATA_DIR` is.
- Any other line that begins `Configuration error:` says which setting to correct.

Then check, in a browser:

- `https://YOUR-SERVICE.onrender.com/api/status`: `"ready": true`, and each tier `"live": true`.
- `https://YOUR-SERVICE.onrender.com/api/ip`: **your own** public address. If it shows some
  other address, every visitor is being counted as one, and the per-visitor proof limit would
  throttle the whole site. Try `CLIENT_IP_HEADER=true-client-ip`, redeploy, and check again.
- The site itself: the pill in the header says Mainnet and the Launch page offers three tiers.

**The site works only at the addresses you gave it.** Opened at any other address, the pages
load, a note at the top says so, and everything that sends a request fails with `CROSS_ORIGIN`
(a wallet balance, a launch, a trade). The log then has a line that begins `origin: refused`
and names the address that was used. Either open the site at `PUBLIC_ORIGIN`, or add that
address to `EXTRA_ORIGINS` and deploy again.

## 5. Check from your computer

Your local `.env` keeps working for the scripts. `npm run doctor` there should still print no
`✗`. For fee claims your computer does not need the server's data: when it has no token list of
its own, `npm run fees:status` reads the pools of your configs from chain.

## 6. Your domain

1. In the service's Settings > Custom Domains, add `privacycash.fun` (and `www` if you want it).
   Render shows the DNS records to create at your registrar and issues the certificate itself.
2. When the domain shows as verified, set these in Environment and deploy again:

   ```
   PUBLIC_ORIGIN=https://privacycash.fun
   EXTRA_ORIGINS=https://YOUR-SERVICE.onrender.com
   ```

   `PUBLIC_ORIGIN` is the main address: token metadata addresses are built from it, and a page
   opened anywhere else is pointed to it. `EXTRA_ORIGINS` keeps the Render address working
   too. Leave it out and the Render address only shows pages.
3. After the deploy, the log says `origin: answering pages opened at ...` with both addresses.

With `PINATA_JWT` set, changing `PUBLIC_ORIGIN` does not affect tokens that already exist.

**Give your users one address.** A browser keeps each address's storage apart, and a ghost
wallet is stored there. A wallet made at the Render address does not appear at
`privacycash.fun`, and the reverse, until its secret key is exported at one and imported at the
other. Nothing is lost, but it looks lost. Publish the domain, and keep the Render address for
your own checks. If you already made a wallet at the Render address, open the wallet page there,
copy the secret key, and import it at the domain.

## 7. Token logos

**On this site.** The server keeps a copy of every logo it pins on the disk (`/var/data/ipfs`)
and the pages load it from the site itself, at `/ipfs/<identifier>`. A visitor never needs to
reach an IPFS gateway to see a logo here. Tokens launched before this was in place are copied
from IPFS when the server starts; the log says `artwork: 1 of 1 missing file(s) copied from
IPFS to this server's disk`. If a copy cannot be fetched the page shows the token's pixel mark,
and the log names the file.

**Everywhere else.** Wallets and explorers load a token's name and logo from the address in
its metadata, which is written at launch and cannot be changed. `PINATA_GATEWAY_URL` chooses
the gateway in that address for tokens launched from then on:

| Value | What it means |
| --- | --- |
| unset | Pinata's shared public gateway. No setup. Pinata throttles it for everyone and describes it as for testing. |
| `https://NAME.mypinata.cloud/ipfs` | Your own Pinata gateway (Pinata dashboard, Gateways). Not throttled; its traffic counts against your Pinata plan. |
| `https://privacycash.fun/ipfs` | This site. The server answers from its disk. Only once the domain opens the site, and only a domain you will keep. |

Tokens that already exist keep the address they were launched with.

**Taking a logo down.** Add its identifier (the last part of the logo's address) to
`ARTWORK_BLOCKLIST` and deploy. The site stops storing and serving it.

## 8. Things to know

- **Every deploy restarts the service** and there is a short gap, because a service with a disk
  stops before its replacement starts. Deploy at quiet times.
- **Only `/var/data` survives a deploy or restart.** It holds the listing database, which can
  be rebuilt from chain, and the copies of token logos, which are fetched from IPFS again if
  they are lost. Up to 500 MB of the disk is used for logos (`ARTWORK_CACHE_MB`).
- **One instance.** The relay's rate limits live in memory, and the disk cannot be shared.
- **Memory.** Starter is enough with the Ghost desk off. If the service is restarted for
  running out of memory, move up one instance size.
- **The Ghost desk** is off (`GHOST_DESK_ENABLED=NO`). To turn it on, follow Part E of
  [MAINNET_RUNBOOK.md](MAINNET_RUNBOOK.md): the key is made and registered on your computer,
  and the settings in its step 5 go into this service's Environment page.
- **Fee modules** are off. To turn them on, follow Part J of
  [MAINNET_RUNBOOK.md](MAINNET_RUNBOOK.md): the seed is made on your computer, goes into this
  service's Environment page with the gas tank address printed beside it, and is backed up
  offline. It must never be changed afterwards.
- **Secrets.** Only `HELIUS_API_KEY` and `PINATA_JWT` live on Render, with `JUPITER_API_KEY`
  if you turn converting on, `DESK_SECRET_KEY` if you turn the Ghost desk on and
  `MODULES_SEED` if you turn fee modules on. Everything the server logs is passed through a
  filter that hides them.
- **Pausing.** Set `PAUSE_LAUNCHES=YES` or `PAUSE_TRADING=YES` in Environment and deploy. The
  wallet page keeps working.
