import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { SessionStore } from '../daemon/sessions.js';
import { sessionCloseVerb } from './session.js';

describe('session.close', () => {
  it('closes every tab of the session in the browser and removes the session', async () => {
    const cfg = loadConfig({ SCRAPER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 's-')) });
    const sessions = new SessionStore(cfg);
    const s = sessions.get('c', 's1');
    s.tabs.set('t1', 't1');
    s.tabs.set('t2', 't2');
    const closed: string[] = [];
    const released: string[] = [];
    const browser = { close: async (id: string) => void closed.push(id), closeSession: async (key: string) => void released.push(key) } as any;
    const ctx = { caller: 'c', cfg, sessions, browser };
    expect(await sessionCloseVerb(ctx, { session: 's1' })).toEqual({ closed: true });
    expect(closed.sort()).toEqual(['t1', 't2']);
    expect(released).toEqual(['c\u0000s1']); // the session's browser context (cookies, storage) is released too
    expect(sessions.list('c')).toEqual([]);
  });

  it('reports closed:false for an unknown session', async () => {
    const cfg = loadConfig({ SCRAPER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 's-')) });
    const ctx = { caller: 'c', cfg, sessions: new SessionStore(cfg), browser: { close: async () => {}, closeSession: async () => {} } as any };
    expect(await sessionCloseVerb(ctx, { session: 'nope' })).toEqual({ closed: false });
  });
});
