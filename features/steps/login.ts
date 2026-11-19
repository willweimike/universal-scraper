import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { loadConfig } from '../../src/config.js';
import { stopDaemon } from '../../src/daemon/client.js';
import type { ScraperWorld } from '../support/world.js';

function handleOf(world: ScraperWorld, role: string, name: string): string {
  const el = world.lastElements.find((e) => e.role === role && e.name === name);
  assert.ok(el, `no ${role} "${name}" in ${JSON.stringify(world.lastElements.map((e) => `${e.role}:${e.name}`))}`);
  return el.handle;
}

async function act(world: ScraperWorld, steps: object[]) {
  await world.call('act', { steps });
  if (world.result?.elements) world.lastElements = world.result.elements;
}

async function loginInBrowser(world: ScraperWorld, profile?: string) {
  await world.call('read', { url: world.fixtureUrl('/login'), interactive: true, ...(profile ? { profile } : {}) });
  assert.equal(world.error, null, JSON.stringify(world.error));
  world.lastElements = world.result.elements;
  await act(world, [
    { do: 'type', target: handleOf(world, 'textbox', 'Username'), text: 'demo' },
    { do: 'type', target: handleOf(world, 'textbox', 'Password'), text: 'secret' },
    { do: 'click', target: handleOf(world, 'button', 'Sign in') },
  ]);
  assert.equal(world.error, null, JSON.stringify(world.error));
  assert.ok(world.result.markdown.includes('Welcome demo'), 'login did not reach the dashboard');
}

When(
  'I type {string} into the textbox {string} and {string} into the textbox {string}',
  async function (this: ScraperWorld, t1: string, n1: string, t2: string, n2: string) {
    await act(this, [
      { do: 'type', target: handleOf(this, 'textbox', n1), text: t1 },
      { do: 'type', target: handleOf(this, 'textbox', n2), text: t2 },
    ]);
  },
);

When('I act {string} on the link {string}', async function (this: ScraperWorld, action: string, name: string) {
  await act(this, [{ do: action, target: handleOf(this, 'link', name) }]);
});

Given('I logged in with profile {string}', async function (this: ScraperWorld, profile: string) {
  await loginInBrowser(this, profile);
});

Given('I logged in without a profile', async function (this: ScraperWorld) {
  await loginInBrowser(this);
});

Given('I logged in over HTTP with profile {string}', async function (this: ScraperWorld, profile: string) {
  await this.call('read', {
    url: this.fixtureUrl('/login'),
    mode: 'http',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'user=demo&pass=secret',
    profile,
  });
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.ok(this.result.markdown.includes('Welcome demo'));
});

When('the daemon is restarted', async function () {
  await stopDaemon(loadConfig());
});

When('I read fixture {string} interactively with profile {string}', async function (this: ScraperWorld, path: string, profile: string) {
  await this.call('read', { url: this.fixtureUrl(path), interactive: true, profile });
});

When('I read fixture {string} with mode {string} and profile {string}', async function (this: ScraperWorld, path: string, mode: string, profile: string) {
  await this.call('read', { url: this.fixtureUrl(path), mode, profile });
});

Then('the error code is {string} and recoverable is true', function (this: ScraperWorld, code: string) {
  assert.ok(this.error, `expected error ${code}, got ${JSON.stringify(this.result)?.slice(0, 200)}`);
  assert.equal(this.error.code, code, JSON.stringify(this.error));
  assert.equal(this.error.recoverable, true);
});

When('I act select {string} on the field {string}', async function (this: ScraperWorld, value: string, name: string) {
  const el = this.lastElements.find((e) => e.name === name);
  assert.ok(el, `no field "${name}" listed`);
  await act(this, [{ do: 'select', target: el.handle, value }]);
});

When('I act scroll by {int}', async function (this: ScraperWorld, by: number) {
  await act(this, [{ do: 'scroll', by }]);
});

Then('the first table has {int} rows and includes {string}', function (this: ScraperWorld, rows: number, text: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  const t = this.result.data[0];
  assert.equal(t.rows.length, rows);
  assert.ok(JSON.stringify(t.rows).includes(text), JSON.stringify(t.rows));
});
