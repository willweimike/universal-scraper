import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { callDaemon } from '../../src/daemon/client.js';
import type { ScraperWorld } from '../support/world.js';

Given('the tab time to live is {int} ms', function (ms: number) {
  process.env.SCRAPER_TAB_TTL_MS = String(ms);
});

When('I wait {int} ms and caller {string} acts with session {string}', async function (this: ScraperWorld, ms: number, caller: string, session: string) {
  await new Promise((r) => setTimeout(r, ms));
  await this.call('act', { session, steps: [{ do: 'click', target: 'e1' }] }, caller);
});

Then('there is no tab in the result', function (this: ScraperWorld) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.equal(this.result.tab, undefined);
});

async function pair(world: ScraperWorld, a: object, b: object) {
  await callDaemon('ping', {}); // warm the daemon
  world.parallel = (await Promise.all([callDaemon('read', a), callDaemon('read', b)])) as any[];
}

When('I read {string} and {string} in the browser at the same time', async function (this: ScraperWorld, p1: string, p2: string) {
  await pair(this, { url: this.fixtureUrl(p1), mode: 'browser' }, { url: this.fixtureUrl(p2), mode: 'browser' });
});

When('I read {string} and {string} interactively at the same time', async function (this: ScraperWorld, p1: string, p2: string) {
  await pair(this, { url: this.fixtureUrl(p1), interactive: true }, { url: this.fixtureUrl(p2), interactive: true });
});

Then('each result shows its own page', function (this: ScraperWorld) {
  const [first, second] = this.parallel;
  const marks = ['SPA Loaded', 'Item A', 'Welcome to the static article'];
  const want = (v: any, expected: string[]) => expected.some((m) => v.markdown.includes(m));
  // the pair is (spa|list, static): the first must show its own marker, the second the static article
  assert.ok(want(first, ['SPA Loaded', 'Item A']), `first result: ${first.markdown.slice(0, 200)}`);
  assert.ok(second.markdown.includes('Welcome to the static article'), `second result: ${second.markdown.slice(0, 200)}`);
  void marks;
});

When('{int} callers ping at once', async function (this: ScraperWorld, n: number) {
  this.parallel = (await Promise.all(Array.from({ length: n }, (_, i) => callDaemon('ping', {}, { caller: `p${i}` })))) as any[];
});

Then('they all reached the same daemon', function (this: ScraperWorld) {
  assert.equal(new Set(this.parallel.map((r: any) => r.pid)).size, 1, JSON.stringify(this.parallel));
});
