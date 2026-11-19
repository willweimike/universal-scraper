import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { ScraperWorld } from '../support/world.js';

Given('SCRAPER_BROWSER points to a missing path', function () {
  process.env.SCRAPER_BROWSER = '/nonexistent/chrome';
});

Then('the error code is {string} and the hint contains {string}', function (this: ScraperWorld, code: string, text: string) {
  assert.ok(this.error, `expected error ${code}, got ${JSON.stringify(this.result)?.slice(0, 200)}`);
  assert.equal(this.error.code, code, JSON.stringify(this.error));
  assert.ok(this.error.hint.includes(text), `hint was: ${this.error.hint}`);
});

Then('the fixture saw {int} requests to {string}', async function (this: ScraperWorld, n: number, path: string) {
  const res = await fetch(this.fixtureUrl(`${path}s`));
  assert.equal(Number(await res.text()), n);
});

When('I read {string} with mode {string}', async function (this: ScraperWorld, url: string, mode: string) {
  await this.call('read', { url, mode });
});
