import fs from 'node:fs';
import { ScraperError } from '../errors.js';

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // exists but belongs to someone else
  }
}

export interface Lock {
  /** Removes the lock file, but only if it still names this process. */
  release(): void;
}

/** An exclusive pid lock held for the daemon's life: the only place a start-up race is decided. */
export function acquireLock(file: string): Lock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        release() {
          try {
            if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file, { force: true });
          } catch {
            // already gone
          }
        },
      };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      let owner = 0;
      try {
        owner = Number(fs.readFileSync(file, 'utf8'));
      } catch {
        // unreadable: treat as stale
      }
      if (alive(owner)) throw new Error('daemon already running');
      fs.rmSync(file, { force: true }); // stale: its owner is dead
    }
  }
  throw new Error('daemon already running');
}

/** The runtime directory holds the control socket, so it must be ours alone: owned by this user, mode 0700, not a symlink. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  const mine = process.getuid === undefined || st.uid === process.getuid();
  if (!st.isDirectory() || st.isSymbolicLink() || !mine || (st.mode & 0o077) !== 0) {
    throw ScraperError.from(
      'internal',
      `The runtime directory ${dir} is not private: it must be a real directory owned by you with mode 700.`,
      'Set SCRAPER_RUNTIME_DIR to a directory only you can access.',
      false,
    );
  }
}
