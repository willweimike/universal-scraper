import { JSDOM, VirtualConsole } from 'jsdom';
import type { ExtractKind } from '../protocol.js';

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

function tables(doc: Document): { headers: string[]; rows: Record<string, string>[] }[] {
  return Array.from(doc.querySelectorAll('table')).map((table) => {
    const rows = Array.from(table.querySelectorAll('tr'));
    const cells = (tr: Element) => Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName)).map((c) => collapse(c.textContent));
    const headRow = table.querySelector('thead tr') ?? rows.find((tr) => Array.from(tr.children).length > 0 && Array.from(tr.children).every((c) => c.tagName === 'TH'));
    const dataRows = rows.filter((tr) => tr !== headRow && !tr.closest('thead')).map(cells).filter((r) => r.length > 0);
    const width = Math.max(headRow ? cells(headRow).length : 0, ...dataRows.map((r) => r.length), 0);
    const headers = headRow ? cells(headRow) : Array.from({ length: width }, (_, i) => `col${i + 1}`);
    return {
      headers,
      rows: dataRows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
    };
  });
}

function lists(doc: Document): string[][] {
  return Array.from(doc.querySelectorAll('ul, ol')).map((list) =>
    Array.from(list.children)
      .filter((c) => c.tagName === 'LI')
      .map((li) => {
        const clone = li.cloneNode(true) as Element;
        clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
        return collapse(clone.textContent);
      }),
  );
}

function structured(doc: Document, baseUrl: string) {
  const jsonLd: unknown[] = [];
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(s.textContent ?? '');
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed];
      jsonLd.push(...items);
    } catch {
      // malformed block: skip
    }
  }
  const openGraph: Record<string, string> = {};
  for (const m of Array.from(doc.querySelectorAll('meta[property^="og:"]'))) {
    openGraph[m.getAttribute('property')!] = m.getAttribute('content') ?? '';
  }
  const microdata = Array.from(doc.querySelectorAll('[itemscope]'))
    .filter((el) => !el.parentElement?.closest('[itemscope]'))
    .map((scope) => {
      const properties: Record<string, string> = {};
      for (const p of Array.from(scope.querySelectorAll('[itemprop]'))) {
        const name = p.getAttribute('itemprop')!;
        const href = p.getAttribute('href') ?? p.getAttribute('src');
        properties[name] = p.getAttribute('content') ?? (href ? new URL(href, baseUrl).toString() : collapse(p.textContent));
      }
      return { type: scope.getAttribute('itemtype') ?? '', properties };
    });
  return { jsonLd, microdata, openGraph };
}

function links(doc: Document, baseUrl: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const text = collapse(a.textContent);
    if (!text) continue;
    try {
      out.push({ text, href: new URL(a.getAttribute('href')!, baseUrl).toString() });
    } catch {
      // unparsable href: skip
    }
  }
  return out;
}

function pageText(doc: Document): string {
  const body = doc.body.cloneNode(true) as Element;
  body.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
  return collapse(body.textContent);
}

/** Deterministic, LLM-free extraction from a page's HTML. `attr` is handled by the verb through a handle. */
export function extractFromHtml(html: string, kind: Exclude<ExtractKind, 'attr'>, baseUrl: string): unknown {
  const doc = new JSDOM(html, { url: baseUrl, virtualConsole: new VirtualConsole() }).window.document;
  switch (kind) {
    case 'tables': return tables(doc);
    case 'lists': return lists(doc);
    case 'structured': return structured(doc, baseUrl);
    case 'links': return links(doc, baseUrl);
    case 'text': return pageText(doc);
  }
}
