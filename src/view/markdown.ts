import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import type { PageView } from '../protocol.js';

export interface BuiltView {
  title: string;
  /** Unfenced markdown of the main content. */
  markdown: string;
  links: PageView['links'];
  forms: PageView['forms'];
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.remove(['script', 'style', 'noscript']);

const MIN_ARTICLE_CHARS = 200;

function clean(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

const BYLINE_SIGNAL = /byline|dateline|writtenby|author/i;

/**
 * Readability lifts the first element that looks like a byline (rel=author, itemprop=author, class/id "author"/"byline")
 * out of the article text. For an agent that silently loses data (the first quote's author, a review's name), so the
 * copy Readability parses has those signals defused; the elements and their text stay where they are.
 */
function keepBylines(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll('[rel],[itemprop],[class],[id]'))) {
    if (/\bauthor\b/i.test(el.getAttribute('rel') ?? '')) el.removeAttribute('rel');
    if (/author/i.test(el.getAttribute('itemprop') ?? '')) el.removeAttribute('itemprop');
    for (const attr of ['class', 'id']) {
      const v = el.getAttribute(attr);
      if (v && BYLINE_SIGNAL.test(v)) {
        el.setAttribute(attr, v.replace(/byline/gi, 'by_line').replace(/dateline/gi, 'date_line').replace(/writtenby/gi, 'written_by').replace(/author/gi, 'auth_or'));
      }
    }
  }
}

export function buildPageView(html: string, baseUrl: string): BuiltView {
  const dom = new JSDOM(html, { url: baseUrl, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  const title = (doc.title ?? '').trim();

  const links: BuiltView['links'] = [];
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    const href = (a as HTMLAnchorElement).href;
    if (text && href && !href.startsWith('javascript:')) links.push({ text, href });
  }

  const forms: BuiltView['forms'] = Array.from(doc.querySelectorAll('form')).map((f) => ({
    action: (f as HTMLFormElement).action || baseUrl,
    method: ((f.getAttribute('method') ?? 'get') as string).toUpperCase(),
    fields: Array.from(f.querySelectorAll('input[name],select[name],textarea[name]')).map((el) => ({
      name: el.getAttribute('name')!,
      type: el.tagName === 'INPUT' ? (el.getAttribute('type') ?? 'text') : el.tagName.toLowerCase(),
    })),
  }));

  let contentHtml = '';
  try {
    const copy = doc.cloneNode(true) as Document;
    keepBylines(copy);
    const article = new Readability(copy).parse();
    if (article && (article.textContent ?? '').trim().length >= MIN_ARTICLE_CHARS) contentHtml = article.content ?? '';
  } catch {
    // fall through to the whole body
  }
  if (!contentHtml) contentHtml = doc.body?.innerHTML ?? '';
  const markdown = clean(turndown.turndown(contentHtml));
  return { title, markdown, links, forms };
}

export { fence } from './fence.js';

/** Splits at a newline near `maxChars` when possible; returns the chunk and the next offset. */
export function chunk(text: string, offset: number, maxChars: number): { text: string; next: number | null } {
  if (offset + maxChars >= text.length) return { text: text.slice(offset), next: null };
  let end = offset + maxChars;
  const nl = text.lastIndexOf('\n', end);
  if (nl > offset + maxChars * 0.5) end = nl;
  return { text: text.slice(offset, end), next: end };
}
