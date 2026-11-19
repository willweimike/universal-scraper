import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { After, AfterAll, Before, BeforeAll } from '@cucumber/cucumber';
import { installBrowser, resolveBrowser } from '../../src/browser/install.js';
import { loadConfig } from '../../src/config.js';
import { stopDaemon } from '../../src/daemon/client.js';
import { startFixture, type Fixture } from './fixture-server.js';
import { fixtureState } from './world.js';

let fixture: Fixture | undefined;
let tmpRoot = '';

BeforeAll(async function () {
  fixture = await startFixture();
  fixtureState.port = fixture.port;
});

AfterAll(async function () {
  await fixture?.close();
});

// Each scenario gets its own short-pathed runtime/data dirs (unix socket paths are length-limited)
// and a clean SCRAPER_* environment; the fixture host is exempt from the SSRF guard.
Before(function () {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's-'));
  for (const k of Object.keys(process.env)) if (k.startsWith('SCRAPER_')) delete process.env[k];
  process.env.SCRAPER_RUNTIME_DIR = path.join(tmpRoot, 'r');
  process.env.SCRAPER_DATA = path.join(tmpRoot, 'd');
  process.env.SCRAPER_ALLOW_HOSTS = `127.0.0.1:${fixtureState.port}`;
});

After(async function () {
  await stopDaemon(loadConfig());
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Until the CLI `scraper setup` exists (Task 10), @browser scenarios install the browser once per run if needed.
let browserReady: Promise<void> | undefined;
Before({ tags: '@browser', timeout: 600_000 }, async function () {
  browserReady ??= (async () => {
    const cfg = loadConfig();
    try {
      await resolveBrowser(cfg);
    } catch {
      await installBrowser(cfg, (m) => console.error(m));
    }
  })();
  await browserReady;
});
