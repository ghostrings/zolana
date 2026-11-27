# Helius Privacy engineering — integration request (draft, not submitted)

Hello Helius Privacy team,

We're building GHOST Markets / privacycash.fun, an independent Solana launchpad and market protocol. Our current native mainnet program provides token issuance, bonding curves, AMM graduation and public SPL execution. We have registered our first native token ZOL for Default Ring holdings, asset #559.

Website: https://privacycash.fun
Repository: https://github.com/ghostrings/zolana
Program: 5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n
Market: AqwuGpwStiafXGnwqxEQ1sdqnPodnytvWrzU71odCrrg
Mint: 2P2pLKSZr48zr7M3GQWEC4uwNgRv9JbJn3Ja2a9DutgX

Our next research milestone is proof-backed confidential exchange for supported assets. We are preparing a pinned local SPL/SOL test of the upstream Xark example (SDK 0.10.0). The test keys are explicitly insecure and will not be used with real assets. We do not claim private native settlement, a live Custom Ring, or Helius endorsement.

Could your engineering team clarify the supported production protocol/SDK combinations, secure proving-artifact generation and verification-key review, the recommended application CPI settlement interface and audit requirements, asset and fee conservation/expiry/recovery expectations, and the current Custom Ring registration and activation process for approved applications? We'd also appreciate guidance on policy enforcement, audit access and accountable disclosures. We want to demonstrate real confidential settlement in a controlled test environment before considering production integration.

We're interested in contributing reproducible integration findings and test improvements upstream.

GHOSTRINGS / privacycash.fun
