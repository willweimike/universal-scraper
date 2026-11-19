import path from 'node:path';
import type { Config } from '../config.js';

export const socketPath = (cfg: Config): string => path.join(cfg.runtimeDir, 'scraperd.sock');
export const lockPath = (cfg: Config): string => path.join(cfg.runtimeDir, 'scraperd.lock');
export const pidPath = (cfg: Config): string => path.join(cfg.runtimeDir, 'scraperd.pid');
