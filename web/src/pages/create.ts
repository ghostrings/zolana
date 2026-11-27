import type { PairStatus, StatusResponse } from '../../../shared/src/api.js';
import { TOKEN_TOTAL_SUPPLY } from '../../../shared/src/constants.js';
import { buildTierConfig } from '../../../shared/src/curve.js';
import { feeSplit, tierById } from '../../../shared/src/tiers.js';
import { parseUnits } from '../../../shared/src/units.js';
import { api } from '../api.js';
import { explorerTx, tokens } from '../format.js';
import { ensureWallet } from '../gate.js';
import { type ModuleChoice, type ModulePicker, choiceText, mountModulePicker } from '../modules.js';
import { SOL_REF, amount, curveQuoteOf, pairOf, quickAmounts, tradeCap, withUnit } from '../pairs.js';
import { watchWallet } from '../session-bus.js';
import { mountRuntime, payoutClause, setupMessage } from '../shell.js';
import { type Launched, checkLaunch, checkModules, firstBuyPreview, friendlyError, launch } from '../trade.js';
import { byId, deterministicAvatar, escapeHtml, initShell, setText, short, toast } from '../ui.js';
import { activeAddress, lastUsedWallet } from '../vault.js';
import { type Session, getSession } from '../wallet.js';

import { mountNativeSummary } from '../native-markets.js';

initShell('create');
void mountNativeSummary();

const form = byId<HTMLFormElement>('launch-form');
const nameInput = byId<HTMLInputElement>('name');
const symbolInput = byId<HTMLInputElement>('symbol');
const descriptionInput = byId<HTMLTextAreaElement>('description');
const websiteInput = byId<HTMLInputElement>('website');
const twitterInput = byId<HTMLInputElement>('twitter');
const firstBuyInput = byId<HTMLInputElement>('first-buy');
const artInput = byId<HTMLInputElement>('art-input');
const artDrop = byId('art-drop');
const artThumb = byId('art-thumb');
const artClear = byId<HTMLButtonElement>('art-clear');
const riskCheck = byId<HTMLInputElement>('risk-check');
const launchButton = byId<HTMLButtonElement>('launch-button');
const output = byId('launch-output');
const gate = byId('launch-gate');
const volumeInput = byId<HTMLInputElement>('volume-sim');

const ART_PLACEHOLDER = artThumb.innerHTML;
const ART_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

let status: StatusResponse | null = null;
let session: Session | null = null;
let step = 1;
/** The pair token the new token will be priced in. SOL until another is picked. */
let pairId = SOL_REF.id;
let tierId = 'tier-300';
let art: File | null = null;
let artUrl: string | null = null;
let busy = false;
let launched = false;
/** The fee modules form. Null while the server does not run fee modules. */
let modulePicker: ModulePicker | null = null;

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/* ---------------- Reading the form ---------------- */

function httpsOrEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) return '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a complete https:// address.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must start with https://.`);
  return url.toString();
}

/** The chosen pair token as the server describes it. Undefined until the status has loaded. */
function pair(): PairStatus | undefined {
  return pairOf(status, pairId);
}

/** The first buy, in base units of the chosen pair token. */
function firstBuyUnits(): bigint {
  const text = firstBuyInput.value.trim();
  if (!text || /^0*(\.0*)?$/.test(text)) return 0n;
  return parseUnits(text, pair()?.decimals ?? SOL_REF.decimals);
}

function checkIdentity(): { field: HTMLElement; message: string } | null {
  const name = nameInput.value.trim();
  if (!name) return { field: nameInput, message: 'Give the token a name.' };
  if (utf8Length(name) > 32) return { field: nameInput, message: 'Token names are limited to 32 bytes.' };
  if (!/^[A-Za-z0-9]{1,10}$/.test(symbolInput.value.trim())) {
    return { field: symbolInput, message: 'The ticker must be 1 to 10 letters or digits.' };
  }
  if (descriptionInput.value.trim().length > 500) return { field: descriptionInput, message: 'Keep the story under 500 characters.' };
  try {
    httpsOrEmpty(websiteInput.value, 'The website');
  } catch (error) {
    return { field: websiteInput, message: (error as Error).message };
  }
  try {
    httpsOrEmpty(twitterInput.value, 'The X link');
  } catch (error) {
    return { field: twitterInput, message: (error as Error).message };
  }
  return null;
}

function checkSettings(): { field: HTMLElement; message: string } | null {
  if (!status) return { field: firstBuyInput, message: 'The server is not reachable, so nothing can be launched right now.' };
  if (status.limits.launchesPaused) return { field: byId('tier-grid'), message: status.limits.notice ?? 'New launches are paused for now.' };
  const chosen = pair();
  if (!chosen || !chosen.live) {
    return { field: byId('pair-grid'), message: chosen?.problem ? `Tokens cannot be launched against ${chosen.symbol} right now. ${chosen.problem}` : 'That pair token is not live yet. Pick another one.' };
  }
  const tier = chosen.tiers.find((candidate) => candidate.id === tierId);
  if (!tier?.live) return { field: byId('tier-grid'), message: tier?.problem ? `That fee tier cannot take launches right now. ${tier.problem}` : 'That fee tier is not live yet. Pick another one.' };
  try {
    const units = firstBuyUnits();
    const cap = tradeCap(status, chosen);
    if (cap > 0n && units > cap) return { field: firstBuyInput, message: `First buys are limited to ${withUnit(cap, chosen, 2)} for now.` };
    if (units > 0n) firstBuyPreview(status, pairId, tierId, units);
  } catch (error) {
    return { field: firstBuyInput, message: friendlyError(error) };
  }
  const moduleProblem = modulePicker?.problem();
  if (moduleProblem) return { field: byId('module-picker'), message: `Fee modules: ${moduleProblem}` };
  return null;
}

/** What happens to the creator's share of the fees, in a few words, for the settings box and the review. */
function feesLine(): string {
  try {
    const choice = modulePicker?.read();
    return choice ? `${choiceText(choice)} · automatic, permanent` : 'Claimed by you, by hand';
  } catch {
    return 'Fee modules: not ready';
  }
}

/* ---------------- Artwork ---------------- */

function setArt(file: File | null): void {
  if (file) {
    if (!ART_TYPES.has(file.type)) {
      toast('Artwork must be a PNG, JPG, GIF or WebP image.', 'error');
      return;
    }
    const limit = status?.uploads.maxImageBytes ?? 4 * 1024 * 1024;
    if (file.size > limit) {
      toast(`Artwork is limited to ${Math.floor(limit / (1024 * 1024))} MB.`, 'error');
      return;
    }
  }
  if (artUrl) URL.revokeObjectURL(artUrl);
  art = file;
  artUrl = file ? URL.createObjectURL(file) : null;
  artThumb.innerHTML = artUrl ? `<img src="${escapeHtml(artUrl)}" alt="Chosen artwork">` : ART_PLACEHOLDER;
  artClear.hidden = !file;
  setText('art-name', file ? file.name : '');
  if (!file) artInput.value = '';
  renderPreview();
}

artInput.addEventListener('change', () => setArt(artInput.files?.[0] ?? null));
artClear.addEventListener('click', () => setArt(null));
for (const type of ['dragenter', 'dragover'] as const) {
  artDrop.addEventListener(type, (event) => {
    event.preventDefault();
    artDrop.classList.add('is-dropping');
  });
}
for (const type of ['dragleave', 'drop'] as const) {
  artDrop.addEventListener(type, (event) => {
    event.preventDefault();
    artDrop.classList.remove('is-dropping');
  });
}
artDrop.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) setArt(file);
});

/* ---------------- Rendering ---------------- */

function renderPreview(): void {
  const symbol = symbolInput.value.trim().toUpperCase();
  setText('preview-symbol', `$${symbol || 'TICKER'}`);
  setText('preview-name', nameInput.value.trim() || 'Your name here');
  setText('preview-description', descriptionInput.value.trim() || 'Your story appears here.');
  setText('name-count', `${utf8Length(nameInput.value.trim())}/32`);
  setText('symbol-count', `${symbolInput.value.trim().length}/10`);
  setText('description-count', `${descriptionInput.value.trim().length}/500`);
  byId('preview-avatar').innerHTML = artUrl
    ? `<img class="token-image" src="${escapeHtml(artUrl)}" alt="">`
    : deterministicAvatar(symbol || 'PCF');
  const tier = tierById(tierId);
  setText('preview-fee', `FEE ${tier.label} · PAIR ${pair()?.symbol ?? SOL_REF.symbol}`);
}

/** The pair tokens a launch can be priced in. One that is not set up on this site is shown, and cannot be picked. */
function renderPairs(): void {
  const grid = byId('pair-grid');
  const pairs = status?.pairs ?? [];
  if (pairs.length === 0) {
    grid.innerHTML = '<div class="empty-state">PAIR TOKENS UNAVAILABLE</div>';
    setText('pair-note', '');
    return;
  }
  // Fall back to the first live pair when the chosen one cannot take launches.
  if (!pairs.find((candidate) => candidate.id === pairId)?.live) pairId = pairs.find((candidate) => candidate.live)?.id ?? pairId;
  grid.innerHTML = pairs
    .map((candidate) => {
      const selected = candidate.id === pairId;
      return `<label class="pair-card ${selected ? 'is-selected' : ''} ${candidate.live ? '' : 'is-off'}" title="${escapeHtml(candidate.live ? candidate.name : (candidate.problem ?? 'Not live yet'))}"><input type="radio" name="pair" value="${escapeHtml(candidate.id)}" ${selected ? 'checked' : ''} ${candidate.live ? '' : 'disabled'}><b>${escapeHtml(candidate.symbol)}</b><span>${escapeHtml(candidate.name)}</span><small>${candidate.live ? 'Live' : candidate.curve ? 'Not live yet' : 'Not set up'}</small></label>`;
    })
    .join('');
  grid.querySelectorAll<HTMLInputElement>('input[name=pair]').forEach((input) => {
    input.addEventListener('change', () => {
      pairId = input.value;
      // An amount typed for one pair token means something else in another.
      firstBuyInput.value = '';
      renderPairs();
      renderTiers();
      renderFirstBuy();
      renderSettings();
      renderPreview();
      renderRevenue();
    });
  });
  const chosen = pair();
  const note = byId('pair-note');
  if (!chosen) {
    note.textContent = '';
    return;
  }
  const parts = [`<b>${escapeHtml(chosen.symbol)}</b>: ${escapeHtml(chosen.note)}`];
  if (!chosen.native) {
    parts.push(`Buyers pay ${escapeHtml(chosen.symbol)}, sellers receive it, and every fee is taken in it.`);
    for (const line of chosen.holderNotes) parts.push(escapeHtml(line));
  }
  note.innerHTML = parts.join(' ');
}

/** The first-buy field's unit, its hint and its quick amounts, all in the chosen pair token. */
function renderFirstBuy(): void {
  const chosen = pair() ?? SOL_REF;
  setText('first-buy-unit', chosen.symbol);
  setText('volume-unit', chosen.symbol);
  setText(
    'first-buy-hint',
    chosen.id === SOL_REF.id
      ? 'Paid from your public SOL in the launch transaction. The tokens go straight into your encrypted balance.'
      : `Paid from your public ${chosen.symbol}, the ${chosen.symbol} in your ordinary token account, in the launch transaction. The tokens go straight into your encrypted balance.`,
  );
  const quick = byId('first-buy-quick');
  quick.innerHTML = `<button type="button" data-first-buy="0">None</button>${quickAmounts(status, chosen, [0.1, 0.5, 1, 2])
    .map((value) => `<button type="button" data-first-buy="${escapeHtml(value)}">${escapeHtml(value)}</button>`)
    .join('')}`;
  quick.querySelectorAll<HTMLButtonElement>('[data-first-buy]').forEach((button) => {
    button.addEventListener('click', () => {
      firstBuyInput.value = button.dataset.firstBuy === '0' ? '' : (button.dataset.firstBuy ?? '');
      renderSettings();
    });
  });
}

function renderTiers(): void {
  const grid = byId('tier-grid');
  const tiers = pair()?.tiers ?? [];
  if (tiers.length === 0) {
    grid.innerHTML = '<div class="empty-state">FEE TIERS UNAVAILABLE</div>';
    return;
  }
  // Fall back to the first live tier when the default one has not been created.
  if (!tiers.find((tier) => tier.id === tierId)?.live) {
    tierId = tiers.find((tier) => tier.live)?.id ?? tierId;
  }
  grid.innerHTML = tiers
    .map((tier) => {
      const live = tier.live;
      const selected = tier.id === tierId;
      return `<label class="tier-card ${selected ? 'is-selected' : ''} ${live ? '' : 'is-off'}"><input type="radio" name="tier" value="${escapeHtml(tier.id)}" ${selected ? 'checked' : ''} ${live ? '' : 'disabled'}><b>${escapeHtml(tier.label)}</b><span>${escapeHtml(tier.blurb)}</span><small>${live ? 'Curve + after graduation' : 'Not live yet'}</small></label>`;
    })
    .join('');
  grid.querySelectorAll<HTMLInputElement>('input[name=tier]').forEach((input) => {
    input.addEventListener('change', () => {
      tierId = input.value;
      renderTiers();
      renderSettings();
      renderPreview();
      renderRevenue();
    });
  });
}

function renderSettings(): void {
  const box = byId('settings-box');
  const chosen = pair();
  if (!status || !chosen || !chosen.curve) {
    box.innerHTML = '<dt>Launch settings</dt><dd>Unavailable</dd>';
    return;
  }
  const tier = tierById(tierId);
  const split = feeSplit(status.economics);
  let raised = '';
  try {
    raised = ` · ${withUnit(BigInt(buildTierConfig(tier, status.economics, curveQuoteOf(chosen)).migrationQuoteThreshold.toString()), chosen, 2)} raised`;
  } catch {
    raised = '';
  }
  let firstBuy = '<dt>First buy</dt><dd>None</dd>';
  try {
    const units = firstBuyUnits();
    if (units > 0n) {
      const preview = firstBuyPreview(status, pairId, tierId, units);
      const share = (Number(preview.tokensOut) / 10 ** 6 / TOKEN_TOTAL_SUPPLY) * 100;
      firstBuy = `<dt>You receive (private)</dt><dd class="quote-main">${tokens(preview.tokensOut, 0)} tokens</dd><dt>Share of supply</dt><dd>${share.toFixed(share < 1 ? 3 : 2)}%</dd><dt>Fee on the first buy</dt><dd>${escapeHtml(withUnit(preview.fee, chosen, 6))}</dd>`;
    }
  } catch (error) {
    firstBuy = `<dt>First buy</dt><dd>${escapeHtml(friendlyError(error))}</dd>`;
  }
  const keeper = chosen.keeperNote ? `<dt>Graduation</dt><dd>${escapeHtml(chosen.keeperNote)}</dd>` : '';
  box.innerHTML = `<dt>Priced and traded in</dt><dd>${escapeHtml(chosen.symbol)} · ${escapeHtml(chosen.name)}</dd><dt>Trading fee, curve</dt><dd>${tier.label}</dd><dt>Trading fee, after graduation</dt><dd>${tier.label}</dd><dt>Fee split, curve</dt><dd>${split.creatorPct}% you · ${split.platformPct}% platform · ${split.protocolPct}% Meteora</dd><dt>After graduation</dt><dd>${escapeHtml(payoutClause(status, 'you'))}</dd><dt>Your share of the fees</dt><dd>${escapeHtml(feesLine())}</dd><dt>Starting market cap</dt><dd>${chosen.curve.initialMarketCap.toLocaleString('en-US')} ${escapeHtml(chosen.symbol)}</dd><dt>Graduates at</dt><dd>${chosen.curve.migrationMarketCap.toLocaleString('en-US')} ${escapeHtml(chosen.symbol)} cap${escapeHtml(raised)}</dd>${keeper}${firstBuy}`;
}

function renderRevenue(): void {
  const tier = tierById(tierId);
  const split = status ? feeSplit(status.economics) : null;
  const unit = pair()?.symbol ?? SOL_REF.symbol;
  const volume = Number(volumeInput.value.replaceAll(',', ''));
  if (!split || !Number.isFinite(volume) || volume < 0) {
    setText('creator-revenue', '—');
    return;
  }
  const revenue = (volume * tier.feeBps * split.creatorPct) / 1_000_000;
  setText('creator-revenue', `${revenue.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${unit}`);
  setText('revenue-note', `${tier.label} fee, ${split.creatorPct}% of each curve fee to the creator, paid in ${unit}. Arithmetic, not a forecast.`);
}

function renderRules(): void {
  if (!status) return;
  const split = feeSplit(status.economics);
  const live = status.pairs.filter((candidate) => candidate.live).map((candidate) => candidate.symbol);
  byId('rules-kv').innerHTML = `<dt>Supply</dt><dd>1,000,000,000 · 6 decimals</dd><dt>Pair token</dt><dd>${escapeHtml(live.length > 0 ? live.join(', ') : 'SOL')} · fixed at launch</dd><dt>Trading fee</dt><dd>2%, 3% or 4% · fixed</dd><dt>Fee after graduation</dt><dd>The same</dd><dt>Your share of each curve fee</dt><dd>${split.creatorPct}% · claimed on chain</dd><dt>Platform share</dt><dd>${split.platformPct}%</dd><dt>Meteora protocol share</dt><dd>${split.protocolPct}%</dd><dt>Liquidity after graduation</dt><dd>100% locked permanently · held by the platform</dd><dt>Your share after graduation</dt><dd>${status.creatorPoolPayoutPct > 0 ? `${status.creatorPoolPayoutPct}% of the pool fees the platform collects, paid by the platform` : 'None: pool fees go to the platform'}</dd>`;
}

function renderReview(): void {
  if (!status) return;
  const tier = tierById(tierId);
  const chosen = pair() ?? SOL_REF;
  let units = 0n;
  let received = '';
  try {
    units = firstBuyUnits();
    if (units > 0n) received = `${withUnit(units, chosen, 6)} → ${tokens(firstBuyPreview(status, pairId, tierId, units).tokensOut, 0)} tokens, private`;
  } catch {
    received = 'Invalid';
  }
  byId('review-list').innerHTML = `<dt>Name</dt><dd>${escapeHtml(nameInput.value.trim())}</dd><dt>Ticker</dt><dd>$${escapeHtml(symbolInput.value.trim().toUpperCase())}</dd><dt>Artwork</dt><dd>${art ? escapeHtml(art.name) : 'Generated pixel mark'}</dd><dt>Priced and traded in</dt><dd>${escapeHtml(chosen.symbol)} · permanent</dd><dt>Trading fee</dt><dd>${tier.label} · curve and after graduation</dd><dt>First buy</dt><dd>${escapeHtml(received) || 'None'}</dd><dt>Your share of the fees</dt><dd>${escapeHtml(feesLine())}</dd><dt>Creator wallet</dt><dd>${session ? escapeHtml(short(session.address, 6, 6)) : 'Not unlocked'}</dd><dt>Network</dt><dd>${escapeHtml(status.network.toUpperCase())}</dd>`;
  byId('launch-visibility').innerHTML = `<div class="visibility-title">What an observer sees</div><dt>Your wallet, as the creator</dt><dd class="is-public">PUBLIC</dd><dt>Name, ticker, artwork, pair, fee</dt><dd class="is-public">PUBLIC</dd><dt>First buy size</dt><dd class="is-public">${units > 0n ? 'PUBLIC' : 'NONE'}</dd>${modulePicker?.enabled() ? '<dt>Fee module wallets and shares</dt><dd class="is-public">PUBLIC</dd>' : ''}<dt>What you hold afterwards</dt><dd class="is-hidden">ENCRYPTED</dd><dt>Private transfers of this token later</dt><dd class="is-hidden">AMOUNT + ASSET ENCRYPTED</dd>`;
}

function refreshLaunchButton(): void {
  launchButton.disabled = busy || launched || !session || !riskCheck.checked;
}

async function enterReview(): Promise<void> {
  renderReview();
  session = await ensureWallet(gate, {
    purpose: 'to launch',
    onReady(ready) {
      session = ready;
      modulePicker?.setOwnWallet(ready.address);
      renderReview();
      refreshLaunchButton();
    },
  });
  if (session) modulePicker?.setOwnWallet(session.address);
  renderReview();
  refreshLaunchButton();
}

function go(target: number): void {
  if (busy) return;
  if (target > step) {
    const problem = (step === 1 ? checkIdentity() : null) ?? (target === 3 ? (checkIdentity() ?? checkSettings()) : null);
    if (problem) {
      toast(problem.message, 'error');
      problem.field.focus();
      return;
    }
  }
  step = target;
  document.querySelectorAll<HTMLElement>('[data-pane]').forEach((pane) => {
    pane.hidden = Number(pane.dataset.pane) !== step;
  });
  document.querySelectorAll<HTMLElement>('#stepper li').forEach((item) => {
    const index = Number(item.dataset.step);
    item.classList.toggle('is-current', index === step);
    item.classList.toggle('is-done', index < step);
    if (index === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  if (step === 2) renderSettings();
  if (step === 3) void enterReview();
  byId('stepper').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------------- Launch ---------------- */

function stage(message: string): void {
  output.innerHTML = `<div class="status"><b>WORKING</b><br>${escapeHtml(message)}</div>`;
}

/** What to say about the fee modules once a launch has landed. Empty when none were asked for. */
function modulesOutcome(outcome: Launched['modules'], choice: ModuleChoice | undefined): string {
  if (!outcome || !choice) return '';
  const network = status?.network ?? 'mainnet';
  if (outcome.on) {
    return `<div class="status ok"><b>FEE MODULES ARE ON</b><br>${escapeHtml(choiceText(choice))}<div class="status-actions"><a class="btn flat" href="${escapeHtml(explorerTx(outcome.signature, network))}" target="_blank" rel="noopener noreferrer">View transaction</a></div></div>`;
  }
  return `<div class="status error"><b>FEE MODULES WERE NOT SWITCHED ON</b><br>Your token is live and trading. Its fee modules are off, so its fees are yours to claim by hand as usual. ${escapeHtml(outcome.reason)}<br>To switch them on, open the token's page with this wallet and use <b>Automate your fees</b>.</div>`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || launched || step !== 3) return;
  const problem = checkIdentity() ?? checkSettings();
  if (problem) {
    toast(problem.message, 'error');
    return;
  }
  if (!session) {
    toast('Unlock a wallet first.', 'error');
    return;
  }
  if (!riskCheck.checked) {
    toast('Confirm the acknowledgement first.', 'error');
    return;
  }
  busy = true;
  refreshLaunchButton();
  form.classList.add('is-loading');
  try {
    const symbol = symbolInput.value.trim().toUpperCase();
    const modules = modulePicker?.read() ?? undefined;
    stage('Checking your wallet…');
    await checkLaunch(session, { pairId, tierId, firstBuy: firstBuyUnits(), ...(modules ? { modules } : {}) });
    if (modules) {
      // Before anything is uploaded: the server reads each wallet from chain and refuses what it could not pay.
      stage('Checking the fee module settings…');
      await checkModules(modules);
    }
    let image = '';
    if (art) {
      stage('Uploading the artwork…');
      image = await api.uploadImage(art);
    }
    stage('Saving the metadata…');
    const uri = await api.uploadMetadata({
      name: nameInput.value.trim(),
      symbol,
      description: descriptionInput.value.trim(),
      image,
      website: httpsOrEmpty(websiteInput.value, 'The website'),
      twitter: httpsOrEmpty(twitterInput.value, 'The X link'),
    });
    const result = await launch(
      session,
      { pairId, tierId, name: nameInput.value.trim(), symbol, uri, firstBuy: firstBuyUnits(), ...(modules ? { modules } : {}) },
      stage,
    );
    launched = true;
    const network = status?.network ?? 'mainnet';
    output.innerHTML = `<div class="status ok"><b>$${escapeHtml(symbol)} IS LIVE</b><span class="address-block">${escapeHtml(result.mint)}</span><div class="status-actions"><a class="btn" href="/token?mint=${encodeURIComponent(result.mint)}">Open the market</a><a class="btn flat" href="${escapeHtml(explorerTx(result.signature, network))}" target="_blank" rel="noopener noreferrer">View transaction</a></div>${result.dustLeftPublic ? '<div class="hint">A few token units of rounding from the first buy stayed in your public token account. You can make them private from the wallet page.</div>' : ''}</div>${modulesOutcome(result.modules, modules)}`;
    toast(`$${symbol} launched`);
  } catch (error) {
    output.innerHTML = `<div class="status error"><b>LAUNCH FAILED</b><br>${escapeHtml(friendlyError(error))}</div>`;
  } finally {
    busy = false;
    form.classList.remove('is-loading');
    refreshLaunchButton();
  }
});

/* ---------------- Wiring ---------------- */

document.querySelectorAll<HTMLButtonElement>('[data-next]').forEach((button) => {
  button.addEventListener('click', () => go(Number(button.dataset.next)));
});
symbolInput.addEventListener('input', () => {
  symbolInput.value = symbolInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
});
for (const input of [nameInput, symbolInput, descriptionInput]) input.addEventListener('input', renderPreview);
firstBuyInput.addEventListener('input', renderSettings);
volumeInput.addEventListener('input', renderRevenue);
riskCheck.addEventListener('change', refreshLaunchButton);
// Enter in a text field moves to the next step instead of submitting early.
form.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || step === 3) return;
  const target = event.target as HTMLElement;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON') return;
  event.preventDefault();
  go(step + 1);
});

renderPreview();

void (async () => {
  status = await mountRuntime();
  const banner = setupMessage(status);
  if (banner) {
    const node = byId('setup-banner');
    node.innerHTML = banner;
    node.hidden = false;
  }
  if (status?.modules.enabled) {
    const node = byId('module-picker');
    // Until a wallet is unlocked, "my wallet" is the one the passphrase will open: the one in use last.
    modulePicker = mountModulePicker(node, { status, ownWallet: activeAddress() ?? lastUsedWallet()?.address ?? null, onChange: renderSettings });
    node.hidden = false;
    // A wallet already unlocked in this tab is the one "Add my wallet" should mean.
    void getSession()
      .then((ready) => {
        if (ready) modulePicker?.setOwnWallet(ready.address);
      })
      .catch(() => undefined);
  }
  renderPairs();
  renderTiers();
  renderFirstBuy();
  renderSettings();
  renderRevenue();
  renderRules();
  renderPreview();
})();

// The wallet can be unlocked, locked or switched from the header while this form is being filled in.
// What was typed stays; only who would sign changes.
watchWallet({
  busy: () => busy,
  async changed() {
    try {
      session = await getSession();
    } catch {
      session = null;
    }
    if (launched) return;
    if (session) modulePicker?.setOwnWallet(session.address);
    if (step === 3) await enterReview();
    else refreshLaunchButton();
  },
});
