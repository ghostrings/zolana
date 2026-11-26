/**
 * Addresses and brand constants.
 *
 * Program ids are taken from the Helius "Addresses" page and the Meteora DBC
 * SDK README. `ops/doctor.ts` re-checks every one of them against the RPC it
 * is pointed at before anything is launched.
 */

export const BRAND = Object.freeze({
  name: 'privacycash.fun',
  short: 'PCF',
  tagline: 'GHOST MARKETS',
  domain: 'privacycash.fun',
  url: 'https://privacycash.fun',
  x: 'https://x.com/privacycashfun',
  xHandle: '@privacycashfun',
});

/**
 * The release this code is. It is in every page's footer and in `/api/status`,
 * so which release a server is running can be read off the live site instead
 * of guessed. Raised with every release; `tests/release.test.ts` holds the
 * footer to it.
 */
export const RELEASE = 'v24';

/**
 * This platform runs on Solana mainnet-beta and nothing else. There is no
 * devnet or test mode: the type has one member so that no code path can carry
 * another network, and every RPC is checked against the mainnet genesis hash
 * before it is used.
 */
export type Network = 'mainnet';
export const NETWORK: Network = 'mainnet';

/** Solana Privacy Program (shielded pool). */
export const SPP_PROGRAM_ID = 'ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW';
/** User registry: maps a Solana address to a shielded address. */
export const USER_REGISTRY_PROGRAM_ID = 'regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ';
/** Default state Merkle tree. */
export const SPP_DEFAULT_TREE = '777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor';

/** Meteora Dynamic Bonding Curve. */
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
/** Meteora DAMM v2 (cp-amm), where graduated pools trade. */
export const DAMM_V2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SOL_DECIMALS = 9;

/** Every launchpad token uses these. Changing them means new configs. */
export const TOKEN_DECIMALS = 6;
export const TOKEN_TOTAL_SUPPLY = 1_000_000_000;
/** Base units a launched token starts with: its whole supply, before any burn. */
export const INITIAL_SUPPLY_UNITS = BigInt(TOKEN_TOTAL_SUPPLY) * 10n ** BigInt(TOKEN_DECIMALS);

/** Helius mainnet RPC root. The server proxies it so the API key stays private. */
export const HELIUS_RPC = 'https://mainnet.helius-rpc.com';

/** Where the SDK downloads the signed prover attestation policy. */
export const TEE_POLICY_HOST = 'd3gbdb0egjwcw9.cloudfront.net';

/** Genesis hash of Solana mainnet-beta. An RPC that reports any other is refused. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/**
 * Meteora's keeper graduates a completed SOL curve on its own only when the
 * curve's target is at least this much SOL (Meteora docs, "What is DBC").
 * Below it, graduation is sent by hand. The rule for every pair is
 * `keeperRule` in `quotes.ts`.
 */
export const KEEPER_MIN_THRESHOLD_LAMPORTS = 10_000_000_000n;

/**
 * The smallest amount the platform sends a creator in one payout of pool
 * fees, in SOL terms. A transfer to a wallet that holds nothing must leave it
 * rent-exempt (890,880 lamports), so a smaller share is not claimed: it stays
 * in the pool, still accruing, until it reaches this. For a pool priced in
 * another pair token the same value is used, converted at that pair's rate.
 */
export const MIN_CREATOR_PAYOUT_LAMPORTS = 2_000_000n;

/**
 * What it costs to open a token account, in lamports: the rent a 165-byte
 * account must hold. A wallet trading against a pair token other than SOL
 * needs an ordinary token account for it, opened once and left open.
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/**
 * The same for a wallet's token account under the Token-2022 program, which
 * is five bytes longer: a byte saying what kind of account it is, and the
 * note that its owner can never be changed.
 */
export const TOKEN_2022_ACCOUNT_RENT_LAMPORTS = 2_074_080n;

/**
 * Meteora's own fee on the liquidity that moves into the pool at graduation,
 * in basis points. Set by Meteora's program and stored on each pool; this is
 * the SDK's value, used only to print an estimate before anything exists.
 */
export const METEORA_GRADUATION_FEE_BPS = 20;

/** Public SOL a wallet keeps back for fees and temporary account rent. */
export const GAS_RESERVE_LAMPORTS = 15_000_000n;

/** Version 1 transaction ceilings (bytes and account addresses). */
export const TX_V1_MAX_BYTES = 4096;
export const TX_V1_MAX_ACCOUNTS = 64;

/** `loadedAccountsDataSizeLimit` the Rings SDK itself sets on every transact. */
export const LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;

/**
 * Compute budgets per transaction kind, set in the v1 message header.
 *
 * The Rings SDK allows 450,000 units for one transact and reports 305,340 used
 * by the widest one it measured. These follow that allowance. They have not
 * been measured on chain for this project's own compositions: a budget that is
 * too small fails in simulation, before any fee is paid, and is raised here
 * (1,400,000 is the network's ceiling). The priority fee is priced on the
 * budget, not on what is used, so they are not set higher than needed.
 */
export const COMPUTE_UNITS = Object.freeze({
  /** One proofless deposit, or one transact. */
  single: 450_000,
  /** Withdraw (one transact) + Meteora swap + proofless deposit. */
  shieldedTrade: 900_000,
  /** Create pool + create Rings interface + first buy + deposit. */
  launch: 1_200_000,
  /** Handing a pool's creator role to a fee module wallet, with the settings memo. */
  moduleActivation: 300_000,
  /** Two transacts in one transaction (Ghost fill): the SDK's allowance, twice. */
  ghostFill: 900_000,
  /** Withdraw (one transact) + token burn + closing the temporary token account. */
  burn: 520_000,
  /** A token burn from an ordinary token account, and closing it when it is emptied. */
  publicBurn: 40_000,
  /** Moving a completed curve into its DAMM v2 pool. The Meteora SDK's own allowance for it. */
  graduation: 600_000,
});
