import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Session } from '../daemon/sessions.js';
import { ScraperError } from '../errors.js';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** `$SCRAPER_DATA/profiles/<caller>/<profile>`; profile names are restricted so they cannot escape the data dir. */
export function profileDirFor(cfg: Config, caller: string, profile: string): string {
  if (!NAME.test(profile)) {
    throw ScraperError.from('internal', `Invalid profile name "${profile}".`, 'Use 1-64 letters, digits, "-" or "_".', false);
  }
  return path.join(cfg.dataDir, 'profiles', caller.replace(/[^\w-]/g, '_'), profile);
}

/** Binds a named profile to the session once: the browser keeps its profile dir and the cookie jar persists beside it. */
export function bindProfile(cfg: Config, caller: string, session: Session, profile: string): void {
  if (session.profile) return;
  const dir = profileDirFor(cfg, caller, profile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  session.profile = profile;
  session.profileDir = dir;
  session.cookies.persistTo(path.join(dir, 'cookies.json'));
}
