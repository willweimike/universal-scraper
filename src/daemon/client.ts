import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from '../config.js';
import { ScraperError } from '../errors.js';
import type { DaemonRequest, DaemonResponse, Verb } from '../protocol.js';
import { ensurePrivateDir } from './lock.js';
import { pidPath, socketPath } from './paths.js';

let nextId = 1;

function connect(sock: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    c.once('connect', () => resolve(c));
    c.once('error', reject);
  });
}

function startDaemon(cfg: Config): void {
  const isTs = import.meta.url.endsWith('.ts');
  const main = fileURLToPath(new URL(isTs ? './main.ts' : './main.js', import.meta.url));
  const args = isTs ? ['--import', 'tsx', main] : [main];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SCRAPER_RUNTIME_DIR: cfg.runtimeDir, SCRAPER_DATA: cfg.dataDir },
  });
  child.unref();
}

async function connectOrStart(cfg: Config): Promise<net.Socket> {
  ensurePrivateDir(cfg.runtimeDir); // never talk to a socket in a directory someone else controls
  const sock = socketPath(cfg);
  try {
    return await connect(sock);
  } catch {
    startDaemon(cfg);
  }
  const deadline = Date.now() + 10000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      return await connect(sock);
    } catch (e) {
      lastErr = e;
    }
  }
  throw ScraperError.from('internal', `daemon did not start: ${String(lastErr)}`, 'Run "scraper doctor".');
}

function roundTrip(conn: net.Socket, req: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    let buf = '';
    conn.setEncoding('utf8'); // decodes across chunk boundaries so multi-byte characters stay intact
    conn.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        conn.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    conn.once('error', reject);
    conn.once('close', () => reject(new Error('daemon closed the connection')));
    conn.write(JSON.stringify(req) + '\n');
  });
}

export async function callDaemon<T = unknown>(
  verb: Verb,
  params: object,
  opts: { caller?: string } = {},
): Promise<T> {
  const cfg = loadConfig();
  const conn = await connectOrStart(cfg);
  const res = await roundTrip(conn, {
    id: nextId++,
    caller: opts.caller ?? cfg.caller,
    verb,
    params: params as Record<string, unknown>,
  });
  if (res.ok) return res.result as T;
  throw new ScraperError(res.error);
}

/** Stops a running daemon without ever starting one. Used by test hooks and `scraper` tooling. */
export async function stopDaemon(cfg: Config = loadConfig()): Promise<void> {
  const sock = socketPath(cfg);
  if (!fs.existsSync(sock)) return;
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidPath(cfg), 'utf8'));
  } catch {
    // no pid file: fall back to waiting for the socket only
  }
  try {
    const conn = await connect(sock);
    await roundTrip(conn, { id: nextId++, caller: cfg.caller, verb: 'shutdown', params: {} });
  } catch {
    // already gone
  }
  const alive = () => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // The daemon closes its browsers before removing the socket and exiting; wait for both so callers can safely delete its files.
  const deadline = Date.now() + 15000;
  while ((fs.existsSync(sock) || alive()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}
