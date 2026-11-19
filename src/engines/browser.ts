import puppeteer, { type Browser, type BrowserContext, type CDPSession, type CookieParam, type Page } from 'puppeteer-core';
import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';
import type { WaitSpec } from '../protocol.js';
import { ensureBrowser } from '../browser/install.js';
import { startGuardProxy, type GuardProxy } from '../safety/proxy.js';
import { ssrfError } from '../safety/ssrf.js';

export type TabId = string;

interface Tab {
  id: TabId;
  page: Page;
  sessionKey: string;
  browser: Browser;
  cdp?: Promise<CDPSession>;
}

function mapBrowserError(e: any, cfg: Config): ScraperError {
  if (e instanceof ScraperError) return e;
  const msg: string = e?.message ?? String(e);
  if (e?.name === 'TimeoutError') {
    return ScraperError.from('timeout', `The page did not finish loading within ${cfg.timeoutMs} ms.`, 'Retry, or raise SCRAPER_TIMEOUT_MS.', true);
  }
  if (msg.includes('ERR_NAME_NOT_RESOLVED')) return ScraperError.from('dns', 'Could not resolve the host name.', 'Check the spelling of the host name.', false);
  if (/ERR_CERT|ERR_SSL/.test(msg)) return ScraperError.from('tls', `TLS handshake failed (${msg}).`, 'The site certificate is invalid.', false);
  if (/ERR_CONNECTION|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_TIMED_OUT/.test(msg)) {
    return ScraperError.from('dns', `Could not connect to the host (${msg}).`, 'The host is unreachable; retry later.', true);
  }
  if (/Target closed|Session closed|Protocol error|Connection closed|disconnected/i.test(msg)) {
    return ScraperError.from('browser_unavailable', `The browser stopped unexpectedly (${msg}).`, 'Retry; the browser restarts on the next call. Run "scraper doctor" if it repeats.', true);
  }
  return ScraperError.from('internal', `Browser error: ${msg}`, 'Retry; if it persists, report it.', false);
}

export class BrowserEngine {
  private browsers = new Map<string, Promise<Browser>>();
  private contexts = new Map<string, { ctx: BrowserContext; browser: Browser }>();
  private tabs = new Map<TabId, Tab>();
  private seq = 0;
  private proxy?: GuardProxy;

  constructor(private cfg: Config) {}

  private async launch(profileDir?: string): Promise<Browser> {
    const resolved = await ensureBrowser(this.cfg);
    // All browser traffic goes through the guard proxy: it enforces the SSRF rules at connect time for pages,
    // popups, workers and WebSockets alike. `<-loopback>` removes Chrome's default exemption for localhost.
    this.proxy ??= await startGuardProxy(this.cfg);
    const args = [
      '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
      `--proxy-server=http://127.0.0.1:${this.proxy.port}`,
      '--proxy-bypass-list=<-loopback>',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--force-webrtc-ip-handling-policy',
    ];
    if (process.getuid?.() === 0) args.push('--no-sandbox');
    try {
      const browser = await puppeteer.launch({
        executablePath: resolved.path,
        headless: resolved.source === 'downloaded' ? 'shell' : true,
        args,
        userDataDir: profileDir,
      });
      try {
        // A page must never be able to write files outside the data dir.
        const session = await browser.target().createCDPSession();
        await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      } catch {
        // older browsers: downloads stay at their default
      }
      return browser;
    } catch (e) {
      throw ScraperError.from('browser_unavailable', `The browser failed to start: ${(e as Error).message}`, 'Run "scraper doctor" to see what is missing.', false);
    }
  }

  private browserFor(profileDir?: string): Promise<Browser> {
    const key = profileDir ?? '';
    let b = this.browsers.get(key);
    if (!b) {
      b = this.launch(profileDir);
      this.browsers.set(key, b);
      b.then(
        (br) =>
          br.on('disconnected', () => {
            // A crashed or closed browser takes its tabs and contexts with it.
            this.browsers.delete(key);
            for (const [id, t] of this.tabs) if (t.browser === br) this.tabs.delete(id);
            for (const [k, c] of this.contexts) if (c.browser === br) this.contexts.delete(k);
          }),
        () => this.browsers.delete(key),
      );
    }
    return b;
  }

  async open(sessionKey: string, profileDir?: string): Promise<TabId> {
    const browser = await this.browserFor(profileDir);
    let page: Page;
    if (profileDir) {
      page = await browser.newPage();
    } else {
      let entry = this.contexts.get(sessionKey);
      if (!entry) {
        entry = { ctx: await browser.createBrowserContext(), browser };
        this.contexts.set(sessionKey, entry);
      }
      page = await entry.ctx.newPage();
    }
    const tab: Tab = { id: `t${++this.seq}`, page, sessionKey, browser };
    this.tabs.set(tab.id, tab);
    page.on('popup', (p) => void p?.close().catch(() => {})); // popups would escape our tab bookkeeping
    return tab.id;
  }

  has(id: TabId): boolean {
    return this.tabs.has(id);
  }

  /** Closes every tab of a session and releases its browser context (cookies, storage). */
  async closeSession(sessionKey: string): Promise<void> {
    for (const [id, t] of [...this.tabs]) if (t.sessionKey === sessionKey) await this.close(id);
    const entry = this.contexts.get(sessionKey);
    this.contexts.delete(sessionKey);
    await entry?.ctx.close().catch(() => {});
  }

  private tab(id: TabId): Tab {
    const t = this.tabs.get(id);
    if (!t) throw ScraperError.from('no_tab', `There is no open tab "${id}".`, 'Call read with interactive: true to open one.', true);
    return t;
  }

  page(id: TabId): Page {
    return this.tab(id).page;
  }

  cdp(id: TabId): Promise<CDPSession> {
    const t = this.tab(id);
    t.cdp ??= t.page.createCDPSession();
    return t.cdp;
  }

  private async settle(page: Page, wait?: WaitSpec): Promise<void> {
    const budget = Math.max(500, Math.min(5000, this.cfg.timeoutMs));
    try {
      if (!wait) await page.waitForNetworkIdle({ idleTime: 400, timeout: budget }).catch(() => {});
      else if ('ms' in wait) await new Promise((r) => setTimeout(r, wait.ms));
      else if ('selector' in wait) await page.waitForSelector(wait.selector, { timeout: this.cfg.timeoutMs });
      else if ('idle' in wait) await page.waitForNetworkIdle({ idleTime: 400, timeout: this.cfg.timeoutMs });
      else throw ScraperError.from('internal', 'Waiting on a handle is not supported here.', 'Use a selector, idle or ms.', false);
    } catch (e) {
      throw mapBrowserError(e, this.cfg);
    }
  }

  async navigate(id: TabId, req: { url: string; wait?: WaitSpec }): Promise<{ status: number; headers: Record<string, string>; html: string; finalUrl: string }> {
    const t = this.tab(id);
    const since = Date.now();
    let status = 0;
    let headers: Record<string, string> = {};
    try {
      const resp = await t.page.goto(req.url, { waitUntil: 'load', timeout: this.cfg.timeoutMs });
      status = resp?.status() ?? 0;
      headers = resp?.headers() ?? {};
    } catch (e) {
      const refused = this.proxy?.blockedSince(since);
      if (refused) throw ssrfError(refused);
      throw mapBrowserError(e, this.cfg);
    }
    const refusedPage = this.refusedCurrent(t.page, since);
    if (refusedPage) throw ssrfError(refusedPage); // the guard answered the navigation with its own 403 page
    await this.settle(t.page, req.wait);
    try {
      return { status, headers, html: await t.page.content(), finalUrl: t.page.url() };
    } catch (e) {
      throw mapBrowserError(e, this.cfg);
    }
  }

  /** Waits on a selector, network idle or a delay. */
  async wait(id: TabId, w: WaitSpec): Promise<void> {
    await this.settle(this.page(id), w);
  }

  async snapshot(id: TabId): Promise<{ html: string; url: string; status: number }> {
    const page = this.page(id);
    try {
      const status = await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as any)?.responseStatus || 200);
      return { html: await page.content(), url: page.url(), status };
    } catch (e) {
      throw mapBrowserError(e, this.cfg);
    }
  }

  async setCookies(id: TabId, cookies: CookieParam[]): Promise<void> {
    const page = this.page(id);
    try {
      await page.setCookie(...cookies);
    } catch {
      // One cookie Chrome rejects must not fail the read: set them one at a time and skip the bad ones.
      for (const c of cookies) await page.setCookie(c).catch(() => {});
    }
  }

  /** The host the guard refused since `since`, if the tab is currently on that host (a refused navigation, not a refused sub-resource). */
  private refusedCurrent(page: Page, since: number): string | undefined {
    const refused = this.proxy?.blockedSince(since);
    if (!refused) return undefined;
    try {
      return refused.replace(/:\d+$/, '') === new URL(page.url()).hostname ? refused : undefined;
    } catch {
      return undefined;
    }
  }

  /** After an action: if the guard refused the page the tab is on, or the tab ended on a browser error page, say why. */
  assertNavigationOk(id: TabId, since: number): void {
    const page = this.page(id);
    const refusedPage = this.refusedCurrent(page, since);
    if (refusedPage) throw ssrfError(refusedPage);
    if (!page.url().startsWith('chrome-error:')) return;
    const refused = this.proxy?.blockedSince(since);
    if (refused) throw ssrfError(refused);
    throw ScraperError.from('dns', 'The page could not be loaded.', 'The site is unreachable or refused the connection; retry later.', true);
  }

  async getCookies(id: TabId): Promise<import('../session/cookies.js').BrowserCookie[]> {
    // Every cookie in the tab's browser context, not only the ones that apply to the current URL.
    return (await this.page(id).browserContext().cookies()) as any;
  }

  async close(id: TabId): Promise<void> {
    const t = this.tabs.get(id);
    if (!t) return;
    this.tabs.delete(id);
    await t.page.close().catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.tabs.clear();
    const all = [...this.browsers.values()];
    this.browsers.clear();
    this.contexts.clear();
    await Promise.all(all.map((b) => b.then((br) => br.close()).catch(() => {})));
    await this.proxy?.close(); // after the browsers, so their open tunnels can end cleanly
    this.proxy = undefined;
  }
}
