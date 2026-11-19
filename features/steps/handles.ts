import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { ScraperWorld } from '../support/world.js';

function find(list: any[], role: string, name: string) {
  const el = list.find((e) => e.role === role && e.name === name);
  assert.ok(el, `no ${role} "${name}" in ${JSON.stringify(list.map((e) => `${e.handle}:${e.role}:${e.name}`))}`);
  return el;
}

async function act(world: ScraperWorld, steps: object[], session?: string) {
  await world.call('act', { steps, ...(session ? { session } : {}) });
  if (world.result?.elements) world.lastElements = world.result.elements;
}

Then('the elements include a button {string} and a button {string}', function (this: ScraperWorld, a: string, b: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  find(this.result.elements, 'button', a);
  find(this.result.elements, 'button', b);
});

Then('the elements include a link {string}', function (this: ScraperWorld, name: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  find(this.result.elements, 'link', name);
});

When('I act {string} on the button {string}', async function (this: ScraperWorld, action: string, name: string) {
  this.targetHandle = find(this.lastElements, 'button', name).handle;
  await act(this, [{ do: action, target: this.targetHandle }]);
});

When('I act {string} on the earlier handle of button {string}', async function (this: ScraperWorld, action: string, name: string) {
  this.targetHandle = find(this.firstElements!, 'button', name).handle;
  await act(this, [{ do: action, target: this.targetHandle }]);
});

When('I act goto fixture {string}', async function (this: ScraperWorld, path: string) {
  await act(this, [{ do: 'goto', url: this.fixtureUrl(path) }]);
});

When('I act {string} the key {string}', async function (this: ScraperWorld, _action: string, key: string) {
  await act(this, [{ do: 'press', key }]);
});

When('I act wait for selector {string}', async function (this: ScraperWorld, selector: string) {
  await act(this, [{ do: 'wait', for: { selector } }]);
});

Given('a fresh session {string} with only an HTTP read', async function (this: ScraperWorld, session: string) {
  await this.call('read', { url: this.fixtureUrl('/static'), mode: 'http', session });
  assert.equal(this.error, null, JSON.stringify(this.error));
});

When('I act {string} on {string} in session {string}', async function (this: ScraperWorld, action: string, handle: string, session: string) {
  await act(this, [{ do: action, target: handle }], session);
});

Then('the click succeeds', function (this: ScraperWorld) {
  assert.equal(this.error, null, JSON.stringify(this.error));
});

Then('the result re-binds the earlier handle of button {string}', function (this: ScraperWorld, name: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  const earlier = find(this.firstElements!, 'button', name).handle;
  assert.ok(this.result.remapped?.includes(earlier), `remapped: ${JSON.stringify(this.result.remapped)}, wanted ${earlier}`);
});

Then('the markdown does not contain {string}', function (this: ScraperWorld, text: string) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  assert.ok(!this.result.markdown.includes(text), `markdown still contains "${text}"`);
});

Then('the error code is {string} and it lists {int} candidates', function (this: ScraperWorld, code: string, n: number) {
  assert.ok(this.error, 'expected an error');
  assert.equal(this.error.code, code, JSON.stringify(this.error));
  assert.equal(this.error.candidates?.length, n);
});

Then('every new element handle is higher than all earlier handles', function (this: ScraperWorld) {
  assert.equal(this.error, null, JSON.stringify(this.error));
  const num = (h: string) => Number(h.slice(1));
  const earlier = Math.max(...this.firstElements!.map((e: any) => num(e.handle)));
  const fresh = this.result.elements.filter((e: any) => e.state === 'new');
  assert.ok(fresh.length > 0, 'expected at least one new element');
  for (const e of fresh) assert.ok(num(e.handle) > earlier, `${e.handle} <= e${earlier}`);
});

Given('the idle timeout is {int} ms', function (ms: number) {
  process.env.SCRAPER_IDLE_MS = String(ms);
});

When('I wait {int} ms', async function (ms: number) {
  await new Promise((r) => setTimeout(r, ms));
});

When('I act click on the first button', async function (this: ScraperWorld) {
  const el = this.lastElements.find((e) => e.role === 'button');
  assert.ok(el, 'no button listed');
  await act(this, [{ do: 'click', target: el.handle }]);
});
