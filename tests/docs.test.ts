import { describe, expect, it } from 'vitest';

import type { StatusResponse } from '../shared/src/api.js';
import { DEFAULT_ECONOMICS, FEE_TIERS } from '../shared/src/tiers.js';
import { DOC_GROUPS, DOC_PAGES, pageForPath, pathForSlug } from '../web/src/docs/content.js';
import { fillVars, plainText, renderInline, renderMarkdown, slugify } from '../web/src/docs/markdown.js';
import { buildIndex, searchDocs } from '../web/src/docs/search.js';
import { DOC_VAR_NAMES, addressLink, docVars } from '../web/src/docs/vars.js';
import { statusFixture } from './fixtures.js';

const CONFIG = 'So11111111111111111111111111111111111111112';

function status(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return statusFixture({
    tiers: FEE_TIERS.map((tier) => ({ id: tier.id, feeBps: tier.feeBps, label: tier.label, blurb: tier.blurb, config: tier.feeBps === 400 ? null : CONFIG, live: tier.feeBps !== 400, problem: null })),
    economics: DEFAULT_ECONOMICS,
    ...overrides,
  });
}

describe('the docs’ Markdown', () => {
  it('escapes everything it is given', () => {
    const { html } = renderMarkdown('A <script>alert(1)</script> & "quotes" in a paragraph.\n\n## A <b>bold</b> heading\n\n| <i>cell</i> |\n| --- |\n| <img src=x onerror=1> |');
    expect(html).not.toMatch(/<script|<img|<i>|<b>bold/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
  });

  it('keeps links that stay on the site or are plain https, and turns the rest into text', () => {
    expect(renderInline('[Wallet](/wallet)')).toBe('<a href="/wallet">Wallet</a>');
    expect(renderInline('[here](#fees)')).toBe('<a href="#fees">here</a>');
    expect(renderInline('[X](https://x.com/privacycashfun)')).toBe('<a href="https://x.com/privacycashfun" target="_blank" rel="noopener noreferrer">X</a>');
    for (const bad of ['javascript:alert', 'data:text/html,x', '//evil.example', 'http://plain.example', '/\\evil', 'vbscript:x']) {
      expect(renderInline(`[click](${bad})`)).toBe('click');
    }
    // An address with a bracket in it ends at the bracket, and is still not a link.
    expect(renderInline('[click](javascript:alert(1))')).not.toContain('<a');
    // An address cannot break out of its attribute.
    expect(renderInline('[a](/x"onmouseover="1)')).not.toMatch(/"onmouseover/);
  });

  it('formats code, bold and the two chips, and leaves the inside of code alone', () => {
    expect(renderInline('Type `BURN` to **confirm**.')).toBe('Type <code>BURN</code> to <strong>confirm</strong>.');
    expect(renderInline('`**not bold** [not](/a) <b>`')).toBe('<code>**not bold** [not](/a) &lt;b&gt;</code>');
    expect(renderInline('==Hidden== and ++Public++')).toBe('<span class="chip chip-hidden">Hidden</span> and <span class="chip chip-public">Public</span>');
  });

  it('gives headings anchors, unique within the page', () => {
    const page = renderMarkdown('Intro.\n\n## What it costs\n\nText.\n\n### What it costs\n\nMore.\n\n## Q&A: can I?\n\nYes.');
    expect(page.sections.map((section) => section.id)).toEqual(['', 'what-it-costs', 'what-it-costs-2', 'q-a-can-i']);
    expect(page.sections.map((section) => section.level)).toEqual([0, 2, 3, 2]);
    expect(page.html).toContain('<h2 id="what-it-costs">What it costs<a class="doc-anchor" href="#what-it-costs"');
    expect(page.sections[1]?.text).toBe('Text.');
    expect(slugify('  ¿¿  ')).toBe('section');
  });

  it('builds lists, tables, code blocks and rules', () => {
    const { html } = renderMarkdown('- one\n- two\n  carried on\n\n1. first\n2. second\n\n| A | B |\n| --- | :---: |\n| 1 | 2 |\n\n```\nconst x = <1>;\n```\n\n---');
    expect(html).toContain('<ul class="doc-list"><li>one</li><li>two carried on</li></ul>');
    expect(html).toContain('<ol class="doc-list"><li>first</li><li>second</li></ol>');
    expect(html).toContain('<thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>');
    expect(html).toContain('<pre class="code-block"><code>const x = &lt;1&gt;;</code></pre>');
    expect(html).toContain('<hr class="doc-rule">');
  });

  it('builds callouts with a kind and a title', () => {
    const { html, sections } = renderMarkdown('> [!WARNING] Back it up\n> First line\n> carries on.\n>\n> Second paragraph.');
    expect(html).toBe('<aside class="callout callout-warning"><strong>Back it up</strong><p>First line carries on.</p><p>Second paragraph.</p></aside>');
    expect(sections[0]?.text).toBe('Back it up First line carries on. Second paragraph.');
    expect(renderMarkdown('> Just a note.').html).toBe('<aside class="callout callout-note"><p>Just a note.</p></aside>');
    expect(renderMarkdown('> [!GHOST] Boo\n> Text.').html).toContain('callout-ghost');
  });

  it('builds the observer box the way the app draws it', () => {
    const { html } = renderMarkdown(':::observer A burn\nYour wallet | public\nWhat you still hold | hidden\nWhat the desk learns | public | YOUR TRADE\n:::');
    expect(html).toContain('<div class="visibility-title">What an observer sees · A burn</div>');
    expect(html).toContain('<dt>Your wallet</dt><dd class="is-public">PUBLIC</dd>');
    expect(html).toContain('<dt>What you still hold</dt><dd class="is-hidden">ENCRYPTED</dd>');
    expect(html).toContain('<dd class="is-public">YOUR TRADE</dd>');
  });

  it('builds steps and link cards', () => {
    const steps = renderMarkdown(':::steps\nOpen the token | From the market.\nSign\n:::').html;
    expect(steps).toBe('<ol class="steps doc-steps"><li><div><b>Open the token</b><span>From the market.</span></div></li><li><div><b>Sign</b></div></li></ol>');
    const cards = renderMarkdown(':::cards\n/docs/burning | Burn | Destroy tokens.\njavascript:1 | Bad | Nope.\n:::').html;
    expect(cards).toContain('<a class="doc-card" href="/docs/burning"><b>Burn</b><span>Destroy tokens.</span></a>');
    expect(cards).toContain('<div class="doc-card"><b>Bad</b>');
  });

  it('fills in live values, and shows a dash for one it does not have', () => {
    expect(fillVars('Keep {{gas}} SOL. {{missing}}.', { gas: '0.015' })).toBe('Keep 0.015 SOL. —.');
    expect(renderMarkdown('Fee: {{fee}}%', { fee: '<3>' }).html).toBe('<p>Fee: &lt;3&gt;%</p>');
  });

  it('takes the markup out of text meant for search', () => {
    expect(plainText('Press **Register** on the [Wallet](/wallet) page, then type `BURN`. ==Hidden== ++Public++')).toBe('Press Register on the Wallet page, then type BURN. Hidden Public');
  });
});

describe('the docs’ pages', () => {
  const full = docVars(status({ desk: { enabled: true, address: CONFIG, spreadBps: 50, maxOrderLamports: '1000000000' } }));

  it('have addresses that are unique and lead back to themselves', () => {
    const slugs = DOC_PAGES.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(pageForPath(pathForSlug(slug))?.slug).toBe(slug);
    }
    expect(pathForSlug(DOC_PAGES[0]?.slug ?? '')).toBe('/docs');
    expect(pageForPath('/docs/')?.slug).toBe(DOC_PAGES[0]?.slug);
    expect(pageForPath('/docs/no-such-page')).toBeNull();
    expect(pageForPath('/docsx')).toBeNull();
    expect(pageForPath('/')).toBeNull();
    expect(DOC_GROUPS.flatMap((group) => group.pages)).toHaveLength(DOC_PAGES.length);
  });

  it('cover sending, burning and the market’s pages', () => {
    for (const slug of ['private-transfers', 'burning', 'market', 'what-is-private', 'fees', 'risks', 'faq']) {
      expect(pageForPath(`/docs/${slug}`), slug).not.toBeNull();
    }
  });

  it('each have a title, a summary and something to read', () => {
    for (const page of DOC_PAGES) {
      expect(page.title.length, page.slug).toBeGreaterThan(2);
      expect(page.summary.length, page.slug).toBeGreaterThan(20);
      const { html, sections } = renderMarkdown(page.body, full);
      expect(html.length, page.slug).toBeGreaterThan(400);
      expect(sections.length, page.slug).toBeGreaterThan(1);
      // Nothing of the source's own markup is left showing.
      const text = html.replace(/<[^>]+>/g, ' ');
      expect(text, page.slug).not.toMatch(/\{\{|\}\}|:::|\*\*|==|\+\+|\]\(/);
      expect(text, page.slug).not.toContain('—.');
    }
  });

  it('link only to pages and places that exist', () => {
    const places = new Set(['/', '/create', '/swap', '/wallet', '/pay', '/view', '/prvmax', '/rings', '/protocol', '/docs']);
    for (const page of DOC_PAGES) {
      const { html, sections } = renderMarkdown(page.body, full);
      const anchors = new Set(sections.map((section) => section.id));
      for (const match of html.matchAll(/href="([^"]+)"/g)) {
        const href = (match[1] as string).replaceAll('&amp;', '&');
        if (href.startsWith('#')) {
          expect(anchors.has(href.slice(1)), `${page.slug} ${href}`).toBe(true);
        } else if (href.startsWith('/docs/')) {
          const [path = '', anchor] = href.split('#');
          const target = pageForPath(path);
          expect(target, `${page.slug} -> ${href}`).not.toBeNull();
          if (anchor && target) expect(renderMarkdown(target.body, full).sections.some((section) => section.id === anchor), `${page.slug} -> ${href}`).toBe(true);
        } else if (href.startsWith('/')) {
          expect(places.has(href), `${page.slug} -> ${href}`).toBe(true);
        } else {
          expect(href, page.slug).toMatch(/^https:\/\/(orbmarkets\.io\/address\/[1-9A-HJ-NP-Za-km-z]{32,44}|x\.com\/privacycashfun)$/);
        }
      }
    }
  });

  it('use only live values that exist, and every one of those is filled in', () => {
    const used = new Set<string>();
    for (const page of DOC_PAGES) for (const match of page.body.matchAll(/\{\{([a-z0-9_]+)\}\}/g)) used.add(match[1] as string);
    for (const name of used) expect(DOC_VAR_NAMES, name).toContain(name);
    for (const name of DOC_VAR_NAMES) {
      expect(full[name], name).toBeTruthy();
      expect(full[name], name).not.toBe('—');
    }
    // Nothing is offered that no page uses.
    for (const name of DOC_VAR_NAMES) expect(used.has(name), name).toBe(true);
  });

  it('never promise what the Default Ring does not give', () => {
    for (const page of DOC_PAGES) {
      const text = renderMarkdown(page.body, full).html.replace(/<[^>]+>/g, ' ').toLowerCase();
      expect(text, page.slug).not.toMatch(/untraceable|\bmixer\b|\binvisible\b/);
      // "Anonymous" appears only to say what this is not.
      for (const match of text.matchAll(/[^.?!]*\banonym[^.?!]*/g)) {
        expect(match[0], page.slug).toMatch(/\bnot\b|\bno\b|is this anonymous/);
      }
    }
  });

  it('say that a burn is public, and that a transfer shows the wallets', () => {
    const burning = renderMarkdown(pageForPath('/docs/burning')?.body ?? '', full).html;
    expect(burning).toMatch(/public by nature/);
    expect(burning).toContain('<dt>Which token, and how much was burned</dt><dd class="is-public">PUBLIC</dd>');
    expect(burning).toMatch(/cannot be undone/);
    const sending = renderMarkdown(pageForPath('/docs/private-transfers')?.body ?? '', full).html;
    expect(sending).toContain('<dt>Your wallet and the recipient&#039;s</dt><dd class="is-public">PUBLIC</dd>');
    expect(sending).toContain('<dt>Which token</dt><dd class="is-hidden">ENCRYPTED</dd>');
    expect(sending).toMatch(/confidential, not anonymous/);
  });
});

describe('the docs’ live values', () => {
  it('come from the server’s own settings', () => {
    const vars = docVars(status());
    expect([vars.creator_pct, vars.platform_pct, vars.protocol_pct]).toEqual(['24', '56', '20']);
    expect(vars.payout_sentence).toBe('the platform pays the creator 30% of the pool fees it collects');
    expect([vars.start_cap, vars.grad_cap]).toEqual(['30', '420']);
    expect([vars.slippage_default, vars.slippage_max]).toEqual(['1', '10']);
    expect(vars.gas_reserve).toBe('0.015');
    expect(vars.min_payout).toBe('0.002');
    expect(vars.page_size).toBe('24');
    expect(vars.image_limit).toBe('4 MB');
    expect(vars.config_200).toBe(`[${CONFIG}](https://orbmarkets.io/address/${CONFIG})`);
    expect(vars.config_400).toBe('Not live yet');
    expect(vars.desk_sentence).toMatch(/switched off/);
    expect(vars.trade_cap_sentence).toBe('No per-trade limit is set right now.');
    expect(vars.pause_sentence).toBe('Nothing is paused right now.');
  });

  it('say so when the operator has changed something', () => {
    const vars = docVars(
      status({
        creatorPoolPayoutPct: 0,
        desk: { enabled: true, address: CONFIG, spreadBps: 75, maxOrderLamports: '2500000000' },
        limits: { maxTradeLamports: '500000000', launchesPaused: true, tradingPaused: false, notice: null },
        uploads: { pinned: false, maxImageBytes: 4 * 1024 * 1024 },
      }),
    );
    expect(vars.payout_sentence).toMatch(/creator is paid nothing further/);
    expect(vars.desk_sentence).toBe('The desk is switched on here right now. Its spread is 0.75% and it fills up to 2.5 SOL per trade.');
    expect(vars.trade_cap_sentence).toMatch(/limited to 0\.5 SOL each/);
    expect(vars.pause_sentence).toBe('Right now new launches are paused.');
    expect(vars.metadata_home).toMatch(/this site’s own server/);
  });

  it('never turn something that is not an address into a link', () => {
    expect(addressLink('](javascript:alert(1))')).toBe('Not live yet');
    expect(addressLink('', 'none')).toBe('none');
    expect(addressLink(null)).toBe('Not live yet');
  });

  it('still give the fixed values when the server has not answered', () => {
    const vars = docVars(null);
    expect(vars.gas_reserve).toBe('0.015');
    expect(vars.page_size).toBe('24');
    expect(vars.creator_pct).toBeUndefined();
  });
});

describe('searching the docs', () => {
  const vars = docVars(status());
  const index = buildIndex(DOC_PAGES.map((page) => ({ slug: page.slug, title: page.title, group: page.group, summary: page.summary, sections: renderMarkdown(page.body, vars).sections })));

  it('finds the page a word is about first', () => {
    expect(searchDocs(index, 'burn')[0]?.slug).toBe('burning');
    expect(searchDocs(index, 'ghost wallet')[0]?.slug).toBe('ghost-wallet');
    expect(searchDocs(index, 'fees')[0]?.slug).toBe('fees');
    expect(searchDocs(index, 'graduation')[0]?.slug).toBe('graduation');
    expect(searchDocs(index, 'register').some((hit) => hit.slug === 'private-transfers' || hit.slug === 'private-balance')).toBe(true);
  });

  it('needs every word, ignores case, and marks what it matched', () => {
    const hits = searchDocs(index, 'BURN   Supply');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const entry = index.find((candidate) => candidate.slug === hit.slug && candidate.id === hit.id);
      const all = `${entry?.title} ${entry?.heading} ${entry?.text}`.toLowerCase();
      expect(all).toContain('burn');
      expect(all).toContain('supply');
    }
    const first = searchDocs(index, 'passphrase')[0];
    expect(first?.snippet.match.toLowerCase()).toBe('passphrase');
    expect(`${first?.snippet.before}${first?.snippet.match}${first?.snippet.after}`.length).toBeLessThan(220);
  });

  it('gives nothing for nothing, and nothing for nonsense', () => {
    expect(searchDocs(index, '')).toEqual([]);
    expect(searchDocs(index, '   ')).toEqual([]);
    expect(searchDocs(index, 'zzzqqqxxx')).toEqual([]);
  });

  it('keeps to its limit, and no page crowds the others out', () => {
    const hits = searchDocs(index, 'the', 8);
    expect(hits.length).toBeLessThanOrEqual(8);
    const perPage = new Map<string, number>();
    for (const hit of hits) perPage.set(hit.slug, (perPage.get(hit.slug) ?? 0) + 1);
    for (const count of perPage.values()) expect(count).toBeLessThanOrEqual(3);
  });
});
