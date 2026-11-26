# Helius collaboration kit

**Drafts and local contribution candidate — not submitted.** This kit is separate from the proprietary application source. Review and authorize contribution rights before sending anything externally.

## Recommended first contribution

Target: [helius-labs/custom-privacy-rings](https://github.com/helius-labs/custom-privacy-rings).

Proposed narrow change: a documentation checklist for independent applications to distinguish research readiness from supported, deployed settlement and distinguish shared public vault observations from audited ring-level analytics. It adds no executable transaction path, cryptography or project branding. It is framed as a proposal, not an asserted upstream bug or established protocol requirement.

- [Maintainer discussion draft](UPSTREAM_DISCUSSION.md)
- [Proposed upstream documentation](upstream/docs/application-readiness-checklist.md)
- [Add-only Git patch](0001-docs-application-readiness.patch)
- [Draft PR body](PULL_REQUEST.md)
- [Updated Helius engineering intake](HELIUS_INTAKE.md)
- [V28 upstream proposal](V28_UPSTREAM_PROPOSAL.md)

The patch is an original add-only documentation candidate. Its format and application can be checked locally, but the latest upstream checkout, file placement, maintainers' contribution rules and CI have not been verified against a local clone in this environment. It is not a tested upstream code change. Ask whether this content is wanted and where it belongs before filing a PR. Do not submit multiple duplicate issues, open parallel speculative PRs or ask for review of the entire launchpad.

## Submit after maintainers agree (GitHub website)

Review current upstream contribution rules, license/CLA/DCO and open proposals. Confirm rights before sharing material. Use the GitHub web interface to fork the agreed repository, create a new branch from the current upstream base, and add only the agreed checklist document. Open a draft pull request, attach the verified base revision and actual test evidence, and ask for review. Do not submit the complete application or claim activation, partnership or security certification. The patch is retained as a review artifact; compatibility against the current upstream base remains unverified.

## Future contribution backlog (do not submit yet)

| Target | Contribution candidate | Required before opening |
| --- | --- | --- |
| `custom-privacy-rings` | Policy conformance cases for actual supported operations, negative tests and version/identity preflight | Maintainer-confirmed semantics, pinned release, real localnet/devnet reproduction |
| `privacy-ring-examples` | A minimal supported app integration with explicit public-vs-private data boundaries | Demonstrated SDK compatibility and approved examples/CI conventions; no insecure test keys with live funds |
| `privacy-rings` | A specific SDK/documentation defect or small improvement | Reproducible test against current upstream, actual expected/observed output, no duplicate open PR |

Relevant ongoing development observed on 2026-11-26: [privacy-rings PR #641](https://github.com/helius-labs/privacy-rings/pull/641) concerns TypeScript ring deposits and interfaces; [examples pull requests](https://github.com/helius-labs/privacy-ring-examples/pulls) show ongoing work on example programs and SDK usage. Treat these as context; check current state before commenting or proposing overlapping work.
