import { setDefaultTimeout, setWorldConstructor, World } from '@cucumber/cucumber';
import { callDaemon } from '../../src/daemon/client.js';
import { ScraperError } from '../../src/errors.js';
import type { Verb } from '../../src/protocol.js';

export interface FixtureState {
  port: number;
}

export const fixtureState: FixtureState = { port: 0 };

export interface StepError {
  code: string;
  message: string;
  recoverable: boolean;
  hint: string;
  candidates?: unknown[];
}

export class ScraperWorld extends World {
  result: any = null;
  error: StepError | null = null;
  lastFetch: { status: number; body: string } | null = null;
  firstChunk: string | null = null;
  cli: { code: number; stdout: string; stderr: string } | null = null;
  mcp: import('@modelcontextprotocol/sdk/client/index.js').Client | null = null;
  mcpTools: string[] = [];
  mcpResult: any = null;
  acc: string[] = [];
  parallel: any[] = [];
  firstElements: any[] | null = null;
  lastElements: any[] = [];
  targetHandle = '';
  pair: Record<string, { result: any; error: StepError | null; ms: number }> = {};

  fixtureUrl(path: string): string {
    return `http://127.0.0.1:${fixtureState.port}${path}`;
  }

  async call(verb: Verb, params: object, caller?: string): Promise<void> {
    try {
      this.result = await callDaemon(verb, params, { caller });
      this.error = null;
    } catch (err) {
      if (!(err instanceof ScraperError)) throw err;
      this.result = null;
      this.error = err.toShape();
    }
  }
}

setDefaultTimeout(60_000);
setWorldConstructor(ScraperWorld);
