import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { profileDirFor } from './profiles.js';

describe('profileDirFor', () => {
  const cfg = loadConfig({ SCRAPER_DATA: '/data' });
  it('places a profile under the data dir, namespaced by caller', () => {
    expect(profileDirFor(cfg, 'mcp-1', 'work')).toBe(path.join('/data', 'profiles', 'mcp-1', 'work'));
  });
  it('rejects names that could escape the data dir', () => {
    for (const bad of ['../x', 'a/b', '', '.', '..', 'x'.repeat(65)]) {
      expect(() => profileDirFor(cfg, 'c', bad)).toThrow();
    }
  });
  it('sanitises the caller segment', () => {
    expect(profileDirFor(cfg, '../evil', 'p')).toBe(path.join('/data', 'profiles', '___evil', 'p'));
  });
});
