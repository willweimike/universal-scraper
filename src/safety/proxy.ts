import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';
import { assertPublicUrl, guardedLookup } from './ssrf.js';

export interface GuardProxy {
  port: number;
  /** The most recent host the proxy refused at or after `ts` (ms since epoch), if any. */
  blockedSince(ts: number): string | undefined;
  close(): Promise<void>;
}

type Lookup = Parameters<typeof guardedLookup>[1];

const hopByHop = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'];

/**
 * A forward proxy for the browser: every request, popup, worker and WebSocket it makes passes through the same
 * connect-time SSRF guard as the HTTP engine (names are resolved here and refused if they point at private space),
 * which page-level request interception cannot guarantee.
 */
export async function startGuardProxy(
  cfg: Pick<Config, 'allowHosts'>,
  opts: { lookup?: Lookup } = {},
): Promise<GuardProxy> {
  const blocked: { at: number; host: string }[] = [];
  const record = (host: string) => {
    blocked.push({ at: Date.now(), host });
    if (blocked.length > 50) blocked.shift();
  };
  const tunnels = new Set<Duplex>(); // CONNECT tunnels are detached from the HTTP server, so track them to close them
  const lookup = guardedLookup(cfg, opts.lookup) as any;
  const isBlock = (e: unknown) => e instanceof ScraperError && e.code === 'ssrf_blocked';

  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const deny = () => {
      record(target.host);
      if (!res.headersSent) res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Blocked by the scraper SSRF guard');
    };
    try {
      assertPublicUrl(target.toString(), cfg);
    } catch {
      return deny();
    }
    const headers = { ...req.headers };
    for (const h of hopByHop) delete headers[h];
    const up = http.request(
      {
        host: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || 80,
        method: req.method,
        path: target.pathname + target.search,
        headers,
        lookup,
      },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on('error', (e) => {
      if (isBlock(e)) return deny();
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });

  server.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const raw = req.url ?? '';
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(raw);
    const host = m?.[1] ?? raw;
    const port = Number(m?.[2] ?? 443);
    const label = `${host}:${port}`;
    try {
      assertPublicUrl(`https://${host.includes(':') ? `[${host}]` : host}:${port}`, cfg);
    } catch {
      record(label);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = net.connect({ host, port, lookup });
    tunnels.add(socket).add(up);
    const forget = () => { tunnels.delete(socket); tunnels.delete(up); };
    up.once('close', forget);
    socket.once('close', forget);
    up.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', (e) => {
      if (isBlock(e)) record(label);
      socket.end(`HTTP/1.1 ${isBlock(e) ? '403 Forbidden' : '502 Bad Gateway'}\r\n\r\n`);
      up.destroy();
    });
    socket.once('close', () => up.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    blockedSince: (ts) => [...blocked].reverse().find((b) => b.at >= ts)?.host,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        for (const t of tunnels) t.destroy();
        server.close(() => resolve());
      }),
  };
}
