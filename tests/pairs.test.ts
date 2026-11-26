import { describe, expect, it } from 'vitest';

import { type AccountInfo, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { ACCOUNT_SIZE, ExtensionType, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { equivalentCurve, readMintFacts } from '../ops/pairs.js';
import { PAIR_TOKENS, pairSymbol, pairTokenById } from '../shared/src/quotes.js';

/** An 82-byte mint account, as either token program stores it. */
function mintBytes(decimals: number, mintAuthority: PublicKey | null, freezeAuthority: PublicKey | null): Buffer {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: mintAuthority ? 1 : 0,
      mintAuthority: mintAuthority ?? PublicKey.default,
      supply: 1_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: freezeAuthority ? 1 : 0,
      freezeAuthority: freezeAuthority ?? PublicKey.default,
    },
    data,
  );
  return data;
}

function account(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, lamports: 1_461_600, executable: false, rentEpoch: 0 };
}

/** A Token-2022 mint with the given extensions, each as an empty-valued entry of `length` bytes. */
function mint2022(base: Buffer, extensions: ReadonlyArray<{ type: ExtensionType; length: number }>): Buffer {
  const entries = extensions.map(({ type, length }) => {
    const entry = Buffer.alloc(4 + length);
    entry.writeUInt16LE(type, 0);
    entry.writeUInt16LE(length, 2);
    return entry;
  });
  const padded = Buffer.alloc(ACCOUNT_SIZE);
  base.copy(padded);
  return Buffer.concat([padded, Buffer.from([1]), ...entries]); // 1 = AccountType.Mint
}

describe('the requested pair tokens', () => {
  it('are the eight that were asked for, each named once', () => {
    expect(PAIR_TOKENS.map((token) => token.id)).toEqual(['SOL', 'USDC', 'ZEC', 'NEAR', 'XMR', 'ANT', 'RENDER', 'HSOL']);
    expect(new Set(PAIR_TOKENS.map((token) => token.id)).size).toBe(PAIR_TOKENS.length);
    for (const token of PAIR_TOKENS) expect(token.id).toBe(token.id.toUpperCase());
    expect(new Set(PAIR_TOKENS.map((token) => token.mint)).size).toBe(PAIR_TOKENS.length);
    for (const token of PAIR_TOKENS) expect(() => new PublicKey(token.mint)).not.toThrow();
    expect(PAIR_TOKENS.filter((token) => token.native).map((token) => token.id)).toEqual(['SOL']);
  });

  it('carry the addresses the operator gave', () => {
    expect(pairTokenById('zec')?.mint).toBe('A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS');
    expect(pairTokenById('NEAR')?.mint).toBe('3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG');
    expect(pairTokenById('XMR')?.mint).toBe('WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp');
    expect(pairTokenById('ANT')?.mint).toBe('ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe');
    expect(pairTokenById('RENDER')?.mint).toBe('rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof');
    expect(pairTokenById('USDC')?.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(pairTokenById('DOGE')).toBeUndefined();
  });

  it('include Helius Staked SOL, found by its ticker in any case and shown as the token writes it', () => {
    const hsol = pairTokenById('hSOL');
    expect(hsol).toBeDefined();
    expect(pairTokenById('HSOL')).toBe(hsol);
    expect(pairTokenById('hSol')).toBe(hsol);
    expect(hsol?.mint).toBe('he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A');
    expect(hsol?.expectedDecimals).toBe(9);
    // It is a token like any other here, not a second form of native SOL.
    expect(hsol?.native).toBe(false);
    expect(hsol?.mint).not.toBe(pairTokenById('SOL')?.mint);
    expect(PAIR_TOKENS.map(pairSymbol)).toEqual(['SOL', 'USDC', 'ZEC', 'NEAR', 'XMR', 'ANT', 'RENDER', 'hSOL']);
  });
});

describe('reading a pair token from chain', () => {
  const address = Keypair.generate().publicKey;
  const issuer = Keypair.generate().publicKey;
  const freezer = Keypair.generate().publicKey;

  it('reads an ordinary SPL Token mint and who controls it', () => {
    const facts = readMintFacts(address, account(TOKEN_PROGRAM_ID, mintBytes(8, issuer, null)));
    expect(facts).toEqual({
      program: 'spl-token',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      initialized: true,
      decimals: 8,
      supply: 1_000_000n,
      mintAuthority: issuer.toBase58(),
      freezeAuthority: null,
      extensions: [],
      restrictive: [],
    });
    const frozen = readMintFacts(address, account(TOKEN_PROGRAM_ID, mintBytes(6, issuer, freezer)));
    expect(frozen.freezeAuthority).toBe(freezer.toBase58());
    expect(readMintFacts(address, account(TOKEN_PROGRAM_ID, mintBytes(9, null, null))).mintAuthority).toBeNull();
  });

  it('names the extensions of a Token-2022 mint and flags the ones that change a transfer', () => {
    const data = mint2022(mintBytes(6, issuer, freezer), [
      { type: ExtensionType.TransferHook, length: 64 },
      { type: ExtensionType.PermanentDelegate, length: 32 },
      { type: ExtensionType.MetadataPointer, length: 64 },
    ]);
    const facts = readMintFacts(address, account(TOKEN_2022_PROGRAM_ID, data));
    expect(facts.program).toBe('token-2022');
    expect(facts.decimals).toBe(6);
    expect(facts.extensions).toEqual(['TransferHook', 'PermanentDelegate', 'MetadataPointer']);
    expect(facts.restrictive).toEqual(['TransferHook', 'PermanentDelegate']);
    // A Token-2022 mint with only harmless extensions is not flagged as restrictive.
    const plain = readMintFacts(address, account(TOKEN_2022_PROGRAM_ID, mint2022(mintBytes(9, null, null), [{ type: ExtensionType.MetadataPointer, length: 64 }])));
    expect(plain.restrictive).toEqual([]);
  });

  it('refuses anything that is not a token mint', () => {
    expect(() => readMintFacts(address, null)).toThrow(/no account/);
    expect(() => readMintFacts(address, account(SystemProgram.programId, Buffer.alloc(0)))).toThrow(/not a token program/);
    expect(() => readMintFacts(address, account(TOKEN_PROGRAM_ID, Buffer.alloc(10)))).toThrow();
  });
});

describe('a curve worth the same in another token', () => {
  it('keeps the dollar size of the SOL curve', () => {
    const same = equivalentCurve({ initialMarketCapSol: 30, migrationMarketCapSol: 420 }, 150, 500);
    expect(same).toEqual({ initialMarketCap: 9, migrationMarketCap: 126, initialUsd: 4_500, migrationUsd: 63_000 });
    // Against a dollar token the numbers are the dollar values themselves.
    const usd = equivalentCurve({ initialMarketCapSol: 30, migrationMarketCapSol: 420 }, 150, 1);
    expect(usd.initialMarketCap).toBe(4_500);
    expect(usd.migrationMarketCap).toBe(63_000);
  });

  it('rounds to three significant digits and refuses a missing price', () => {
    const same = equivalentCurve({ initialMarketCapSol: 30, migrationMarketCapSol: 420 }, 143.27, 3.337);
    expect(same.initialMarketCap).toBe(1_290);
    expect(same.migrationMarketCap).toBe(18_000);
    expect(() => equivalentCurve({ initialMarketCapSol: 30, migrationMarketCapSol: 420 }, 0, 5)).toThrow();
    expect(() => equivalentCurve({ initialMarketCapSol: 30, migrationMarketCapSol: 420 }, 150, Number.NaN)).toThrow();
  });
});
