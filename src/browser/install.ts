import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Browser, computeExecutablePath, detectBrowserPlatform, getInstalledBrowsers, install } from '@puppeteer/browsers';
import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';

/** The pinned headless-only Chromium build downloaded by `scraper setup`. */
export const PINNED_BUILD = '157.0.8103.78';

export interface ResolvedBrowser {
  path: string;
  source: 'env' | 'system' | 'downloaded';
}

export const DEBIAN_PACKAGES = [
  'ca-certificates', 'fonts-liberation', 'libasound2', 'libatk-bridge2.0-0', 'libatk1.0-0', 'libcairo2', 'libcups2',
  'libdbus-1-3', 'libdrm2', 'libgbm1', 'libglib2.0-0', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6',
  'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2',
];

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultSystemCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((d) => names.map((n) => path.join(d, n)));
}

const unavailable = (message: string): ScraperError =>
  ScraperError.from('browser_unavailable', message, 'Run "scraper setup" to download the browser and its system libraries, then retry. HTTP-only reads still work.', false);

export async function resolveBrowser(
  cfg: Config,
  opts: { systemCandidates?: string[] } = {},
): Promise<ResolvedBrowser> {
  if (cfg.browserPath) {
    if (executable(cfg.browserPath)) return { path: cfg.browserPath, source: 'env' };
    throw unavailable(`SCRAPER_BROWSER points to a missing or non-executable file: ${cfg.browserPath}`);
  }
  for (const c of opts.systemCandidates ?? defaultSystemCandidates()) {
    if (executable(c)) return { path: c, source: 'system' };
  }
  try {
    const installed = await getInstalledBrowsers({ cacheDir: cfg.browserCacheDir });
    const shells = installed.filter((b) => b.browser === Browser.CHROMEHEADLESSSHELL);
    const pick = shells.find((b) => b.buildId === PINNED_BUILD) ?? shells[0];
    if (pick && executable(pick.executablePath)) return { path: pick.executablePath, source: 'downloaded' };
  } catch {
    // cache dir missing: nothing installed
  }
  throw unavailable('No Chrome/Chromium was found and no browser has been downloaded.');
}

async function missingLibs(exe: string): Promise<string[]> {
  const r = spawnSync('ldd', [exe], { encoding: 'utf8' });
  if (r.error) return [];
  return r.stdout.split('\n').filter((l) => l.includes('not found')).map((l) => l.trim());
}

export function systemLibCommands(isRoot: boolean): string[] {
  const sudo = isRoot ? '' : 'sudo ';
  return [`${sudo}apt-get update`, `${sudo}apt-get install -y ${DEBIAN_PACKAGES.join(' ')}`];
}

async function ensureSystemLibs(exe: string, say: (m: string) => void): Promise<void> {
  if (process.platform !== 'linux') return;
  const missing = await missingLibs(exe);
  if (missing.length === 0) return;
  const fail = () =>
    unavailable(`Chromium still lacks ${missing.length} system libraries.`);
  const isRoot = process.getuid?.() === 0;
  const sudoOk = !isRoot && spawnSync('sudo', ['-n', 'true']).status === 0;
  const hasApt = spawnSync('apt-get', ['--version']).status === 0;
  const commands = systemLibCommands(isRoot);
  if (hasApt && (isRoot || sudoOk)) {
    say(`Installing system libraries for Chromium (${missing.length} missing)…`);
    for (const c of commands) {
      const [cmd, ...args] = c.split(' ');
      const r = spawnSync(cmd, args, { stdio: 'inherit' });
      if (r.status !== 0) throw unavailable(`"${c}" failed; run it manually, then retry.`);
    }
    if ((await missingLibs(exe)).length > 0) throw fail();
    return;
  }
  say('Chromium needs system libraries that could not be installed automatically. Run:');
  for (const c of commands) say(`  ${c}`);
  // Not "ready": say so, so setup exits non-zero instead of claiming success.
  throw unavailable(`Chromium needs system libraries that were not installed. Run: ${commands.join(' && ')}`);
}

/** Downloads the pinned chrome-headless-shell and makes sure its system libraries are present. */
export async function installBrowser(
  cfg: Config,
  onProgress: (msg: string) => void = () => {},
  deps: { install?: typeof install } = {},
): Promise<string> {
  const platform = detectBrowserPlatform();
  if (!platform) throw unavailable(`Unsupported platform: ${process.platform}/${process.arch}`);
  onProgress(`Downloading chrome-headless-shell ${PINNED_BUILD} to ${cfg.browserCacheDir}…`);
  try {
    await (deps.install ?? install)({ browser: Browser.CHROMEHEADLESSSHELL, buildId: PINNED_BUILD, cacheDir: cfg.browserCacheDir });
  } catch (e) {
    throw ScraperError.from(
      'browser_unavailable',
      `Could not download or unpack the browser: ${(e as Error).message}`,
      'Check the network connection and free disk space in the cache directory, then run "scraper setup" again.',
      false,
    );
  }
  const exe = computeExecutablePath({ browser: Browser.CHROMEHEADLESSSHELL, buildId: PINNED_BUILD, cacheDir: cfg.browserCacheDir });
  await ensureSystemLibs(exe, onProgress);
  onProgress(`Browser ready: ${exe}`);
  return exe;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctor(cfg: Config): Promise<{ checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= 22, detail: `Node ${process.versions.node} (need 22+)` });

  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.accessSync(cfg.dataDir, fs.constants.W_OK);
    checks.push({ name: 'data-dir', ok: true, detail: cfg.dataDir });
  } catch (e) {
    checks.push({ name: 'data-dir', ok: false, detail: `${cfg.dataDir} is not writable: ${String(e)}` });
  }

  const sockLen = Buffer.byteLength(path.join(cfg.runtimeDir, 'scraperd.sock'));
  checks.push({
    name: 'socket-path',
    ok: sockLen < 100,
    detail: sockLen < 100 ? cfg.runtimeDir : `Socket path is ${sockLen} bytes (limit ~104); set SCRAPER_RUNTIME_DIR to a shorter path.`,
  });

  try {
    const b = await resolveBrowser(cfg);
    checks.push({ name: 'browser', ok: true, detail: `${b.path} (${b.source})` });
    if (process.platform === 'linux') {
      const missing = await missingLibs(b.path);
      checks.push({
        name: 'system-libs',
        ok: missing.length === 0,
        detail: missing.length === 0 ? 'all shared libraries present' : `${missing.length} missing; run "scraper setup"`,
      });
    }
  } catch (e) {
    checks.push({ name: 'browser', ok: false, detail: `${(e as ScraperError).message} Run "scraper setup".` });
  }
  return { checks };
}

let installing: Promise<unknown> | undefined;

/**
 * The browser the engine should launch. When none is installed and the user did not pick one (SCRAPER_BROWSER),
 * it is downloaded once on first need, so a bare container needs no setup step; SCRAPER_NO_INSTALL=1 turns that off.
 */
export async function ensureBrowser(
  cfg: Config,
  deps: { resolve?: (cfg: Config) => Promise<ResolvedBrowser>; install?: (cfg: Config) => Promise<unknown> } = {},
): Promise<ResolvedBrowser> {
  const resolve = deps.resolve ?? resolveBrowser;
  try {
    return await resolve(cfg);
  } catch (e) {
    if (!(e instanceof ScraperError) || e.code !== 'browser_unavailable' || cfg.browserPath || !cfg.autoInstall) throw e;
    installing ??= (deps.install ?? ((c: Config) => installBrowser(c)))(cfg).finally(() => (installing = undefined));
    await installing;
    return resolve(cfg);
  }
}
