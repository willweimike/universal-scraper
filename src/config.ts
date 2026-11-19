import os from 'node:os';
import path from 'node:path';

export interface Config {
  runtimeDir: string;
  dataDir: string;
  idleMs: number;
  /** A session's tabs are closed after this long without a call. */
  tabTtlMs: number;
  /** Download the browser on first need when none is installed (disable with SCRAPER_NO_INSTALL=1). */
  autoInstall: boolean;
  timeoutMs: number;
  allowHosts: string[];
  browserPath?: string;
  browserCacheDir: string;
  caller: string;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const uid = process.getuid?.() ?? 0;
  const runtimeBase = env.XDG_RUNTIME_DIR
    ? path.join(env.XDG_RUNTIME_DIR, 'scraper')
    : path.join(os.tmpdir(), `scraper-${uid}`);
  return {
    runtimeDir: env.SCRAPER_RUNTIME_DIR || runtimeBase,
    dataDir: env.SCRAPER_DATA || path.join(os.homedir(), '.scraper'),
    idleMs: num(env.SCRAPER_IDLE_MS, 900000),
    tabTtlMs: num(env.SCRAPER_TAB_TTL_MS, 600000),
    autoInstall: env.SCRAPER_NO_INSTALL !== '1',
    timeoutMs: num(env.SCRAPER_TIMEOUT_MS, 30000),
    allowHosts: (env.SCRAPER_ALLOW_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    browserPath: env.SCRAPER_BROWSER || undefined,
    browserCacheDir: env.SCRAPER_BROWSER_CACHE || path.join(os.homedir(), '.cache', 'universal-scraper', 'browsers'),
    caller: env.SCRAPER_CALLER || 'cli',
  };
}
