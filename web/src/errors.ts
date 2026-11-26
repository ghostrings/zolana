/**
 * Error messages. Kept free of anything that needs a page or a chain, so the
 * wording can be tested.
 */

/** Every code and message along an error's chain of causes, as one text. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    const link = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof link.code === 'string') parts.push(link.code);
    if (typeof link.message === 'string') parts.push(link.message);
    current = link.cause;
  }
  return parts.join(' ');
}

/**
 * Turns SDK and program error codes into something a person can act on.
 * `relayReason` is why this site's own relay refused a request a moment ago,
 * when it did.
 */
export function explainError(error: unknown, relayReason?: { code: string; message: string } | null): string {
  const message = error instanceof Error ? error.message : typeof (error as { message?: unknown } | null)?.message === 'string' ? (error as { message: string }).message : String(error);
  const text = errorText(error);
  // A conversion this site read and refused, or could not get: the sentence already says which and why.
  // It is returned before the patterns below, which would mistake its wording for a failed trade.
  if ((error as { name?: unknown } | null)?.name === 'ConvertError') return message;
  if (/\b(NO_ROUTE|CONVERTER_BUSY|CONVERTER_DOWN|OVER_LIMIT)\b/.test(text)) return message;
  // Rings refusing a token when a transaction is run against the chain (its errors 7037 to 7039).
  if (/UnsupportedToken2022Extension|custom program error: 0x1b7f\b/i.test(text)) {
    return 'Rings does not take this token: its mint carries a Token-2022 feature Rings does not support, so it cannot be held privately. Nothing was sent.';
  }
  if (/UnsupportedSplTokenProgram|InvalidSplTokenMint|custom program error: 0x1b7[de]\b/i.test(text)) {
    return 'Rings does not take this token as it is on chain, so it cannot be held privately. Nothing was sent.';
  }
  // The token program's own refusal for an account its issuer has frozen.
  if (/AccountFrozen|Account is frozen|custom program error: 0x11\b/i.test(text)) {
    return 'An account this needs has been frozen by the token’s issuer, so the token cannot be moved. Nothing was sent.';
  }
  // The Rings SDK reports a request that failed as a bare code and drops the server's answer.
  // If this site's own relay refused a request a moment ago, its reason is the real one.
  const bare = /WALLET_SYNC|CLIENT_RPC|CLIENT_INDEXER|CLIENT_PROVER|API_HTTP/.test(text);
  if (bare && relayReason) return explainError({ code: relayReason.code, message: relayReason.message }, null);
  // The SDK says this both when the balance is too small and when the notes that would cover it are set aside
  // for a transaction of this wallet that was sent in the last two minutes and has not settled yet.
  if (/INSUFFICIENT_BALANCE|INSUFFICIENT_PRIVATE/.test(text)) {
    return 'Your private balance does not cover this right now. If a transaction of yours was sent in the last two minutes and has not settled, what it spends is set aside until it does: wait, then try again. Otherwise deposit more, or lower the amount.';
  }
  if (/TOO_MANY_INPUTS|TOO_FRAGMENTED/.test(text)) return 'Your private balance is split across too many notes. Open the wallet and consolidate it, then try again.';
  if (/RECIPIENT_NOT_REGISTERED/.test(text)) return 'That address has not registered a private wallet yet, so it cannot receive a private transfer.';
  if (/SPL_INTERFACE_CREATION_RESTRICTED|INTERFACE_RESTRICTED/.test(text)) return 'This token has no Rings interface, and Rings does not currently allow creating one.';
  if (/User rejected|rejected the request|denied/i.test(text)) return 'You declined the request in your wallet.';
  if (/blockhash not found|Blockhash/i.test(text)) return 'The transaction expired before it landed. Try again.';
  if (/insufficient lamports/i.test(text)) return 'Not enough public SOL for fees and temporary account rent. Keep at least 0.015 SOL public.';
  // The token program's own words, for a token account that holds less than a transfer asks of it.
  if (/insufficient funds/i.test(text)) return 'Not enough in the public balance this draws on. Fees and temporary account rent need at least 0.015 public SOL, and a purchase paid from a public balance needs the amount itself, in the token it is paid in.';
  if (/ExceededSlippage|slippage|AmountOutNotEnough|0x1771/i.test(text)) return 'The price moved past your slippage limit. Nothing was traded. Try again, or raise the limit.';
  if (/InsufficientLiquidity|AmountLeftIsNotZero|NotEnoughLiquidity|PoolIsCompleted|Pool is completed/.test(text)) return 'The curve changed before this landed: somebody else traded first. Nothing moved. Quote again.';
  if (/exceeded CUs|Computational budget exceeded|ProgramFailedToComplete/i.test(text)) return 'This transaction needs more compute than this build allows for it, so it was not sent. Tell the operator.';
  if (/CLIENT_PROVER|PROVER|attest/i.test(text)) return 'The prover did not answer. Try again in a moment.';
  if (/CROSS_ORIGIN/.test(text)) return 'This site does not work at this address, so nothing was sent. Open it at its main address: see the note at the top of the page.';
  if (/NOT_CONFIGURED/.test(text)) return 'This deployment has no RPC configured, so nothing on chain can be reached.';
  if (/NETWORK_UNCONFIRMED/.test(text)) return 'This site cannot reach Solana mainnet right now. Nothing was sent. Try again shortly.';
  if (/LAUNCHES_PAUSED/.test(text)) return 'New launches are paused for now.';
  if (/TRADING_PAUSED/.test(text)) return 'Trading through this site is paused for now. Your wallet is not affected.';
  if (/PROOF_BUDGET/.test(text)) return 'The site has reached its proving budget for today. Private transactions resume when it resets.';
  if (/RATE_LIMITED|\b429\b/.test(text)) return 'Too many requests. Wait a minute and try again.';
  if (/METHOD_NOT_ALLOWED/.test(text)) return 'This site\'s relay refused a request the wallet needed. Tell the operator.';
  if (/\b50[234]\b|UPSTREAM|fetch failed|Failed to fetch|NetworkError|failed to get /i.test(text)) return 'The network did not answer. Check your connection and try again.';
  if (/WALLET_UNRESOLVED_ASSET/.test(text)) return 'Your wallet holds a token this page could not identify, so the balance was not read. Try again in a moment.';
  if (bare) return 'The network did not return what was needed. Nothing was sent. Try again in a moment.';
  // A bare code says nothing to the person reading it.
  if (message && message.length < 240 && !/^[A-Z][A-Z0-9_]*$/.test(message) && !message.startsWith('[object ')) return message;
  return 'This could not be completed. Nothing was sent that did not settle.';
}
