# GHOST Markets V27 — mainnet evidence

This directory contains an exact transcription of the owner's November 26, 2026 successful deployment and RPC byte-verification output, not an independently fetched receipt or an audit. The record describes the intentionally locked binary at its original deployment slot. Current state can change through the upgrade authority. No market execution, Custom Ring activation or private settlement is reported.

- [Recorded release](ghost-markets-v27.json)
- [Program explorer](https://explorer.solana.com/address/5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n)
- [Deployment transaction](https://explorer.solana.com/tx/5TMpEwE2XkjWTfY42XShQPks3UoYrVEDWiHFdAzcCXeJcZ1wnu6AXyEaXefQn3cx3geMixMHjKtziSe6vtXaANjT)

## Read-only verification

From the repository root, after `npm ci`:

```sh
npm run markets:observe -- status
```

The observer checks finalized accounts against the recorded deployment. It refuses mismatched identities, authorities or code. An RPC response is a point-in-time provider observation, not independently proven chain state. A hash comparison is not an audit, a reproducible build or a security claim.

## Exact release export (owner's Ubuntu machine)

The original sealed release, generated IDL and executable were never supplied to the packaging environment. This repository deliberately does not fabricate them. The developer source under `protocol/ghost-markets` retains a local test placeholder program ID; the permanent production source was synchronized with the real ID during preparation. To publish the exact artifact and source snapshot from the private release directory, run the read-only export script:

```sh
cd ~/src/Ghostring/protocol/ghost-markets
bash scripts/export-mainnet-evidence.sh
```

The script verifies the sealed manifest and source checksums against the original recorded byte digest and checks current RPC verification. It copies only allowlisted public release files to `deployments/mainnet/v27-release/`; it refuses an existing export directory. Review publication rights and files before manually uploading. Do not copy the parent key directory, build workspace, private keypairs, wallet recovery phrases, or `.env` files. It does not send any transaction or require wallet signatures. If the deployment changed or the protocol was initialized after the original verification, the legacy strict verifier will stop; investigate instead of bypassing it.

## Owner-reported V28 finalized observations (2026-11-26)

The owner subsequently ran both `markets:observe -- status` and `markets:observe -- scan`. The supplied results reported matching deployed bytecode, deployment slot and upgrade authority, an uninitialized protocol (`null`), disabled market execution and disabled private settlement. The finalized market scan at slot `474269887` returned an empty list. These are point-in-time RPC observations, not a claim about every later slot. The owner also reported that application checks passed and showed a successful public release export. See [transcribed observations](v28-observations.json). The actual exported artifact directory was not supplied to the packaging environment and is not part of this ZIP.
