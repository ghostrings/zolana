/**
 * The docs: one page that draws each of its own. Addresses are real paths
 * (/docs/burning), the Back button works, and search runs in the browser.
 */

import '../docs.css';
import { DOC_GROUPS, DOC_PAGES, type DocPage, pageForPath, pathForSlug } from '../docs/content.js';
import { type Rendered, escapeHtml, renderMarkdown } from '../docs/markdown.js';
import { type SearchEntry, type SearchHit, buildIndex, searchDocs } from '../docs/search.js';
import { docVars } from '../docs/vars.js';
import { mountRuntime } from '../shell.js';
import { byId, ghostState, initShell, wireCopyButtons } from '../ui.js';

initShell('docs');

const article = byId('gb-page');
const nav = byId('gb-nav');
const toc = byId('gb-toc');
const searchInput = byId<HTMLInputElement>('gb-search');
const results = byId('gb-results');
const menu = byId<HTMLButtonElement>('gb-menu');

let vars: Record<string, string> = docVars(null);
const drawn = new Map<string, Rendered>();
let index: SearchEntry[] | null = null;
let hits: SearchHit[] = [];
let activeHit = -1;
let current: (DocPage & { readonly group: string }) | null = null;

function rendered(page: DocPage): Rendered {
  let out = drawn.get(page.slug);
  if (!out) {
    out = renderMarkdown(page.body, vars);
    drawn.set(page.slug, out);
  }
  return out;
}

/* ---------------- Sidebar ---------------- */

function renderNav(): void {
  nav.innerHTML = DOC_GROUPS.map(
    (group) =>
      `<div class="gb-group"><span class="gb-group-title">${escapeHtml(group.title)}</span>${group.pages
        .map((page) => `<a href="${pathForSlug(page.slug)}" data-doc="${page.slug}">${escapeHtml(page.title)}</a>`)
        .join('')}</div>`,
  ).join('');
}

function markNav(): void {
  nav.querySelectorAll<HTMLAnchorElement>('a[data-doc]').forEach((link) => {
    const active = link.dataset.doc === current?.slug;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  byId('gb-menu-label').textContent = current ? `${current.group} / ${current.title}` : 'Contents';
}

function closeMenu(): void {
  nav.classList.remove('open');
  menu.setAttribute('aria-expanded', 'false');
}

menu.addEventListener('click', () => {
  const open = !nav.classList.contains('open');
  nav.classList.toggle('open', open);
  menu.setAttribute('aria-expanded', String(open));
});

/* ---------------- A page ---------------- */

function renderToc(page: Rendered): void {
  const headings = page.sections.filter((section) => section.level !== 0);
  toc.innerHTML = headings.length
    ? `<span class="gb-toc-title">On this page</span>${headings
        .map((section) => `<a href="#${section.id}" data-toc="${section.id}" class="lvl-${section.level}">${escapeHtml(section.heading)}</a>`)
        .join('')}`
    : '';
}

function renderPage(page: DocPage & { readonly group: string }): void {
  const body = rendered(page);
  const at = DOC_PAGES.findIndex((candidate) => candidate.slug === page.slug);
  const previous = at > 0 ? DOC_PAGES[at - 1] : undefined;
  const next = at >= 0 && at < DOC_PAGES.length - 1 ? DOC_PAGES[at + 1] : undefined;
  const step = (other: DocPage | undefined, label: string, side: string): string =>
    other
      ? `<a class="gb-step ${side}" href="${pathForSlug(other.slug)}"><span>${label}</span><b>${escapeHtml(other.title)}</b></a>`
      : `<span class="gb-step ${side} is-empty" aria-hidden="true"></span>`;
  article.innerHTML = `<nav class="gb-crumbs" aria-label="Breadcrumb"><a href="/docs">Docs</a><i aria-hidden="true">/</i><span>${escapeHtml(page.group)}</span><i aria-hidden="true">/</i><span>${escapeHtml(page.title)}</span></nav>
<header class="gb-head"><span class="eyebrow">${escapeHtml(page.group)}</span><h1 tabindex="-1">${escapeHtml(page.title)}</h1><p class="gb-lede">${escapeHtml(page.summary)}</p></header>
<div class="gb-body">${body.html}</div>
<nav class="gb-steps" aria-label="More pages">${step(previous, '‹ Previous', 'prev')}${step(next, 'Next ›', 'next')}</nav>
<p class="gb-foot">These pages describe the site as it runs now: figures such as fee shares and limits are read from this server. Something unclear or wrong? Tell us on <a href="https://x.com/privacycashfun" target="_blank" rel="noopener noreferrer">X</a>. The short version of all of it is on the <a href="/protocol">Protocol</a> page.</p>`;
  document.title = `${page.title} — privacycash.fun docs`;
  renderToc(body);
  wireCopyButtons(article);
}

function renderMissing(): void {
  article.innerHTML = ghostState('NO SUCH PAGE', 'Nothing lives at this address. It may have been renamed.<br><br><a class="btn flat" href="/docs">Open the docs</a>');
  toc.innerHTML = '';
  document.title = 'Not found — privacycash.fun docs';
}

function scrollToHash(hash: string): void {
  const id = decodeURIComponent(hash.replace(/^#/, ''));
  const target = id ? document.getElementById(id) : null;
  if (target && article.contains(target)) target.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 0);
}

/** Shows the page an address asks for. */
function show(pathname: string, hash: string): void {
  const page = pageForPath(pathname);
  current = page;
  if (page) renderPage(page);
  else renderMissing();
  markNav();
  closeMenu();
  // Wait for the new page to be laid out before moving to a heading on it.
  requestAnimationFrame(() => {
    scrollToHash(hash);
    markToc();
  });
}

function go(href: string): void {
  const url = new URL(href, location.origin);
  const samePage = url.pathname === location.pathname;
  history.pushState(null, '', `${url.pathname}${url.hash}`);
  if (samePage && current) {
    scrollToHash(url.hash);
    markToc();
  } else {
    show(url.pathname, url.hash);
    // Someone reading by keyboard or screen reader lands on the new page's title.
    article.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }
}

// Links between pages of the docs are followed here, without loading the page again.
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
  if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
  const url = new URL(link.href, location.origin);
  if (url.origin !== location.origin) return;
  const inDocs = url.pathname === '/docs' || url.pathname.startsWith('/docs/');
  if (!inDocs || !link.closest('.gb')) return;
  event.preventDefault();
  hideResults();
  go(`${url.pathname}${url.hash}`);
});

window.addEventListener('popstate', () => show(location.pathname, location.hash));

/* ---------------- On this page ---------------- */

function markToc(): void {
  const links = [...toc.querySelectorAll<HTMLAnchorElement>('a[data-toc]')];
  if (links.length === 0) return;
  let active = links[0]?.dataset.toc ?? '';
  for (const link of links) {
    const heading = document.getElementById(link.dataset.toc ?? '');
    // The section being read is the last one whose heading has passed under the header.
    if (heading && heading.getBoundingClientRect().top <= 150) active = link.dataset.toc ?? active;
  }
  for (const link of links) link.classList.toggle('active', link.dataset.toc === active);
}

let tocQueued = false;
window.addEventListener(
  'scroll',
  () => {
    if (tocQueued) return;
    tocQueued = true;
    requestAnimationFrame(() => {
      tocQueued = false;
      markToc();
    });
  },
  { passive: true },
);

/* ---------------- Search ---------------- */

function searchIndex(): SearchEntry[] {
  index ??= buildIndex(DOC_PAGES.map((page) => ({ slug: page.slug, title: page.title, group: page.group, summary: page.summary, sections: rendered(page).sections })));
  return index;
}

function hideResults(): void {
  results.hidden = true;
  results.innerHTML = '';
  searchInput.setAttribute('aria-expanded', 'false');
  hits = [];
  activeHit = -1;
}

function renderResults(): void {
  const query = searchInput.value.trim();
  if (!query) {
    hideResults();
    return;
  }
  hits = searchDocs(searchIndex(), query);
  activeHit = hits.length > 0 ? 0 : -1;
  results.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  results.innerHTML = hits.length
    ? hits
        .map((hit, position) => {
          const href = `${pathForSlug(hit.slug)}${hit.id ? `#${hit.id}` : ''}`;
          return `<a class="gb-hit ${position === 0 ? 'active' : ''}" role="option" href="${href}" data-hit="${position}"><span class="gb-hit-path">${escapeHtml(hit.group)} / ${escapeHtml(hit.title)}</span><b>${escapeHtml(hit.heading || hit.title)}</b><span class="gb-hit-text">${escapeHtml(hit.snippet.before)}<mark>${escapeHtml(hit.snippet.match)}</mark>${escapeHtml(hit.snippet.after)}</span></a>`;
        })
        .join('')
    : `<div class="gb-none"><span class="ghost-mark" aria-hidden="true"></span><b>NOTHING FOUND</b><span>No page mentions “${escapeHtml(query)}”. Try one word, such as burn, fee or register.</span></div>`;
}

function markHit(): void {
  results.querySelectorAll<HTMLAnchorElement>('.gb-hit').forEach((node) => {
    const active = Number(node.dataset.hit) === activeHit;
    node.classList.toggle('active', active);
    if (active) node.scrollIntoView({ block: 'nearest' });
  });
}

searchInput.addEventListener('input', renderResults);
searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim()) renderResults();
});
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    searchInput.value = '';
    hideResults();
    searchInput.blur();
    return;
  }
  if (hits.length === 0) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    activeHit = (activeHit + (event.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
    markHit();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const hit = hits[Math.max(0, activeHit)];
    if (!hit) return;
    hideResults();
    searchInput.blur();
    go(`${pathForSlug(hit.slug)}${hit.id ? `#${hit.id}` : ''}`);
  }
});

document.addEventListener('click', (event) => {
  if (!(event.target as HTMLElement).closest('.gb-search')) hideResults();
});

// "/" jumps to the search box, as it does in most docs.
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
  event.preventDefault();
  searchInput.focus();
});

/* ---------------- Start ---------------- */

renderNav();

// The figures the pages quote come from this server, so the first page waits a moment for them.
// If the server is slow the page is drawn without them and redrawn when they arrive.
void (async () => {
  const answered = mountRuntime();
  const first = await Promise.race([answered, new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), 1500))]);
  if (first) vars = docVars(first);
  show(location.pathname, location.hash);
  if (first !== undefined) return;
  const late = await answered;
  if (!late) return;
  vars = docVars(late);
  drawn.clear();
  index = null;
  const keep = window.scrollY;
  if (current) {
    renderPage(current);
    window.scrollTo(0, keep);
    markToc();
  }
})();
