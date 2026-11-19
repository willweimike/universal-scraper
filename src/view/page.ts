import crypto from 'node:crypto';
import type { Session } from '../daemon/sessions.js';
import type { HttpResult } from '../engines/http.js';
import { ScraperError } from '../errors.js';
import type { PageView } from '../protocol.js';
import { chunk, fence } from './markdown.js';

/** A short, fenced excerpt of an error response body, so an API's validation message is not lost. */
export function excerptOf(text: string, max = 500): string {
  const plain = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain ? fence(plain.slice(0, max)) : '';
}

export const DEFAULT_MAX_CHARS = 30000;
const CURSOR_TTL_MS = 10 * 60 * 1000;

export type PageBase = Omit<PageView, 'markdown' | 'truncated'>;

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const sniff = head.subarray(0, 2048).toString('latin1');
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8';
}

export function decodeText(body: Buffer, contentType: string): string {
  const label = charsetOf(contentType, body);
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

export function httpError(res: Pick<HttpResult, 'status' | 'finalUrl'> & { excerpt?: string; retryAfter?: string }): ScraperError {
  const s = res.status;
  const hint =
    s === 401 || s === 403
      ? 'The page needs a login or refuses automated access; log in with a session, or ask the user.'
      : s === 404
        ? 'Check the URL; the page does not exist.'
        : 'The server returned an error status; retry later if it is a 5xx.';
  const wait = res.retryAfter ? ` Retry-After: ${res.retryAfter}.` : '';
  const body = res.excerpt ? `\nResponse body (untrusted):\n${res.excerpt}` : '';
  return ScraperError.from('http_status', `The server answered HTTP ${s} for ${res.finalUrl}.${wait}${body}`, hint, s === 429 || s >= 500);
}

/** Fences one chunk of markdown and stores a cursor for the rest. */
export function paginate(session: Session, base: PageBase, full: string, offset: number, maxChars: number, cursorId?: string): PageView {
  const { text, next } = chunk(full, offset, maxChars);
  const view: PageView = { ...base, markdown: fence(text) };
  if (next !== null) {
    const id = cursorId ?? crypto.randomBytes(6).toString('hex');
    session.cursors.set(id, { markdown: full, expires: Date.now() + CURSOR_TTL_MS, view: base });
    view.truncated = { cursor: `${id}:${next}` };
  } else if (cursorId) {
    session.cursors.delete(cursorId);
  }
  return view;
}

export function continueRead(session: Session, cursor: string, maxChars: number): PageView {
  const [id, off] = cursor.split(':');
  const entry = session.cursors.get(id);
  if (!entry || entry.expires < Date.now()) {
    throw ScraperError.from('session_expired', 'That continuation cursor has expired.', 'Read the URL again to get a fresh cursor.', true);
  }
  return paginate(session, entry.view, entry.markdown, Number(off), maxChars, id);
}
