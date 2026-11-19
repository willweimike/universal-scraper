import type { Config } from './config.js';
import { runExclusive, type Session } from './daemon/sessions.js';
import { httpFetch } from './engines/http.js';
import { ScraperError } from './errors.js';
import type { EscalationReason, PageView, ReadParams, VerbContext } from './protocol.js';
import { tableFor } from './handles.js';
import { collectElements } from './view/elements.js';
import { buildPageView } from './view/markdown.js';
import { decodeText, excerptOf, httpError, paginate, type PageBase } from './view/page.js';

// ---------- classification ----------

export interface Classifiable {
  status: number;
  headers: Record<string, string>;
  html: string;
}

const CHALLENGE_BODY = /checking your browser|just a moment\.\.\.|attention required|cf-chl|_incapsula_|px-captcha|datadome/i;

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Decides whether an HTTP response should be retried in the browser (or is a wall). Pure. */
export function classify(res: Classifiable): EscalationReason | null {
  const challengeStatus = res.status === 403 || res.status === 503 || res.status === 429;
  if (res.headers['cf-mitigated'] || (challengeStatus && CHALLENGE_BODY.test(res.html))) return 'challenge';
  if (res.status === 429) return 'rate_limited';
  if (!/<(html|body)\b/i.test(res.html)) return null;
  const text = visibleText(res.html);
  if (text.length < 100 && /<script\b/i.test(res.html)) {
    if (/<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(res.html)) return 'empty_spa_shell';
    if (/(enable|requires?) javascript|javascript (is )?(required|disabled)/i.test(res.html)) return 'js_required';
  }
  if (res.html.length > 5000 && text.length / res.html.length < 0.02) return 'low_text_ratio';
  return null;
}

/** A page that is only a CAPTCHA widget or a one-time-code prompt needs a person; a long article that embeds a widget does not. */
export function detectHandoff(html: string): 'captcha' | 'mfa' | null {
  if (visibleText(html).length >= 400) return null;
  if (/class=["'][^"']*\b(g-recaptcha|h-captcha|cf-turnstile)\b|<iframe[^>]+src=["'][^"']*(recaptcha|hcaptcha|challenges\.cloudflare\.com)/i.test(html)) return 'captcha';
  if (/autocomplete=["']one-time-code["']/i.test(html)) return 'mfa';
  return null;
}

export function assertNoHandoff(html: string): void {
  const kind = detectHandoff(html);
  if (!kind) return;
  throw ScraperError.from(
    'needs_human',
    `This page needs a person to complete a ${kind === 'captcha' ? 'CAPTCHA' : 'one-time-code (MFA)'} step.`,
    'Ask the user to complete it (for example in their own browser), then retry. The tool does not solve CAPTCHAs or enter codes.',
    true,
  );
}

// ---------- per-host concurrency ----------

/** At most `max` concurrent calls per host; extra calls queue. */
export class DomainLimiter {
  private state = new Map<string, { active: number; queue: (() => void)[] }>();
  constructor(private max = 4) {}

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    let s = this.state.get(host);
    if (!s) this.state.set(host, (s = { active: 0, queue: [] }));
    if (s.active < this.max) s.active++;
    else await new Promise<void>((resolve) => s!.queue.push(resolve)); // slot is handed over on release
    try {
      return await fn();
    } finally {
      const next = s.queue.shift();
      if (next) next();
      else s.active--;
    }
  }
}

const limiter = new DomainLimiter(4);

// ---------- robots.txt (reported, never enforced) ----------

export type RobotsStatus = 'allowed' | 'disallowed' | 'unknown';
export type RobotsFetcher = (robotsUrl: string) => Promise<{ status: number; text: string }>;

interface RobotsEntry {
  rules: { allow: boolean; pattern: string; length: number }[] | 'unknown';
  expires: number;
}
const robotsCache = new Map<string, RobotsEntry>();
const ROBOTS_TTL_MS = 10 * 60 * 1000;

export function clearRobotsCache(): void {
  robotsCache.clear();
}

const MAX_ROBOTS_RULES = 1000;
const MAX_ROBOTS_PATTERN = 500;

/** robots.txt path match with `*` wildcards and a trailing `$` anchor, in linear-ish time (no regex backtracking). */
export function robotsMatch(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!target.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  if (parts.length === 1) return anchored ? target === parts[0] : true;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = target.indexOf(parts[i], pos);
    if (at < 0) return false;
    pos = at + parts[i].length;
  }
  const last = parts[parts.length - 1];
  if (anchored) return target.length - last.length >= pos && target.endsWith(last);
  return target.indexOf(last, pos) >= 0;
}

function parseRobots(text: string): RobotsEntry['rules'] {
  const rules: { allow: boolean; pattern: string; length: number }[] = [];
  let applies = false;
  let inGroup = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!inGroup) applies = false;
      inGroup = true;
      if (value === '*') applies = true;
    } else if ((key === 'allow' || key === 'disallow') && applies) {
      inGroup = false;
      if (!value || value.length > MAX_ROBOTS_PATTERN || rules.length >= MAX_ROBOTS_RULES) continue;
      rules.push({ allow: key === 'allow', pattern: value, length: value.length });
    } else if (key !== 'user-agent') {
      inGroup = false;
    }
  }
  return rules;
}

async function defaultRobotsFetcher(cfg: Config): Promise<RobotsFetcher> {
  return async (robotsUrl) => {
    const res = await httpFetch({ url: robotsUrl }, { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 5000) });
    return { status: res.status, text: res.body.toString('utf8') };
  };
}

export async function checkRobots(url: string, cfg: Config, fetcher?: RobotsFetcher): Promise<RobotsStatus> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'unknown';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'unknown';
  let entry = robotsCache.get(u.origin);
  if (!entry || entry.expires < Date.now()) {
    try {
      const res = await (fetcher ?? (await defaultRobotsFetcher(cfg)))(`${u.origin}/robots.txt`);
      entry = { rules: res.status === 200 ? parseRobots(res.text) : res.status === 404 ? [] : 'unknown', expires: Date.now() + ROBOTS_TTL_MS };
    } catch {
      entry = { rules: 'unknown', expires: Date.now() + ROBOTS_TTL_MS };
    }
    robotsCache.set(u.origin, entry);
  }
  if (entry.rules === 'unknown') return 'unknown';
  const target = u.pathname + u.search;
  let best: { allow: boolean; length: number } | undefined;
  for (const r of entry.rules) {
    if (robotsMatch(r.pattern, target) && (!best || r.length > best.length || (r.length === best.length && r.allow))) best = r;
  }
  return best && !best.allow ? 'disallowed' : 'allowed';
}

// ---------- routing ----------

export const blocked = (host: string, afterBrowser: boolean): ScraperError =>
  ScraperError.from(
    'blocked',
    afterBrowser
      ? `${host} served a bot-protection challenge and the browser attempt was challenged too.`
      : `${host} served a bot-protection challenge.`,
    afterBrowser
      ? 'This site blocks automated access and the tool does not bypass it. Ask the user for another source, or have them open it themselves.'
      : 'Retry with mode "auto" or "browser"; if the browser is challenged too, ask the user for another source.',
    false,
  );

function cookieHooks(session: Session) {
  return {
    header: (url: string) => session.cookies.forUrl(url),
    store: (url: string, setCookie: string[]) => session.cookies.fromSetCookie(url, setCookie),
  };
}

async function listElements(ctx: VerbContext, session: Session, tab: string) {
  try {
    return tableFor(session, tab).sync(await collectElements(await ctx.browser.cdp(tab)), { markChanges: false });
  } catch {
    return []; // the page is readable even when the accessibility tree is not
  }
}

/**
 * Reads in the browser. An interactive read keeps the session's tab (and lists element handles); any other
 * browser read uses a scratch tab that is closed afterwards, so it never moves the tab an agent is working in.
 */
async function browserRead(
  ctx: VerbContext,
  session: Session,
  p: ReadParams,
  started: number,
  reason: EscalationReason,
  maxChars: number,
): Promise<PageView> {
  const keep = p.interactive === true;
  return keep
    ? runExclusive(session, () => browserReadOn(ctx, session, p, started, reason, maxChars, true))
    : browserReadOn(ctx, session, p, started, reason, maxChars, false);
}

async function browserReadOn(
  ctx: VerbContext,
  session: Session,
  p: ReadParams,
  started: number,
  reason: EscalationReason,
  maxChars: number,
  keep: boolean,
): Promise<PageView> {
  const key = `${ctx.caller}\u0000${session.name}`;
  let tab: string;
  if (keep) {
    for (const id of [...session.tabs.keys()]) if (!ctx.browser.has(id)) session.tabs.delete(id); // closed or crashed
    if (!session.activeTab || !session.tabs.has(session.activeTab)) {
      const id = await ctx.browser.open(key, session.profileDir);
      session.tabs.set(id, id);
      session.activeTab = id;
    }
    tab = session.activeTab;
  } else {
    tab = await ctx.browser.open(key, session.profileDir);
  }
  try {
    const jar = session.cookies.toPuppeteer();
    if (jar.length) await ctx.browser.setCookies(tab, jar);
    const nav = await ctx.browser.navigate(tab, { url: p.url!, wait: p.wait });
    session.cookies.absorb(await ctx.browser.getCookies(tab));
    const host = new URL(nav.finalUrl).host;
    if (classify({ status: nav.status, headers: nav.headers, html: nav.html }) === 'challenge') throw blocked(host, true);
    if (nav.status >= 400) throw httpError({ status: nav.status, finalUrl: nav.finalUrl });
    assertNoHandoff(nav.html);
    session.lastHtml = nav.html;
    session.lastUrl = nav.finalUrl;
    const built = buildPageView(nav.html, nav.finalUrl);
    const base: PageBase = {
      url: nav.finalUrl,
      status: nav.status,
      title: built.title,
      contentType: 'text/html',
      engine: 'browser',
      escalatedBecause: reason,
      elapsedMs: Date.now() - started,
      ...(keep ? { tab } : {}),
      elements: keep ? await listElements(ctx, session, tab) : [],
      links: built.links,
      forms: built.forms,
    };
    return paginate(session, base, built.markdown, 0, maxChars);
  } finally {
    if (!keep) await ctx.browser.close(tab);
  }
}

const SOFT_REASONS = new Set<EscalationReason>(['low_text_ratio', 'rate_limited']);

async function fetchAndBuild(ctx: VerbContext, session: Session, p: ReadParams, started: number, maxChars: number): Promise<PageView> {
  const mode = p.mode ?? 'auto';
  if (mode === 'browser' || p.interactive) {
    return browserRead(ctx, session, p, started, p.interactive ? 'interactive' : 'forced', maxChars);
  }
  // A wait only makes sense in a browser: go straight there instead of silently ignoring it.
  if (mode === 'auto' && p.wait) return browserRead(ctx, session, p, started, 'forced', maxChars);
  const res = await httpFetch(
    { url: p.url!, method: p.method, headers: p.headers, body: p.body, cookies: cookieHooks(session) },
    ctx.cfg,
  );
  const textual = !res.savedPath && !/json/i.test(res.contentType);
  const text = textual ? decodeText(res.body, res.contentType) : '';
  const reason = classify({ status: res.status, headers: res.headers, html: text });
  // Only a plain GET can be replayed in the browser; a POST or a request with custom headers would silently become a different request.
  const plainGet = (p.method ?? 'GET').toUpperCase() === 'GET' && !p.body && !p.headers;
  if (reason && mode === 'auto' && plainGet) {
    try {
      return await browserRead(ctx, session, p, started, reason, maxChars);
    } catch (e) {
      // For soft signals the HTTP result is still useful when no browser is installed.
      if (!(SOFT_REASONS.has(reason) && e instanceof ScraperError && e.code === 'browser_unavailable')) throw e;
    }
  }
  if (reason === 'challenge') throw blocked(new URL(res.finalUrl).host, false);
  if (res.status >= 400) {
    const errText = res.savedPath ? '' : decodeText(res.body, res.contentType);
    throw httpError({ ...res, excerpt: excerptOf(errText), retryAfter: res.headers['retry-after'] });
  }
  if (textual) assertNoHandoff(text);

  const base: PageBase = {
    url: res.finalUrl,
    status: res.status,
    title: '',
    contentType: res.contentType,
    engine: 'http',
    elapsedMs: Date.now() - started,
    elements: [],
    links: [],
    forms: [],
    ...(res.bodyTruncated ? { bodyTruncated: true } : {}),
  };
  if (res.savedPath) return { ...base, savedPath: res.savedPath };
  if (/json/i.test(res.contentType)) {
    const raw = decodeText(res.body, res.contentType);
    if (raw.length > maxChars) return paginate(session, base, raw, 0, maxChars); // too big to dump: page it like text
    try {
      return { ...base, body: JSON.parse(raw) };
    } catch {
      return paginate(session, base, raw, 0, maxChars);
    }
  }
  if (/html|xml/i.test(res.contentType) || /^\s*</.test(text)) {
    session.lastHtml = text;
    session.lastUrl = res.finalUrl;
    const built = buildPageView(text, res.finalUrl);
    return paginate(session, { ...base, title: built.title, links: built.links, forms: built.forms }, built.markdown, 0, maxChars);
  }
  return paginate(session, base, text, 0, maxChars);
}

/** HTTP first; escalates to the browser on an SPA shell, JS-required page or challenge; reports robots.txt status. */
export async function routeRead(ctx: VerbContext, session: Session, p: ReadParams, started: number, maxChars: number): Promise<PageView> {
  const robots = checkRobots(p.url!, ctx.cfg);
  const view = await limiter.run(new URL(p.url!).host, () => fetchAndBuild(ctx, session, p, started, maxChars));
  view.robots = await robots;
  return view;
}
