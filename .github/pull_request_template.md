## Problem and scope

<!-- What observable behavior changes? Link a focused issue/design note. -->

## Implementation and trust boundaries

<!-- Mainnet path, research-only path, dependencies, keys, public visibility, auditor/operator powers. -->

## Verification

- [ ] `npm run ghost:baseline`
- [ ] `npm run ghost:check`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm run --silent ghost:demo` evidence reviewed (if affected)
- [ ] Relevant browser/API smoke checks run (or explicitly marked pending)

Actual output, environment, and any blocked checks:

## Risk and release scope

- [ ] No new real-fund execution path, or separate review and approval explicitly identified
- [ ] No secrets, real wallet data, or unsupported privacy/audit/compliance claims
- [ ] Dependencies, license and upstream contribution rights reviewed if applicable
- [ ] Protected baseline changes explicitly reviewed (if any)

Rollback / limitations:
