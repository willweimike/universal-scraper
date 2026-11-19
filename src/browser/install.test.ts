import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { ScraperError } from '../errors.js';
import { doctor, ensureBrowser, installBrowser, resolveBrowser } from './install.js';

describe('resolveBrowser', () => {
  it('uses SCRAPER_BROWSER when it points at an executable', async () => {
    const cfg = loadConfig({ SCRAPER_BROWSER: process.execPath });
    expect(await resolveBrowser(cfg)).toEqual({ path: process.execPath, source: 'env' });
  });

  it('fails clearly, without falling through, when SCRAPER_BROWSER is missing', async () => {
    const cfg = loadConfig({ SCRAPER_BROWSER: '/nonexistent/chrome' });
    const err = await resolveBrowser(cfg).catch((e) => e);
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.code).toBe('browser_unavailable');
    expect(err.hint).toContain('scraper setup');
  });

  it('reports browser_unavailable when nothing is installed anywhere', async () => {
    const cfg = loadConfig({ SCRAPER_BROWSER_CACHE: '/nonexistent/cache', PATH: '/nonexistent' });
    const err = await resolveBrowser(cfg, { systemCandidates: [] }).catch((e) => e);
    expect(err.code).toBe('browser_unavailable');
    expect(err.hint).toContain('scraper setup');
  });
});

describe('doctor', () => {
  it('flags a missing browser with the fix', async () => {
    const cfg = loadConfig({ SCRAPER_BROWSER: '/nonexistent/chrome' });
    const report = await doctor(cfg);
    const browser = report.checks.find((c) => c.name === 'browser')!;
    expect(browser.ok).toBe(false);
    expect(browser.detail).toContain('scraper setup');
    expect(report.checks.find((c) => c.name === 'node')!.ok).toBe(true);
  });
});

describe('installBrowser', () => {
  it('reports a failed download as browser_unavailable with the cause and a fix, not as an internal bug', async () => {
    const cfg = loadConfig({ SCRAPER_BROWSER_CACHE: '/nonexistent/cache' });
    const failing = async () => { throw new Error('All providers failed: no zip archiver is available'); };
    const err = await installBrowser(cfg, () => {}, { install: failing as any }).catch((e) => e);
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.code).toBe('browser_unavailable');
    expect(err.message).toContain('no zip archiver');
    expect(err.hint.toLowerCase()).toContain('network');
  });
});

describe('ensureBrowser', () => {
  const missing = () => Promise.reject(ScraperError.from('browser_unavailable', 'none', 'run setup', false));
  const found = { path: '/b', source: 'downloaded' as const };

  it('installs the browser on first need, then resolves it', async () => {
    let installed = 0;
    let resolved = 0;
    const got = await ensureBrowser(loadConfig({}), {
      resolve: async () => (resolved++ === 0 ? missing() : found),
      install: async () => void installed++,
    });
    expect(installed).toBe(1);
    expect(got).toEqual(found);
  });

  it('does not install when a browser is already available', async () => {
    let installed = 0;
    await ensureBrowser(loadConfig({}), { resolve: async () => found, install: async () => void installed++ });
    expect(installed).toBe(0);
  });

  it('does not install when SCRAPER_BROWSER names a path (an explicit choice that failed)', async () => {
    let installed = 0;
    const err = await ensureBrowser(loadConfig({ SCRAPER_BROWSER: '/nope' }), { resolve: missing, install: async () => void installed++ }).catch((e) => e);
    expect(err.code).toBe('browser_unavailable');
    expect(installed).toBe(0);
  });

  it('does not install when SCRAPER_NO_INSTALL=1', async () => {
    let installed = 0;
    const err = await ensureBrowser(loadConfig({ SCRAPER_NO_INSTALL: '1' }), { resolve: missing, install: async () => void installed++ }).catch((e) => e);
    expect(err.code).toBe('browser_unavailable');
    expect(installed).toBe(0);
  });
});
