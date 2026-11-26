import '../custom-rings/ghost.css';
import { GHOST_RING_TARGET, ghostRingStatus, type GhostRingStatus } from '../../../shared/src/custom-rings/config.js';
import { GhostRingLab, LAB_ASSETS, LAB_MEMBERS, LAB_MAX_AMOUNT, type LabAsset, type LabLeg, type LabOperation } from '../../../shared/src/custom-rings/lab.js';
import { labAggregate } from '../../../shared/src/custom-rings/intelligence.js';
import { byId, initShell, setText } from '../ui.js';

// No production wallet, signer, viewing key, RPC or transaction code imported here.
initShell('ghost');
// The shared header remains a normal wallet-page link; no wallet popover is mounted here.
const identity = document.querySelector('[data-identity]');
identity?.removeAttribute('aria-haspopup');
identity?.removeAttribute('aria-expanded');
const field = <T extends HTMLElement>(id: string): T => byId<T>(id);
const select = (id: string) => field<HTMLSelectElement>(id);
const input = (id: string) => field<HTMLInputElement>(id);
const member = select('ghost-member'), recipient = select('ghost-recipient'), policyMember = select('ghost-policy-member');
const operation = select('ghost-operation'), asset = select('ghost-asset');
const blocked = input('ghost-block'), frozen = input('ghost-freeze'), paused = input('ghost-pause');
const result = byId('ghost-result');
let lab = new GhostRingLab();
for (const picker of [member, recipient, policyMember]) for (const id of LAB_MEMBERS) picker.add(new Option(id, id));
recipient.selectedIndex = 1;
const selectedAsset = (): LabAsset => asset.value === 'TEST-TOKEN' ? 'TEST-TOKEN' : 'TEST-SOL';
function displayConfig(): void {
  const list = byId('ghost-config');
  for (const [key, value] of Object.entries(GHOST_RING_TARGET)) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = key; dd.textContent = typeof value === 'boolean' ? (value ? 'Enabled' : 'Disabled') : value;
    list.append(dt, dd);
  }
}
function showStatus(status: GhostRingStatus, remote: boolean): void {
  setText('ghost-status', 'Not deployed · simulation only');
  setText('ghost-status-source', `${remote ? 'Server readiness' : 'Local release guard (server unavailable)'} · upstream documentation checked ${status.checkedOn}`);
  const list = byId('ghost-blockers');
  list.replaceChildren(...status.blockers.map((text) => { const li = document.createElement('li'); li.textContent = text; return li; }));
  const pill = document.querySelector<HTMLElement>('[data-runtime]');
  if (pill) { pill.textContent = 'Research lab'; pill.dataset.mode = 'mock'; }
}
async function loadStatus(): Promise<void> {
  try {
    const response = await fetch('/api/custom-rings/status', { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error('Unavailable');
    const status = await response.json() as GhostRingStatus;
    if (status.execution !== 'local-simulation-only' || status.canTransact !== false || status.network !== null || status.ringProgram !== null || status.auditedAnalytics !== false || status.checkedOn !== ghostRingStatus().checkedOn || !Array.isArray(status.blockers) || !status.blockers.every((v) => typeof v === 'string') || JSON.stringify(status.target) !== JSON.stringify(GHOST_RING_TARGET)) throw new Error('Unexpected status');
    showStatus(status, true);
  } catch { showStatus(ghostRingStatus(), false); }
}
function showPolicy(): void {
  blocked.checked = lab.isBlocked(policyMember.value); frozen.checked = lab.isFrozen(policyMember.value); paused.checked = lab.paused;
}
function showOperation(): void {
  const counterparty = operation.value === 'transfer' || operation.value === 'fill';
  byId('ghost-recipient-field').hidden = !counterparty;
  byId('ghost-other-field').hidden = operation.value !== 'fill';
}
function pct(bps: number | null): string { return bps === null ? 'Suppressed' : `${(bps / 100).toFixed(2)}%`; }
function render(): void {
  const balance = lab.balance(member.value, selectedAsset());
  setText('ghost-ring-balance', `${balance.ring} ${selectedAsset()}`);
  setText('ghost-outside-balance', `${balance.outside} ${selectedAsset()}`);
  const report = labAggregate(lab.snapshot(selectedAsset()));
  setText('ghost-holders', report.holderCount === null ? 'Suppressed' : String(report.holderCount));
  setText('ghost-share', pct(report.ringShareBps));
  setText('ghost-concentration', pct(report.topTenShareBps));
  setText('ghost-snapshot', `SYNTHETIC · ${report.asset} · operation #${report.sequence} · ${report.ringUnits} / ${report.totalSupplyUnits} fictional supply units in ring. Not an attestation.`);
  const receipts: HTMLElement[] = lab.receipts().slice(-8).reverse().map((entry) => {
    const row = document.createElement('div'); row.className = 'ghost-receipt';
    for (const text of [`#${entry.sequence}`, entry.result.toUpperCase(), entry.reason]) { const span = document.createElement('span'); span.textContent = text; row.append(span); }
    return row;
  });
  if (!receipts.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No test operations yet.'; receipts.push(p); }
  byId('ghost-receipts').replaceChildren(...receipts);
}
function amount(id: string): bigint {
  const raw = input(id).value.trim();
  if (!/^[1-9]\d{0,6}$/.test(raw)) throw new Error('Enter positive whole fictional units.');
  const parsed = BigInt(raw);
  if (parsed > LAB_MAX_AMOUNT) throw new Error('Amount exceeds the lab limit.');
  return parsed;
}
field<HTMLFormElement>('ghost-operation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const selected = selectedAsset();
    const legs: LabLeg[] = operation.value === 'fill' ? [
      { operation: 'transfer', member: member.value, recipient: recipient.value, asset: selected, amount: amount('ghost-amount') },
      { operation: 'transfer', member: recipient.value, recipient: member.value, asset: LAB_ASSETS.find((value) => value !== selected)!, amount: amount('ghost-other-amount') },
    ] : [{ operation: operation.value as LabOperation, member: member.value, ...(operation.value === 'transfer' ? { recipient: recipient.value } : {}), asset: selected, amount: amount('ghost-amount') }];
    const receipt = lab.execute(legs, { ownerApproved: input('ghost-owner-approval').checked, cosignerApproved: input('ghost-cosigner-approval').checked });
    result.textContent = `${receipt.result.toUpperCase()} · ${receipt.reason}`; result.dataset.result = receipt.result;
    render();
  } catch (error) { result.textContent = error instanceof Error ? error.message : 'Invalid test operation.'; result.dataset.result = 'rejected'; }
});
operation.addEventListener('change', showOperation);
member.addEventListener('change', render); asset.addEventListener('change', render);
policyMember.addEventListener('change', showPolicy);
blocked.addEventListener('change', () => lab.setBlocked(policyMember.value, blocked.checked));
frozen.addEventListener('change', () => lab.setFrozen(policyMember.value, frozen.checked));
paused.addEventListener('change', () => lab.setPaused(paused.checked));
byId('ghost-reset').addEventListener('click', () => {
  lab = new GhostRingLab(); field<HTMLFormElement>('ghost-operation-form').reset(); recipient.selectedIndex = 1; policyMember.selectedIndex = 0; showPolicy(); showOperation(); render(); result.textContent = 'All fictional state reset.'; delete result.dataset.result;
});
byId('ghost-download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(GHOST_RING_TARGET, null, 2)}\n`], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'ghost-ring.research.json'; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});
displayConfig(); showStatus(ghostRingStatus(), false); showPolicy(); showOperation(); render(); void loadStatus();
