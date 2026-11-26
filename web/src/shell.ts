/** Fills the parts of the page shell that depend on the server's status and the unlocked wallet. */

import type { StatusResponse } from '../../shared/src/api.js';
import { feeSplit } from '../../shared/src/tiers.js';
import { mainAddressFor } from './address.js';
import { startAlerts } from './alerts.js';
import { api } from './api.js';
import { sol } from './format.js';
import { icon } from './icons.js';
import { announceWallet } from './session-bus.js';
import { deterministicAvatar, escapeHtml, short } from './ui.js';
import { activeAddress, activeWallet, hasVault, walletCount } from './vault.js';
import { iconSvg } from './wallet-icons.js';
import { mountWalletPop } from './wallet-pop.js';

export async function mountRuntime(): Promise<StatusResponse | null> {
  // The header's wallet button works from the first moment, before the server has answered anything.
  paintIdentity();
  mountWalletPop(paintIdentity);
  // Does nothing until somebody turns alerts on for the wallet in use.
  startAlerts();
  const pill = document.querySelector<HTMLElement>('[data-runtime]');
  let status: StatusResponse | null = null;
  try {
    status = await api.status();
  } catch {
    if (pill) {
      pill.textContent = 'Offline';
      pill.dataset.mode = 'mock';
    }
  }
  if (status) {
    if (pill) {
      pill.textContent = !status.rpcConfigured ? 'Not configured' : !status.ready ? 'Mainnet / setup' : 'Mainnet';
      if (!status.ready) pill.dataset.mode = 'mock';
    }
    const split = feeSplit(status.economics);
    document.querySelectorAll<HTMLElement>('[data-split]').forEach((node) => {
      node.textContent = `Creator ${split.creatorPct}% / Platform ${split.platformPct}% / Meteora ${split.protocolPct}%`;
    });
    document.querySelectorAll<HTMLElement>('[data-split-sentence]').forEach((node) => {
      node.textContent = splitSentence(status);
    });
    document.querySelectorAll<HTMLElement>('[data-payout-clause]').forEach((node) => {
      node.textContent = payoutClause(status);
    });
    document.querySelectorAll<HTMLElement>('[data-network]').forEach((node) => {
      node.textContent = 'MAINNET';
    });
  }
  paintIdentity();
  return status;
}

/**
 * Writes the wallet in use into the header: its icon and its name. With an
 * extension connected it is the address; with nothing unlocked, what to do.
 */
export function paintIdentity(): void {
  const identity = document.querySelector<HTMLAnchorElement>('[data-identity]');
  if (!identity) return;
  const wallet = activeWallet();
  const caret = icon('chevron', 'pill-caret');
  if (wallet) {
    // Somebody with one wallet they never named sees its address, as they always have.
    const unnamed = walletCount() <= 1 && wallet.name === 'Wallet 1';
    const name = unnamed ? short(wallet.address) : [...wallet.name].length > 16 ? `${[...wallet.name].slice(0, 15).join('')}…` : wallet.name;
    identity.dataset.state = 'open';
    identity.innerHTML = `<span class="pill-icon">${iconSvg(wallet.icon, wallet.name, deterministicAvatar(wallet.address))}</span><span class="pill-text">${escapeHtml(name)}</span>${caret}`;
    identity.title = wallet.address;
  } else {
    const active = activeAddress();
    if (active) {
      // A wallet extension: its address, and the pixel mark of it.
      identity.dataset.state = 'open';
      identity.innerHTML = `<span class="pill-icon">${deterministicAvatar(active)}</span><span class="pill-text">${escapeHtml(short(active))}</span>${caret}`;
      identity.title = active;
    } else {
      const locked = hasVault();
      identity.dataset.state = locked ? 'locked' : 'none';
      identity.innerHTML = `${icon(locked ? 'lock' : 'wallet')}<span class="pill-text">${locked ? 'Unlock' : 'Wallet'}</span>`;
      identity.removeAttribute('title');
    }
  }
  // Whatever else shows the wallet in use, the panel behind this button for one, draws itself again.
  announceWallet();
}

/**
 * The banner for a page opened at an address the server does not answer.
 * A ghost wallet is kept in the browser under the address it was made at, so
 * the note says where that leaves it.
 */
export function addressMessage(status: StatusResponse | null): string | null {
  const main = mainAddressFor(status?.origins, location.origin);
  if (!main) return null;
  const there = `${main}${location.pathname}${location.search}`;
  return `<strong>This is not the address this site works at.</strong> Pages open here, but nothing can be sent. Use <a href="${escapeHtml(there)}">${escapeHtml(main)}</a>. A ghost wallet made at this address stays in this browser under this address: to use it there, copy its secret key from the wallet page here and import it there.`;
}

export function setupMessage(status: StatusResponse | null): string | null {
  if (!status) return '<strong>The server is not reachable.</strong> The listing below may be empty.';
  const elsewhere = addressMessage(status);
  if (elsewhere) return elsewhere;
  if (!status.rpcConfigured) return '<strong>This deployment has no RPC configured.</strong> Set HELIUS_API_KEY on the server. Nothing on chain is reachable until then.';
  if (!status.ready) {
    const created = status.pairs.flatMap((pair) => pair.tiers).filter((tier) => tier.config);
    if (created.length === 0) {
      return '<strong>No fee tier is live yet.</strong> The operator has to create the Meteora configs (<code>npm run configs:apply</code>) before tokens can be launched.';
    }
    const problem = created.find((tier) => tier.problem)?.problem ?? 'The fee tiers are still being checked against the chain.';
    return `<strong>Launching is paused.</strong> ${escapeHtml(problem)} Tokens that already exist can be traded.`;
  }
  return limitsMessage(status);
}

/** Where a trading fee goes, in one sentence. */
/** What a creator gets after graduation, as a clause. The platform holds all locked liquidity, so this is its payment. */
export function payoutClause(status: StatusResponse, who: 'the creator' | 'you' = 'the creator'): string {
  return status.creatorPoolPayoutPct > 0
    ? `the platform pays ${who} ${status.creatorPoolPayoutPct}% of the pool fees it collects`
    : 'the pool fees go to the platform';
}

export function splitSentence(status: StatusResponse): string {
  const split = feeSplit(status.economics);
  return `On the curve, ${split.creatorPct}% of every fee goes to the creator, ${split.platformPct}% to the platform and ${split.protocolPct}% to Meteora's protocol. After graduation the platform holds all of the locked liquidity, and ${payoutClause(status)}.`;
}

/** The operator's limits, as a banner line. Null when none is in force. */
export function limitsMessage(status: StatusResponse | null): string | null {
  if (!status) return null;
  const { launchesPaused, tradingPaused, notice, maxTradeLamports } = status.limits;
  const wallet = 'Your wallet is not affected: deposits, withdrawals and private transfers work as usual.';
  if (launchesPaused || tradingPaused) {
    const what = launchesPaused && tradingPaused ? 'Launches and trading through this site are paused.' : launchesPaused ? 'New launches are paused.' : 'Trading through this site is paused.';
    return `<strong>${what}</strong> ${notice ? `${escapeHtml(notice)} ` : ''}${wallet}`;
  }
  const cap = BigInt(maxTradeLamports || '0');
  if (cap > 0n) {
    return `<strong>Early days.</strong> Trades and first buys through this site are limited to ${escapeHtml(sol(cap, 2))} SOL each for now${status.pairs.filter((pair) => pair.problem === null).length > 1 ? ', or about as much in another pair token' : ''}.`;
  }
  return null;
}
