import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { ScraperWorld } from '../support/world.js';

function handleOf(world: ScraperWorld, role: string, name: string): string {
  const el = world.lastElements.find((e) => e.role === role && e.name === name);
  assert.ok(el, `no ${role} "${name}" listed`);
  return el.handle;
}

When('I extract {string}', async function (this: ScraperWorld, kind: string) {
  await this.call('extract', { kind });
});

When('I extract {string} from the button {string}', async function (this: ScraperWorld, kind: string, name: string) {
  await this.call('extract', { kind, target: handleOf(this, 'button', name) });
});

When('I extract attribute {string} from the link {string}', async function (this: ScraperWorld, attr: string, name: string) {
  await this.call('extract', { kind: 'attr', attr, target: handleOf(this, 'link', name) });
});

function ok(world: ScraperWorld) {
  assert.equal(world.error, null, JSON.stringify(world.error));
  return world.result.data;
}

Then('the first table has headers {string} and {int} rows', function (this: ScraperWorld, headers: string, rows: number) {
  const t = ok(this)[0];
  assert.equal(t.headers.join(','), headers);
  assert.equal(t.rows.length, rows);
});

Then('the first list is {string}', function (this: ScraperWorld, items: string) {
  assert.equal(ok(this)[0].join(','), items);
});

Then('jsonLd contains a {string}', function (this: ScraperWorld, type: string) {
  assert.ok(ok(this).jsonLd.some((o: any) => o['@type'] === type), JSON.stringify(this.result.data.jsonLd));
});

Then('the extracted links include {string} ending in {string}', function (this: ScraperWorld, text: string, end: string) {
  const link = ok(this).find((l: any) => l.text === text);
  assert.ok(link, `no link ${text}`);
  assert.ok(link.href.endsWith(end), link.href);
});

Then('the data is {string}', function (this: ScraperWorld, text: string) {
  assert.equal(ok(this), text);
});

Then('the data ends with {string}', function (this: ScraperWorld, end: string) {
  assert.ok(String(ok(this)).endsWith(end), String(this.result.data));
});
