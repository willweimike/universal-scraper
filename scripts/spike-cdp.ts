// THROWAWAY spike (Task 1): answers CDP questions before the design hardens. Not shipped.
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { Browser, install, resolveBuildId, detectBrowserPlatform, computeExecutablePath } from '@puppeteer/browsers';
import { startFixture } from '../features/support/fixture-server.js';

const cacheDir = path.join(os.homedir(), '.cache', 'universal-scraper', 'browsers');
const platform = detectBrowserPlatform()!;
const buildId = await resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, 'stable');
const t0 = Date.now();
await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir });
const installMs = Date.now() - t0;
const executablePath = computeExecutablePath({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir });
const sizeMb = Number(execSync(`du -sk "${cacheDir}"`).toString().split('\t')[0]) / 1024;
console.log(JSON.stringify({ buildId, platform, installMs, diskMb: Math.round(sizeMb) }));

const fixture = await startFixture();
const t1 = Date.now();
const browser = await puppeteer.launch({ executablePath, headless: 'shell', args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
const page = await browser.newPage();
const coldLaunchMs = Date.now() - t1;
const cdp = await page.createCDPSession();
await cdp.send('Accessibility.enable');
await page.goto(`http://127.0.0.1:${fixture.port}/list`);

async function snapshot() {
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as any;
  const out: Record<string, number> = {};
  let withRoleAndName = 0, buttons = 0;
  for (const n of nodes) {
    if (n.role?.value === 'button') {
      buttons++;
      if (n.name?.value) withRoleAndName++;
      if (n.backendDOMNodeId) out[`button:${n.name?.value}`] = out[`button:${n.name?.value}`] ?? n.backendDOMNodeId;
    }
  }
  return { ids: out, buttons, withRoleAndName };
}
const before = await snapshot();
await page.click('[data-action=add]');
const afterAdd = await snapshot();
await page.click('[data-action=refresh]');
const afterRefresh = await snapshot();
const same = (a: any, b: any, k: string) => a.ids[k] !== undefined && a.ids[k] === b.ids[k];
console.log(JSON.stringify({
  coldLaunchMs,
  buttonsHaveRoleAndName: `${before.withRoleAndName}/${before.buttons}`,
  addKeepsRefreshId: same(before, afterAdd, 'button:Refresh'),
  addKeepsDeleteItemB: same(before, afterAdd, 'button:Delete Item B'),
  refreshKeepsRefreshBtn: same(afterAdd, afterRefresh, 'button:Refresh'),
  refreshKeepsDeleteItemB: same(afterAdd, afterRefresh, 'button:Delete Item B'),
  refreshKeepsDeleteItemA: same(afterAdd, afterRefresh, 'button:Delete Item A'),
}));
await browser.close();
await fixture.close();
