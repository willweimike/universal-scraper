import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { Given, Then, When } from '@cucumber/cucumber';
import { loadConfig } from '../../src/config.js';
import { pidPath, socketPath } from '../../src/daemon/paths.js';
import type { ScraperWorld } from '../support/world.js';

Given('no daemon is running', function () {
  assert.equal(fs.existsSync(socketPath(loadConfig())), false);
});

When('I call {string}', async function (this: ScraperWorld, verb: string) {
  await this.call(verb as any, {});
});

Then('the result field {string} is true', function (this: ScraperWorld, field: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.equal(this.result[field], true);
});

Then('a daemon process is running', function () {
  const pid = Number(fs.readFileSync(pidPath(loadConfig()), 'utf8'));
  process.kill(pid, 0); // throws if the process does not exist
});

Given('a stale socket file and pid file from a dead daemon', function () {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.runtimeDir, { recursive: true, mode: 0o700 });
  const sock = socketPath(cfg);
  // A child binds the socket then SIGKILLs itself, leaving the socket file behind like a crashed daemon.
  const r = spawnSync(process.execPath, ['-e', `
    const net=require('net');
    net.createServer().listen(${JSON.stringify(sock)},()=>{
      require('fs').writeFileSync(${JSON.stringify(pidPath(cfg))}, String(process.pid));
      process.kill(process.pid,'SIGKILL');
    });`]);
  assert.ok(fs.existsSync(sock), `stale socket was not left behind (status ${r.status})`);
  assert.ok(fs.existsSync(pidPath(cfg)));
});

Given('caller {string} has an open session {string}', async function (this: ScraperWorld, caller: string, session: string) {
  await this.call('ping', { session }, caller);
  assert.equal(this.error, null);
});

Given('caller {string} has an open shared session {string}', async function (this: ScraperWorld, caller: string, session: string) {
  await this.call('ping', { session, share: true }, caller);
  assert.equal(this.error, null);
});

When('caller {string} calls {string}', async function (this: ScraperWorld, caller: string, verb: string) {
  await this.call(verb as any, {}, caller);
});

Then('the session list is empty', function (this: ScraperWorld) {
  assert.deepEqual(this.result.sessions, []);
});

Then('the session list contains {string}', function (this: ScraperWorld, name: string) {
  assert.ok(this.result.sessions.includes(name), JSON.stringify(this.result));
});

Given('the idle timeout is {int} ms and caller {string} had session {string}', async function (this: ScraperWorld, ms: number, caller: string, session: string) {
  process.env.SCRAPER_IDLE_MS = String(ms);
  await this.call('ping', { session }, caller);
  assert.equal(this.error, null);
});

When('I wait {int} ms and caller {string} reads with session {string}', async function (this: ScraperWorld, ms: number, caller: string, session: string) {
  await new Promise((r) => setTimeout(r, ms));
  await this.call('read', { url: this.fixtureUrl('/static'), session }, caller);
});

