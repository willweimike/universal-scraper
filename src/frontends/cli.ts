#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { doctor, installBrowser } from '../browser/install.js';
import { callDaemon, stopDaemon } from '../daemon/client.js';
import { socketPath } from '../daemon/paths.js';
import fs from 'node:fs';
import { ScraperError, toShape } from '../errors.js';
import type { PageView, ReadParams, Verb, WaitSpec } from '../protocol.js';
import { formatError, formatExtract, formatPageView } from './format.js';

const program = new Command('scraper').description('Agent-native web access: read, act and extract through one daemon.');

async function main<T>(json: boolean, verb: Verb, params: object, human: (r: T) => string): Promise<void> {
  try {
    const result = await callDaemon<T>(verb, params);
    process.stdout.write((json ? JSON.stringify(result, null, 2) : human(result)) + '\n');
  } catch (e) {
    const shape = toShape(e instanceof ScraperError ? e : e);
    process.stderr.write((json ? JSON.stringify({ error: shape }, null, 2) : formatError(shape)) + '\n');
    process.exitCode = 1;
  }
}

const headersOf = (list: string[] | undefined): Record<string, string> | undefined =>
  list?.length
    ? Object.fromEntries(list.map((h) => { const i = h.indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()]; }))
    : undefined;

program
  .command('read [url]')
  .description('Fetch a page, API response or file (HTTP first, browser when needed).')
  .option('--mode <mode>', 'auto | http | browser')
  .option('--interactive', 'open a browser tab and list element handles')
  .option('--session <name>').option('--profile <name>').option('--share')
  .option('-X, --method <method>').option('-H, --header <header...>', 'e.g. "x-key: 1"').option('--body <body>')
  .option('--max-chars <n>', 'truncate to n characters per chunk', Number).option('--cursor <cursor>')
  .option('--wait-selector <css>').option('--wait-ms <n>', 'wait n ms', Number).option('--wait-idle')
  .option('--json', 'print the raw JSON result')
  .action(async (url: string | undefined, o) => {
    const wait: WaitSpec | undefined = o.waitSelector ? { selector: o.waitSelector } : o.waitMs ? { ms: o.waitMs } : o.waitIdle ? { idle: true } : undefined;
    const params: ReadParams = {
      url, cursor: o.cursor, mode: o.mode, interactive: o.interactive, wait, session: o.session, profile: o.profile, share: o.share,
      method: o.method, headers: headersOf(o.header), body: o.body, maxChars: o.maxChars,
    };
    await main<PageView>(!!o.json, 'read', params, formatPageView);
  });

program
  .command('act')
  .description("Run steps in the session's browser tab.")
  .requiredOption('--steps <json>', 'JSON array, e.g. \'[{"do":"click","target":"e3"}]\'')
  .option('--session <name>').option('--tab <id>').option('--json')
  .action(async (o) => {
    await main<PageView>(!!o.json, 'act', { steps: JSON.parse(o.steps), session: o.session, tab: o.tab }, formatPageView);
  });

program
  .command('extract <kind>')
  .description('tables | lists | structured | links | text | attr')
  .option('--target <handle>').option('--attr <name>').option('--session <name>').option('--tab <id>').option('--json')
  .action(async (kind: string, o) => {
    await main<{ data: unknown }>(!!o.json, 'extract', { kind, target: o.target, attr: o.attr, session: o.session, tab: o.tab }, (r) => formatExtract(r.data));
  });

program
  .command('sessions')
  .description('List your sessions, or close one.')
  .option('--close <name>').option('--json')
  .action(async (o) => {
    if (o.close) await main<{ closed: boolean }>(!!o.json, 'session.close', { session: o.close }, (r) => (r.closed ? 'closed' : 'no such session'));
    else await main<{ sessions: string[] }>(!!o.json, 'session.list', {}, (r) => r.sessions.join('\n'));
  });

program
  .command('stop')
  .description('Stop the background daemon (the next call starts a fresh one with the current environment).')
  .action(async () => {
    const cfg = loadConfig();
    const running = fs.existsSync(socketPath(cfg));
    await stopDaemon(cfg);
    process.stdout.write(running ? 'daemon stopped\n' : 'no daemon is running\n');
  });

program
  .command('setup')
  .description('Download the browser and install its system libraries.')
  .action(async () => {
    try {
      await installBrowser(loadConfig(), (m) => process.stderr.write(m + '\n'));
    } catch (e) {
      process.stderr.write(formatError(toShape(e)) + '\n');
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Check the environment and say what to fix.')
  .action(async () => {
    const { checks } = await doctor(loadConfig());
    for (const c of checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}\n`);
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

program
  .command('mcp')
  .description('Run the MCP server over stdio (for agent hosts).')
  .action(async () => {
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer();
  });

await program.parseAsync(process.argv);
