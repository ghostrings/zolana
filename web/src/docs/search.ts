/**
 * Search over the docs: every section of every page, matched in the browser.
 * Nothing leaves the page, so what somebody looks up is not sent anywhere.
 */

import type { Section } from './markdown.js';

export interface SearchEntry {
  readonly slug: string;
  readonly title: string;
  readonly group: string;
  /** Anchor of the section within the page. Empty for the top of the page. */
  readonly id: string;
  readonly heading: string;
  readonly text: string;
}

export interface SearchHit {
  readonly slug: string;
  readonly title: string;
  readonly group: string;
  readonly id: string;
  readonly heading: string;
  /** A piece of the section around the first match, in three parts so the match can be marked. */
  readonly snippet: { readonly before: string; readonly match: string; readonly after: string };
  readonly score: number;
}

export function buildIndex(pages: ReadonlyArray<{ slug: string; title: string; group: string; summary: string; sections: readonly Section[] }>): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const page of pages) {
    for (const section of page.sections) {
      // The top of a page is searched together with its one-line summary.
      const text = section.level === 0 ? `${page.summary} ${section.text}`.trim() : section.text;
      if (!text && !section.heading) continue;
      entries.push({ slug: page.slug, title: page.title, group: page.group, id: section.id, heading: section.heading, text });
    }
  }
  return entries;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < 5; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

function snippetOf(text: string, terms: readonly string[]): SearchHit['snippet'] {
  const lower = text.toLowerCase();
  let at = -1;
  let found = '';
  for (const term of terms) {
    const position = lower.indexOf(term);
    if (position !== -1 && (at === -1 || position < at)) {
      at = position;
      found = term;
    }
  }
  if (at === -1) return { before: text.slice(0, 120) + (text.length > 120 ? '…' : ''), match: '', after: '' };
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + found.length + 80);
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + found.length),
    after: text.slice(at + found.length, end) + (end < text.length ? '…' : ''),
  };
}

/**
 * The sections that contain every word of `query`, best first. A word in a
 * page's title counts most, then one in the section's heading, then the text.
 */
export function searchDocs(index: readonly SearchEntry[], query: string, limit = 8): SearchHit[] {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 6);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of index) {
    const title = entry.title.toLowerCase();
    const heading = entry.heading.toLowerCase();
    const text = entry.text.toLowerCase();
    let score = 0;
    let all = true;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inHeading = heading.includes(term);
      const inText = occurrences(text, term);
      if (!inTitle && !inHeading && inText === 0) {
        all = false;
        break;
      }
      score += (inTitle ? 6 : 0) + (inHeading ? 4 : 0) + inText;
    }
    if (!all) continue;
    // A page's own top section stands for the page when its title is what matched.
    if (entry.id === '') score += 1;
    hits.push({ slug: entry.slug, title: entry.title, group: entry.group, id: entry.id, heading: entry.heading, snippet: snippetOf(entry.text, terms), score });
  }
  hits.sort((a, b) => b.score - a.score);
  // No page takes more than three of the places.
  const perPage = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const seen = perPage.get(hit.slug) ?? 0;
    if (seen >= 3) continue;
    perPage.set(hit.slug, seen + 1);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}
