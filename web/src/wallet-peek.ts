/** A native modal keeps the market in place. Sensitive actions stay on the audited wallet flows. */
import { activeAddress, activeWallet, hasVault } from './vault.js';
import { deterministicAvatar, escapeHtml, short, tokenArt } from './ui.js';
import type { TokenSummary } from '../../shared/src/api.js';
import { iconSvg } from './wallet-icons.js';
import type { PeekData } from './wallet-peek-data.js';

export function mountWalletPeek(catalog: () => readonly TokenSummary[]): void {
  const trigger = document.querySelector<HTMLAnchorElement>('[data-identity]');
  if (!trigger || typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'wallet-peek';
  dialog.setAttribute('aria-labelledby', 'peek-title');
  dialog.innerHTML = `<div class="peek-shell"><header class="peek-head"><div><span class="hero-overline">SELF-CUSTODY / SOLANA</span><h2 id="peek-title">Wallet</h2></div><button type="button" class="peek-close" aria-label="Close wallet" autofocus>×</button></header><div class="peek-content" aria-live="polite"></div></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector<HTMLElement>('.peek-content')!;
  const close = dialog.querySelector<HTMLButtonElement>('.peek-close')!;
  let revision = 0;
  let inFlight: { owner: string; task: Promise<PeekData> } | null = null;
  let data: PeekData | null = null;
  let tab: 'private' | 'public' | 'activity' = 'private';
  const sol = (amount: string | null | undefined) => amount === undefined ? 'Reading…' : amount === null ? 'Unavailable' : `${escapeHtml(amount)} SOL`;
  const link = (action: string) => `/wallet?action=${encodeURIComponent(action)}`;
  function render(owner: string): void {
    const wallet = activeWallet();
    const name = wallet?.name || 'Connected wallet';
    content.innerHTML = `<div class="peek-identity"><span class="peek-avatar">${iconSvg(wallet?.icon ?? 'auto', name, deterministicAvatar(owner))}</span><div><strong>${escapeHtml(name)}</strong><button class="peek-copy" type="button" data-peek-copy title="Copy full address">${escapeHtml(short(owner, 6, 6))} <span aria-hidden="true">⧉</span></button></div><a class="peek-manage" href="/wallet#wallets-section">Manage ↗</a></div>
    <div class="peek-balance"><div class="peek-balance-top"><span>Private SOL balance</span><button class="peek-icon-btn" type="button" data-peek-refresh aria-label="Refresh wallet balances" ${!data ? 'disabled' : ''}>↻</button></div><div class="peek-main-balance">${sol(data?.privateSol)}</div><div class="peek-public-line"><span>Public SOL</span><strong>${sol(data?.publicSol)}</strong></div><div class="peek-note">Private balances are encrypted in Rings. Public SOL pays network fees.</div></div>
    <div class="peek-actions"><a href="#market" data-peek-market><i aria-hidden="true">⇄</i>Trade</a><a href="${link('send')}"><i aria-hidden="true">↗</i>Send</a><button type="button" data-peek-receive><i aria-hidden="true">↙</i>Receive</button><a href="${link('deposit')}"><i aria-hidden="true">↓</i>Shield</a></div>
    <div class="peek-tabs" role="group" aria-label="Wallet holdings"><button data-peek-tab="private" aria-pressed="${tab === 'private'}">Private</button><button data-peek-tab="public" aria-pressed="${tab === 'public'}">Public</button><button data-peek-tab="activity" aria-pressed="${tab === 'activity'}">Activity</button></div><div class="peek-holdings"></div><a class="peek-open-full btn secondary wide" href="/wallet">Open full wallet ↗</a>`;
    renderRows();
  }
  function renderRows(): void {
    const rows = content.querySelector<HTMLElement>('.peek-holdings');
    if (!rows) return;
    content.querySelectorAll<HTMLButtonElement>('[data-peek-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.peekTab === tab)));
    if (!data) { rows.innerHTML = '<p class="peek-empty">Reading your on-chain balances…</p>'; return; }
    if (tab === 'activity') {
      if (!data.privateOk) { rows.innerHTML = '<p class="peek-empty">Private activity could not be read. Refresh to try again.</p>'; return; }
      const labels: Record<string, string> = { deposit: 'Shield', privateTransfer: 'Private transfer', publicWithdrawal: 'Unshield', ringEntry: 'Ring entry', split: 'Split', merge: 'Consolidation' };
      rows.innerHTML = data.activity.length ? data.activity.map((entry) => `<div class="peek-asset"><span class="peek-asset-icon activity-icon">${entry.direction === 'inbound' ? '↙' : entry.direction === 'outbound' ? '↗' : '⇄'}</span><div><strong>${escapeHtml(labels[entry.kind] ?? entry.kind)}</strong><small>${escapeHtml(entry.symbol)}</small></div><b>${escapeHtml(entry.amount)}</b></div>`).join('') : '<p class="peek-empty">No private activity yet.</p>';
      return;
    }
    const assets = data.assets.filter((asset) => asset.source === tab);
    const ok = tab === 'private' ? data.privateOk : data.publicOk;
    rows.innerHTML = `${!ok ? '<p class="peek-empty">Some balances could not be read. Refresh to try again.</p>' : ''}${assets.length ? assets.map((asset) => `<div class="peek-asset"><span class="peek-asset-icon">${tokenArt(asset.source === 'private' ? { ...asset, image: '' } : asset)}</span><div><strong>${escapeHtml(asset.symbol)}</strong><small>${escapeHtml(asset.name)}</small></div><b>${escapeHtml(asset.amount)}</b></div>`).join('') : ok ? '<p class="peek-empty">No assets in this balance yet.</p>' : ''}`;
  }
  async function refresh(): Promise<void> {
    const owner = activeAddress();
    const current = ++revision;
    data = null;
    if (!owner) {
      content.innerHTML = `<div class="peek-welcome"><span class="peek-ghost"><img src="/assets/ghost.svg" alt=""></span><h3>${hasVault() ? 'Welcome back.' : 'Your keys. Your market.'}</h3><p>${hasVault() ? 'Unlock your wallet to view your private and public balances.' : 'Create or import a self-custodial ghost wallet, or connect your own compatible Solana wallet.'}</p><a class="btn wide" href="/wallet?next=${encodeURIComponent(location.pathname + location.search)}">${hasVault() ? 'Unlock wallet' : 'Open wallet'} ↗</a><small>Keys stay in your browser. Never share your secret key.</small></div>`;
      return;
    }
    render(owner);
    try {
      if (!inFlight || inFlight.owner !== owner) {
        const task = import('./wallet-peek-data.js').then((module) => module.loadPeek(owner, catalog()));
        inFlight = { owner, task };
        void task.finally(() => { if (inFlight?.task === task) inFlight = null; }).catch(() => undefined);
      }
      const result = await inFlight.task;
      if (!dialog.open || revision !== current || activeAddress() !== owner) return;
      data = result;
      render(owner);
    } catch {
      if (dialog.open && revision === current && activeAddress() === owner) {
        data = { privateSol: null, publicSol: null, privateOk: false, publicOk: false, assets: [], activity: [] };
        render(owner);
      }
    }
  }
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.addEventListener('click', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!dialog.open) { tab = 'private'; dialog.showModal(); document.documentElement.classList.add('peek-open'); void refresh(); }
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { ++revision; data = null; content.replaceChildren(); document.documentElement.classList.remove('peek-open'); trigger.focus(); });
  content.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('[data-peek-tab]');
    if (button) { const value = button.dataset.peekTab; if (value === 'private' || value === 'public' || value === 'activity') { tab = value; renderRows(); } }
    if (target.closest('[data-peek-refresh]')) void refresh();
    if (target.closest('[data-peek-market]')) dialog.close();
    if (target.closest('[data-peek-receive]')) {
      const owner = activeAddress();
      if (!owner) return;
      const ticket = ++revision;
      content.innerHTML = `<div class="peek-receive"><button class="btn flat" type="button" data-peek-back>← Back</button><h3>Receive SOL or tokens</h3><div class="peek-qr" role="img" aria-label="Wallet address QR code">Generating QR…</div><code>${escapeHtml(owner)}</code><button type="button" class="btn wide" data-peek-copy>Copy address</button><p>Transfers to this Solana address are public. For private transfers, this wallet must be registered with Rings.</p><a class="btn secondary wide" href="${link('receive')}">Open receive settings</a></div>`;
      void import('./qr.js').then(({ qrSvg }) => {
        const box = content.querySelector<HTMLElement>('.peek-qr');
        if (box && dialog.open && revision === ticket && activeAddress() === owner) box.innerHTML = qrSvg(owner);
      }).catch(() => { const box = content.querySelector<HTMLElement>('.peek-qr'); if (box && revision === ticket) box.textContent = 'QR unavailable'; });
    }
    if (target.closest('[data-peek-back]')) { const owner = activeAddress(); if (owner && data) render(owner); else void refresh(); }

    if (target.closest('[data-peek-copy]')) {
      const owner = activeAddress();
      const control = target.closest<HTMLButtonElement>('[data-peek-copy]');
      if (owner && control && navigator.clipboard) void navigator.clipboard.writeText(owner).then(() => {
        if (dialog.open) control.textContent = 'Address copied';
      }, () => { if (dialog.open) control.textContent = 'Copy unavailable'; });
      else if (control) control.textContent = 'Copy unavailable';
    }
  });
  // Session changes in another same-origin document must not leave balances visible.
  window.addEventListener('storage', () => { if (dialog.open) dialog.close(); });
}
