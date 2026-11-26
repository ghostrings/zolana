/**
 * The small Markdown subset the docs are written in, and nothing more:
 * headings, paragraphs, lists, tables, code, callouts and three boxes of this
 * site's own (what an observer sees, numbered steps, link cards).
 *
 * Every character of the source is escaped before any tag is added, and the
 * only tags that come out are the ones written here. Nothing touches a page,
 * so the whole renderer can be tested.
 */

export interface Section {
  /** The heading's anchor. Empty for what comes before the first heading. */
  readonly id: string;
  readonly heading: string;
  readonly level: 0 | 2 | 3;
  /** The section's words, without markup. This is what search reads. */
  readonly text: string;
}

export interface Rendered {
  readonly html: string;
  readonly sections: readonly Section[];
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

/** "What an observer sees" -> "what-an-observer-sees". */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** Fills `{{name}}` from `vars`. A name with no value becomes a dash, never a blank or the braces. */
export function fillVars(source: string, vars: Readonly<Record<string, string>>): string {
  return source.replace(/\{\{([a-z0-9_]+)\}\}/g, (_match, name: string) => vars[name] ?? '—');
}

/** A link is kept only when it stays on this site or is plain https. Anything else is shown as text. */
function safeHref(href: string): string | null {
  if (href.startsWith('#')) return href;
  if (href.startsWith('/') && !href.startsWith('//') && !href.includes('\\')) return href;
  if (/^https:\/\/[^\s]+$/.test(href)) return href;
  return null;
}

/** The words of an inline run, with the markup characters taken out. */
export function plainText(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\+\+([^+]+)\+\+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bold, links and the two chips, on text that is already escaped. */
function formatted(escaped: string): string {
  return escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
      // The address was escaped with everything else; undo that to judge it, and escape it again for the attribute.
      const raw = href.replaceAll('&amp;', '&').replaceAll('&#039;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
      const safe = safeHref(raw);
      if (!safe) return label;
      const outside = safe.startsWith('https://');
      return `<a href="${escapeHtml(safe)}"${outside ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/==([^=]+)==/g, '<span class="chip chip-hidden">$1</span>')
    .replace(/\+\+([^+]+)\+\+/g, '<span class="chip chip-public">$1</span>');
}

/** One run of text: `code`, **bold**, [links](/somewhere), ==hidden== and ++public++ chips. */
export function renderInline(text: string): string {
  // Code spans are cut out first, so nothing inside one is read as markup.
  return text
    .split('`')
    .map((part, index) => (index % 2 === 1 ? `<code>${escapeHtml(part)}</code>` : formatted(escapeHtml(part))))
    .join('');
}

const CALLOUTS: Readonly<Record<string, string>> = { NOTE: 'note', WARNING: 'warning', GHOST: 'ghost', TIP: 'tip' };

function isBlockStart(line: string): boolean {
  return (
    line.startsWith('```') ||
    line.startsWith(':::') ||
    line.startsWith('>') ||
    line.startsWith('|') ||
    line === '---' ||
    /^#{2,3}\s+\S/.test(line) ||
    /^[-*]\s+\S/.test(line) ||
    /^\d+\.\s+\S/.test(line)
  );
}

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

export function renderMarkdown(source: string, vars: Readonly<Record<string, string>> = {}): Rendered {
  const lines = fillVars(source, vars).replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  const sections: Array<{ id: string; heading: string; level: 0 | 2 | 3; words: string[] }> = [{ id: '', heading: '', level: 0, words: [] }];
  const used = new Set<string>();
  const say = (text: string): void => {
    const plain = plainText(text);
    if (plain) (sections[sections.length - 1] as { words: string[] }).words.push(plain);
  };

  let index = 0;
  while (index < lines.length) {
    const line = (lines[index] ?? '').trimEnd();
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // ```code```
    if (line.startsWith('```')) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      html.push(`<pre class="code-block"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      say(body.join(' '));
      continue;
    }

    // ## Heading
    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length as 2 | 3;
      const text = (heading[2] as string).trim();
      const base = slugify(plainText(text));
      let id = base;
      for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
      used.add(id);
      sections.push({ id, heading: plainText(text), level, words: [] });
      html.push(`<h${level} id="${id}">${renderInline(text)}<a class="doc-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`);
      index += 1;
      continue;
    }

    if (line === '---') {
      html.push('<hr class="doc-rule">');
      index += 1;
      continue;
    }

    // :::observer / :::steps / :::cards
    if (line.startsWith(':::')) {
      const [name = '', ...rest] = line.slice(3).trim().split(/\s+/);
      const title = rest.join(' ');
      const rows: string[][] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() !== ':::') {
        const row = (lines[index] ?? '').trim();
        if (row) rows.push(row.split('|').map((part) => part.trim()));
        index += 1;
      }
      index += 1;
      if (name === 'observer') {
        const label = title ? `What an observer sees · ${title}` : 'What an observer sees';
        say(label);
        html.push(
          `<dl class="visibility doc-visibility"><div class="visibility-title">${renderInline(label)}</div>${rows
            .map(([what = '', kind = 'public', word]) => {
              const hidden = kind.toLowerCase() === 'hidden';
              const value = word ?? (hidden ? 'ENCRYPTED' : 'PUBLIC');
              say(`${what} ${value}`);
              return `<dt>${renderInline(what)}</dt><dd class="${hidden ? 'is-hidden' : 'is-public'}">${escapeHtml(value)}</dd>`;
            })
            .join('')}</dl>`,
        );
      } else if (name === 'steps') {
        html.push(
          `<ol class="steps doc-steps">${rows
            .map(([what = '', detail = '']) => {
              say(`${what} ${detail}`);
              return `<li><div><b>${renderInline(what)}</b>${detail ? `<span>${renderInline(detail)}</span>` : ''}</div></li>`;
            })
            .join('')}</ol>`,
        );
      } else if (name === 'cards') {
        html.push(
          `<div class="doc-cards">${rows
            .map(([href = '', what = '', detail = '']) => {
              say(`${what} ${detail}`);
              const safe = safeHref(href);
              const inner = `<b>${renderInline(what)}</b><span>${renderInline(detail)}</span>`;
              return safe ? `<a class="doc-card" href="${escapeHtml(safe)}">${inner}</a>` : `<div class="doc-card">${inner}</div>`;
            })
            .join('')}</div>`,
        );
      }
      continue;
    }

    // > [!NOTE] Title
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) {
        body.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      const first = /^\[!([A-Z]+)\]\s*(.*)$/.exec(body[0] ?? '');
      const kind = first ? (CALLOUTS[first[1] as string] ?? 'note') : 'note';
      const title = first ? (first[2] as string).trim() : '';
      if (first) body.shift();
      const paragraphs = body
        .join('\n')
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
        .filter(Boolean);
      if (title) say(title);
      for (const paragraph of paragraphs) say(paragraph);
      html.push(
        `<aside class="callout callout-${kind}">${title ? `<strong>${renderInline(title)}</strong>` : ''}${paragraphs.map((paragraph) => `<p>${renderInline(paragraph)}</p>`).join('')}</aside>`,
      );
      continue;
    }

    // | a | b |
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(cells(lines[index] ?? ''));
        index += 1;
      }
      const divided = rows.length > 1 && (rows[1] as string[]).every((cell) => /^:?-{3,}:?$/.test(cell));
      const head = divided ? (rows[0] as string[]) : null;
      const body = divided ? rows.slice(2) : rows;
      for (const row of rows) if (!(divided && row === rows[1])) say(row.join(' '));
      html.push(
        `<div class="table-wrap doc-table"><table class="protocol-table">${head ? `<thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>` : ''}<tbody>${body
          .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }

    // - item   /   1. item
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const pattern = ordered ? /^\d+\.\s+(.+)$/ : /^[-*]\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const current = (lines[index] ?? '').trimEnd();
        const item = pattern.exec(current);
        if (item) items.push((item[1] as string).trim());
        // An indented line carries the item above it on.
        else if (/^\s{2,}\S/.test(current) && items.length > 0) items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`;
        else break;
        index += 1;
      }
      for (const item of items) say(item);
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag} class="doc-list">${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // A paragraph runs to the next blank line or the next block.
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = (lines[index] ?? '').trimEnd();
      if (!next.trim() || isBlockStart(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    const text = paragraph.join(' ');
    say(text);
    html.push(`<p>${renderInline(text)}</p>`);
  }

  return {
    html: html.join('\n'),
    sections: sections.map((section) => ({ id: section.id, heading: section.heading, level: section.level, text: section.words.join(' ') })),
  };
}
