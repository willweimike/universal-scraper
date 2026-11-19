import dns from 'node:dns';
import net from 'node:net';
import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';

type AllowCfg = Pick<Config, 'allowHosts'>;

export const ssrfError = (what: string): ScraperError =>
  ScraperError.from(
    'ssrf_blocked',
    `Refusing to fetch ${what}: it points at a private, loopback, link-local or metadata address.`,
    'Use a public URL. To permit a specific local host for development, set SCRAPER_ALLOW_HOSTS=host[:port] and run "scraper stop" so the daemon restarts with it.',
    false,
  );

function v4Bytes(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}

function v6Bytes(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const b = v4Bytes(tail[1]);
    if (!b) return null;
    s = s.slice(0, -tail[1].length) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n > 0xffff) return null;
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and cloud-metadata addresses. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return blockedV4(v4Bytes(ip)!);
  if (kind === 6) {
    const b = v6Bytes(ip);
    if (!b) return true;
    if (b.every((x) => x === 0)) return true; // ::
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
    if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
    if (b[0] === 0xff) return true; // multicast
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return blockedV4(b.slice(12)); // ::ffff:v4
    if (b.slice(0, 12).every((x) => x === 0)) return blockedV4(b.slice(12)); // ::v4
    return false;
  }
  return true; // not an IP: callers pass only literals
}

function isBlockedHostname(host: string): boolean {
  return (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host === 'metadata'
  );
}

function allowed(host: string, port: string | null, cfg: AllowCfg): boolean {
  return cfg.allowHosts.some((entry) => {
    const i = entry.lastIndexOf(':');
    const hasPort = i > 0 && !entry.endsWith(']') && /^\d+$/.test(entry.slice(i + 1));
    const eh = (hasPort ? entry.slice(0, i) : entry).toLowerCase().replace(/^\[|\]$/g, '');
    if (eh !== host) return false;
    return hasPort && port !== null ? entry.slice(i + 1) === port : true;
  });
}

/** Throws ssrf_blocked unless the URL is http(s) to a public host (or an allowed one). Names that resolve privately are caught at connect time by guardedLookup. */
export function assertPublicUrl(url: string, cfg: AllowCfg): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw ScraperError.from('dns', `Not a valid URL: ${url}`, 'Pass a full http(s) URL.', false);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw ssrfError(`${u.protocol} URLs (only http and https are allowed)`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (allowed(host, port, cfg)) return;
  if (net.isIP(host) ? isBlockedAddress(host) : isBlockedHostname(host)) throw ssrfError(u.host);
}

type Resolver = (host: string, opts: any, cb: (err: any, address: any, family?: number) => void) => void;

/** A `dns.lookup` replacement for undici/net `connect.lookup`: rejects private resolutions so DNS rebinding fails at connect time. */
export function guardedLookup(cfg: AllowCfg, resolve: Resolver = dns.lookup as unknown as Resolver) {
  return (host: string, opts: any, cb: (err: any, address?: any, family?: number) => void): void => {
    resolve(host, opts, (err, address, family) => {
      if (err) return cb(err);
      const list: { address: string }[] = Array.isArray(address) ? address : [{ address }];
      const hostAllowed = allowed(host.toLowerCase(), null, cfg);
      if (!hostAllowed && list.some((a) => isBlockedAddress(a.address))) return cb(ssrfError(host));
      cb(null, address, family);
    });
  };
}
