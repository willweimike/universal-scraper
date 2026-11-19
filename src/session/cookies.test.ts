import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CookieJar } from './cookies.js';

describe('CookieJar', () => {
  it('stores a host-only cookie and sends it only to that host and path', () => {
    const jar = new CookieJar();
    jar.fromSetCookie('http://127.0.0.1:4000/login', ['sid=ok; Path=/app; HttpOnly']);
    expect(jar.forUrl('http://127.0.0.1:4000/app/page')).toBe('sid=ok');
    expect(jar.forUrl('http://127.0.0.1:4000/other')).toBe('');
    expect(jar.forUrl('http://localhost:4000/app/page')).toBe('');
  });

  it('defaults the path to the directory of the request URL', () => {
    const jar = new CookieJar();
    jar.fromSetCookie('http://example.test/a/b/login', ['x=1']);
    expect(jar.forUrl('http://example.test/a/b/c')).toBe('x=1');
    expect(jar.forUrl('http://example.test/a/other')).toBe('');
  });

  it('shares a Domain cookie with subdomains', () => {
    const jar = new CookieJar();
    jar.fromSetCookie('https://example.com/', ['a=1; Domain=example.com; Path=/']);
    expect(jar.forUrl('https://www.example.com/x')).toBe('a=1');
    expect(jar.forUrl('https://evilexample.com/x')).toBe('');
  });

  it('withholds Secure cookies from plain http', () => {
    const jar = new CookieJar();
    jar.fromSetCookie('https://example.com/', ['s=1; Secure; Path=/']);
    expect(jar.forUrl('https://example.com/')).toBe('s=1');
    expect(jar.forUrl('http://example.com/')).toBe('');
  });

  it('deletes a cookie when the server expires it', () => {
    const jar = new CookieJar();
    jar.fromSetCookie('http://example.test/', ['k=v; Path=/']);
    jar.fromSetCookie('http://example.test/', ['k=; Path=/; Max-Age=0']);
    expect(jar.forUrl('http://example.test/')).toBe('');
  });

  it('round-trips through the browser cookie shape', () => {
    const jar = new CookieJar();
    jar.fromSetCookie('http://127.0.0.1:4000/', ['sid=ok; Path=/; HttpOnly']);
    const out = jar.toPuppeteer();
    expect(out).toEqual([expect.objectContaining({ name: 'sid', value: 'ok', domain: '127.0.0.1', path: '/', httpOnly: true })]);
    const other = new CookieJar();
    other.absorb([{ name: 'b', value: '2', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, session: true } as any]);
    expect(other.forUrl('http://127.0.0.1:9/x')).toBe('b=2');
  });

  it('persists to a private file and reloads into a new jar', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's-')), 'p', 'cookies.json');
    const a = new CookieJar();
    a.persistTo(file);
    a.fromSetCookie('http://example.test/', ['sid=ok; Path=/']);
    const b = new CookieJar();
    b.persistTo(file);
    expect(b.forUrl('http://example.test/')).toBe('sid=ok');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('does not reload expired cookies from disk', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's-')), 'cookies.json');
    fs.writeFileSync(file, JSON.stringify([{ name: 'old', value: '1', domain: 'example.test', hostOnly: true, path: '/', expires: 1, secure: false, httpOnly: false }]));
    const jar = new CookieJar();
    jar.persistTo(file);
    expect(jar.forUrl('http://example.test/')).toBe('');
  });

  it('rejects a cookie whose Domain is a bare top-level label or does not cover the host', () => {
    const jar = new CookieJar();
    jar.fromSetCookie('http://evil.com/', ['x=1; Domain=com; Path=/', 'y=1; Domain=bank.com; Path=/']);
    expect(jar.forUrl('http://bank.com/')).toBe('');
    expect(jar.forUrl('http://evil.com/')).toBe('');
  });
});
