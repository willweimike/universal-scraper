import { describe, expect, it } from 'vitest';
import { ScraperError } from '../errors.js';
import { assertPublicUrl, guardedLookup } from './ssrf.js';

const none = { allowHosts: [] as string[] };

function code(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ScraperError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('assertPublicUrl', () => {
  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/',
    'http://app.localhost/',
    'http://0.0.0.0/',
    'http://[::ffff:127.0.0.1]/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
  ])('refuses %s', (url) => {
    expect(code(() => assertPublicUrl(url, none))).toBe('ssrf_blocked');
  });

  it('passes a public host', () => {
    expect(code(() => assertPublicUrl('https://example.com/', none))).toBeUndefined();
    expect(code(() => assertPublicUrl('http://93.184.216.34/', none))).toBeUndefined();
  });

  it('exempts hosts listed in allowHosts, with or without a port', () => {
    const cfg = { allowHosts: ['127.0.0.1:4000'] };
    expect(code(() => assertPublicUrl('http://127.0.0.1:4000/x', cfg))).toBeUndefined();
    expect(code(() => assertPublicUrl('http://127.0.0.1:4001/x', cfg))).toBe('ssrf_blocked');
    expect(code(() => assertPublicUrl('http://localhost/', { allowHosts: ['localhost'] }))).toBeUndefined();
  });

  it('is not recoverable and says how to allow a host', () => {
    try {
      assertPublicUrl('http://10.0.0.5/', none);
    } catch (e) {
      const err = e as ScraperError;
      expect(err.recoverable).toBe(false);
      expect(err.hint).toContain('SCRAPER_ALLOW_HOSTS');
      expect(err.hint).toContain('scraper stop'); // a running daemon keeps the settings it started with
    }
  });
});

describe('guardedLookup', () => {
  const resolver = (ip: string) =>
    ((_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, ip, 4)) as any;

  const run = (cfg: { allowHosts: string[] }, ip: string, host = 'evil.test') =>
    new Promise<{ err: any; address?: string }>((resolve) =>
      guardedLookup(cfg, resolver(ip))(host, {}, (err: any, address: any) => resolve({ err, address })),
    );

  it('rejects a hostname that resolves to a private address (DNS rebinding)', async () => {
    const { err } = await run(none, '10.0.0.1');
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.code).toBe('ssrf_blocked');
  });

  it('passes a hostname that resolves to a public address', async () => {
    const { err, address } = await run(none, '93.184.216.34');
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
  });

  it('allows a private resolution for an allowed host that was listed with a port', async () => {
    const { err } = await run({ allowHosts: ['intranet.test:8080'] }, '10.0.0.1', 'intranet.test');
    expect(err).toBeNull();
  });

  it('allows a private resolution for an allowed host', async () => {
    const { err } = await run({ allowHosts: ['intranet.test'] }, '10.0.0.1', 'intranet.test');
    expect(err).toBeNull();
  });
});
