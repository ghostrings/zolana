import { describe, expect, it } from 'vitest';

import { explainError } from '../web/src/errors.js';

/** A failed wallet sync as the Rings SDK throws it: codes only, the server's answer dropped. */
function sdkFailure(layer: 'CLIENT_RPC' | 'CLIENT_INDEXER' | 'CLIENT_PROVER', top = 'WALLET_SYNC'): Error {
  const inner = Object.assign(new Error(layer), { name: 'ClientError', code: layer, details: { method: 'getProgramAccounts', retryable: false }, cause: { category: 'external', code: 'API_HTTP' } });
  return Object.assign(new Error(top), { name: 'WalletError', code: top, cause: inner });
}

describe('explaining a failed read of the private balance', () => {
  it("gives this site's own reason when its relay refused the request", () => {
    const refused = { code: 'METHOD_NOT_ALLOWED', message: 'That program cannot be scanned through this relay.' };
    expect(explainError(sdkFailure('CLIENT_RPC'), refused)).toBe("This site's relay refused a request the wallet needed. Tell the operator.");
    expect(explainError(sdkFailure('CLIENT_INDEXER'), { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' })).toMatch(/Too many requests/);
    expect(explainError(sdkFailure('CLIENT_RPC'), { code: 'NOT_CONFIGURED', message: 'The RPC is not configured on this server.' })).toMatch(/no RPC configured/);
    expect(explainError(sdkFailure('CLIENT_RPC'), { code: 'CROSS_ORIGIN', message: 'Open it at https://privacycash.fun.' })).toMatch(/does not work at this address/);
    expect(explainError(sdkFailure('CLIENT_PROVER', 'TRANSACTION_PROVE'), { code: 'PROOF_BUDGET', message: 'The site has reached its proving budget for today.' })).toMatch(/proving budget/);
    // A reason of the relay's that has no wording of its own is passed on as the relay wrote it.
    expect(explainError(sdkFailure('CLIENT_RPC'), { code: 'BAD_REQUEST', message: 'Send between 1 and 40 calls.' })).toBe('Send between 1 and 40 calls.');
  });

  it('never shows a bare code when there is no better reason', () => {
    for (const layer of ['CLIENT_RPC', 'CLIENT_INDEXER'] as const) {
      const text = explainError(sdkFailure(layer), null);
      expect(text).toMatch(/Nothing was sent/);
      expect(text).not.toMatch(/WALLET_SYNC|CLIENT_|API_HTTP/);
    }
    expect(explainError(sdkFailure('CLIENT_PROVER', 'TRANSACTION_PROVE'), null)).toMatch(/prover did not answer/);
    expect(explainError(Object.assign(new Error('WALLET_UNRESOLVED_ASSET'), { code: 'WALLET_UNRESOLVED_ASSET' }), null)).toMatch(/could not identify/);
    expect(explainError(new Error('SOMETHING_ODD'), null)).not.toMatch(/SOMETHING_ODD/);
    expect(explainError({ unexpected: true }, null)).not.toMatch(/object/);
  });

  it('finds a known cause wherever it sits in the chain', () => {
    const deep = Object.assign(new Error('WALLET_SYNC'), { code: 'WALLET_SYNC', cause: Object.assign(new Error('x'), { cause: { code: 'INSUFFICIENT_BALANCE' } }) });
    expect(explainError(deep, null)).toMatch(/does not cover/);
    expect(explainError(new Error('403 Forbidden: {"error":{"code":"METHOD_NOT_ALLOWED","message":"..."}}'), null)).toMatch(/relay refused/);
  });

  it('keeps a message that was written for people, and the other known cases', () => {
    expect(explainError(new Error('Leave at least 0.015 SOL public for fees.'), null)).toBe('Leave at least 0.015 SOL public for fees.');
    expect(explainError('User rejected the request', null)).toMatch(/declined/);
    expect(explainError(new Error('TOO_MANY_INPUTS'), null)).toMatch(/consolidate/);
    expect(explainError(new Error('Transaction simulation failed: ExceededSlippage'), null)).toMatch(/slippage/);
    // Short of SOL for fees, and short of the token a purchase is paid in, are told apart.
    expect(explainError(new Error('Transfer: insufficient lamports 1000, need 2039280'), null)).toMatch(/Not enough public SOL for fees/);
    expect(explainError(new Error('Program log: Error: insufficient funds'), null)).toMatch(/in the token it is paid in/);
  });
});
