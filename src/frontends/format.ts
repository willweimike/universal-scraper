import type { ElementRef, PageView, ScraperErrorShape } from '../protocol.js';
import { fence } from '../view/fence.js';

const MAX_ELEMENTS = 150;
const MAX_LINKS = 50;
const MAX_EXTRACT_CHARS = 30_000;

/** Page-derived text printed outside the fence: one line, no control characters, bounded, and unable to forge the fence. */
function clean(text: string | undefined, max = 160): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/<(\s*\/?\s*)web_content/gi, '&lt;$1web_content');
}

function elementLine(e: ElementRef): string {
  return `${e.handle}  ${clean(e.role, 40)}  "${clean(e.name)}"${e.href ? ` → ${clean(e.href, 300)}` : ''}${e.state ? ` (${e.state})` : ''}`;
}

/** Compact, agent-readable text for a page view: header, content, then addressable elements. */
export function formatPageView(v: PageView): string {
  const meta = [`engine: ${v.engine}`];
  if (v.escalatedBecause) meta.push(`escalated: ${v.escalatedBecause}`);
  meta.push(`status ${v.status}`, `${v.elapsedMs} ms`);
  if (v.tab) meta.push(`tab ${v.tab}`);
  if (v.robots && v.robots !== 'allowed') meta.push(`robots: ${v.robots}`);

  const out: string[] = [`# ${clean(v.title || v.url, 200)}  [${meta.join(', ')}]`, clean(v.url, 500)];
  if (v.body !== undefined) out.push(fence(JSON.stringify(v.body, null, 2)));
  if (v.savedPath) out.push(`Saved download to ${v.savedPath}`);
  if (v.bodyTruncated) out.push('[the response was larger than the size cap and was cut off]');
  if (v.markdown) out.push(v.markdown);
  if (v.truncated) out.push(`[truncated: continue with cursor "${v.truncated.cursor}"]`);
  if (v.remapped?.length) out.push(`[handles re-bound: ${v.remapped.join(', ')}]`);
  if (v.elements.length) {
    const shown = v.elements.slice(0, MAX_ELEMENTS).map(elementLine);
    const left = v.elements.length - MAX_ELEMENTS;
    out.push(['## Elements', ...shown, ...(left > 0 ? [`… ${left} more elements not shown (use web_extract with kind "links" to list links)`] : [])].join('\n'));
  } else if (!v.tab && v.links.length) {
    const left = v.links.length - MAX_LINKS;
    out.push(['## Links', ...v.links.slice(0, MAX_LINKS).map((l) => `${clean(l.text)} → ${clean(l.href, 300)}`), ...(left > 0 ? [`… ${left} more links not shown`] : [])].join('\n'));
  }
  if (!v.tab && v.forms.length) {
    out.push(['## Forms', ...v.forms.slice(0, 20).map((f) => `${clean(f.method, 10)} ${clean(f.action, 300)}: ${f.fields.slice(0, 40).map((x) => clean(x.name, 60)).join(', ')}`)].join('\n'));
  }
  return out.join('\n\n');
}

export function formatError(e: ScraperErrorShape): string {
  const lines = [`Error [${e.code}]: ${e.message}`, `Hint: ${e.hint}`];
  if (e.recoverable) lines.push('(recoverable: retrying or adjusting may work)');
  if (e.candidates?.length) lines.push('Candidates:', ...e.candidates.map((c) => `  ${elementLine(c)}`));
  return lines.join('\n');
}

/** Extracted data is page content too: fence it and cap its size so one extraction cannot flood the agent's context. */
export function formatExtract(data: unknown): string {
  const text = JSON.stringify(data, null, 2) ?? 'null';
  const capped = text.length > MAX_EXTRACT_CHARS
    ? `${text.slice(0, MAX_EXTRACT_CHARS)}\n… ${text.length - MAX_EXTRACT_CHARS} more characters not shown; extract a narrower part of the page`
    : text;
  return fence(capped);
}
