import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Then, When } from '@cucumber/cucumber';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ScraperWorld } from '../support/world.js';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

Then('{string} is valid JSON with a name and version', function (file: string) {
  const j = JSON.parse(read(file));
  assert.match(j.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'name must be kebab-case');
  assert.equal(typeof j.version, 'string');
  assert.ok(j.description, 'description missing');
});

Then('{string} declares a server that uses {string}', function (file: string, needle: string) {
  const servers = JSON.parse(read(file)).mcpServers;
  assert.ok(servers && Object.keys(servers).length > 0, 'no mcpServers');
  const uses = Object.values<any>(servers).some((s) => [s.command, ...(s.args ?? [])].some((a: string) => a.includes(needle)));
  assert.ok(uses, `no server uses ${needle}`);
});

When('I spawn the command from {string} and list tools over stdio', async function (this: ScraperWorld, file: string) {
  const server = Object.values<any>(JSON.parse(read(file)).mcpServers)[0];
  const pluginRoot = path.join(root, 'plugin');
  const sub = (s: string) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  const transport = new StdioClientTransport({
    command: sub(server.command),
    args: (server.args ?? []).map(sub),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot } as Record<string, string>,
    stderr: 'ignore',
  });
  this.mcp = new Client({ name: 'bdd', version: '0.0.0' });
  await this.mcp.connect(transport);
  this.mcpTools = (await this.mcp.listTools()).tools.map((t) => t.name);
});

Then('the tools include {string}', function (this: ScraperWorld, tool: string) {
  assert.ok(this.mcpTools.includes(tool), `missing ${tool} in ${this.mcpTools}`);
});

When('I run the plugin command {string}', async function (this: ScraperWorld, cmd: string) {
  const [bin, ...args] = cmd.split(' ');
  this.cli = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, bin), args, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
});

Then('{string} has frontmatter name {string} and mentions {string}, {string}, {string} and {string}', function (file: string, name: string, a: string, b: string, c: string, d: string) {
  const text = read(file);
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fm, 'no frontmatter on line 1');
  assert.match(fm[1], new RegExp(`^name:\\s*${name}\\s*$`, 'm'));
  assert.match(fm[1], /^description:\s*\S/m);
  for (const word of [a, b, c, d]) assert.ok(text.includes(word), `SKILL.md does not mention "${word}"`);
});

let rebuilt = '';
When('I rebuild the plugin bundle into a temporary directory', async function () {
  rebuilt = fs.mkdtempSync(path.join(os.tmpdir(), 'b-'));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/build-plugin.mjs', rebuilt], { cwd: root, stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
  });
});

Then('it is identical to {string}', function (dir: string) {
  const files = (d: string) => fs.readdirSync(d).sort();
  assert.deepEqual(files(rebuilt), files(path.join(root, dir)));
  for (const f of files(rebuilt)) {
    assert.ok(fs.readFileSync(path.join(rebuilt, f)).equals(fs.readFileSync(path.join(root, dir, f))), `${f} is stale: run npm run build:plugin`);
  }
  fs.rmSync(rebuilt, { recursive: true, force: true });
});
