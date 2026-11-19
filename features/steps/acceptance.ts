import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Then, When } from '@cucumber/cucumber';
import type { ScraperWorld } from '../support/world.js';

const textOf = (r: any): string => (r.content as { text: string }[]).map((c) => c.text).join('\n');

async function tool(world: ScraperWorld, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  // The first browser use in a bare container downloads the browser and its libraries, which takes minutes.
  const r: any = await world.mcp!.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  return { text: textOf(r), isError: r.isError === true };
}

/** Reads a handle out of the compact element list the agent sees, e.g. `e3  button  "Add"`. */
function handleIn(text: string, role: string, name: string): string {
  const m = new RegExp(`^(e\\d+)  ${role}  "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm').exec(text);
  assert.ok(m, `no ${role} "${name}" in:\n${text.slice(-600)}`);
  return m[1];
}

Then('{string} and {string} are not on PATH', function (a: string, b: string) {
  for (const bin of [a, b]) {
    assert.notEqual(spawnSync('sh', ['-c', `command -v ${bin}`]).status, 0, `${bin} is installed`);
  }
});

When('the agent calls web_read on {string} and on {string}', { timeout: 600_000 }, async function (this: ScraperWorld, p1: string, p2: string) {
  this.acc = [(await tool(this, 'web_read', { url: this.fixtureUrl(p1) })).text, (await tool(this, 'web_read', { url: this.fixtureUrl(p2) })).text];
});

Then('both return their content', function (this: ScraperWorld) {
  assert.ok(this.acc[0].includes('Welcome to the static article'), this.acc[0].slice(0, 300));
  assert.ok(this.acc[1].includes('SPA Loaded'), this.acc[1].slice(0, 300));
  assert.ok(this.acc[1].includes('escalated: empty_spa_shell'), 'the SPA should have been escalated to the browser');
});

When('the agent logs in via {string}, clicks {string} and calls web_extract {string}', { timeout: 600_000 }, async function (this: ScraperWorld, login: string, link: string, kind: string) {
  const page = await tool(this, 'web_read', { url: this.fixtureUrl(login), interactive: true });
  assert.ok(!page.isError, page.text);
  const signedIn = await tool(this, 'web_act', {
    steps: [
      { do: 'type', target: handleIn(page.text, 'textbox', 'Username'), text: 'demo' },
      { do: 'type', target: handleIn(page.text, 'textbox', 'Password'), text: 'secret' },
      { do: 'click', target: handleIn(page.text, 'button', 'Sign in') },
    ],
  });
  assert.ok(signedIn.text.includes('Welcome demo'), signedIn.text.slice(0, 400));
  const next = await tool(this, 'web_act', { steps: [{ do: 'click', target: handleIn(signedIn.text, 'link', link) }] });
  assert.ok(!next.isError, next.text);
  this.acc = [(await tool(this, 'web_extract', { kind })).text];
});

Then('it receives table rows as JSON', function (this: ScraperWorld) {
  // web_extract output is fenced as untrusted page data: unwrap it before parsing
  const inner = /<web_content untrusted>\n([\s\S]*)\n<\/web_content>/.exec(this.acc[0]);
  assert.ok(inner, `extract output is not fenced: ${this.acc[0].slice(0, 200)}`);
  const tables = JSON.parse(inner[1]);
  assert.equal(tables[0].rows.length, 3);
  assert.ok(JSON.stringify(tables[0].rows).includes('Delta'), 'page 2 rows expected after clicking Next');
});

When('the agent opens {string}, clicks {string} and then {string}', { timeout: 600_000 }, async function (this: ScraperWorld, path: string, first: string, second: string) {
  const page = await tool(this, 'web_read', { url: this.fixtureUrl(path), interactive: true });
  const earlier = handleIn(page.text, 'button', second); // captured before the re-render
  const refreshed = await tool(this, 'web_act', { steps: [{ do: 'click', target: handleIn(page.text, 'button', first) }] });
  assert.ok(!refreshed.isError, refreshed.text);
  this.acc = [(await tool(this, 'web_act', { steps: [{ do: 'click', target: earlier }] })).text, refreshed.text];
});

Then('the item is removed', function (this: ScraperWorld) {
  assert.ok(!this.acc[0].startsWith('Error'), this.acc[0]);
  assert.ok(this.acc[1].includes('re-bound'), 'the Refresh result should say the old handle was re-bound to its replacement');
  assert.ok(!this.acc[0].includes('Item B'), 'Item B should be gone');
});

When('the agent calls web_read on {string} with POST, a header and a body', { timeout: 600_000 }, async function (this: ScraperWorld, path: string) {
  this.acc = [(await tool(this, 'web_read', { url: this.fixtureUrl(path), method: 'POST', headers: { 'x-test': '1' }, body: '{"a":1}' })).text];
});

Then('the echoed method, header and body match', function (this: ScraperWorld) {
  const t = this.acc[0];
  assert.ok(t.includes('"method": "POST"'), t);
  assert.ok(t.includes('"x-test": "1"'), t);
  assert.ok(t.includes('{\\"a\\":1}') || t.includes('"body": "{'), t);
});

When('the agent calls web_read on {string}', { timeout: 600_000 }, async function (this: ScraperWorld, path: string) {
  const r = await tool(this, 'web_read', { url: this.fixtureUrl(path) });
  this.acc = [r.text, String(r.isError)];
});

Then('it receives {string} with a hint and no challenge text as content', function (this: ScraperWorld, code: string) {
  assert.equal(this.acc[1], 'true', 'expected an error result');
  assert.ok(this.acc[0].includes(code), this.acc[0]);
  assert.ok(/Hint: \S/.test(this.acc[0]), this.acc[0]);
  assert.ok(!this.acc[0].includes('Checking your browser'), 'challenge text leaked into the result');
});
