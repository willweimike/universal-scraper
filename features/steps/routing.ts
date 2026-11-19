import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { callDaemon } from '../../src/daemon/client.js';
import { ScraperError } from '../../src/errors.js';
import type { ScraperWorld } from '../support/world.js';

Then('the engine is {string} and there is no escalation reason', function (this: ScraperWorld, engine: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.equal(this.result.engine, engine);
  assert.equal(this.result.escalatedBecause, undefined);
});

Then('the engine is {string} and the escalation reason is {string}', function (this: ScraperWorld, engine: string, reason: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.equal(this.result.engine, engine);
  assert.equal(this.result.escalatedBecause, reason);
});

Then('the error code is {string} and the hint is not empty', function (this: ScraperWorld, code: string) {
  assert.ok(this.error, `expected error ${code}`);
  assert.equal(this.error.code, code, JSON.stringify(this.error));
  assert.ok(this.error.hint.length > 0);
});

Then('no result contains {string}', function (this: ScraperWorld, text: string) {
  assert.ok(!JSON.stringify([this.result, this.error]).includes(text), `found "${text}" in the output`);
});

Given('the timeout is {int} ms', function (ms: number) {
  process.env.SCRAPER_TIMEOUT_MS = String(ms);
});

When(
  'caller {string} reads fixture {string} while caller {string} reads fixture {string}',
  async function (this: ScraperWorld, a: string, aPath: string, b: string, bPath: string) {
    await callDaemon('ping', {}); // warm the daemon so timing below excludes start-up
    const outcome = async (caller: string, path: string) => {
      const t0 = Date.now();
      try {
        return { result: (await callDaemon('read', { url: this.fixtureUrl(path) }, { caller })) as any, error: null, ms: Date.now() - t0 };
      } catch (e) {
        if (!(e instanceof ScraperError)) throw e;
        return { result: null, error: e.toShape(), ms: Date.now() - t0 };
      }
    };
    const [ra, rb] = await Promise.all([outcome(a, aPath), outcome(b, bPath)]);
    this.pair = { [a]: ra, [b]: rb };
  },
);

Then('caller {string} gets error {string} with recoverable true', function (this: ScraperWorld, caller: string, code: string) {
  const r = this.pair[caller];
  assert.ok(r.error, `caller ${caller} got no error`);
  assert.equal(r.error.code, code);
  assert.equal(r.error.recoverable, true);
});

Then('caller {string} gets the static page within {int} ms', function (this: ScraperWorld, caller: string, ms: number) {
  const r = this.pair[caller];
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.ok(r.result.markdown.includes('Welcome to the static article'));
  assert.ok(r.ms <= ms, `took ${r.ms} ms`);
});

When('I read fixture {string} interactively', async function (this: ScraperWorld, path: string) {
  await this.call('read', { url: this.fixtureUrl(path), interactive: true });
  if (this.result?.elements) {
    this.firstElements ??= this.result.elements;
    this.lastElements = this.result.elements;
  }
});

Then('the robots status is {string}', function (this: ScraperWorld, status: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.equal(this.result.robots, status);
});
