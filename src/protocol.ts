import type { Config } from './config.js';
import type { SessionStore } from './daemon/sessions.js';
import type { BrowserEngine } from './engines/browser.js';

export type Verb = 'ping' | 'read' | 'act' | 'extract' | 'session.list' | 'session.close' | 'shutdown';

export type ErrorCode =
  | 'blocked' | 'timeout' | 'dns' | 'tls' | 'http_status' | 'stale_handle' | 'needs_human'
  | 'ssrf_blocked' | 'browser_unavailable' | 'no_tab' | 'session_expired'
  | 'not_actionable' | 'internal';

export interface ScraperErrorShape {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  hint: string;
  candidates?: ElementRef[];
}

export type WaitSpec = { handle: string } | { selector: string } | { idle: true } | { ms: number };

export type EscalationReason =
  | 'empty_spa_shell' | 'js_required' | 'challenge' | 'rate_limited' | 'low_text_ratio' | 'interactive' | 'forced';

export interface ElementRef {
  handle: string;
  role: string;
  name: string;
  href?: string;
  inputType?: string;
  state?: 'new' | 'changed';
}

export interface ReadParams {
  url?: string;
  cursor?: string;
  mode?: 'auto' | 'http' | 'browser';
  interactive?: boolean;
  wait?: WaitSpec;
  session?: string;
  profile?: string;
  share?: boolean;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  maxChars?: number;
}

export interface PageView {
  url: string;
  status: number;
  title: string;
  contentType: string;
  engine: 'http' | 'browser';
  escalatedBecause?: EscalationReason;
  elapsedMs: number;
  tab?: string;
  markdown?: string;
  elements: ElementRef[];
  links: { text: string; href: string }[];
  forms: { action: string; method: string; fields: { name: string; type: string }[] }[];
  body?: unknown;
  savedPath?: string;
  /** The body was larger than the size cap and was cut off. */
  bodyTruncated?: boolean;
  truncated?: { cursor: string };
  remapped?: string[];
  robots?: 'allowed' | 'disallowed' | 'unknown';
}

export type ActStep =
  | { do: 'click' | 'hover'; target: string }
  | { do: 'type'; target: string; text: string }
  | { do: 'select'; target: string; value: string }
  | { do: 'press'; key: string }
  | { do: 'scroll'; by: number }
  | { do: 'goto'; url: string }
  | { do: 'wait'; for: WaitSpec };

export interface ActParams {
  session?: string;
  tab?: string;
  steps: ActStep[];
}

export type ExtractKind = 'tables' | 'lists' | 'structured' | 'links' | 'text' | 'attr';

export interface ExtractParams {
  session?: string;
  tab?: string;
  kind: ExtractKind;
  target?: string;
  attr?: string;
}

export interface VerbContext {
  caller: string;
  cfg: Config;
  sessions: SessionStore;
  browser: BrowserEngine;
}

export type VerbHandler = (ctx: VerbContext, params: any) => Promise<unknown>;

export interface DaemonRequest {
  id: number;
  caller: string;
  verb: Verb;
  params: Record<string, unknown>;
}

export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: ScraperErrorShape };
