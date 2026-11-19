import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { ScraperError } from '../errors.js';
import type { HandleTable } from '../handles.js';
import { CookieJar } from '../session/cookies.js';

export interface Session {
  name: string;
  owner: string;
  lastUsed: number;
  /** Number of exclusive calls currently running on this session. */
  busy: number;
  /** Tail of the promise chain that serialises calls touching this session's tab. */
  chain: Promise<void>;
  shared: boolean;
  tabs: Map<string, string>;
  activeTab?: string;
  lastHtml?: string;
  lastUrl?: string;
  profile?: string;
  profileDir?: string;
  cookies: CookieJar;
  /** Handle tables per tab id. */
  handles: Map<string, HandleTable>;
  cursors: Map<string, { markdown: string; expires: number; view: any }>;
  // Later tasks add: handles (Task 7).
  [key: string]: unknown;
}

type Registry = Record<string, string[]>;

/** Runs `fn` after every earlier exclusive task on this session has finished; a failure does not block later tasks. */
export function runExclusive<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  session.busy++;
  const tracked = async () => {
    try {
      return await fn();
    } finally {
      session.busy--;
      session.lastUsed = Date.now();
    }
  };
  const run = session.chain.then(tracked, tracked);
  session.chain = run.then(() => undefined, () => undefined);
  return run;
}

/** Sessions are namespaced per caller; a session created with share:true is addressable by any caller. */
export class SessionStore {
  private live = new Map<string, Session>();
  private known: Registry = {};
  private registryFile: string;

  constructor(private cfg: Config) {
    this.registryFile = path.join(cfg.dataDir, 'sessions.json');
    try {
      this.known = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
    } catch {
      this.known = {};
    }
  }

  private key(caller: string, name: string): string {
    return `${caller}\u0000${name}`;
  }

  /** The caller's own session, or (only when it asks to share) another caller's shared session of that name. */
  private find(caller: string, name: string, allowShared: boolean): Session | undefined {
    const own = this.live.get(this.key(caller, name));
    if (own) return own;
    if (allowShared) for (const s of this.live.values()) if (s.shared && s.name === name) return s;
    return undefined;
  }

  /**
   * Returns the live session or creates it. A session that existed before a daemon restart throws session_expired
   * (its tab and handles are gone), unless the call does not depend on earlier state (`forgive`).
   */
  get(caller: string, name: string, opts: { share?: boolean; forgive?: boolean } = {}): Session {
    const existing = this.find(caller, name, opts.share === true);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (this.known[caller]?.includes(name)) {
      this.known[caller] = this.known[caller].filter((n) => n !== name);
      this.persist();
      if (!opts.forgive) {
        throw ScraperError.from(
          'session_expired',
          `Session "${name}" ended when the daemon restarted.`,
          'Open it again with read (interactive: true if you need to act); old handles are gone.',
          true,
        );
      }
    }
    const session: Session = {
      name, owner: caller, shared: opts.share === true, lastUsed: Date.now(), busy: 0, chain: Promise.resolve(),
      tabs: new Map(), cursors: new Map(), cookies: new CookieJar(), handles: new Map(),
    };
    this.live.set(this.key(caller, name), session);
    (this.known[caller] ??= []).push(name);
    this.persist();
    return session;
  }

  /** Looks up a live session without creating it. */
  peek(caller: string, name: string): Session | undefined {
    return this.find(caller, name, false);
  }

  list(caller: string): string[] {
    const names: string[] = [];
    for (const s of this.live.values()) if (s.owner === caller || s.shared) names.push(s.name);
    return names;
  }

  close(caller: string, name: string): boolean {
    const s = this.find(caller, name, false);
    if (!s) return false;
    this.live.delete(this.key(s.owner, s.name));
    this.known[s.owner] = (this.known[s.owner] ?? []).filter((n) => n !== name);
    this.persist();
    return true;
  }

  /** Drops expired cursors everywhere, and closes the tabs and drops the cached page of sessions idle beyond `ttlMs`. */
  async sweep(now: number, ttlMs: number, closeTab: (tabId: string) => Promise<void>): Promise<void> {
    for (const s of this.live.values()) {
      for (const [id, c] of s.cursors) if (c.expires < now) s.cursors.delete(id);
      if (s.busy > 0 || now - s.lastUsed <= ttlMs) continue;
      for (const id of [...s.tabs.keys()]) {
        await closeTab(id).catch(() => {});
        s.tabs.delete(id);
        s.handles.delete(id);
      }
      s.activeTab = undefined;
      s.lastHtml = undefined;
      s.lastUrl = undefined;
      s.cursors.clear();
    }
  }

  hasOpenTabs(): boolean {
    for (const s of this.live.values()) if (s.tabs.size > 0) return true;
    return false;
  }

  private persist(): void {
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    fs.writeFileSync(this.registryFile, JSON.stringify(this.known));
  }
}
