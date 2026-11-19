import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';
import { assertPublicUrl, guardedLookup } from '../safety/ssrf.js';

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Cookie hooks, so redirects carry cookies set on earlier hops (Task 6 passes the session jar). */
  cookies?: { header(url: string): string; store(url: string, setCookie: string[]): void };
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  setCookie: string[];
  contentType: string;
  /** Empty when the body was a binary download streamed to `savedPath`. */
  body: Buffer;
  bodyTruncated: boolean;
  savedPath?: string;
  size: number;
  finalUrl: string;
}

export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 10;

const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
};

const TIMEOUT = Symbol('timeout');

function mapNetError(e: any, cfg: Config): ScraperError {
  if (e instanceof ScraperError) return e;
  if (e === TIMEOUT || e?.[TIMEOUT]) {
    return ScraperError.from('timeout', `The request did not finish within ${cfg.timeoutMs} ms.`, 'Retry, or raise SCRAPER_TIMEOUT_MS.', true);
  }
  const c: string = e?.code ?? '';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') {
    return ScraperError.from('dns', `Could not resolve the host name (${c}).`, 'Check the spelling of the host name.', c === 'EAI_AGAIN');
  }
  if (/^ERR_TLS|^ERR_SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO/.test(c)) {
    return ScraperError.from('tls', `TLS handshake failed (${c}).`, 'The site certificate is invalid or the connection was intercepted.', false);
  }
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEDOUT)$/.test(c)) {
    return ScraperError.from('dns', `Could not connect to the host (${c}).`, 'The host is unreachable or refused the connection; retry later.', true);
  }
  return ScraperError.from('internal', `Network error: ${e?.message ?? String(e)}`, 'Retry; if it persists, report it.', false);
}

function send(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  cfg: Config,
  deadline: number,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(TIMEOUT);
    const h = { ...headers };
    if (body !== undefined && h['content-length'] === undefined) h['content-length'] = String(Buffer.byteLength(body));
    const req = lib.request(u, { method, headers: h, lookup: guardedLookup(cfg) as any }, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { [TIMEOUT]: true })), remaining);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function isBinary(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (!ct) return false;
  if (/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/.test(ct)) return false;
  if (/\+(json|xml)\b/.test(ct)) return false;
  return true;
}

function safeName(url: string): string {
  const base = path.basename(new URL(url).pathname) || 'download';
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 80);
}

/** NUL bytes in the first chunk mean binary, whatever the Content-Type claims. */
function looksBinary(chunk: Buffer): boolean {
  return chunk.subarray(0, 8192).includes(0);
}

async function consume(
  res: http.IncomingMessage,
  finalUrl: string,
  cfg: Config,
  deadline: number,
): Promise<Pick<HttpResult, 'body' | 'bodyTruncated' | 'savedPath' | 'size'>> {
  const contentType = String(res.headers['content-type'] ?? '');
  const declaredBinary = isBinary(contentType);
  let size = 0;
  let truncated = false;
  let timedOut = false;
  const chunks: Buffer[] = [];
  let out: fs.WriteStream | undefined;
  let savedPath: string | undefined;
  let first = true;

  const openFile = () => {
    const dir = path.join(cfg.dataDir, 'downloads');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    savedPath = path.join(dir, `${Date.now()}-${safeName(finalUrl)}`);
    out = fs.createWriteStream(savedPath, { mode: 0o600 });
    for (const c of chunks.splice(0)) out.write(c);
  };

  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (first) {
        first = false;
        if (declaredBinary || looksBinary(chunk)) openFile();
      }
      size += chunk.length;
      const limit = out ? MAX_DOWNLOAD_BYTES : MAX_TEXT_BYTES;
      if (size > limit) {
        truncated = true;
        res.destroy(); // stop reading; the pipeline then ends with a premature close that we accept below
        return cb();
      }
      if (out) return void (out.write(chunk) ? cb() : out.once('drain', () => cb()));
      chunks.push(chunk);
      cb();
    },
    final(cb) {
      if (out) out.end(() => cb());
      else cb();
    },
  });

  const timer = setTimeout(() => {
    timedOut = true;
    res.destroy();
  }, Math.max(1, deadline - Date.now()));
  try {
    await pipeline(res, ...decoders(res), sink);
  } catch (e: any) {
    if (timedOut) throw TIMEOUT;
    if (!truncated) {
      out?.destroy();
      if (savedPath) fs.rmSync(savedPath, { force: true });
      if (e?.code === 'Z_BUF_ERROR' || /unexpected end of file|premature close/i.test(String(e?.message))) {
        throw ScraperError.from('internal', 'The server cut the response off before it finished.', 'Retry the request.', true);
      }
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }
  if (savedPath && out) await new Promise<void>((r) => (out!.writableFinished ? r() : out!.once('finish', () => r())));
  return { body: Buffer.concat(chunks), bodyTruncated: truncated, savedPath, size };
}

function decoders(res: http.IncomingMessage): NodeJS.ReadWriteStream[] {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return [zlib.createGunzip()];
  if (enc === 'deflate') return [zlib.createInflate()];
  if (enc === 'br') return [zlib.createBrotliDecompress()];
  return [];
}

function lowerKeys(h: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

function flatten(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && k !== 'set-cookie') out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

export async function httpFetch(req: HttpRequest, cfg: Config): Promise<HttpResult> {
  const deadline = Date.now() + cfg.timeoutMs;
  let url = req.url;
  let method = (req.method ?? 'GET').toUpperCase();
  let body = req.body;
  const headers = { ...DEFAULT_HEADERS, ...lowerKeys(req.headers) };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicUrl(url, cfg);
    const hopHeaders = { ...headers };
    const cookie = req.cookies?.header(url);
    if (cookie) hopHeaders.cookie = hopHeaders.cookie ? `${hopHeaders.cookie}; ${cookie}` : cookie;
    let res: http.IncomingMessage;
    try {
      res = await send(url, method, hopHeaders, body, cfg, deadline);
    } catch (e) {
      throw mapNetError(e, cfg);
    }
    const status = res.statusCode ?? 0;
    const setCookie = (res.headers['set-cookie'] as string[] | undefined) ?? [];
    if (setCookie.length) req.cookies?.store(url, setCookie);
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      res.resume();
      const next = new URL(location, url);
      if (next.origin !== new URL(url).origin) {
        // Credentials the caller attached belong to the original origin only.
        for (const h of ['authorization', 'cookie', 'proxy-authorization']) delete headers[h];
      }
      url = next.toString();
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
      }
      continue;
    }
    let consumed;
    try {
      consumed = await consume(res, url, cfg, deadline);
    } catch (e) {
      throw mapNetError(e, cfg);
    }
    return {
      status,
      headers: flatten(res.headers),
      setCookie,
      contentType: String(res.headers['content-type'] ?? ''),
      finalUrl: url,
      ...consumed,
    };
  }
  throw ScraperError.from('http_status', `Too many redirects (more than ${MAX_REDIRECTS}).`, 'The site redirects in a loop; check the URL.', false);
}
