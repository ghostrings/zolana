/**
 * Fee modules on the pages: the form a creator fills in to switch them on,
 * and the words that describe a token's modules to everyone else.
 *
 * The form only collects. `shared/src/modules.ts` decides what is valid, the
 * server says where the creator role must go, and the creator's own signature
 * is what switches anything on.
 */

import type { ModuleEventView, ModuleView, PairRef, StatusResponse } from '../../shared/src/api.js';
import { MAX_MODULE_WALLETS, MIN_SHARE_BPS, ModuleError, SHARE_TOTAL_BPS, checkModuleShares, percentText } from '../../shared/src/modules.js';
import { explorerAddress, explorerTx, sol, tokens } from './format.js';
import { withUnit } from './pairs.js';
import { escapeHtml, relativeTime, short } from './ui.js';

/** What the form holds once it is valid: shares in hundredths of a percent, adding up to 10000. */
export interface ModuleChoice {
  readonly burnBps: number;
  readonly wallets: ReadonlyArray<{ readonly address: string; readonly bps: number }>;
}

export interface ModulePicker {
  /** True when the creator has ticked the box. */
  enabled(): boolean;
  /** Why the form cannot be used as it stands, in a sentence. Null when it can, and when modules are off. */
  problem(): string | null;
  /** The settings as typed, or null when modules are off. Throws the same sentence `problem` returns. */
  read(): ModuleChoice | null;
  /** The wallet "Add my wallet" fills in. Null hides the button. */
  setOwnWallet(address: string | null): void;
}

/** `12.5` typed as a percentage, as hundredths of a percent. NaN for anything that is not a plain number with at most two decimals. */
function percentToBps(text: string): number {
  const trimmed = text.trim();
  if (!/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/.test(trimmed)) return Number.NaN;
  return Math.round(Number(trimmed) * 100);
}

/**
 * A sentence for what a pass acts on and how often, from the server's own
 * limits. `whose` is how the fees are named: a creator filling in the form
 * reads "your", everybody else reads "the creator's".
 */
export function moduleLimitsText(status: StatusResponse | null, whose: 'your' | "the creator's" = 'your'): string {
  const modules = status?.modules;
  if (!modules) return '';
  return `The server looks at each token every ${modules.everyMinutes} minutes. It acts once at least ${sol(modules.minLamports, 4)} SOL of ${whose} fees is waiting (the same value in another pair token), and one buyback spends at most ${sol(modules.maxBuyLamports, 4)} SOL.`;
}

/**
 * Draws the form into `container`. `always` leaves out the tick box: the form
 * is then the whole point of where it sits (the token page).
 */
export function mountModulePicker(
  container: HTMLElement,
  options: { status: StatusResponse | null; onChange?: () => void; ownWallet?: string | null; always?: boolean; mint?: string },
): ModulePicker {
  const { status } = options;
  const max = status?.modules.maxWallets ?? MAX_MODULE_WALLETS;
  const minBps = status?.modules.minShareBps ?? MIN_SHARE_BPS;
  let own = options.ownWallet ?? null;
  const changed = (): void => options.onChange?.();

  container.innerHTML = `${
    options.always
      ? ''
      : `<label class="check-row"><input type="checkbox" data-mod-on><span><b style="color:#fff">Run my fees through fee modules</b> (optional). Instead of claiming your share of the trading fees by hand, have it bought back and burned, shared between wallets, or both, automatically.</span></label>`
  }<div class="module-form" data-mod-body ${options.always ? '' : 'hidden'}>
<label class="field"><span>Buyback and burn</span><div class="input-shell"><input data-mod-burn inputmode="decimal" value="100" autocomplete="off" aria-label="Share of your fees that buys back and burns"><span class="input-unit">%</span></div><div class="hint">This share of your fees buys the token on the open market and burns what it bought, so the supply only ever falls. Enter 0 for none.</div></label>
<span class="field-label">Share with wallets</span>
<div data-mod-rows></div>
<div class="quick-amounts" style="margin-top:0"><button type="button" data-mod-add>Add a wallet</button><button type="button" data-mod-me hidden>Add my wallet</button></div>
<dl class="quote-box" data-mod-summary></dl>
<div class="notice is-plain"><strong>Permanent and public.</strong> Switching modules on hands your token's creator role to a wallet this platform's server runs for it. From then on that wallet collects your share of the fees and does exactly what you set here; you no longer claim them yourself, and the settings can never be changed, by you or by us. The wallets and their shares are written on chain for anyone to read.${options.always ? '' : ' At launch this is a second signature, asked for as soon as your token is listed.'} ${escapeHtml(moduleLimitsText(status))}</div>
</div>`;

  const body = container.querySelector<HTMLElement>('[data-mod-body]') as HTMLElement;
  const toggle = container.querySelector<HTMLInputElement>('[data-mod-on]');
  const burn = container.querySelector<HTMLInputElement>('[data-mod-burn]') as HTMLInputElement;
  const rows = container.querySelector<HTMLElement>('[data-mod-rows]') as HTMLElement;
  const add = container.querySelector<HTMLButtonElement>('[data-mod-add]') as HTMLButtonElement;
  const me = container.querySelector<HTMLButtonElement>('[data-mod-me]') as HTMLButtonElement;
  const summary = container.querySelector<HTMLElement>('[data-mod-summary]') as HTMLElement;

  const enabled = (): boolean => options.always === true || toggle?.checked === true;
  const rowNodes = (): HTMLElement[] => [...rows.querySelectorAll<HTMLElement>('.module-row')];
  const typed = (): Array<{ address: string; share: string }> =>
    rowNodes().map((row) => ({
      address: (row.querySelector<HTMLInputElement>('[data-mod-address]') as HTMLInputElement).value.trim(),
      share: (row.querySelector<HTMLInputElement>('[data-mod-share]') as HTMLInputElement).value,
    }));

  function evaluate(): { choice: ModuleChoice | null; problem: string | null; total: number } {
    const burnBps = percentToBps(burn.value || '0');
    const entries = typed();
    const shares = entries.map((entry) => percentToBps(entry.share));
    const total = (Number.isNaN(burnBps) ? 0 : burnBps) + shares.reduce((sum, bps) => sum + (Number.isNaN(bps) ? 0 : bps), 0);
    if (Number.isNaN(burnBps)) return { choice: null, problem: 'The buyback share must be a percentage, such as 50 or 12.5.', total };
    const blank = entries.findIndex((entry) => !entry.address);
    if (blank !== -1) return { choice: null, problem: `Wallet ${blank + 1} has no address. Fill it in or remove the row.`, total };
    const unread = shares.findIndex((bps) => Number.isNaN(bps));
    if (unread !== -1) return { choice: null, problem: `The share of wallet ${unread + 1} must be a percentage, such as 25 or 12.5.`, total };
    try {
      const checked = checkModuleShares({ burnBps, wallets: entries.map((entry, index) => ({ address: entry.address, bps: shares[index] as number })) });
      if (checked.wallets.some((wallet) => wallet.bps < minBps) || (checked.burnBps > 0 && checked.burnBps < minBps)) {
        return { choice: null, problem: `Every share must be at least ${percentText(minBps)}.`, total };
      }
      // Where the token is already known, its own address is not a wallet. The server checks this again.
      const own = options.mint ? checked.wallets.findIndex((wallet) => wallet.address === options.mint) : -1;
      if (own !== -1) return { choice: null, problem: `Wallet ${own + 1} is the token's own address, not a wallet.`, total };
      return { choice: { burnBps: checked.burnBps, wallets: checked.wallets }, problem: null, total };
    } catch (error) {
      return { choice: null, problem: error instanceof ModuleError ? error.message : 'These settings cannot be used.', total };
    }
  }

  function render(): void {
    body.hidden = !enabled();
    add.hidden = rowNodes().length >= max;
    me.hidden = !own || rowNodes().length >= max || typed().some((entry) => entry.address === own);
    if (!enabled()) return;
    const state = evaluate();
    const burnBps = percentToBps(burn.value || '0');
    const lines: string[] = [];
    if (!Number.isNaN(burnBps) && burnBps > 0) lines.push(`<dt>Bought back and burned</dt><dd>${escapeHtml(percentText(burnBps))}</dd>`);
    typed().forEach((entry, index) => {
      const bps = percentToBps(entry.share);
      lines.push(`<dt>${escapeHtml(entry.address ? short(entry.address, 6, 6) : `Wallet ${index + 1}`)}${entry.address && entry.address === own ? ' (you)' : ''}</dt><dd>${Number.isNaN(bps) ? '—' : escapeHtml(percentText(bps))}</dd>`);
    });
    lines.push(`<dt>Total</dt><dd class="quote-main">${escapeHtml(percentText(state.total))}${state.total === SHARE_TOTAL_BPS ? '' : ' · must be 100%'}</dd>`);
    if (state.problem) lines.push(`<dt>Not ready</dt><dd>${escapeHtml(state.problem)}</dd>`);
    summary.innerHTML = lines.join('');
  }

  function addRow(address = '', share = ''): void {
    if (rowNodes().length >= max) return;
    const row = document.createElement('div');
    row.className = 'module-row field';
    row.innerHTML = `<input data-mod-address placeholder="Wallet address" autocomplete="off" spellcheck="false" aria-label="Wallet address"><div class="input-shell"><input data-mod-share inputmode="decimal" placeholder="0" autocomplete="off" aria-label="Its share"><span class="input-unit">%</span></div><button type="button" class="icon-btn" data-mod-remove aria-label="Remove this wallet">×</button>`;
    (row.querySelector<HTMLInputElement>('[data-mod-address]') as HTMLInputElement).value = address;
    (row.querySelector<HTMLInputElement>('[data-mod-share]') as HTMLInputElement).value = share;
    row.querySelectorAll('input').forEach((input) =>
      input.addEventListener('input', () => {
        render();
        changed();
      }),
    );
    (row.querySelector('[data-mod-remove]') as HTMLButtonElement).addEventListener('click', () => {
      row.remove();
      render();
      changed();
    });
    rows.append(row);
  }

  /** What is still unassigned, as a percentage to pre-fill a new row with. Empty when nothing is. */
  const remainder = (): string => {
    const left = SHARE_TOTAL_BPS - evaluate().total;
    return left > 0 ? String(left / 100) : '';
  };

  toggle?.addEventListener('change', () => {
    render();
    changed();
  });
  burn.addEventListener('input', () => {
    render();
    changed();
  });
  add.addEventListener('click', () => {
    addRow('', remainder());
    render();
    changed();
  });
  me.addEventListener('click', () => {
    if (!own) return;
    addRow(own, remainder());
    render();
    changed();
  });
  render();

  return {
    enabled,
    problem() {
      return enabled() ? evaluate().problem : null;
    },
    read() {
      if (!enabled()) return null;
      const state = evaluate();
      if (!state.choice) throw new Error(state.problem ?? 'These settings cannot be used.');
      return state.choice;
    },
    setOwnWallet(address) {
      own = address;
      render();
    },
  };
}

/** A choice in one line: `50% buyback and burn · 50% to 7xKX…9fQa`. */
export function choiceText(choice: ModuleChoice): string {
  const parts: string[] = [];
  if (choice.burnBps > 0) parts.push(`${percentText(choice.burnBps)} buyback and burn`);
  for (const wallet of choice.wallets) parts.push(`${percentText(wallet.bps)} to ${short(wallet.address, 4, 4)}`);
  return parts.join(' · ');
}

export { moduleTag } from './module-tag.js';

const EVENT_TITLE: Record<ModuleEventView['kind'], string> = {
  payout: 'Fees paid out',
  buyback: 'Bought back and burned',
  burn: 'Burned',
  setup: 'Token accounts opened',
};

/** The panel a token's page shows for its modules: the settings, what they have done, and where to check it. */
export function moduleHtml(view: ModuleView, pair: PairRef, status: StatusResponse | null): string {
  const address = (value: string): string =>
    `<a href="${escapeHtml(explorerAddress(value))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(value, 6, 6))}</a>`;
  const settings: string[] = [];
  if (view.burnBps > 0) settings.push(`<dt>Bought back and burned</dt><dd>${escapeHtml(percentText(view.burnBps))}</dd>`);
  for (const wallet of view.wallets) settings.push(`<dt>Paid to ${address(wallet.address)}${wallet.address === view.dev ? ' (the creator)' : ''}</dt><dd>${escapeHtml(percentText(wallet.bps))}</dd>`);
  const totals = `${view.wallets.length > 0 ? `<dt>Paid to wallets so far</dt><dd>${escapeHtml(withUnit(view.totals.paid, pair, 6))}</dd>` : ''}${
    view.burnBps > 0 ? `<dt>Spent on buybacks so far</dt><dd>${escapeHtml(withUnit(view.totals.spent, pair, 6))}</dd><dt>Burned by buybacks so far</dt><dd>${escapeHtml(tokens(view.totals.burned, 0))} tokens</dd>` : ''
  }`;
  const events =
    view.events.length === 0
      ? '<div class="empty-state">NOTHING YET. THE FIRST PASS ACTS ONCE ENOUGH FEES ARE WAITING.</div>'
      : `<div class="receipt-list">${view.events
          .map((event) => {
            const detail =
              event.kind === 'buyback'
                ? `${withUnit(event.quote, pair, 6)} spent · ${tokens(event.tokens, 0)} tokens burned`
                : event.kind === 'burn'
                  ? `${tokens(event.tokens, 0)} tokens burned`
                  : event.kind === 'payout'
                    ? `${withUnit(event.quote, pair, 6)} divided`
                    : 'So the wallets can be paid';
            return `<a class="receipt-row history-row" href="${escapeHtml(explorerTx(event.signature))}" target="_blank" rel="noopener noreferrer"><div class="receipt-glyph">${event.kind === 'payout' ? '→' : event.kind === 'setup' ? '+' : '×'}</div><div><b>${escapeHtml(EVENT_TITLE[event.kind])}</b><span>${escapeHtml(detail)}</span></div><div class="receipt-values"><span>${escapeHtml(relativeTime(event.at))}</span></div></a>`;
          })
          .join('')}</div>`;
  const pass = view.lastPassAt > 0 ? `Last looked at ${relativeTime(view.lastPassAt)}.` : 'Not looked at yet.';
  const stalled = view.needsAccounts
    ? ` <strong>The payout is waiting: a wallet it pays has no ${escapeHtml(pair.symbol)} account. The server opens one for each wallet once, and that one was closed again. Nothing is lost. The payout goes ahead once every wallet above holds a ${escapeHtml(pair.symbol)} account, and sending a wallet any amount of ${escapeHtml(pair.symbol)} opens one.</strong>`
    : view.stalled
      ? ' <strong>The last pass could not finish for this token. Nothing is lost: it is tried again on the next one.</strong>'
      : '';
  return `<dl class="kv">${settings.join('')}${totals}<dt>Switched on by</dt><dd>${address(view.dev)} · ${escapeHtml(relativeTime(view.since))}</dd><dt>Fee wallet (holds the creator role)</dt><dd>${address(view.wallet)}</dd>${view.pot ? `<dt>Buyback pot</dt><dd>${address(view.pot)}</dd>` : ''}</dl>
<p class="small muted">Only the creator's share of the fees runs through this. The settings are permanent, and they are on chain: the wallet that holds the creator role exists only for these exact settings. ${escapeHtml(moduleLimitsText(status, "the creator's"))} ${escapeHtml(pass)}${stalled}</p>
${events}`;
}
