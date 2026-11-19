import fs from 'node:fs';
import net from 'node:net';
import type { Config } from '../config.js';
import { BrowserEngine } from '../engines/browser.js';
import { toShape } from '../errors.js';
import type { DaemonRequest, DaemonResponse, Verb, VerbContext, VerbHandler } from '../protocol.js';
import { sessionCloseVerb, sessionListVerb } from '../verbs/session.js';
import { acquireLock, ensurePrivateDir } from './lock.js';
import { lockPath, pidPath, socketPath } from './paths.js';
import { SessionStore } from './sessions.js';

export { pidPath, socketPath };

const registry = new Map<Verb, VerbHandler>();

export function registerVerb(name: Verb, handler: VerbHandler): void {
  registry.set(name, handler);
}

registerVerb('ping', async () => ({ pong: true, pid: process.pid }));
registerVerb('session.list', sessionListVerb);
registerVerb('session.close', sessionCloseVerb);

export function isAlive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
}

export interface RunningServer {
  /** Resolves once the server has stopped (idle exit, shutdown verb or close()). */
  closed: Promise<void>;
  close(): Promise<void>;
}

export async function startServer(cfg: Config): Promise<RunningServer> {
  ensurePrivateDir(cfg.runtimeDir);
  const sock = socketPath(cfg);
  // The lock decides who is the daemon; once we hold it, any socket file left behind is stale.
  const lock = acquireLock(lockPath(cfg));
  fs.rmSync(sock, { force: true });
  fs.rmSync(pidPath(cfg), { force: true });

  const sessions = new SessionStore(cfg);
  const browser = new BrowserEngine(cfg);
  let idleTimer: NodeJS.Timeout | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let inflight = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const connections = new Set<net.Socket>();

  const server = net.createServer((conn) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    let buf = '';
    conn.setEncoding('utf8'); // decodes across chunk boundaries so multi-byte characters stay intact
    conn.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void handle(conn, line);
      }
    });
    conn.on('error', () => {});
  });

  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (inflight > 0 || sessions.hasOpenTabs()) arm();
      else void stop();
    }, cfg.idleMs);
  };

  async function stop(): Promise<void> {
    if (stopping) return closed;
    stopping = true;
    clearTimeout(idleTimer);
    clearInterval(sweepTimer);
    for (const c of connections) c.end();
    await new Promise<void>((r) => server.close(() => r()));
    await browser.shutdown();
    fs.rmSync(sock, { force: true });
    fs.rmSync(pidPath(cfg), { force: true });
    lock.release();
    resolveClosed();
    return closed;
  }

  async function handle(conn: net.Socket, line: string): Promise<void> {
    let req: DaemonRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    arm();
    inflight++;
    let res: DaemonResponse;
    try {
      const ctx: VerbContext = { caller: req.caller, cfg, sessions, browser };
      const params = req.params ?? {};
      if (typeof params.session === 'string' && req.verb !== 'session.close') {
        // Only calls that rely on earlier state (act, extract, a cursor) see session_expired; a read of a URL starts afresh.
        const stateless = req.verb === 'read' && typeof params.url === 'string' && !params.cursor;
        sessions.get(req.caller, params.session, { share: params.share === true, forgive: stateless });
      }
      if (req.verb === 'shutdown') {
        res = { id: req.id, ok: true, result: { stopping: true } };
        conn.write(JSON.stringify(res) + '\n', () => void stop());
        return;
      }
      const handler = registry.get(req.verb);
      if (!handler) throw new Error(`unknown verb: ${req.verb}`);
      res = { id: req.id, ok: true, result: await handler(ctx, params) };
    } catch (err) {
      res = { id: req.id, ok: false, error: toShape(err) };
    } finally {
      inflight--;
    }
    conn.write(JSON.stringify(res) + '\n');
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, () => resolve());
    });
  } catch (e) {
    lock.release();
    throw e;
  }
  fs.chmodSync(sock, 0o600);
  fs.writeFileSync(pidPath(cfg), String(process.pid));
  arm();
  sweepTimer = setInterval(
    () => void sessions.sweep(Date.now(), cfg.tabTtlMs, (id) => browser.close(id)),
    Math.max(100, Math.min(30_000, cfg.tabTtlMs / 2)),
  );
  return { closed, close: stop };
}
