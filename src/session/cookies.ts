import fs from 'node:fs';
import path from 'node:path';
import type { CookieParam } from 'puppeteer-core';

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  /** Seconds since the epoch; undefined for a session cookie. */
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
}

function defaultPath(urlPath: string): string {
  if (!urlPath.startsWith('/') || urlPath.lastIndexOf('/') === 0) return '/';
  return urlPath.slice(0, urlPath.lastIndexOf('/'));
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

/** One cookie store per session, shared by the HTTP engine and the browser. */
export class CookieJar {
  private cookies = new Map<string, StoredCookie>();
  private file?: string;

  /** Loads cookies from `file` (dropping expired ones) and writes every later change back to it, privately (0600). */
  persistTo(file: string): void {
    this.file = file;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredCookie[];
      const now = Date.now() / 1000;
      for (const c of stored) if (c.expires === undefined || c.expires > now) this.cookies.set(this.key(c), c);
    } catch {
      // no file yet, or unreadable: start empty
    }
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify([...this.cookies.values()]), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  private key(c: Pick<StoredCookie, 'name' | 'domain' | 'path'>): string {
    return `${c.name}\u0000${c.domain}\u0000${c.path}`;
  }

  fromSetCookie(url: string, headers: string[]): void {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const raw of headers) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const cookie: StoredCookie = {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        domain: host,
        hostOnly: true,
        path: defaultPath(u.pathname),
        secure: false,
        httpOnly: false,
      };
      let maxAge: number | undefined;
      let expires: number | undefined;
      let rejected = false;
      for (const a of attrs) {
        const i = a.indexOf('=');
        const k = (i < 0 ? a : a.slice(0, i)).toLowerCase();
        const v = i < 0 ? '' : a.slice(i + 1);
        if (k === 'domain' && v) {
          const d = v.replace(/^\./, '').toLowerCase();
          // A Domain must cover the host and be more than a bare top-level label (so evil.com cannot set a cookie for all of .com).
          if (host === d || (d.includes('.') && host.endsWith(`.${d}`))) {
            cookie.domain = d;
            cookie.hostOnly = false;
          } else {
            rejected = true;
          }
        } else if (k === 'path' && v.startsWith('/')) cookie.path = v;
        else if (k === 'secure') cookie.secure = true;
        else if (k === 'httponly') cookie.httpOnly = true;
        else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
        else if (k === 'expires') {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) expires = t / 1000;
        }
      }
      if (rejected) continue;
      const now = Date.now() / 1000;
      cookie.expires = maxAge !== undefined ? now + maxAge : expires;
      if (cookie.expires !== undefined && cookie.expires <= now) this.cookies.delete(this.key(cookie));
      else this.cookies.set(this.key(cookie), cookie);
    }
    this.save();
  }

  forUrl(url: string): string {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const now = Date.now() / 1000;
    return [...this.cookies.values()]
      .filter((c) => {
        if (c.expires !== undefined && c.expires <= now) return false;
        if (c.secure && u.protocol !== 'https:') return false;
        const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`);
        return domainOk && pathMatches(u.pathname || '/', c.path);
      })
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  toPuppeteer(): CookieParam[] {
    return [...this.cookies.values()].map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.hostOnly ? c.domain : `.${c.domain}`,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.expires !== undefined ? { expires: c.expires } : {}),
    }));
  }

  /** Replaces the jar with the browser's current cookies. */
  absorb(cookies: BrowserCookie[]): void {
    this.cookies.clear();
    for (const b of cookies) {
      const hostOnly = !b.domain.startsWith('.');
      const c: StoredCookie = {
        name: b.name,
        value: b.value,
        domain: b.domain.replace(/^\./, '').toLowerCase(),
        hostOnly,
        path: b.path || '/',
        expires: b.expires !== undefined && b.expires > 0 ? b.expires : undefined,
        secure: b.secure === true,
        httpOnly: b.httpOnly === true,
      };
      this.cookies.set(this.key(c), c);
    }
    this.save();
  }
}
