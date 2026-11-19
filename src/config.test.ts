import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses documented defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.idleMs).toBe(900000);
    expect(cfg.timeoutMs).toBe(30000);
    expect(cfg.tabTtlMs).toBe(600000);
    expect(cfg.autoInstall).toBe(true);
    expect(cfg.allowHosts).toEqual([]);
    expect(cfg.caller).toBe('cli');
    expect(cfg.browserPath).toBeUndefined();
  });
  it('reads every SCRAPER_* override', () => {
    const cfg = loadConfig({
      SCRAPER_RUNTIME_DIR: '/r', SCRAPER_DATA: '/d', SCRAPER_IDLE_MS: '300', SCRAPER_TAB_TTL_MS: '250', SCRAPER_NO_INSTALL: '1', SCRAPER_TIMEOUT_MS: '1500',
      SCRAPER_ALLOW_HOSTS: '127.0.0.1:4000, example.test', SCRAPER_BROWSER: '/b/chrome', SCRAPER_CALLER: 'mcp-1', SCRAPER_BROWSER_CACHE: '/cache',
    });
    expect(cfg).toMatchObject({
      runtimeDir: '/r', dataDir: '/d', idleMs: 300, tabTtlMs: 250, autoInstall: false, timeoutMs: 1500,
      allowHosts: ['127.0.0.1:4000', 'example.test'], browserPath: '/b/chrome', caller: 'mcp-1', browserCacheDir: '/cache',
    });
  });
});
