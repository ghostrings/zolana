/**
 * Jupiter `/swap/v2/build` answers for the tests.
 *
 * The first three `LIVE_*` answers are what Jupiter's API returned on
 * 2026-11-23 for `transactionVersion=1`, read with no key and no funds. The
 * first is whole. The other two keep the instructions around the swap and the
 * first twelve accounts of the swap itself, which is every position this code
 * reads; the route's own pool accounts that followed are left out.
 *
 * The three after them were read the same way on 2026-11-25, for tokens this
 * site has no pair for: BONK, an SPL Token mint, bought and sold; and PYUSD, a
 * Token-2022 mint, which is whole and shows where Jupiter puts a Token-2022
 * token's program and the wallet's account for it.
 *
 * `answerFor` builds an answer of the same shape for any request, so a test
 * can ask for one for its own wallet and then change one thing about it.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../shared/src/constants.js';
import { type BuildRequest, JUPITER_PROGRAM_ID, programsOf } from '../shared/src/jupiter.js';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const ZEC_MINT = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS';
/** BONK: an SPL Token mint with five decimals that this site has no pair for. */
export const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
/** PayPal USD: a Token-2022 mint. Its extensions are ones this site refuses; its answer is kept for its shape. */
export const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';

export const LIVE_TAKER = 'GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ';
const LIVE_WSOL_ACCOUNT = 'GSFbPvFTbfcRNGs4EEZVF8tBjV6ChcTaBrTYGGsDAq8o';
const LIVE_USDC_ACCOUNT = 'GWWjoZ2bZikAhhMAH5V3Mp6goHqnWAT6KqCZSHmqtoZ';
const LIVE_ZEC_ACCOUNT = '8cW5vcR4WjtxThuQHaA9aq47uTvS2aMZzAfMcba3y8ri';
const LIVE_BONK_ACCOUNT = '2XscHuqupXCSoKnqrAcYvfjCgMSv42b42UvBk1igH1wA';
/** The live wallet's account for PYUSD, which is where the Token-2022 program puts it. */
export const LIVE_PYUSD_ACCOUNT = 'CkPg6aWTda2Su6xdJBBo3t9By6rfu23JuVYprWkHhsgQ';
const EVENT_AUTHORITY = 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';

interface RawAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface RawInstruction {
  programId: string;
  accounts: RawAccount[];
  data: string;
}

/** "address, S or -, W or -" per line, as the answers were noted down. */
function accounts(lines: string): RawAccount[] {
  return lines
    .trim()
    .split('\n')
    .map((line) => {
      const [pubkey, signer, writable] = line.trim().split(/\s+/) as [string, string, string];
      return { pubkey, isSigner: signer === 'S', isWritable: writable === 'W' };
    });
}

const openAccount = (owner: string, account: string, mint: string, program: string = TOKEN_PROGRAM_ID): RawInstruction => ({
  programId: ASSOCIATED_TOKEN_PROGRAM_ID,
  data: 'AQ==',
  accounts: accounts(`
    ${owner} S W
    ${account} - W
    ${owner} - -
    ${mint} - -
    ${SYSTEM_PROGRAM_ID} - -
    ${program} - -`),
});

const unwrap = (owner: string, account: string): RawInstruction => ({
  programId: TOKEN_PROGRAM_ID,
  data: 'CQ==',
  accounts: accounts(`
    ${account} - W
    ${owner} - W
    ${owner} S -`),
});

/** 0.1 SOL to USDC through two venues: `route_v2`, the whole answer. */
export const LIVE_SOL_TO_USDC = Object.freeze({
  request: { inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 100_000_000n, taker: LIVE_TAKER, slippageBps: 50, maxAccounts: 28 } satisfies BuildRequest,
  body: {
    inputMint: WSOL_MINT,
    outputMint: USDC_MINT,
    inAmount: '100000000',
    outAmount: '7726964',
    otherAmountThreshold: '7688330',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.0002887237661482111688754835',
    routePlan: [
      { swapInfo: { ammKey: '8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj', label: 'Raydium CLMM' }, percent: 38.2, bps: 3820 },
      { swapInfo: { ammKey: 'DbuvwPuLvH8uy2B1sKuu18aCd2QpCvfZdfDtdRZztBd2', label: '1DEX' }, percent: 61.8, bps: 6180 },
    ],
    computeBudgetInstructions: [],
    setupInstructions: [
      openAccount(LIVE_TAKER, LIVE_WSOL_ACCOUNT, WSOL_MINT),
      {
        programId: SYSTEM_PROGRAM_ID,
        data: 'AgAAAADh9QUAAAAA',
        accounts: accounts(`
          ${LIVE_TAKER} S W
          ${LIVE_WSOL_ACCOUNT} - W`),
      },
      { programId: TOKEN_PROGRAM_ID, data: 'EQ==', accounts: accounts(`${LIVE_WSOL_ACCOUNT} - W`) },
      openAccount(LIVE_TAKER, LIVE_USDC_ACCOUNT, USDC_MINT),
    ],
    swapInstruction: {
      programId: JUPITER_PROGRAM_ID,
      data: 'u2T6zDHErxQA4fUFAAAAAHTndQAAAAAAMgAAAAAAAgAAABrsDgACMCQYAAI=',
      accounts: accounts(`
        ${LIVE_TAKER} S -
        ${LIVE_WSOL_ACCOUNT} - W
        ${LIVE_USDC_ACCOUNT} - W
        ${WSOL_MINT} - -
        ${USDC_MINT} - -
        ${TOKEN_PROGRAM_ID} - -
        ${TOKEN_PROGRAM_ID} - -
        ${JUPITER_PROGRAM_ID} - -
        ${EVENT_AUTHORITY} - -
        ${JUPITER_PROGRAM_ID} - -
        CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK - -
        ${LIVE_TAKER} - -
        9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x - -
        8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj - W
        ${LIVE_WSOL_ACCOUNT} - W
        ${LIVE_USDC_ACCOUNT} - W
        6P4tvbzRY6Bh3MiWDHuLqyHywovsRwRpfskPvyeSoHsz - W
        6mK4Pxs6GhwnessH7CvPivqDYauiHZmAdbEFDpXFk9zt - W
        3MsJXVvievxAbsMsaT6TS4i6oMitD9jazucuq3X234tC - W
        ${TOKEN_PROGRAM_ID} - -
        EEtqknbrycxTexrVBNy1xG9TQgMe8V4FqdV5ytheNV92 - W
        DoPuiZfJu7sypqwR4eiU7C5TMcmmiFoU4HaF5SoD8mRy - W
        APEXc4zwGN6Hu3yR8vdGMiq7uyS7xyeZFjJE9UZWCvnr - W
        Bqir4ZvrNKbXZX2JMRXMZGy2bCoiWL55TesnV36yDfH7 - W
        ${JUPITER_PROGRAM_ID} - -
        DEXYosS6oEGvk8uCDayvwEZz4qEyDJRf9nFgYCaqPMTm - -
        5nmAbnjJfW1skrPvYjLTBNdhoKzJfznnbvDcM8G2U7Ki - -
        DbuvwPuLvH8uy2B1sKuu18aCd2QpCvfZdfDtdRZztBd2 - W
        Enc6rB84ZwGxZU8aqAF41dRJxg3yesiJgD7uJFVhMraM - -
        HZ5JFB1ZoZs6NQLr7bb4MMEXDgty4Vs1ZghoyX35mNnV - W
        AHFAv95Z67xnPYuHTf5a9uMEHdXFvbQvwc4EazY3tpt7 - W
        ${LIVE_TAKER} - W
        ${LIVE_WSOL_ACCOUNT} - W
        ${LIVE_USDC_ACCOUNT} - W
        GswwnegnBMWEuEsptDCBDmRB9YtG5zjetTSw7RunUQMY - W
        DuFXxPxAyJhHj4gMpE8As1Ta4nSSVXv8xfEDRrWQmJ9G - W
        ${TOKEN_PROGRAM_ID} - -`),
    },
    cleanupInstruction: unwrap(LIVE_TAKER, LIVE_WSOL_ACCOUNT),
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    blockhashWithMetadata: { blockhash: [], lastValidBlockHeight: 450_990_901 },
    transactionVersion: 1,
    computeUnitPrice: '26328',
  },
});

/** 50 USDC to bridged ZEC over two hops: `shared_accounts_route_v2`. The swap's first twelve accounts. */
export const LIVE_USDC_TO_ZEC = Object.freeze({
  request: { inputMint: USDC_MINT, outputMint: ZEC_MINT, amount: 50_000_000n, taker: LIVE_TAKER, slippageBps: 50, maxAccounts: 64 } satisfies BuildRequest,
  body: {
    inputMint: USDC_MINT,
    outputMint: ZEC_MINT,
    inAmount: '50000000',
    outAmount: '5696591',
    otherAmountThreshold: '5668109',
    swapMode: 'ExactIn',
    slippageBps: 50,
    routePlan: [
      { swapInfo: { ammKey: 'AfaA4CE8C2DWSHANCqvU9RWrxRiXCV7KKVSw4cHi68Wn', label: 'BisonFi' }, percent: 100, bps: 10_000 },
      { swapInfo: { ammKey: 'ELd5tdWhSHpPgNePKvNVB2N5jSQMf8SqZXz24q9sQnjN', label: 'Whirlpool' }, percent: 100, bps: 10_000 },
    ],
    computeBudgetInstructions: [],
    setupInstructions: [openAccount(LIVE_TAKER, LIVE_ZEC_ACCOUNT, ZEC_MINT)],
    swapInstruction: {
      programId: JUPITER_PROGRAM_ID,
      data: '0ZhTk3z+2OkGgPD6AgAAAABP7FYAAAAAADIAAAAAAAIAAADNABAnAAEvAQAQJwEC',
      accounts: accounts(`
        9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8 - -
        ${LIVE_TAKER} S -
        ${LIVE_USDC_ACCOUNT} - W
        EXrqY7jLTLp83H38L8Zw3GvGkk1KoQbYTckPGBghwD8X - W
        E8qw1KPofhDR1QA8J2zSHuDkcdDWmkk8MU86sS3e3yqp - W
        ${LIVE_ZEC_ACCOUNT} - W
        ${USDC_MINT} - -
        ${ZEC_MINT} - -
        ${TOKEN_PROGRAM_ID} - -
        ${TOKEN_PROGRAM_ID} - -
        ${EVENT_AUTHORITY} - -
        ${JUPITER_PROGRAM_ID} - -`),
    },
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    transactionVersion: 1,
    computeUnitPrice: '5467',
  },
});

/** 0.05 bridged ZEC to SOL in one hop, asked to fit 20 accounts: `route_v2`. The swap's first twelve accounts. */
export const LIVE_ZEC_TO_SOL = Object.freeze({
  request: { inputMint: ZEC_MINT, outputMint: WSOL_MINT, amount: 5_000_000n, taker: LIVE_TAKER, slippageBps: 50, maxAccounts: 20 } satisfies BuildRequest,
  body: {
    inputMint: ZEC_MINT,
    outputMint: WSOL_MINT,
    inAmount: '5000000',
    outAmount: '570180000',
    otherAmountThreshold: '567329100',
    swapMode: 'ExactIn',
    slippageBps: 50,
    routePlan: [{ swapInfo: { ammKey: 'EVwA1Hsgyt6gn7wAnDnsrqasmBLiRDTHn2qfheH7At3t', label: 'Scorch' }, percent: 100, bps: 10_000 }],
    computeBudgetInstructions: [],
    setupInstructions: [openAccount(LIVE_TAKER, LIVE_WSOL_ACCOUNT, WSOL_MINT)],
    swapInstruction: {
      programId: JUPITER_PROGRAM_ID,
      data: 'u2T6zDHErxRAS0wAAAAAAKBB/CEAAAAAMgAAAAAAAQAAAM/QMRUxp8WuCgIAAAAMAAUAECcAAQ==',
      accounts: accounts(`
        ${LIVE_TAKER} S -
        ${LIVE_ZEC_ACCOUNT} - W
        ${LIVE_WSOL_ACCOUNT} - W
        ${ZEC_MINT} - -
        ${WSOL_MINT} - -
        ${TOKEN_PROGRAM_ID} - -
        ${TOKEN_PROGRAM_ID} - -
        ${JUPITER_PROGRAM_ID} - -
        ${EVENT_AUTHORITY} - -
        ${JUPITER_PROGRAM_ID} - -
        SCoRcH8c2dpjvcJD6FiPbCSQyQgu3PcUAWj2Xxx3mqn - -
        EHcege7dok1iYs7SxL2XzDPvhg6XzMVcx2V5SkMUurJP - -`),
    },
    cleanupInstruction: unwrap(LIVE_TAKER, LIVE_WSOL_ACCOUNT),
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    transactionVersion: 1,
    computeUnitPrice: '7174',
  },
});

/** 0.1 SOL to BONK over three hops, with no limit on accounts asked: `shared_accounts_route_v2`. The swap's first twelve of 52 accounts. */
export const LIVE_SOL_TO_BONK = Object.freeze({
  request: { inputMint: WSOL_MINT, outputMint: BONK_MINT, amount: 100_000_000n, taker: LIVE_TAKER, slippageBps: 50, maxAccounts: 64 } satisfies BuildRequest,
  body: {
    inputMint: WSOL_MINT,
    outputMint: BONK_MINT,
    inAmount: '100000000',
    outAmount: '328017147199',
    otherAmountThreshold: '326377061464',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0',
    routePlan: [
      { swapInfo: { label: 'Whirlpool' }, percent: 12.64 },
      { swapInfo: { label: 'Whirlpool' }, percent: 100 },
      { swapInfo: { label: 'Whirlpool' }, percent: 87.36 },
    ],
    computeBudgetInstructions: [],
    setupInstructions: [
      openAccount(LIVE_TAKER, LIVE_WSOL_ACCOUNT, WSOL_MINT),
      {
        programId: SYSTEM_PROGRAM_ID,
        data: 'AgAAAADh9QUAAAAA',
        accounts: accounts(`
          ${LIVE_TAKER} S W
          ${LIVE_WSOL_ACCOUNT} - W`),
      },
      { programId: TOKEN_PROGRAM_ID, data: 'EQ==', accounts: accounts(`${LIVE_WSOL_ACCOUNT} - W`) },
      openAccount(LIVE_TAKER, LIVE_BONK_ACCOUNT, BONK_MINT),
    ],
    swapInstruction: {
      programId: JUPITER_PROGRAM_ID,
      data: '0ZhTk3z+2OkFAOH1BQAAAAA/dVhfTAAAADIAAAAAAAMAAAAvAQDwBAABEQAQJwEDEQEgIgAD',
      accounts: accounts(`
        CapuXNQoDviLvU1PxFiizLgPNQCxrsag1uMeyk6zLVps - -
        ${LIVE_TAKER} S -
        ${LIVE_WSOL_ACCOUNT} - W
        91bUbswo6Di8235jAPwim1At4cPZLbG2pkpneyqKg4NQ - W
        8RRLouGA1QHZAT7ZZ3pp9nbi3B6bmKZdRGkPoLhmLqyK - W
        ${LIVE_BONK_ACCOUNT} - W
        ${WSOL_MINT} - -
        ${BONK_MINT} - -
        ${TOKEN_PROGRAM_ID} - -
        ${TOKEN_PROGRAM_ID} - -
        ${EVENT_AUTHORITY} - -
        ${JUPITER_PROGRAM_ID} - -`),
    },
    cleanupInstruction: unwrap(LIVE_TAKER, LIVE_WSOL_ACCOUNT),
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    transactionVersion: 1,
    computeUnitPrice: '103',
  },
});

/** Ten million BONK to SOL in one hop, asked to fit 30 accounts: `route_v2`. The swap's first twelve of 29 accounts. */
export const LIVE_BONK_TO_SOL = Object.freeze({
  request: { inputMint: BONK_MINT, outputMint: WSOL_MINT, amount: 1_000_000_000_000n, taker: LIVE_TAKER, slippageBps: 50, maxAccounts: 30 } satisfies BuildRequest,
  body: {
    inputMint: BONK_MINT,
    outputMint: WSOL_MINT,
    inAmount: '1000000000000',
    outAmount: '304960000',
    otherAmountThreshold: '303435200',
    swapMode: 'ExactIn',
    slippageBps: 50,
    routePlan: [{ swapInfo: { label: 'Scorch' }, percent: 100 }],
    computeBudgetInstructions: [],
    setupInstructions: [openAccount(LIVE_TAKER, LIVE_WSOL_ACCOUNT, WSOL_MINT)],
    swapInstruction: {
      programId: JUPITER_PROGRAM_ID,
      data: 'u2T6zDHErxQAEKXU6AAAAABSLRIAAAAAMgAAAAAAAQAAAM+g/eI7bTq3SVemCwAMAAUAECcAAQ==',
      accounts: accounts(`
        ${LIVE_TAKER} S -
        ${LIVE_BONK_ACCOUNT} - W
        ${LIVE_WSOL_ACCOUNT} - W
        ${BONK_MINT} - -
        ${WSOL_MINT} - -
        ${TOKEN_PROGRAM_ID} - -
        ${TOKEN_PROGRAM_ID} - -
        ${JUPITER_PROGRAM_ID} - -
        ${EVENT_AUTHORITY} - -
        ${JUPITER_PROGRAM_ID} - -
        SCoRcH8c2dpjvcJD6FiPbCSQyQgu3PcUAWj2Xxx3mqn - -
        EHcege7dok1iYs7SxL2XzDPvhg6XzMVcx2V5SkMUurJP - -`),
    },
    cleanupInstruction: unwrap(LIVE_TAKER, LIVE_WSOL_ACCOUNT),
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    transactionVersion: 1,
    computeUnitPrice: '9127',
  },
});

/**
 * 0.1 SOL to PYUSD by way of USDC, asked to fit 30 accounts: `route_v2`, the
 * whole answer. PYUSD is a Token-2022 mint: its program stands where the
 * program of what is bought stands, the wallet's account for it is the one
 * that program gives, and the account is opened under that program. The
 * route also passes through the wallet's own USDC account, which it opens.
 */
export const LIVE_SOL_TO_PYUSD = Object.freeze({
  request: {
    inputMint: WSOL_MINT,
    outputMint: PYUSD_MINT,
    amount: 100_000_000n,
    taker: LIVE_TAKER,
    slippageBps: 50,
    maxAccounts: 30,
    outputProgram: TOKEN_2022_PROGRAM_ID,
  } satisfies BuildRequest,
  body: {
    inputMint: WSOL_MINT,
    outputMint: PYUSD_MINT,
    inAmount: '100000000',
    outAmount: '6795558',
    otherAmountThreshold: '6761581',
    swapMode: 'ExactIn',
    slippageBps: 50,
    routePlan: [
      { swapInfo: { label: 'Kipseli' }, percent: 100 },
      { swapInfo: { label: 'Manifest' }, percent: 100 },
    ],
    computeBudgetInstructions: [],
    setupInstructions: [
      openAccount(LIVE_TAKER, LIVE_WSOL_ACCOUNT, WSOL_MINT),
      {
        programId: SYSTEM_PROGRAM_ID,
        data: 'AgAAAADh9QUAAAAA',
        accounts: accounts(`
          ${LIVE_TAKER} S W
          ${LIVE_WSOL_ACCOUNT} - W`),
      },
      { programId: TOKEN_PROGRAM_ID, data: 'EQ==', accounts: accounts(`${LIVE_WSOL_ACCOUNT} - W`) },
      openAccount(LIVE_TAKER, LIVE_USDC_ACCOUNT, USDC_MINT),
      openAccount(LIVE_TAKER, LIVE_PYUSD_ACCOUNT, PYUSD_MINT, TOKEN_2022_PROGRAM_ID),
    ],
    swapInstruction: {
      programId: JUPITER_PROGRAM_ID,
      data: 'u2T6zDHErxQA4fUFAAAAACaxZwAAAAAAMgAAAAAAAgAAAM4BECcAAXQAECcBAg==',
      accounts: accounts(`
        ${LIVE_TAKER} S -
        ${LIVE_WSOL_ACCOUNT} - W
        ${LIVE_PYUSD_ACCOUNT} - W
        ${WSOL_MINT} - -
        ${PYUSD_MINT} - -
        ${TOKEN_PROGRAM_ID} - -
        ${TOKEN_2022_PROGRAM_ID} - -
        ${JUPITER_PROGRAM_ID} - -
        ${EVENT_AUTHORITY} - -
        ${JUPITER_PROGRAM_ID} - -
        3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU - -
        ${LIVE_TAKER} - -
        7yD7gfXv49SFxhx9uTc11dEd7Nj98rGWeYMdZJgheZbG - W
        HgFLBWQugxt6qbPaWiwXjrqauXdQmcpMV6H6t8ttD8s1 - W
        FzvRbXDdrsYVMa9KohXyQytWNAZAo4PsF8yujDH7KCfG - W
        ${WSOL_MINT} - -
        ${USDC_MINT} - -
        ${LIVE_WSOL_ACCOUNT} - W
        ${LIVE_USDC_ACCOUNT} - W
        ${TOKEN_PROGRAM_ID} - -
        ${SYSTEM_PROGRAM_ID} - -
        ${LIVE_TAKER} - -
        Df2r2qyaCS8u3JG2RHRg2yjE2qrAAjcLWa7F95fNJrjJ - -
        Df2r2qyaCS8u3JG2RHRg2yjE2qrAAjcLWa7F95fNJrjJ - -
        J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv - -
        Sysvar1nstructions1111111111111111111111111 - -
        9mYEd71VzXZoa8a3B3Zw5TG6C3N7qLRGnw2JdtocsrrS - -
        MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms - -
        ${LIVE_TAKER} - W
        ${LIVE_TAKER} - -
        GVJfHJsvrsWZmVj2JVQ3KyY1n7azyi8Z2FdBPxucUe58 - W
        ${SYSTEM_PROGRAM_ID} - -
        ${LIVE_PYUSD_ACCOUNT} - W
        ${LIVE_USDC_ACCOUNT} - W
        DXK4yMpigbTSqv33nJk1tJucXB4E3rDmTXn3yZmiFAXt - W
        3iCcc5iXwqtnZeJ3x5aui6j4SCAGSXwz6fDYjr2nueVA - W
        ${TOKEN_2022_PROGRAM_ID} - -
        ${PYUSD_MINT} - -
        ${TOKEN_PROGRAM_ID} - -
        ${USDC_MINT} - -
        5Ycu1FCKX7TTWmScXvzGkYCpJxQw8s2FYMQa9V4K86F1 - W
        CG8vBSopUJE3SvW3bNaerqj2rrtBX2U13AeB1tHTvcrM - W`),
    },
    cleanupInstruction: unwrap(LIVE_TAKER, LIVE_WSOL_ACCOUNT),
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    transactionVersion: 1,
    computeUnitPrice: '9127',
  },
});

/* ------------------------------------------------------------------ */
/* An answer for any request                                           */
/* ------------------------------------------------------------------ */

export type SwapKind = 'route_v2' | 'shared_accounts_route_v2';

const DISCRIMINATOR: Record<SwapKind, number[]> = {
  route_v2: [187, 100, 250, 204, 49, 196, 175, 20],
  shared_accounts_route_v2: [209, 152, 83, 147, 124, 254, 216, 233],
};

export function tokenAccount(owner: string, mint: string, program: string = TOKEN_PROGRAM_ID): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, new PublicKey(program)).toBase58();
}

/** The data of a swap instruction: the amounts where each kind keeps them, then a one-step route. */
export function swapData(kind: SwapKind, input: { amountIn: bigint; quotedOut: bigint; slippageBps: number; platformFeeBps?: number }): string {
  const head = Buffer.from(kind === 'route_v2' ? DISCRIMINATOR[kind] : [...DISCRIMINATOR[kind], 6]);
  const amounts = Buffer.alloc(22);
  amounts.writeBigUInt64LE(input.amountIn, 0);
  amounts.writeBigUInt64LE(input.quotedOut, 8);
  amounts.writeUInt16LE(input.slippageBps, 16);
  amounts.writeUInt16LE(input.platformFeeBps ?? 0, 18);
  amounts.writeUInt16LE(0, 20);
  const route = Buffer.from([1, 0, 0, 0, 12, 0, 16, 39, 0, 1]);
  return Buffer.concat([head, amounts, route]).toString('base64');
}

export interface AnswerOptions {
  readonly kind?: SwapKind;
  readonly expectedOut?: bigint;
  /** How many accounts of the route's own pools follow the fixed ones. */
  readonly routeAccounts?: number;
}

/** What Jupiter would answer `request` with, in the shape of the live answers above. */
export function answerFor(request: BuildRequest, options: AnswerOptions = {}): Record<string, unknown> & { setupInstructions: RawInstruction[]; swapInstruction: RawInstruction; cleanupInstruction: RawInstruction | null } {
  const kind = options.kind ?? 'route_v2';
  const expectedOut = options.expectedOut ?? request.amount * 77n;
  // The floor Jupiter states: the quote less the slippage, rounded up.
  const minimumOut = (expectedOut * BigInt(10_000 - request.slippageBps) + 9_999n) / 10_000n;
  const { taker } = request;
  const programs = programsOf(request);
  const source = tokenAccount(taker, request.inputMint, programs.input);
  const destination = tokenAccount(taker, request.outputMint, programs.output);
  const wrapped = tokenAccount(taker, WSOL_MINT);
  const lamports = Buffer.alloc(12);
  lamports.writeUInt32LE(2, 0);
  lamports.writeBigUInt64LE(request.amount, 4);

  const setup: RawInstruction[] = [];
  if (request.inputMint === WSOL_MINT) {
    setup.push(openAccount(taker, wrapped, WSOL_MINT));
    setup.push({ programId: SYSTEM_PROGRAM_ID, data: lamports.toString('base64'), accounts: accounts(`${taker} S W\n${wrapped} - W`) });
    setup.push({ programId: TOKEN_PROGRAM_ID, data: 'EQ==', accounts: accounts(`${wrapped} - W`) });
  }
  setup.push(openAccount(taker, destination, request.outputMint, programs.output));

  const route = Array.from({ length: options.routeAccounts ?? 12 }, (_unused, index) => `${Keypair.generate().publicKey.toBase58()} - ${index % 2 === 0 ? 'W' : '-'}`).join('\n');
  const fixed =
    kind === 'route_v2'
      ? `${taker} S -
         ${source} - W
         ${destination} - W
         ${request.inputMint} - -
         ${request.outputMint} - -
         ${programs.input} - -
         ${programs.output} - -
         ${JUPITER_PROGRAM_ID} - -
         ${EVENT_AUTHORITY} - -
         ${JUPITER_PROGRAM_ID} - -`
      : `9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8 - -
         ${taker} S -
         ${source} - W
         ${Keypair.generate().publicKey.toBase58()} - W
         ${Keypair.generate().publicKey.toBase58()} - W
         ${destination} - W
         ${request.inputMint} - -
         ${request.outputMint} - -
         ${programs.input} - -
         ${programs.output} - -
         ${EVENT_AUTHORITY} - -
         ${JUPITER_PROGRAM_ID} - -`;
  return {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmount: request.amount.toString(),
    outAmount: expectedOut.toString(),
    otherAmountThreshold: minimumOut.toString(),
    swapMode: 'ExactIn',
    slippageBps: request.slippageBps,
    routePlan: [{ swapInfo: { ammKey: Keypair.generate().publicKey.toBase58(), label: 'Whirlpool' }, percent: 100, bps: 10_000 }],
    computeBudgetInstructions: [],
    setupInstructions: setup,
    swapInstruction: {
      programId: JUPITER_PROGRAM_ID,
      data: swapData(kind, { amountIn: request.amount, quotedOut: expectedOut, slippageBps: request.slippageBps }),
      accounts: accounts(`${fixed}\n${route}`),
    },
    cleanupInstruction: request.inputMint === WSOL_MINT || request.outputMint === WSOL_MINT ? unwrap(taker, wrapped) : null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    transactionVersion: 1,
    computeUnitPrice: '20000',
  };
}
