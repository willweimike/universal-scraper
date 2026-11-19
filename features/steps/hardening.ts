import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { fixtureState, type ScraperWorld } from '../support/world.js';

Given('the hosts {string} and {string} are allowed', function (a: string, b: string) {
  process.env.SCRAPER_ALLOW_HOSTS = `${a}:${fixtureState.port},${b}:${fixtureState.port}`;
});

When('I read fixture {string} with header {string}', async function (this: ScraperWorld, path: string, header: string) {
  const i = header.indexOf(': ');
  await this.call('read', { url: this.fixtureUrl(path), headers: { [header.slice(0, i)]: header.slice(i + 2) } });
});

When('I read fixture {string} with method {string}', async function (this: ScraperWorld, path: string, method: string) {
  await this.call('read', { url: this.fixtureUrl(path), method });
});

When('I read fixture {string} with wait selector {string}', async function (this: ScraperWorld, path: string, selector: string) {
  await this.call('read', { url: this.fixtureUrl(path), wait: { selector } });
});

Then('the body field {string} is true', function (this: ScraperWorld, field: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.equal(this.result.body?.[field], true, JSON.stringify(this.result.body)?.slice(0, 200));
});

Then('the response is flagged as cut off', function (this: ScraperWorld) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.equal(this.result.bodyTruncated, true);
});

Then('the echoed request has no authorization header', function (this: ScraperWorld) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.ok(this.result.body?.headers, `no echo: ${JSON.stringify(this.result).slice(0, 200)}`);
  assert.equal(this.result.body.headers.authorization, undefined);
});

Then('the error code is {string} and the message contains {string}', function (this: ScraperWorld, code: string, text: string) {
  assert.ok(this.error, 'expected an error');
  assert.equal(this.error.code, code, JSON.stringify(this.error));
  assert.ok(this.error.message.includes(text), this.error.message);
});

Then('a cursor is returned and there is no parsed body', function (this: ScraperWorld) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.ok(this.result.truncated?.cursor, 'no cursor');
  assert.equal(this.result.body, undefined);
});

Then('the markdown has no replacement characters', function (this: ScraperWorld) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.ok(this.result.markdown.includes('日本語のテキスト'));
  assert.ok(!this.result.markdown.includes('�'), 'found U+FFFD');
});
