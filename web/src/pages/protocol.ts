import {
  DAMM_V2_PROGRAM_ID,
  DBC_PROGRAM_ID,
  SPP_DEFAULT_TREE,
  SPP_PROGRAM_ID,
  USER_REGISTRY_PROGRAM_ID,
} from '../../../shared/src/constants.js';
import { feeSplit } from '../../../shared/src/tiers.js';
import { explorerAddress, sol } from '../format.js';
import { mountRuntime } from '../shell.js';
import { byId, escapeHtml, initShell, setText, wireCopyButtons } from '../ui.js';

initShell('protocol');

void (async () => {
  const status = await mountRuntime();
  const network = status?.network ?? 'mainnet';
  const link = (label: string, value: string | null) =>
    value
      ? `<dt>${label}</dt><dd><a class="tx-link" href="${escapeHtml(explorerAddress(value, network))}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a> <button class="icon-btn" type="button" data-copy="${escapeHtml(value)}">COPY</button></dd>`
      : `<dt>${label}</dt><dd>Not live yet</dd>`;

  const tiers = status?.tiers ?? [];
  byId('addresses-kv').innerHTML = [
    `<dt>Network</dt><dd>${escapeHtml(network.toUpperCase())}</dd>`,
    link('Solana Privacy Rings program', SPP_PROGRAM_ID),
    link('Rings user registry', USER_REGISTRY_PROGRAM_ID),
    link('Rings default tree', SPP_DEFAULT_TREE),
    link('Meteora bonding curve program', DBC_PROGRAM_ID),
    link('Meteora DAMM v2 program', DAMM_V2_PROGRAM_ID),
    ...tiers.map((tier) => link(`${tier.label} fee config`, tier.config)),
    status?.desk.address ? link('Ghost desk wallet', status.desk.address) : '',
  ].join('');
  wireCopyButtons(byId('addresses-kv'));

  if (!status) {
    setText('desk-status', 'The server is not reachable, so the desk status is unknown.');
    return;
  }
  const split = feeSplit(status.economics);
  byId('economics-kv').innerHTML = `<dt>Creator share of each curve fee</dt><dd>${split.creatorPct}% · claimed by the creator on chain</dd><dt>Platform share</dt><dd>${split.platformPct}%</dd><dt>Meteora protocol share</dt><dd>${split.protocolPct}%</dd><dt>Starting market cap</dt><dd>${status.economics.initialMarketCapSol} SOL</dd><dt>Graduation market cap</dt><dd>${status.economics.migrationMarketCapSol} SOL</dd><dt>Liquidity locked at graduation</dt><dd>100% · held by the platform</dd><dt>Creator share after graduation</dt><dd>${status.creatorPoolPayoutPct > 0 ? `${status.creatorPoolPayoutPct}% of the pool fees the platform collects · paid by the platform` : 'None'}</dd><dt>Default slippage limit</dt><dd>${status.slippage.defaultBps / 100}%</dd>`;
  setText(
    'desk-status',
    status.desk.enabled
      ? `The desk is on. Its spread is ${(status.desk.spreadBps / 100).toFixed(2)}% and it fills up to ${sol(status.desk.maxOrderLamports, 2)} SOL per trade. Ghost fill needs the built-in ghost wallet.`
      : 'Ghost fill is switched off on this deployment. The Shielded route is available.',
  );
})();
