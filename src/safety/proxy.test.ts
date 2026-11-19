import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startGuardProxy, type GuardProxy } from './proxy.js';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function target(): Promise<number> {
  const s = http.createServer((req, res) => res.end(`hello from target ${req.url}`));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => s.close(() => r())));
  return (s.address() as net.AddressInfo).port;
}

async function proxy(allowHosts: string[], lookup?: any): Promise<GuardProxy> {
  const p = await startGuardProxy({ allowHosts }, lookup ? { lookup } : {});
  closers.push(() => p.close());
  return p;
}

/** Sends a CONNECT request and returns the proxy's status line. */
function connect(proxyPort: number, hostPort: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(proxyPort, '127.0.0.1', () => c.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
    c.once('data', (d) => {
      resolve(d.toString().split('\r\n')[0]);
      c.destroy();
    });
  });
}

function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: u.host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('guard proxy', () => {
  it('refuses CONNECT to a private address and records it', async () => {
    const p = await proxy([]);
    const since = Date.now();
    expect(await connect(p.port, '127.0.0.1:9')).toContain('403');
    expect(p.blockedSince(since)).toBe('127.0.0.1:9');
  });

  it('refuses CONNECT to a name that resolves to a private address (DNS rebinding)', async () => {
    const lookup = (_h: string, _o: any, cb: any) => cb(null, [{ address: '10.0.0.1', family: 4 }]);
    const p = await proxy([], lookup);
    expect(await connect(p.port, 'rebind.test:80')).toContain('403');
  });

  it('tunnels CONNECT to an allowed host', async () => {
    const port = await target();
    const p = await proxy([`127.0.0.1:${port}`]);
    expect(await connect(p.port, `127.0.0.1:${port}`)).toContain('200');
  });

  it('forwards plain HTTP to an allowed host and refuses a metadata address', async () => {
    const port = await target();
    const p = await proxy([`127.0.0.1:${port}`]);
    const ok = await viaProxy(p.port, `http://127.0.0.1:${port}/x`);
    expect(ok).toEqual({ status: 200, body: 'hello from target /x' });
    const since = Date.now();
    const bad = await viaProxy(p.port, 'http://169.254.169.254/latest/meta-data/');
    expect(bad.status).toBe(403);
    expect(p.blockedSince(since)).toContain('169.254.169.254');
  });

  it('reports nothing blocked before the given time', async () => {
    const p = await proxy([]);
    await connect(p.port, '127.0.0.1:9');
    expect(p.blockedSince(Date.now() + 1000)).toBeUndefined();
  });

  it('closes promptly even while a CONNECT tunnel is open', async () => {
    const port = await target();
    const p = await startGuardProxy({ allowHosts: [`127.0.0.1:${port}`] });
    const tunnel = net.connect(p.port, '127.0.0.1');
    await new Promise<void>((resolve) => {
      tunnel.once('data', () => resolve());
      tunnel.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
    const started = Date.now();
    await p.close();
    expect(Date.now() - started).toBeLessThan(2000);
    tunnel.destroy();
  });
});
