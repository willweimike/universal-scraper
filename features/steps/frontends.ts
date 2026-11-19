import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { After, Then, When } from '@cucumber/cucumber';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ScraperWorld } from '../support/world.js';

const CLI = ['--import', 'tsx', 'src/frontends/cli.ts'];

// Async on purpose: the fixture site lives in this process, so blocking here would starve the CLI's own requests.
function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...CLI, ...argv], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

When('I run the CLI {string}', async function (this: ScraperWorld, args: string) {
  this.cli = await runCli(args.replaceAll('<fixture>', this.fixtureUrl('')).split(' '));
});

Then('the JSON has title {string} and engine {string}', function (this: ScraperWorld, title: string, engine: string) {
  assert.equal(this.cli?.code, 0, this.cli?.stderr);
  const v = JSON.parse(this.cli!.stdout);
  assert.equal(v.title, title);
  assert.equal(v.engine, engine);
});

Then('the exit code is {int} and the output mentions {string}', function (this: ScraperWorld, code: number, text: string) {
  assert.equal(this.cli?.code, code, `${this.cli?.stdout}\n${this.cli?.stderr}`);
  assert.ok(`${this.cli!.stdout}\n${this.cli!.stderr}`.includes(text), `output lacked "${text}": ${this.cli!.stdout}${this.cli!.stderr}`);
});

When('I connect an MCP client to {string} over stdio', async function (this: ScraperWorld, _name: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...CLI, 'mcp'],
    env: { ...process.env } as Record<string, string>,
    stderr: 'ignore',
  });
  this.mcp = new Client({ name: 'bdd', version: '0.0.0' });
  await this.mcp.connect(transport);
  this.mcpTools = (await this.mcp.listTools()).tools.map((t) => t.name);
});

After(async function (this: ScraperWorld) {
  await this.mcp?.close();
});

Then('the tools include {string}, {string}, {string} and {string}', function (this: ScraperWorld, a: string, b: string, c: string, d: string) {
  for (const t of [a, b, c, d]) assert.ok(this.mcpTools.includes(t), `missing ${t} in ${this.mcpTools}`);
});

async function callTool(world: ScraperWorld, name: string, args: Record<string, unknown>) {
  world.mcpResult = await world.mcp!.callTool({ name, arguments: args });
}

const textOf = (r: any): string => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

When('the MCP tool {string} is called with the fixture {string}', async function (this: ScraperWorld, tool: string, path: string) {
  await callTool(this, tool, { url: this.fixtureUrl(path) });
});

When('the MCP tool {string} is called with a private URL', async function (this: ScraperWorld, tool: string) {
  await callTool(this, tool, { url: 'http://169.254.169.254/latest/meta-data/' });
});

When('the MCP tool {string} is called to click {string}', async function (this: ScraperWorld, tool: string, handle: string) {
  await callTool(this, tool, { steps: [{ do: 'click', target: handle }] });
});

Then('the MCP text contains {string} and {string}', function (this: ScraperWorld, a: string, b: string) {
  assert.ok(!this.mcpResult.isError, textOf(this.mcpResult));
  const t = textOf(this.mcpResult);
  assert.ok(t.includes(a) && t.includes(b), t.slice(0, 400));
});

Then('the result is an error containing {string} and a hint', function (this: ScraperWorld, code: string) {
  assert.equal(this.mcpResult.isError, true, textOf(this.mcpResult));
  const t = textOf(this.mcpResult);
  assert.ok(t.includes(code), t);
  assert.ok(/Hint: \S/.test(t), t);
});
