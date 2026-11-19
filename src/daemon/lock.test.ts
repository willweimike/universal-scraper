import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, ensurePrivateDir } from './lock.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 's-'));

describe('acquireLock', () => {
  it('refuses a second holder while the first process is alive', () => {
    const file = path.join(tmp(), 'l');
    const first = acquireLock(file);
    expect(() => acquireLock(file)).toThrow('daemon already running');
    first.release();
  });

  it('takes over a lock whose owner is dead', () => {
    const file = path.join(tmp(), 'l');
    const dead = spawnSync(process.execPath, ['-e', '0']);
    expect(dead.status).toBe(0);
    fs.writeFileSync(file, String(999_999_999)); // a pid that cannot exist
    const lock = acquireLock(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(String(process.pid));
    lock.release();
  });

  it('removes only its own lock on release', () => {
    const file = path.join(tmp(), 'l');
    const lock = acquireLock(file);
    fs.writeFileSync(file, '12345'); // someone else owns it now
    lock.release();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('ensurePrivateDir', () => {
  it('creates a private directory', () => {
    const dir = path.join(tmp(), 'r');
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
  it('refuses a directory others can write to', () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o777);
    expect(() => ensurePrivateDir(dir)).toThrow(/private/);
  });
  it('refuses a symlink', () => {
    const real = tmp();
    const link = path.join(tmp(), 'link');
    fs.symlinkSync(real, link);
    expect(() => ensurePrivateDir(link)).toThrow(/private/);
  });
});
