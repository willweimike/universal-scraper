import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { runExclusive, SessionStore } from './sessions.js';

const store = () => new SessionStore(loadConfig({ SCRAPER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 's-')) }));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('runExclusive', () => {
  it('runs tasks one at a time, in order', async () => {
    const s = store().get('c', 's');
    const log: string[] = [];
    const a = runExclusive(s, async () => { log.push('a:start'); await tick(40); log.push('a:end'); });
    const b = runExclusive(s, async () => { log.push('b:start'); log.push('b:end'); });
    await Promise.all([a, b]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not let a failed task block the next one', async () => {
    const s = store().get('c', 's');
    const a = runExclusive(s, async () => { throw new Error('boom'); });
    await expect(a).rejects.toThrow('boom');
    await expect(runExclusive(s, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('session expiry after a restart', () => {
  it('throws session_expired for a session known from before, once', () => {
    const cfg = loadConfig({ SCRAPER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 's-')) });
    new SessionStore(cfg).get('c', 's1');
    const after = new SessionStore(cfg); // a restarted daemon
    expect(() => after.get('c', 's1')).toThrow(/ended when the daemon restarted/);
    expect(after.get('c', 's1').name).toBe('s1'); // the next call starts a fresh session
  });

  it('recreates silently when the call does not depend on earlier state (forgive)', () => {
    const cfg = loadConfig({ SCRAPER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 's-')) });
    new SessionStore(cfg).get('c', 's1');
    expect(new SessionStore(cfg).get('c', 's1', { forgive: true }).name).toBe('s1');
  });
});

describe('sharing', () => {
  it("lets another caller attach to a shared session only when it asks to share", () => {
    const st = store();
    const owned = st.get('a', 'team', { share: true });
    expect(st.get('b', 'team')).not.toBe(owned);
    expect(st.get('c', 'team', { share: true })).toBe(owned);
  });
});

describe('sweep', () => {
  it('closes tabs of sessions idle beyond the time to live and drops their state, leaving active ones alone', async () => {
    const st = store();
    const idle = st.get('c', 'idle');
    idle.tabs.set('t1', 't1');
    idle.activeTab = 't1';
    idle.lastHtml = '<html></html>';
    idle.cursors.set('x', { markdown: 'm', expires: Date.now() + 60_000, view: {} });
    const busy = st.get('c', 'busy');
    busy.tabs.set('t2', 't2');
    idle.lastUsed = Date.now() - 10_000;
    const closed: string[] = [];
    await st.sweep(Date.now(), 5_000, async (id) => void closed.push(id));
    expect(closed).toEqual(['t1']);
    expect(idle.tabs.size).toBe(0);
    expect(idle.activeTab).toBeUndefined();
    expect(idle.lastHtml).toBeUndefined();
    expect(idle.cursors.size).toBe(0);
    expect(busy.tabs.size).toBe(1);
  });

  it('drops expired cursors even from active sessions', async () => {
    const st = store();
    const s = st.get('c', 's');
    s.cursors.set('old', { markdown: 'm', expires: Date.now() - 1, view: {} });
    s.cursors.set('new', { markdown: 'm', expires: Date.now() + 60_000, view: {} });
    await st.sweep(Date.now(), 5_000, async () => {});
    expect([...s.cursors.keys()]).toEqual(['new']);
  });

  it('never sweeps a session while a call on it is still running, and restarts its clock afterwards', async () => {
    const st = store();
    const s = st.get('c', 's');
    s.tabs.set('t1', 't1');
    s.lastUsed = Date.now() - 10_000;
    const closed: string[] = [];
    let release!: () => void;
    const running = runExclusive(s, () => new Promise<void>((r) => (release = r)));
    await tick();
    await st.sweep(Date.now(), 5_000, async (id) => void closed.push(id));
    expect(closed).toEqual([]); // busy
    release();
    await running;
    await st.sweep(Date.now(), 5_000, async (id) => void closed.push(id));
    expect(closed).toEqual([]); // just finished: the idle clock restarted
  });
});
