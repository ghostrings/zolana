import '../custom-rings/ghost.css';
import { api } from '../api.js';
import { amountText, looksLikeAddress, shareText } from '../rings-render.js';
import { byId, initShell, setText } from '../ui.js';

// Read-only public data. This page does not import wallet or private history code.
initShell('ghost');
// The shared header remains a normal wallet-page link; no wallet popover is mounted here.
const identity = document.querySelector('[data-identity]');
identity?.removeAttribute('aria-haspopup');
identity?.removeAttribute('aria-expanded');
const pill = document.querySelector<HTMLElement>('[data-runtime]');
if (pill) pill.textContent = 'Public data';
const mint = byId<HTMLInputElement>('gi-mint');
const explorer = byId<HTMLAnchorElement>('gi-explorer');
const date = (value: number | null): string => value === null || !Number.isFinite(value) ? 'Unknown' : new Date(value).toISOString();
let overviewRequest = 0, tokenRequest = 0;
async function refresh(): Promise<void> {
  const sequence = ++overviewRequest;
  setText('gi-status', 'Reading the existing public Rings indexer…');
  for (const id of ['gi-assets', 'gi-sol', 'gi-24h', 'gi-coverage', 'gi-period']) setText(id, '—');
  try {
    const data = await api.ringOverview();
    if (sequence !== overviewRequest) return;
    if (!data.enabled || data.through === null) { setText('gi-status', 'Public index unavailable or not yet synchronized.'); return; }
    setText('gi-assets', data.tokens.toLocaleString('en-US'));
    setText('gi-sol', `${amountText(data.solShielded, 9)} SOL`);
    setText('gi-24h', data.tx24h.toLocaleString('en-US'));
    setText('gi-coverage', data.complete ? 'Configured range' : 'Partial');
    setText('gi-period', `Indexed history: ${date(data.since)} to ${date(data.through)}. “Configured range” is not proof of full chain history; 24h counts may be incomplete.`);
    setText('gi-status', 'Source: existing public Rings indexer · not Custom Ring audit data.');
  } catch { if (sequence === overviewRequest) setText('gi-status', 'Public index unavailable. No fallback estimates are shown.'); }
}
async function readToken(): Promise<void> {
  const sequence = ++tokenRequest;
  const value = mint.value.trim();
  byId('gi-token-data').hidden = true; explorer.hidden = true; setText('gi-token-note', '');
  if (!looksLikeAddress(value)) { setText('gi-token-status', 'Enter a valid-shaped public Solana token mint.'); return; }
  setText('gi-token-status', 'Reading public token metrics…');
  try {
    const result = await api.ringToken(value);
    if (sequence !== tokenRequest) return;
    const token = result.asset;
    if (token.mint !== value) throw new Error('Mint mismatch');
    const label = token.symbol || 'token units';
    setText('gi-supply', token.supply ? `${amountText(token.supply, token.decimals)} ${label}` : 'Unknown');
    setText('gi-shielded', token.shielded ? `${amountText(token.shielded, token.decimals)} ${label}` : 'Unknown');
    setText('gi-share', token.shareBps === null ? 'Unknown' : shareText(token.shareBps, token.shielded));
    setText('gi-moves', token.moves24h.toLocaleString('en-US'));
    setText('gi-token-status', 'Source: public protocol asset record. Not isolated to GHOST Ring.');
    setText('gi-token-note', 'The public asset record is an indexed observation; it is not an independently attested finalized snapshot. No private holder count is inferred.');
    explorer.href = `/rings?token=${encodeURIComponent(value)}`; explorer.hidden = false; byId('gi-token-data').hidden = false;
  } catch { if (sequence === tokenRequest) setText('gi-token-status', 'No matching public record could be read. No estimates are shown.'); }
}
byId('gi-refresh').addEventListener('click', () => { void refresh(); if (mint.value.trim()) void readToken(); });
byId<HTMLFormElement>('gi-token-form').addEventListener('submit', (event) => { event.preventDefault(); void readToken(); });
// Clear a previous result immediately if the input changes; invalidate outstanding reads.
mint.addEventListener('input', () => { tokenRequest++; byId('gi-token-data').hidden = true; explorer.hidden = true; setText('gi-token-note', ''); setText('gi-token-status', 'Read metrics for this mint.'); });
const initial = new URLSearchParams(location.search).get('mint');
if (initial && looksLikeAddress(initial)) { mint.value = initial; void readToken(); }
void refresh();
