/**
 * The short label a token carries in a list when its creator fees run through
 * fee modules. Kept apart from the rest of the modules code so that the
 * market's page, which only needs this, loads nothing else for it.
 */

import type { TokenSummary } from '../../shared/src/api.js';

/** Empty for a token without modules. Shares are in hundredths of a percent: 10000 is all of it. */
export function moduleTag(token: Pick<TokenSummary, 'modules'>): string {
  const modules = token.modules;
  if (!modules) return '';
  if (modules.burnBps >= 10_000) return 'FEES BURN';
  if (modules.burnBps > 0) return `BURN ${Number((modules.burnBps / 100).toFixed(2))}%`;
  return 'FEES SHARED';
}
