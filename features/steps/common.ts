import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { ScraperWorld } from '../support/world.js';

When('I fetch fixture {string} directly', async function (this: ScraperWorld, path: string) {
  const res = await fetch(this.fixtureUrl(path));
  this.lastFetch = { status: res.status, body: await res.text() };
});

Then('the status is {int}', function (this: ScraperWorld, status: number) {
  assert.equal(this.lastFetch?.status, status);
});

Then('the body contains {string}', function (this: ScraperWorld, text: string) {
  assert.ok(this.lastFetch?.body.includes(text), `body did not contain "${text}"`);
});

Then('the error code is {string}', function (this: ScraperWorld, code: string) {
  assert.ok(this.error, `expected error ${code} but got result ${JSON.stringify(this.result)?.slice(0, 300)}`);
  assert.equal(this.error.code, code, JSON.stringify(this.error));
});
