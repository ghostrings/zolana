/**
 * Page shell: the room's light and the dust in it, navigation, toasts, copy
 * buttons and the deterministic pixel avatars.
 */

import './fonts.css';
import './style.css';
import './app.css';
import './ghost.css';
import './walletpop.css';

import { type IconName, icon } from './icons.js';

type PageKey = 'market' | 'create' | 'swap' | 'rings' | 'ghost' | 'wallet' | 'prvmax' | 'protocol' | 'docs';

const PAGE_LABELS: Record<PageKey, readonly [string, string, IconName]> = {
  market: ['Market', '/', 'market'],
  create: ['Launch', '/create', 'plus'],
  swap: ['Swap', '/swap', 'swap'],
  rings: ['Rings', '/rings', 'rings'],
  ghost: ['GHOST', '/ghost', 'shield'],
  wallet: ['Wallet', '/wallet', 'wallet'],
  prvmax: ['prvmax', '/prvmax', 'layers'],
  protocol: ['Protocol', '/protocol', 'docs'],
  docs: ['Docs', '/docs', 'docs'],
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function short(value: unknown, front = 4, back = 4): string {
  const text = String(value ?? '');
  return text.length <= front + back + 1 ? text : `${text.slice(0, front)}…${text.slice(-back)}`;
}

export function relativeTime(time: number): string {
  const seconds = Math.floor(Math.max(0, Date.now() - Number(time || 0)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Only https addresses, or ones on this site itself, are ever rendered. */
export function safeImageUrl(value: string): string {
  try {
    const url = new URL(value, location.origin);
    return url.protocol === 'https:' || url.origin === location.origin ? url.toString() : '';
  } catch {
    return '';
  }
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function setText(id: string, text: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

export function initShell(page: PageKey): void {
  document.documentElement.classList.add('js');
  injectAmbient();
  injectMobileNav(page);
  markActive(page);
  wireMenu();
  startPixelField();
  wireCopyButtons();
  wireArtFallback();
}

/**
 * Artwork that does not load is replaced by the token's pixel mark, so a page
 * never shows a broken picture. Image errors do not bubble, hence the capture.
 */
function wireArtFallback(): void {
  document.addEventListener(
    'error',
    (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.classList.contains('token-image')) return;
      const holder = document.createElement('div');
      holder.innerHTML = deterministicAvatar(image.dataset.mark ?? '');
      const mark = holder.firstElementChild;
      if (mark) image.replaceWith(mark);
    },
    true,
  );
}

function injectAmbient(): void {
  if (document.querySelector('.ambient-ui')) return;
  const node = document.createElement('div');
  node.className = 'ambient-ui';
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = '<div class="beam"></div><canvas id="pixel-field"></canvas><div class="grain"></div><div class="vignette"></div>';
  document.body.prepend(node);
}

function injectMobileNav(page: PageKey): void {
  if (document.querySelector('.mobile-dock')) return;
  const nav = document.createElement('nav');
  nav.className = 'mobile-dock';
  nav.setAttribute('aria-label', 'Mobile navigation');
  nav.innerHTML = (Object.entries(PAGE_LABELS) as Array<[PageKey, readonly [string, string, IconName]]>)
    .filter(([key]) => key !== 'protocol')
    .map(([key, [label, href, glyph]]) => `<a href="${href}" ${key === page ? 'aria-current="page"' : ''}>${icon(glyph)}${label}</a>`)
    .join('');
  document.body.append(nav);
}

function markActive(page: PageKey): void {
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((link) => {
    const active = link.dataset.nav === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
  });
}

function wireMenu(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
  const links = document.querySelector<HTMLElement>('.nav-links');
  if (!button || !links) return;
  const set = (open: boolean): void => {
    button.setAttribute('aria-expanded', String(open));
    links.classList.toggle('open', open);
  };
  button.addEventListener('click', () => set(button.getAttribute('aria-expanded') !== 'true'));
  // It closes the way a menu does: on Escape, on a press anywhere else, and when the window grows past it.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      set(false);
      button.focus();
    }
  });
  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (button.getAttribute('aria-expanded') === 'true' && !button.contains(target) && !links.contains(target)) set(false);
  });
  matchMedia('(min-width: 961px)').addEventListener?.('change', (query) => {
    if (query.matches) set(false);
  });
}

/** One ghost adrift in the background: where it is, how big, how fast it rises and how it sways. */
interface Apparition {
  x: number;
  y: number;
  /** Width in pixels. The mark is 15 cells wide, so this is a whole number of them. */
  size: number;
  speed: number;
  sway: number;
  phase: number;
  alpha: number;
}

/** A mote of dust in the projector's light. */
interface Mote {
  x: number;
  y: number;
  radius: number;
  speed: number;
  drift: number;
  alpha: number;
  phase: number;
}

/**
 * The air of the room: dust drifting up through the light, and now and then a
 * ghost. It draws about thirty times a second, stops while the tab is hidden,
 * and is not started at all for someone who asked for less motion.
 */
function startPixelField(): void {
  const canvas = document.getElementById('pixel-field') as HTMLCanvasElement | null;
  if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  let width = 0;
  let height = 0;
  let raf = 0;
  let last = 0;
  let motes: Mote[] = [];
  let ghosts: Apparition[] = [];
  // The ghosts are drawn from the same mark the rest of the page uses. Until it has loaded there are none.
  const mark = new Image();
  let markReady = false;
  mark.addEventListener('load', () => {
    markReady = true;
  });
  mark.src = '/assets/ghost.svg';
  // A page of reading gets fewer of them, and fainter.
  const reading = document.body.dataset.page === 'docs' || document.body.dataset.page === 'protocol';
  const spawn = (anywhere: boolean): Apparition => {
    const cells = 2 + Math.floor(Math.random() * 3);
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : height + 40 + Math.random() * 120,
      size: cells * 15,
      speed: 0.12 + Math.random() * 0.2,
      sway: 10 + Math.random() * 22,
      phase: Math.random() * Math.PI * 2,
      alpha: (reading ? 0.025 : 0.04) + Math.random() * (reading ? 0.02 : 0.04),
    };
  };
  const seed = (): void => {
    const count = Math.min(70, Math.max(18, Math.floor(width / 22)));
    motes = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: 0.5 + Math.random() * 1.1,
      speed: 0.05 + Math.random() * 0.22,
      drift: (Math.random() - 0.5) * 0.12,
      alpha: 0.1 + Math.random() * 0.32,
      phase: Math.random() * Math.PI * 2,
    }));
    // A phone gets the dust and no ghosts: less to draw on a small battery.
    const haunting = width < 700 ? 0 : Math.min(reading ? 1 : 3, Math.floor(width / 420));
    ghosts = Array.from({ length: haunting }, () => spawn(true));
  };
  const resize = (): void => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    // A phone's address bar sliding away changes the height many times a minute: only a new width starts the dust over.
    const again = innerWidth !== width || motes.length === 0;
    width = innerWidth;
    height = innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (again) seed();
  };
  /** How much of the beam reaches a point: most at the top and the middle, little in the corners. */
  const lit = (x: number, y: number): number => Math.max(0.2, 1 - (y / height) * 0.85) * Math.max(0.3, 1 - Math.abs(x / width - 0.5) * 1.3);
  const draw = (now: number): void => {
    raf = requestAnimationFrame(draw);
    if (now - last < 32) return;
    const step = Math.min(3, (now - last) / 16.7);
    last = now;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    for (const mote of motes) {
      mote.y -= mote.speed * step;
      mote.x += (mote.drift + Math.sin(now / 2600 + mote.phase) * 0.06) * step;
      if (mote.y < -4) {
        mote.y = height + 4;
        mote.x = Math.random() * width;
      }
      if (mote.x < -4) mote.x = width + 4;
      if (mote.x > width + 4) mote.x = -4;
      ctx.globalAlpha = mote.alpha * lit(mote.x, mote.y) * (0.65 + 0.35 * Math.sin(now / 900 + mote.phase));
      ctx.beginPath();
      ctx.arc(mote.x, mote.y, mote.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    if (markReady) {
      ctx.imageSmoothingEnabled = false;
      for (let index = 0; index < ghosts.length; index += 1) {
        const ghost = ghosts[index] as Apparition;
        ghost.y -= ghost.speed * step;
        const tall = (ghost.size * 16) / 15;
        if (ghost.y < -tall - 10) {
          ghosts[index] = spawn(false);
          continue;
        }
        const x = ghost.x + Math.sin(now / 1500 + ghost.phase) * ghost.sway;
        // It fades in from the foot of the screen and thins out toward the top.
        const rise = Math.min(1, (height - ghost.y) / 160) * Math.min(1, (ghost.y + tall) / 220);
        ctx.globalAlpha = Math.max(0, ghost.alpha * rise);
        ctx.drawImage(mark, Math.round(x), Math.round(ghost.y), ghost.size, Math.round(tall));
      }
    }
    ctx.globalAlpha = 1;
  };
  addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) raf = requestAnimationFrame(draw);
  });
  resize();
  raf = requestAnimationFrame(draw);
}

export function wireCopyButtons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    if (button.dataset.copyReady) return;
    button.dataset.copyReady = '1';
    button.addEventListener('click', async () => {
      const source = button.dataset.copyTarget ? document.querySelector<HTMLElement>(button.dataset.copyTarget) : null;
      const value = (source as HTMLInputElement | null)?.value || source?.textContent || button.dataset.copy || '';
      try {
        await navigator.clipboard.writeText(String(value).trim());
        const old = button.textContent;
        button.textContent = 'Copied';
        toast('Copied to clipboard');
        setTimeout(() => {
          button.textContent = old;
        }, 1200);
      } catch {
        toast('Clipboard blocked. Select and copy manually.', 'error');
      }
    });
  });
}

export function toast(message: string, kind: 'ok' | 'error' = 'ok', shownMs?: number): void {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.append(stack);
  }
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  stack.append(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(
    () => {
      item.classList.remove('show');
      setTimeout(() => item.remove(), 250);
    },
    shownMs ?? (kind === 'error' ? 5200 : 2600),
  );
}

export function deterministicAvatar(seed: string, size = 7): string {
  const clean = String(seed || 'PCF').toUpperCase();
  let hash = 2166136261;
  for (const char of clean) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const cells: Array<[number, number]> = [];
  const half = Math.ceil(size / 2);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < half; x += 1) {
      hash ^= hash << 13;
      hash ^= hash >>> 17;
      hash ^= hash << 5;
      hash >>>= 0;
      if ((hash & 3) !== 0) {
        cells.push([x, y]);
        const mirror = size - 1 - x;
        if (mirror !== x) cells.push([mirror, y]);
      }
    }
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(clean)} pixel mark" shape-rendering="crispEdges"><rect width="${size}" height="${size}" class="avatar-bg"/>${cells
    .map(([x, y], index) => `<rect x="${x}" y="${y}" width="1" height="1" class="${index % 5 === 0 ? 'avatar-dim' : ''}"/>`)
    .join('')}</svg>`;
}

/** A token's artwork when it has any, its pixel mark otherwise. */
export function tokenArt(token: { image: string; symbol: string; mint: string }): string {
  const image = token.image ? safeImageUrl(token.image) : '';
  const mark = token.symbol || token.mint;
  if (image) return `<img class="token-image" src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-mark="${escapeHtml(mark)}">`;
  return deterministicAvatar(mark);
}

/**
 * An empty, waiting or failed state with the ghost over it. `title` is plain
 * text; `body` is HTML the caller has already made safe.
 */
export function ghostState(title: string, body = ''): string {
  return `<div class="empty-state ghost-state"><span class="ghost-mark" aria-hidden="true"></span><b>${escapeHtml(title)}</b>${body ? `<p>${body}</p>` : ''}</div>`;
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong.';
}
