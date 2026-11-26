# Manual GitHub publication

**Owner namespace:** [ghostrings](https://github.com/ghostrings) · **Application repository:** [ghostrings/zolana](https://github.com/ghostrings/zolana) · **Default branch:** `main`.

The destination exists with default branch `main` and public visibility. The owner manually uploaded the previous source package; this combined candidate makes no remote changes. The archive contains the repository root directly. The owner must review source publication rights and credentials before uploading; switch to private visibility for initial review if needed.

## 1. Before upload

Keep the full application private for initial review. No source license has been selected; see [NOTICE](../../NOTICE.md). Confirm ownership, asset rights and third-party obligations before public release. Review the files and history with a dedicated secret scanner (for example Gitleaks); rotate exposed credentials. Never upload real `.env`, wallet exports, keys, databases, deployment credentials or production logs. `.env.example` is a template, not a production configuration. Use the extracted public-source archive, not a working directory or parent deployment folder. Browser uploads ignore `.gitignore`. See the [publication safety record](PUBLICATION_CHECK.md); the archive inventory and pattern review are not a comprehensive audit or scan of repository history.

## 2. Browser upload (no command line required)

1. Use the existing `ghostrings/zolana` repository after completing the publication review above. If GitHub requires a first commit for the web uploader, initialize with a temporary README only; the supplied README replaces it. Do not select a license on behalf of the owner.
2. Extract the upload package; do **not** upload the ZIP itself or an enclosing directory. The single ZIP contains the entire repository; select files and directories in batches if uploading through the browser. GitHub limits web uploads to 100 files per operation and 25 MiB per file. Drag files and folders preserving their paths to the repository root via **Add file → Upload files**. Preserve the nested directories and filenames; commit each batch. If using an existing repository, upload on a new branch and review the diff instead of overwriting its default branch.
3. Enable hidden-file visibility in your file manager (Windows: View → Show → Hidden items; macOS: Command-Shift-period). Verify `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `.env.example`, `.gitattributes`, `.gitignore`, `.editorconfig` and `.node-version` appear at the right paths. If the browser refuses dotfiles or flattens paths, use GitHub Desktop as below. A browser upload does not apply `.gitattributes` conversion rules; upload the extracted files unmodified.
4. After the last batch, check the root file list against the extracted archive. The repository should have `README.md`, `package.json`, `package-lock.json`, `web/`, `server/`, `shared/`, `docs/` and `.github/` at the root. Confirm the header, diagrams and all relative links render. Do not publish the outer delivery folder, the upload manifest, private packaging ZIPs, or a repository profile package into this application repo.

Reference: [GitHub browser upload documentation](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository).

## 3. GitHub Desktop alternative (recommended if folder upload fails)

Clone `ghostrings/zolana` in GitHub Desktop, then copy the **contents** of the full repository source ZIP into that clone. Review all changes in Desktop (including hidden files), commit, then push using Desktop. If working with an existing repo, create a new branch first. Never replace its `.git` folder or force-push. No Git history bundle or additional archive is required.

## 4. Repository presentation

Use these values in the repository's About panel:

- **Description:** Solana launchpad, self-custodial privacy wallet, confidential settlement and Custom Ring integration research.
- **Website:** https://privacycash.fun
- **Topics:** `solana`, `privacy`, `typescript`, `helius`, `meteora`, `defi`, `zero-knowledge`, `custom-rings`, `launchpad`
- **Social preview:** upload [docs/assets/social-preview.png](../assets/social-preview.png) in Settings → General → Social preview.
- **Profile avatar:** optionally use [docs/assets/avatar.png](../assets/avatar.png) on the `ghostrings` account.

The avatar and social preview are already included in `docs/assets/`; no separate profile archive is required.

## 5. Verify and protect

- Run `npm ci`, `npm run verify` and reproduce the committed demo on a clean checkout. The original 229 protected hashes must match. Use the exact Node version in `.node-version`; see [validation](VALIDATION.md).
- In GitHub Actions, check the actual **Engineering verification** run for the final upload. The workflow never deploys, signs transactions or requires a secret. If partial uploads triggered failed or cancelled builds, review the final complete run rather than asserting CI passed. Prefer a single commit of the full package on an update branch; see [CI recovery](CI_RECOVERY.md). The new market workflows are independent of the application build.
- Require the observed CI check and independent reviewer approval on `main`; disable force pushes. Enable private vulnerability reporting. Review action version references and pin verified SHAs if required by your policy. No production secrets belong in PR workflows.
- Review dependency advisories, full typecheck/build, HTTP and browser checks, and licensing. No live Custom Ring is included. CI success alone is not security approval.
- Use the included PR template for changes; if sharing a candidate release, mark it as a pre-release (suggested tag `v27.0.0-rc.1`) and attach the actual validation report. Never claim the application is audited or that the locked mainnet deployment enables trading or private settlement. The recorded V27 deployment is distinct from V28 source and the pending Custom Ring.

## 6. Engage Helius

Once there is an approved repository URL and exact commit SHA, review [the engineering intake draft](../../contrib/helius/HELIUS_INTAKE.md). Replace the pending contact, CI and revision details with genuine evidence. Helius's [Custom Rings integration page](https://www.helius.dev/docs/privacy/integration/custom-ring) provides the engineering support route.

Follow [the upstream contribution kit](../../contrib/helius/README.md) only after confirming the current upstream base, contribution rights and scope with maintainers. The local add-only patch is a proposal, not an upstream change or acceptance. The package does not create repositories, send an application, open issues or submit PRs automatically.
