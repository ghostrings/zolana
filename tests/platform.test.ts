import { describe, expect, it } from 'vitest';

import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { ShieldedKeypair, SigningKey } from '@heliuslabs/spr';

import { confirmed, newWalletKey, parseArgs } from '../ops/lib.js';
import { DESK_PUBLIC_RESERVE_LAMPORTS, deskFundingHint } from '../server/src/desk.js';
import { redact } from '../server/src/redact.js';
import { CLIENT_IP_HEADER_SETTING, clientIp, sameOrigin } from '../server/src/http.js';

import { DEFAULT_ECONOMICS, METEORA_PROTOCOL_FEE_PCT, PLATFORM_LOCKED_LIQUIDITY_PCT, checkEconomics, feeSplit, planPoolClaim, splitPoolFees } from '../shared/src/tiers.js';
import { AmountError, boundedSlippageBps, formatUnits, groupDigits, minusBps, mulBps, parseUnits, plusBps } from '../shared/src/units.js';
import { MAINNET_GENESIS_HASH, MIN_CREATOR_PAYOUT_LAMPORTS, NETWORK } from '../shared/src/constants.js';
import { priorityFeeFor } from '../shared/src/tx.js';
import { EnvError, parseSecretKey, readEnv } from '../server/src/env.js';
import { clampPriority, estimatePriority } from '../server/src/priority.js';
import { MAX_IMAGE_BYTES, UploadError, cleanMetadata, metadataJson, sniffImage } from '../server/src/uploads.js';
import { mainAddressFor, otherAddresses } from '../web/src/address.js';
import { decimalText, feeLabel, sol, tokens } from '../web/src/format.js';

describe('fee split', () => {
  it('takes Meteora\'s share first, then splits the rest', () => {
    expect(METEORA_PROTOCOL_FEE_PCT).toBe(20);
    expect(feeSplit(DEFAULT_ECONOMICS)).toEqual({ creatorPct: 24, platformPct: 56, protocolPct: 20 });
    expect(feeSplit({ creatorFeeSharePct: 100 })).toEqual({ creatorPct: 80, platformPct: 0, protocolPct: 20 });
    expect(feeSplit({ creatorFeeSharePct: 0 })).toEqual({ creatorPct: 0, platformPct: 80, protocolPct: 20 });
  });

  it('always adds up to the whole fee', () => {
    for (let share = 0; share <= 100; share += 1) {
      const split = feeSplit({ creatorFeeSharePct: share });
      expect(split.creatorPct + split.platformPct + split.protocolPct).toBeCloseTo(100, 9);
    }
  });

  it('rejects economics that make no sense', () => {
    expect(() => checkEconomics({ ...DEFAULT_ECONOMICS, creatorFeeSharePct: 101 })).toThrow();
    expect(() => checkEconomics({ ...DEFAULT_ECONOMICS, migrationMarketCapSol: 10 })).toThrow();
    expect(() => checkEconomics({ ...DEFAULT_ECONOMICS, initialMarketCapSol: 0 })).toThrow();
  });
});

describe('amounts', () => {
  it('convert exactly in both directions', () => {
    expect(parseUnits('1.5', 9)).toBe(1_500_000_000n);
    expect(parseUnits('0.000000001', 9)).toBe(1n);
    expect(parseUnits('1000000000', 6)).toBe(1_000_000_000_000_000n);
    expect(formatUnits(1_500_000_000n, 9)).toBe('1.5');
    expect(formatUnits(1n, 9)).toBe('0.000000001');
    expect(formatUnits(1_999_999_999n, 9, 2)).toBe('1.99');
    expect(groupDigits('1234567.891')).toBe('1,234,567.891');
  });

  it('refuse anything that is not a plain positive decimal', () => {
    for (const bad of ['', '-1', '1e9', '0x10', '1,5', '1.', '.5', ' ', '1.0000000001', 'NaN', '01']) {
      expect(() => parseUnits(bad, 9), bad).toThrow(AmountError);
    }
    expect(() => parseUnits('18446744073709551616', 0)).toThrow(AmountError);
  });

  it('round basis points against the trader, never for them', () => {
    expect(mulBps(10_001n, 300)).toBe(300n);
    expect(minusBps(1_000_000n, 100)).toBe(990_000n);
    expect(plusBps(1_000_000n, 100)).toBe(1_010_000n);
    expect(minusBps(3n, 1)).toBeLessThanOrEqual(3n);
    expect(plusBps(3n, 1)).toBeGreaterThanOrEqual(3n);
  });

  it('bound a slippage request and refuse one past the cap', () => {
    expect(boundedSlippageBps(250, 1000, 100)).toBe(250);
    expect(boundedSlippageBps(undefined, 1000, 100)).toBe(100);
    expect(boundedSlippageBps('', 1000, 100)).toBe(100);
    expect(() => boundedSlippageBps(5000, 1000, 100)).toThrow(AmountError);
    expect(() => boundedSlippageBps('abc', 1000, 100)).toThrow(AmountError);
    expect(() => boundedSlippageBps(-5, 1000, 100)).toThrow(AmountError);
    expect(() => boundedSlippageBps(0, 1000, 100)).toThrow(AmountError);
  });

  it('are displayed without exponents', () => {
    expect(decimalText('0.0000000512')).toBe('0.0000000512');
    expect(decimalText('420')).toBe('420.00');
    expect(decimalText('12345.6')).toBe('12,346');
    expect(decimalText('0')).toBe('0');
    expect(sol(1_234_567_890n, 4)).toBe('1.2345');
    expect(tokens(40_000_000_000n, 2)).toBe('40,000');
    expect(feeLabel(300)).toBe('3%');
  });
});

describe('server environment', () => {
  const key = Array.from({ length: 64 }, (_, index) => index).join(',');

  it('is mainnet, with the desk off, by default', () => {
    const env = readEnv({});
    expect(env.network).toBe('mainnet');
    expect(NETWORK).toBe('mainnet');
    expect(MAINNET_GENESIS_HASH).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    expect(env.desk.enabled).toBe(false);
    expect(env.heliusRpcUrl).toBeUndefined();
    expect(env.economics).toEqual(DEFAULT_ECONOMICS);
  });

  it('refuses every network but mainnet', () => {
    expect(readEnv({ SOLANA_NETWORK: 'mainnet' }).network).toBe('mainnet');
    for (const other of ['devnet', 'testnet', 'localnet', 'Mainnet', 'mainnet-beta']) {
      expect(() => readEnv({ SOLANA_NETWORK: other }), other).toThrow(/mainnet only/);
    }
    expect(() => readEnv({ SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=abcd1234', SPR_URL: 'https://devnet.helius-rpc.com/v1/spr' })).toThrow(/mainnet only/);
    expect(() => readEnv({ SOLANA_RPC_URL: 'https://api.testnet.solana.com' })).toThrow(/mainnet only/);
    expect(readEnv({ HELIUS_API_KEY: 'abcd1234-ef56-7890' }).heliusRpcUrl).toMatch(/^https:\/\/mainnet\.helius-rpc\.com\//);
  });

  it('keeps the desk off until its risk is acknowledged', () => {
    const base = { GHOST_DESK_ENABLED: 'YES', DESK_SECRET_KEY: `[${key}]` };
    expect(() => readEnv(base)).toThrow(/GHOST_DESK_MAINNET_ACK/);
    expect(readEnv({ ...base, GHOST_DESK_MAINNET_ACK: 'YES' }).desk.enabled).toBe(true);
    expect(() => readEnv({ GHOST_DESK_ENABLED: 'YES' })).toThrow(/DESK_SECRET_KEY/);
  });

  it('stocks only the mints the operator lists, and none by default', () => {
    expect(readEnv({}).desk.stockMints).toEqual([]);
    expect(readEnv({}).desk.maxImpactBps).toBe(150);
    const a = 'So11111111111111111111111111111111111111112';
    const b = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
    expect(readEnv({ DESK_STOCK_MINTS: ` ${a}, ${b},${a} ` }).desk.stockMints).toEqual([a, b]);
    expect(() => readEnv({ DESK_STOCK_MINTS: 'not-an-address' })).toThrow(EnvError);
    expect(() => readEnv({ DESK_MAX_IMPACT_BPS: '5' })).toThrow(EnvError);
  });

  it('accepts only a bare https origin, or this machine itself', () => {
    expect(readEnv({ PUBLIC_ORIGIN: 'https://privacycash.fun' }).publicOrigin).toBe('https://privacycash.fun');
    expect(readEnv({ PUBLIC_ORIGIN: 'https://privacycash.fun/' }).publicOrigin).toBe('https://privacycash.fun');
    expect(readEnv({ PUBLIC_ORIGIN: 'https://privacycash.fun' }).localOrigin).toBe(false);
    expect(() => readEnv({ PUBLIC_ORIGIN: 'http://privacycash.fun' })).toThrow(EnvError);
    expect(() => readEnv({ PUBLIC_ORIGIN: 'https://privacycash.fun/app' })).toThrow(EnvError);
    expect(() => readEnv({ PUBLIC_ORIGIN: 'https://user:pw@privacycash.fun' })).toThrow(EnvError);
    expect(() => readEnv({ PUBLIC_ORIGIN: 'http://192.168.1.10:8080' })).toThrow(EnvError);
    const local = readEnv({ PUBLIC_ORIGIN: 'http://localhost:8080' });
    expect(local.publicOrigin).toBe('http://localhost:8080');
    expect(local.localOrigin).toBe(true);
    expect(readEnv({ PUBLIC_ORIGIN: 'http://127.0.0.1:8080' }).localOrigin).toBe(true);
  });

  it('bounds the priority fee and prices it per compute unit', () => {
    const env = readEnv({});
    expect(env.priorityMinMicroLamports).toBe(20_000);
    expect(env.priorityMaxMicroLamports).toBe(2_000_000);
    expect(() => readEnv({ PRIORITY_FEE_MIN_MICROLAMPORTS: '500', PRIORITY_FEE_MAX_MICROLAMPORTS: '100' })).toThrow(EnvError);
    expect(clampPriority(undefined, 20_000, 2_000_000)).toBe(20_000);
    expect(clampPriority(Number.NaN, 20_000, 2_000_000)).toBe(20_000);
    expect(clampPriority(5, 20_000, 2_000_000)).toBe(20_000);
    expect(clampPriority(123_456.7, 20_000, 2_000_000)).toBe(123_457);
    expect(clampPriority(9e9, 20_000, 2_000_000)).toBe(2_000_000);
    // 20,000 micro-lamports per unit on a 900,000-unit trade is 18,000 lamports.
    expect(priorityFeeFor(20_000, 900_000)).toBe(18_000n);
    expect(priorityFeeFor(1, 1)).toBe(1n);
    expect(priorityFeeFor(0, 900_000)).toBe(0n);
    expect(priorityFeeFor(-5, 900_000)).toBe(0n);
    expect(priorityFeeFor(Number.NaN, 900_000)).toBe(0n);
  });

  it('has no trade cap and no pause unless the operator sets one', () => {
    const env = readEnv({});
    expect(env.maxTradeLamports).toBe(0n);
    expect(env.pauseLaunches).toBe(false);
    expect(env.pauseTrading).toBe(false);
    expect(env.pauseMessage).toBeUndefined();
    const set = readEnv({ MAX_TRADE_LAMPORTS: '2000000000', PAUSE_LAUNCHES: 'YES', PAUSE_TRADING: 'NO', PAUSE_MESSAGE: 'Back in an hour.' });
    expect(set.maxTradeLamports).toBe(2_000_000_000n);
    expect(set.pauseLaunches).toBe(true);
    expect(set.pauseTrading).toBe(false);
    expect(set.pauseMessage).toBe('Back in an hour.');
    expect(() => readEnv({ PAUSE_TRADING: 'true' })).toThrow(EnvError);
    expect(() => readEnv({ PAUSE_MESSAGE: '<b>hi</b>' })).toThrow(EnvError);
    expect(() => readEnv({ MAX_TRADE_LAMPORTS: '2 SOL' })).toThrow(EnvError);
  });

  it('reads no estimate from an RPC that does not offer one', async () => {
    const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
    expect(await estimatePriority('https://rpc.example', answer({ result: { priorityFeeEstimate: 4321.5 } }))).toBe(4321.5);
    expect(await estimatePriority('https://rpc.example', answer({ error: { code: -32601, message: 'Method not found' } }))).toBeUndefined();
    expect(await estimatePriority('https://rpc.example', answer({ result: { priorityFeeEstimate: 'lots' } }))).toBeUndefined();
    expect(await estimatePriority('https://rpc.example', answer({}, false))).toBeUndefined();
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await estimatePriority('https://rpc.example', failing)).toBeUndefined();
  });

  it('never puts the API key anywhere but the upstream URLs', () => {
    const env = readEnv({ HELIUS_API_KEY: 'abcd1234-ef56-7890' });
    expect(env.heliusRpcUrl).toContain('api-key=abcd1234-ef56-7890');
    expect(env.heliusSprUrl).toContain('/v1/spr?api-key=abcd1234-ef56-7890');
    const rest = JSON.stringify({ ...env, heliusRpcUrl: undefined, heliusSprUrl: undefined }, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(rest).not.toContain('abcd1234');
    expect(() => readEnv({ HELIUS_API_KEY: 'has spaces' })).toThrow(EnvError);
  });
});

describe('uploads', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it('go by the file\'s own bytes, not its name', () => {
    expect(sniffImage(png)?.extension).toBe('png');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))?.extension).toBe('jpg');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<!doctype html>'))).toBeNull();
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
  });

  it('normalise good metadata', () => {
    const clean = cleanMetadata({ name: '  Night Shift ', symbol: 'night', description: ' hi ', website: 'https://example.com' });
    expect(clean).toEqual({ name: 'Night Shift', symbol: 'NIGHT', description: 'hi', image: '', website: 'https://example.com/', twitter: '' });
    expect(metadataJson(clean)).toEqual({
      name: 'Night Shift',
      symbol: 'NIGHT',
      description: 'hi',
      external_url: 'https://example.com/',
      extensions: { website: 'https://example.com/' },
    });
  });

  it('refuse bad names, tickers and links', () => {
    expect(() => cleanMetadata({ name: '', symbol: 'A' })).toThrow(UploadError);
    expect(() => cleanMetadata({ name: 'x'.repeat(33), symbol: 'A' })).toThrow(/32 bytes/);
    expect(() => cleanMetadata({ name: 'ééééééééééééééééé', symbol: 'A' })).toThrow(/32 bytes/);
    expect(() => cleanMetadata({ name: 'A', symbol: 'TOO-LONG-TICKER' })).toThrow(UploadError);
    expect(() => cleanMetadata({ name: 'A', symbol: 'A B' })).toThrow(UploadError);
    expect(() => cleanMetadata({ name: 'A', symbol: 'A', website: 'javascript:alert(1)' })).toThrow(UploadError);
    expect(() => cleanMetadata({ name: 'A', symbol: 'A', twitter: 'http://x.com/a' })).toThrow(UploadError);
    expect(() => cleanMetadata({ name: 'A', symbol: 'A', description: 'd'.repeat(501) })).toThrow(UploadError);
  });

  it('accept plain-http artwork only when this server stored it', () => {
    const own = `http://localhost:8080/u/${'a'.repeat(40)}.png`;
    expect(cleanMetadata({ name: 'A', symbol: 'A', image: own }, 'http://localhost:8080').image).toBe(own);
    expect(() => cleanMetadata({ name: 'A', symbol: 'A', image: own })).toThrow(UploadError);
    expect(() => cleanMetadata({ name: 'A', symbol: 'A', image: 'http://localhost:8080/u/../secret.png' }, 'http://localhost:8080')).toThrow(UploadError);
    expect(() => cleanMetadata({ name: 'A', symbol: 'A', image: `http://evil.example/u/${'a'.repeat(40)}.png` }, 'http://localhost:8080')).toThrow(UploadError);
  });
});

/* ------------------------------------------------------------------ */
/* Operator scripts: confirmation words and what they print             */
/* ------------------------------------------------------------------ */

describe('confirming a script that sends', () => {
  const run = (...argv: string[]) => parseArgs(argv);

  it('takes plain words, which every shell passes through npm', () => {
    expect(confirmed(run('apply', 'yes', 'mainnet'), 'mainnet')).toBe(true);
    expect(confirmed(run('claim', 'yes'))).toBe(true);
    expect(confirmed(run('So11111111111111111111111111111111111111112', 'yes'))).toBe(true);
    expect(run('So11111111111111111111111111111111111111112', 'yes').command).toBe('So11111111111111111111111111111111111111112');
  });

  it('still takes the flags', () => {
    expect(confirmed(run('apply', '--yes', 'mainnet'), 'mainnet')).toBe(true);
    expect(confirmed(run('claim', '--yes'))).toBe(true);
    expect(confirmed(run('So11111111111111111111111111111111111111112', '--yes'))).toBe(true);
  });

  it('is not confirmed by anything less', () => {
    // What PowerShell's npm wrapper delivers for `npm run configs:apply -- --yes mainnet`: the flag is gone.
    expect(confirmed(run('apply', 'mainnet'), 'mainnet')).toBe(false);
    expect(confirmed(run('apply'), 'mainnet')).toBe(false);
    expect(confirmed(run('apply', 'yes'), 'mainnet')).toBe(false);
    expect(confirmed(run('apply', 'yes', 'devnet'), 'mainnet')).toBe(false);
    expect(confirmed(run('apply', '--yes'), 'mainnet')).toBe(false);
    expect(confirmed(run('claim'))).toBe(false);
    expect(confirmed(run('claim', 'no'))).toBe(false);
    expect(confirmed(run('So11111111111111111111111111111111111111112'))).toBe(false);
  });
});

describe('what gets printed', () => {
  const secrets = {
    HELIUS_API_KEY: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    PINATA_JWT: 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
    DEPLOYER_KEY: '4NwTpSecretSecretSecretSecretSecretSecretSecretSecretSecretSecretSecretSecret',
    PARTNER_KEY: '[12,34,56,78,90,12,34,56,78,90]',
  };

  it('never carries the API key of an RPC address', () => {
    const line = 'fetch failed: https://mainnet.helius-rpc.com/?api-key=a1b2c3d4-e5f6-7890-abcd-ef0123456789 (ECONNRESET)';
    const out = redact(line, secrets);
    expect(out).not.toContain('a1b2c3d4');
    expect(out).toContain('api-key=[hidden]');
    expect(out).toContain('ECONNRESET');
    // Also when the key is not in the environment the text is printed from.
    expect(redact('GET /v1/spr/status?api-key=zzzzzzzzzzzz&x=1', {})).toBe('GET /v1/spr/status?api-key=[hidden]&x=1');
  });

  it('never carries a configured secret, wherever it appears', () => {
    const out = redact(`Authorization: Bearer ${secrets.PINATA_JWT}; key ${secrets.DEPLOYER_KEY}; partner ${secrets.PARTNER_KEY}`, secrets);
    expect(out).not.toContain(secrets.PINATA_JWT);
    expect(out).not.toContain(secrets.DEPLOYER_KEY);
    expect(out).not.toContain(secrets.PARTNER_KEY);
    expect(out).toContain('[PINATA_JWT hidden]');
    expect(out).toContain('[DEPLOYER_KEY hidden]');
  });

  it('leaves ordinary text alone', () => {
    const line = 'tiers: 3% tier verified against the chain (config 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU)';
    expect(redact(line, secrets)).toBe(line);
    expect(redact('short values are not treated as secrets', { HELIUS_API_KEY: 'short' })).toBe('short values are not treated as secrets');
  });
});

/* ------------------------------------------------------------------ */
/* Pool fees after graduation: the platform collects, the creator is paid */
/* ------------------------------------------------------------------ */

describe('pool fees after graduation', () => {
  const claim = (lamports: bigint, overrides: Partial<Parameters<typeof planPoolClaim>[0]> = {}) =>
    planPoolClaim({ lamports, creatorPayoutPct: 30, creatorIsPlatform: false, minClaimLamports: 2_000_000n, minPayoutLamports: MIN_CREATOR_PAYOUT_LAMPORTS, ...overrides });

  it('leaves all locked liquidity with the platform', () => {
    expect(PLATFORM_LOCKED_LIQUIDITY_PCT).toBe(100);
  });

  it('splits a claim 30 / 70 by default and never creates or loses a lamport', () => {
    expect(splitPoolFees(1_000_000_000n, 30)).toEqual({ creator: 300_000_000n, platform: 700_000_000n });
    expect(splitPoolFees(1_000_000_000n, 0)).toEqual({ creator: 0n, platform: 1_000_000_000n });
    expect(splitPoolFees(1_000_000_000n, 100)).toEqual({ creator: 1_000_000_000n, platform: 0n });
    // Rounding goes down for the creator, and the two parts always add up.
    expect(splitPoolFees(10n, 33)).toEqual({ creator: 3n, platform: 7n });
    for (const amount of [0n, 1n, 7n, 999n, 123_456_789n, 88_576_623_265n]) {
      for (const pct of [0, 1, 30, 50, 99, 100]) {
        const split = splitPoolFees(amount, pct);
        expect(split.creator + split.platform).toBe(amount);
        expect(split.creator <= (amount * BigInt(pct)) / 100n).toBe(true);
      }
    }
    expect(() => splitPoolFees(100n, 101)).toThrow();
    expect(() => splitPoolFees(100n, -1)).toThrow();
    expect(() => splitPoolFees(100n, 12.5)).toThrow();
    expect(() => splitPoolFees(-1n, 30)).toThrow();
  });

  it('claims and pays the creator in one step when the amounts are worth sending', () => {
    expect(claim(1_000_000_000n)).toEqual({ creator: 300_000_000n, platform: 700_000_000n, wait: null });
  });

  it('leaves a position unclaimed while the creator\'s part is too small to send', () => {
    // 0.005 SOL of fees: the creator's 30% is 0.0015 SOL, under the 0.002 SOL minimum.
    const small = claim(5_000_000n);
    expect(small.wait).toBe('creator-share-too-small');
    // At 0.00667 SOL the creator's part reaches the minimum and the position is claimed.
    expect(claim(6_666_666n).wait).toBe('creator-share-too-small');
    expect(claim(6_666_667n)).toEqual({ creator: 2_000_000n, platform: 4_666_667n, wait: null });
    // The smallest payout is enough to open a wallet that holds nothing (890,880 lamports of rent).
    expect(MIN_CREATOR_PAYOUT_LAMPORTS > 890_880n).toBe(true);
  });

  it('does not claim dust, or nothing', () => {
    expect(claim(0n).wait).toBe('nothing');
    expect(claim(1_999_999n).wait).toBe('too-small');
  });

  it('pays nobody when the payout is switched off or the platform launched the token itself', () => {
    expect(claim(5_000_000n, { creatorPayoutPct: 0 })).toEqual({ creator: 0n, platform: 5_000_000n, wait: null });
    expect(claim(5_000_000n, { creatorIsPlatform: true })).toEqual({ creator: 0n, platform: 5_000_000n, wait: null });
  });

  it('reads the payout from the environment, following the curve share unless told otherwise', () => {
    expect(readEnv({}).creatorPoolPayoutPct).toBe(30);
    expect(readEnv({}).economics.creatorFeeSharePct).toBe(30);
    expect(readEnv({ CREATOR_FEE_SHARE_PCT: '40' }).creatorPoolPayoutPct).toBe(40);
    expect(readEnv({ CREATOR_FEE_SHARE_PCT: '40', CREATOR_POOL_PAYOUT_PCT: '25' }).creatorPoolPayoutPct).toBe(25);
    expect(readEnv({ CREATOR_POOL_PAYOUT_PCT: '0' }).creatorPoolPayoutPct).toBe(0);
    expect(() => readEnv({ CREATOR_POOL_PAYOUT_PCT: '101' })).toThrow(EnvError);
    expect(() => readEnv({ CREATOR_POOL_PAYOUT_PCT: 'half' })).toThrow(EnvError);
  });
});

/* ------------------------------------------------------------------ */
/* Whose request it is, behind a hosting platform's edge                */
/* ------------------------------------------------------------------ */

describe("a visitor's address behind a hosting platform", () => {
  const request = (headers: Record<string, string | string[]>, ip: string | undefined, setting?: string) =>
    ({
      headers,
      ip,
      socket: { remoteAddress: '10.0.0.9' },
      app: { get: (name: string) => (name === CLIENT_IP_HEADER_SETTING ? setting : undefined) },
    }) as unknown as Parameters<typeof clientIp>[0];

  it("uses Express's answer when no header is named", () => {
    expect(clientIp(request({ 'cf-connecting-ip': '203.0.113.7' }, '198.51.100.4'))).toBe('198.51.100.4');
    expect(clientIp(request({}, undefined))).toBe('10.0.0.9');
  });

  it("takes the platform's header when the operator names it", () => {
    expect(clientIp(request({ 'cf-connecting-ip': '203.0.113.7' }, '10.0.0.1', 'cf-connecting-ip'))).toBe('203.0.113.7');
    expect(clientIp(request({ 'cf-connecting-ip': '2001:db8::17' }, '10.0.0.1', 'cf-connecting-ip'))).toBe('2001:db8::17');
    expect(clientIp(request({ 'cf-connecting-ip': ['203.0.113.7', '203.0.113.8'] }, '10.0.0.1', 'cf-connecting-ip'))).toBe('203.0.113.7');
    expect(clientIp(request({ 'cf-connecting-ip': ' 203.0.113.7 , 10.1.1.1' }, '10.0.0.1', 'cf-connecting-ip'))).toBe('203.0.113.7');
  });

  it('falls back when the header is missing or is not an address', () => {
    expect(clientIp(request({}, '198.51.100.4', 'cf-connecting-ip'))).toBe('198.51.100.4');
    expect(clientIp(request({ 'cf-connecting-ip': 'not-an-ip' }, '198.51.100.4', 'cf-connecting-ip'))).toBe('198.51.100.4');
    expect(clientIp(request({ 'cf-connecting-ip': '<script>' }, '198.51.100.4', 'cf-connecting-ip'))).toBe('198.51.100.4');
    expect(clientIp(request({ 'cf-connecting-ip': '' }, '198.51.100.4', 'cf-connecting-ip'))).toBe('198.51.100.4');
  });

  it('reads the header name from the environment, lower-cased', () => {
    expect(readEnv({}).clientIpHeader).toBeUndefined();
    expect(readEnv({ CLIENT_IP_HEADER: 'CF-Connecting-IP' }).clientIpHeader).toBe('cf-connecting-ip');
    expect(() => readEnv({ CLIENT_IP_HEADER: 'two words' })).toThrow(EnvError);
    expect(() => readEnv({ CLIENT_IP_HEADER: 'x:y' })).toThrow(EnvError);
  });
});

describe('the addresses the site answers at', () => {
  const MAIN = 'https://privacycash.fun';
  const HOSTED = 'https://privacycash.onrender.com';

  /** Runs the check on one request and reports what it did. */
  const send = (
    allowed: readonly string[],
    method: string,
    headers: Record<string, string>,
    host = 'privacycash.fun',
  ): { passed: boolean; status?: number; code?: string; message?: string; unlisted: string[] } => {
    const unlisted: string[] = [];
    const result: { passed: boolean; status?: number; code?: string; message?: string; unlisted: string[] } = { passed: false, unlisted };
    const request = { method, headers, protocol: 'https', get: (name: string) => (name === 'host' ? host : undefined) };
    const response = {
      headersSent: false,
      status(code: number) {
        result.status = code;
        return this;
      },
      json(body: { error: { code: string; message: string } }) {
        result.code = body.error.code;
        result.message = body.error.message;
      },
    };
    sameOrigin(allowed, (origin) => unlisted.push(origin))(
      request as unknown as Parameters<ReturnType<typeof sameOrigin>>[0],
      response as unknown as Parameters<ReturnType<typeof sameOrigin>>[1],
      () => {
        result.passed = true;
      },
    );
    return result;
  };

  it('reads the main address and the extra ones from the environment', () => {
    expect(readEnv({}).allowedOrigins).toEqual([]);
    expect(readEnv({ PUBLIC_ORIGIN: MAIN }).allowedOrigins).toEqual([MAIN]);
    expect(readEnv({ PUBLIC_ORIGIN: MAIN, EXTRA_ORIGINS: HOSTED }).allowedOrigins).toEqual([MAIN, HOSTED]);
    // Commas or spaces, a trailing slash, upper case, and repeats are all tidied; the main address stays first.
    expect(readEnv({ PUBLIC_ORIGIN: `${MAIN}/`, EXTRA_ORIGINS: ` HTTPS://PrivacyCash.OnRender.com/ , https://www.privacycash.fun ${MAIN} ${HOSTED}` }).allowedOrigins).toEqual([
      MAIN,
      HOSTED,
      'https://www.privacycash.fun',
    ]);
    expect(readEnv({ PUBLIC_ORIGIN: MAIN, EXTRA_ORIGINS: HOSTED }).publicOrigin).toBe(MAIN);
  });

  it('refuses extra addresses that are not plain https origins, or that have no main address', () => {
    expect(() => readEnv({ EXTRA_ORIGINS: HOSTED })).toThrow(/needs PUBLIC_ORIGIN/);
    expect(() => readEnv({ PUBLIC_ORIGIN: MAIN, EXTRA_ORIGINS: 'http://privacycash.onrender.com' })).toThrow(EnvError);
    expect(() => readEnv({ PUBLIC_ORIGIN: MAIN, EXTRA_ORIGINS: 'privacycash.onrender.com' })).toThrow(EnvError);
    expect(() => readEnv({ PUBLIC_ORIGIN: MAIN, EXTRA_ORIGINS: `${HOSTED}/launch` })).toThrow(EnvError);
    expect(() => readEnv({ PUBLIC_ORIGIN: MAIN, EXTRA_ORIGINS: '*' })).toThrow(EnvError);
    const nine = Array.from({ length: 9 }, (_, index) => `https://a${index}.example`).join(',');
    expect(() => readEnv({ PUBLIC_ORIGIN: MAIN, EXTRA_ORIGINS: nine })).toThrow(/more than 8/);
  });

  it('accepts a request from a page at any listed address', () => {
    expect(send([MAIN, HOSTED], 'POST', { origin: MAIN, 'sec-fetch-site': 'same-origin' }).passed).toBe(true);
    expect(send([MAIN, HOSTED], 'POST', { origin: HOSTED, 'sec-fetch-site': 'same-origin' }, 'privacycash.onrender.com').passed).toBe(true);
    // Reading is never restricted, and a client that is not a browser sends neither header.
    expect(send([MAIN], 'GET', { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' }).passed).toBe(true);
    expect(send([MAIN], 'POST', {}).passed).toBe(true);
  });

  it('refuses a page at an address that is not listed, says where to go, and reports it', () => {
    const refused = send([MAIN], 'POST', { origin: HOSTED, 'sec-fetch-site': 'same-origin' }, 'privacycash.onrender.com');
    expect(refused.passed).toBe(false);
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('CROSS_ORIGIN');
    expect(refused.message).toContain(MAIN);
    expect(refused.unlisted).toEqual([HOSTED]);
    // Near misses are different addresses: another scheme, a www prefix, a port.
    for (const origin of ['http://privacycash.fun', 'https://www.privacycash.fun', 'https://privacycash.fun:8443', 'null']) {
      expect(send([MAIN], 'POST', { origin }).passed).toBe(false);
    }
  });

  it('refuses another website outright, even one that claims a listed address', () => {
    const forged = send([MAIN, HOSTED], 'POST', { origin: MAIN, 'sec-fetch-site': 'cross-site' });
    expect(forged.passed).toBe(false);
    expect(forged.code).toBe('CROSS_ORIGIN');
    expect(forged.unlisted).toEqual([]);
    expect(send([MAIN], 'POST', { origin: MAIN, 'sec-fetch-site': 'same-site' }).passed).toBe(false);
  });

  it('with no address configured, takes requests only from the address they were sent to', () => {
    expect(send([], 'POST', { origin: 'https://localhost:8080' }, 'localhost:8080').passed).toBe(true);
    const other = send([], 'POST', { origin: 'https://elsewhere.example' }, 'localhost:8080');
    expect(other.passed).toBe(false);
    expect(other.unlisted).toEqual([]);
  });

  it('tells a page opened at the wrong address where the site works', () => {
    expect(mainAddressFor([MAIN, HOSTED], MAIN)).toBeNull();
    expect(mainAddressFor([MAIN, HOSTED], HOSTED)).toBeNull();
    expect(mainAddressFor([MAIN], HOSTED)).toBe(MAIN);
    // No list (local development, or an older server): any address works.
    expect(mainAddressFor([], HOSTED)).toBeNull();
    expect(mainAddressFor(undefined, HOSTED)).toBeNull();
  });

  it('names the other addresses a wallet may have been made at', () => {
    expect(otherAddresses([MAIN, HOSTED], MAIN)).toEqual([HOSTED]);
    expect(otherAddresses([MAIN, HOSTED], HOSTED)).toEqual([MAIN]);
    expect(otherAddresses([MAIN], MAIN)).toEqual([]);
    // At an address the site does not answer, the banner speaks instead.
    expect(otherAddresses([MAIN], HOSTED)).toEqual([]);
    expect(otherAddresses(undefined, MAIN)).toEqual([]);
  });
});

describe('setting up the Ghost desk', () => {
  it('makes a key the server reads back as the same wallet', () => {
    const key = newWalletKey();
    expect(key.secret).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    // The way the server turns DESK_SECRET_KEY into the desk's wallet.
    const bytes = parseSecretKey(key.secret, (text) => bs58.decode(text));
    expect(bytes.length).toBe(64);
    const desk = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(bytes.subarray(0, 32)) as never));
    expect(desk.toSolanaSigner().address).toBe(key.address);
    // And the way any Solana wallet would import it.
    expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(key.address);
    expect(readEnv({ GHOST_DESK_ENABLED: 'YES', GHOST_DESK_MAINNET_ACK: 'YES', DESK_SECRET_KEY: key.secret }).desk.enabled).toBe(true);
    expect(newWalletKey().secret).not.toBe(key.secret);
  });

  it('says so when the desk was sent too little to trade with', () => {
    const SOL = 1_000_000_000n;
    expect(DESK_PUBLIC_RESERVE_LAMPORTS).toBe((3n * SOL) / 10n);
    // Half a SOL stays public: it is under the 0.6 SOL at which anything is moved to the private balance.
    const hint = deskFundingHint(SOL / 2n, 0n);
    expect(hint).toContain('0.3 SOL');
    expect(hint).toContain('0.6 SOL');
    expect(hint).toContain('0.5 SOL');
    expect(deskFundingHint((6n * SOL) / 10n, 0n)).not.toBeNull();
    // Enough to be moved on the next pass, or already holding a private balance: nothing to say.
    expect(deskFundingHint(SOL, 0n)).toBeNull();
    expect(deskFundingHint(SOL / 10n, SOL)).toBeNull();
  });
});
