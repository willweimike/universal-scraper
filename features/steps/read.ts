import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Given, Then, When } from '@cucumber/cucumber';
import { fixtureState, type ScraperWorld } from '../support/world.js';

async function read(world: ScraperWorld, params: Record<string, unknown>) {
  await world.call('read', params);
}

Given('private hosts are not allowed', function () {
  delete process.env.SCRAPER_ALLOW_HOSTS;
});

Given('only the fixture host is allowed', function () {
  process.env.SCRAPER_ALLOW_HOSTS = `127.0.0.1:${fixtureState.port}`;
});

When('I read fixture {string}', async function (this: ScraperWorld, path: string) {
  await read(this, { url: this.fixtureUrl(path) });
});

When('I read fixture {string} with mode {string}', async function (this: ScraperWorld, path: string, mode: string) {
  await read(this, { url: this.fixtureUrl(path), mode });
});

When('I read fixture {string} with maxChars {int}', async function (this: ScraperWorld, path: string, maxChars: number) {
  await read(this, { url: this.fixtureUrl(path), maxChars });
});

When('I read {string}', async function (this: ScraperWorld, url: string) {
  await read(this, { url });
});

When(
  'I read fixture {string} with method {string}, header {string} and body {string}',
  async function (this: ScraperWorld, path: string, method: string, header: string, body: string) {
    const i = header.indexOf(': ');
    await read(this, { url: this.fixtureUrl(path), method, headers: { [header.slice(0, i)]: header.slice(i + 2) }, body });
  },
);

When('I read again with that cursor', async function (this: ScraperWorld) {
  this.firstChunk = this.result.markdown;
  await read(this, { cursor: this.result.truncated.cursor });
});

function ok(world: ScraperWorld) {
  assert.equal(world.error, null, JSON.stringify(world.error));
  return world.result;
}

Then('the page title is {string}', function (this: ScraperWorld, title: string) {
  assert.equal(ok(this).title, title);
});

Then('the markdown contains {string}', function (this: ScraperWorld, text: string) {
  assert.ok(ok(this).markdown?.includes(text), `markdown missing "${text}": ${this.result.markdown?.slice(0, 300)}`);
});

Then('the engine is {string}', function (this: ScraperWorld, engine: string) {
  assert.equal(ok(this).engine, engine);
});

Then('the links include {string} pointing to {string}', function (this: ScraperWorld, text: string, href: string) {
  const link = ok(this).links.find((l: any) => l.text === text);
  assert.ok(link, `no link "${text}" in ${JSON.stringify(this.result.links)}`);
  assert.ok(link.href.endsWith(href), link.href);
});

Then('the markdown starts with {string} and ends with {string}', function (this: ScraperWorld, start: string, end: string) {
  const md: string = ok(this).markdown;
  assert.ok(md.startsWith(start), md.slice(0, 80));
  assert.ok(md.endsWith(end), md.slice(-80));
});

Then('the string {string} appears exactly once in the markdown', function (this: ScraperWorld, s: string) {
  assert.equal(ok(this).markdown.split(s).length - 1, 1);
});

Then(
  'the body field {string} is {string} and {string} is {string} and {string} is {string}',
  function (this: ScraperWorld, p1: string, v1: string, p2: string, v2: string, p3: string, v3: string) {
    const body = ok(this).body;
    const get = (path: string) => path.split('.').reduce((o: any, k) => o?.[k], body);
    assert.equal(get(p1), v1);
    assert.equal(get(p2), v2);
    assert.equal(get(p3), v3);
  },
);

Then('the saved file has size {int} and there is no markdown', function (this: ScraperWorld, size: number) {
  const r = ok(this);
  assert.equal(r.markdown, undefined);
  assert.equal(fs.statSync(r.savedPath).size, size);
});

Then('the markdown length is at most {int} and a cursor is returned', function (this: ScraperWorld, max: number) {
  const r = ok(this);
  assert.ok(r.markdown.length <= max, `length ${r.markdown.length}`);
  assert.ok(r.truncated?.cursor, 'no cursor');
});

Then('the next chunk does not repeat the first chunk', function (this: ScraperWorld) {
  const next: string = ok(this).markdown;
  const probe = (this.firstChunk as string).split('\n').find((l) => l.startsWith('Paragraph 0'))!;
  assert.ok(probe, 'first chunk should contain Paragraph 0');
  assert.ok(!next.includes(probe), 'second chunk repeats the start of the first');
});
