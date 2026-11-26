# Helius collaboration kit

**Drafts and local contribution candidate — not submitted.** This kit is separate from the proprietary application source. Review and authorize contribution rights before sending anything externally.

## Recommended first contribution

Target: [helius-labs/custom-privacy-rings](https://github.com/helius-labs/custom-privacy-rings).

Proposed narrow change: a documentation checklist for independent applications to distinguish research readiness from supported, deployed settlement and distinguish shared public vault observations from audited ring-level analytics. It adds no executable transaction path, cryptography or project branding. It is framed as a proposal, not an asserted upstream bug or established protocol requirement.

- [Maintainer discussion draft](UPSTREAM_DISCUSSION.md)
- [Proposed upstream documentation](upstream/docs/application-readiness-checklist.md)
- [Add-only Git patch](0001-docs-application-readiness.patch)
- [Draft PR body](PULL_REQUEST.md)
- [Private Helius integration intake](HELIUS_INTAKE.md)

The patch is an original add-only documentation candidate. Its format and application can be checked locally, but the latest upstream checkout, file placement, maintainers' contribution rules and CI have not been verified against a local clone in this environment. It is not a tested upstream code change. Ask whether this content is wanted and where it belongs before filing a PR. Do not submit multiple duplicate issues, open parallel speculative PRs or ask for review of the entire launchpad.

## Apply after maintainers agree

1. Review current `README`, `CONTRIBUTING`, license/CLA/DCO, issue templates, open PRs and repository permissions. Resolve publication and contribution rights first.
2. Fork the approved repository under your actual account and clone the fork. Add the official upstream remote and fetch the agreed base commit; record its SHA. Create a new branch from that base (replace placeholders with verified values).

```sh
git remote add upstream https://github.com/helius-labs/custom-privacy-rings.git
git fetch upstream
git switch -c docs/application-readiness upstream/main
# Absolute path to the supplied local patch; check the intended file does not already exist.
git apply --check /path/to/0001-docs-application-readiness.patch
git apply /path/to/0001-docs-application-readiness.patch
git diff --check
git add docs/application-readiness-checklist.md
git diff --cached --check
git diff --cached --stat
# Run any upstream-required checks and review the content before committing.
git commit -m "docs: propose application integration readiness checklist"
git push -u origin docs/application-readiness
```

3. Open a **draft PR** from your fork into the agreed upstream branch, using [the proposed PR body](PULL_REQUEST.md) and replacing pending verification fields with actual results. Do not claim upstream CI, compatibility, deployment or approval until verified.

## Future contribution backlog (do not submit yet)

| Target | Contribution candidate | Required before opening |
| --- | --- | --- |
| `custom-privacy-rings` | Policy conformance cases for actual supported operations, negative tests and version/identity preflight | Maintainer-confirmed semantics, pinned release, real localnet/devnet reproduction |
| `privacy-ring-examples` | A minimal supported app integration with explicit public-vs-private data boundaries | Demonstrated SDK compatibility and approved examples/CI conventions; no insecure test keys with live funds |
| `privacy-rings` | A specific SDK/documentation defect or small improvement | Reproducible test against current upstream, actual expected/observed output, no duplicate open PR |

Relevant ongoing development observed on 2026-11-26: [privacy-rings PR #641](https://github.com/helius-labs/privacy-rings/pull/641) concerns TypeScript ring deposits and interfaces; [examples pull requests](https://github.com/helius-labs/privacy-ring-examples/pulls) show ongoing work on example programs and SDK usage. Treat these as context; check current state before commenting or proposing overlapping work.
