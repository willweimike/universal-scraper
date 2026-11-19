import { tableFor, type HandleTable, type NodeSig } from '../handles.js';
import { ScraperError } from '../errors.js';
import type { ActParams, ActStep, PageView, VerbContext } from '../protocol.js';
import { assertPublicUrl } from '../safety/ssrf.js';
import { assertNoHandoff, blocked, classify } from '../router.js';
import { resolveHandle } from './target.js';
import { collectElements } from '../view/elements.js';
import { buildPageView } from '../view/markdown.js';
import { DEFAULT_MAX_CHARS, paginate } from '../view/page.js';
import { runExclusive, type Session } from '../daemon/sessions.js';
import type { CDPSession, KeyInput, Page } from 'puppeteer-core';

const POINT_FN = `function () {
  const el = this;
  if (el.disabled) return { error: 'disabled' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { error: 'hidden' };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  if (!top || !(top === el || el.contains(top) || top.contains(el))) {
    return { error: 'covered', by: top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : 'nothing' };
  }
  return { x, y };
}`;

const notActionable = (what: string, why: string): ScraperError =>
  ScraperError.from('not_actionable', `Cannot act on ${what}: it is ${why}.`, 'Close any overlay, scroll, wait for the page to settle, or pick another element; then retry.', true);

interface Ctx {
  ctx: VerbContext;
  session: Session;
  tab: string;
  table: HandleTable;
  page: Page;
  cdp: CDPSession;
  remapped: string[];
}

function resolveTarget(c: Ctx, handle: string): Promise<NodeSig> {
  return resolveHandle(c.cdp, c.table, handle, c.remapped);
}

async function pointOf(c: Ctx, sig: NodeSig): Promise<{ x: number; y: number }> {
  const { object } = (await c.cdp.send('DOM.resolveNode', { backendNodeId: sig.backendNodeId })) as any;
  try {
    const { result } = (await c.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: POINT_FN,
      returnByValue: true,
    })) as any;
    const v = result.value;
    const label = `${sig.role} "${sig.name}"`;
    if (v.error === 'covered') throw notActionable(label, `covered by ${v.by}`);
    if (v.error) throw notActionable(label, v.error);
    return v;
  } finally {
    await c.cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}

/** Runs a function with the resolved DOM node as `this`; returns its JSON value. */
async function onNode<T>(c: Ctx, sig: NodeSig, fn: string, args: unknown[] = []): Promise<T> {
  const { object } = (await c.cdp.send('DOM.resolveNode', { backendNodeId: sig.backendNodeId })) as any;
  try {
    const { result } = (await c.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    })) as any;
    return result.value as T;
  } finally {
    await c.cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs an action that may trigger a re-render or navigation, then waits for the page to settle. */
async function settling(page: Page, action: () => Promise<void>): Promise<void> {
  let navigated = false;
  const mark = () => void (navigated = true);
  page.on('framenavigated', mark);
  try {
    await action();
    await sleep(150);
    await page.waitForNetworkIdle({ idleTime: navigated ? 300 : 100, timeout: navigated ? 5000 : 500 }).catch(() => {});
  } finally {
    page.off('framenavigated', mark);
  }
}

/** Browser/CDP failures that are the agent's situation, not a scraper bug, get a code and a hint. */
function mapStepError(e: unknown, step: ActStep): unknown {
  if (e instanceof ScraperError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/unknown key|unsupported key/i.test(msg)) {
    return notActionable(`the key press "${step.do === 'press' ? step.key : ''}"`, 'not a key name the browser knows (try Enter, Tab, Escape, ArrowDown, a letter)');
  }
  if (/no node with given id|could not find node|node is detached|cannot find context|execution context was destroyed/i.test(msg)) {
    return new ScraperError({ code: 'stale_handle', message: 'The element went away while acting on it.', recoverable: true, hint: 'The page changed under the action; read it again and retry with fresh handles.' });
  }
  return e;
}

async function runStep(c: Ctx, step: ActStep): Promise<void> {
  try {
    await runStepInner(c, step);
  } catch (e) {
    throw mapStepError(e, step);
  }
}

async function runStepInner(c: Ctx, step: ActStep): Promise<void> {
  switch (step.do) {
    case 'click': {
      const sig = await resolveTarget(c, step.target);
      const { x, y } = await pointOf(c, sig);
      return settling(c.page, () => c.page.mouse.click(x, y));
    }
    case 'hover': {
      const sig = await resolveTarget(c, step.target);
      const { x, y } = await pointOf(c, sig);
      return settling(c.page, () => c.page.mouse.move(x, y));
    }
    case 'type': {
      const sig = await resolveTarget(c, step.target);
      await onNode(c, sig, 'function () { this.focus(); if (typeof this.select === "function") this.select(); }');
      return settling(c.page, () => c.page.keyboard.type(step.text));
    }
    case 'select': {
      const sig = await resolveTarget(c, step.target);
      const r = await onNode<{ error?: string }>(c, sig, `function (v) {
        if (this.tagName !== 'SELECT') return { error: 'is not a select list' };
        const opt = Array.from(this.options).find((o) => o.value === v || o.text === v);
        if (!opt) return { error: 'has no option "' + v + '"' };
        this.value = opt.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return {};
      }`, [step.value]);
      if (r.error) throw notActionable(`${sig.role} "${sig.name}"`, r.error);
      return settling(c.page, async () => {});
    }
    case 'scroll':
      return settling(c.page, async () => {
        await c.page.evaluate((n) => window.scrollBy(0, n), step.by);
      });
    case 'press':
      return settling(c.page, () => c.page.keyboard.press(step.key as KeyInput));
    case 'goto': {
      assertPublicUrl(step.url, c.ctx.cfg);
      await c.ctx.browser.navigate(c.tab, { url: step.url });
      return;
    }
    case 'wait': {
      const w = step.for;
      if ('handle' in w) {
        const deadline = Date.now() + c.ctx.cfg.timeoutMs;
        for (;;) {
          const r = c.table.resolve(w.handle, await collectElements(c.cdp));
          if (r.kind !== 'stale') return;
          if (Date.now() > deadline) {
            throw ScraperError.from('timeout', `Handle ${w.handle} did not reappear in time.`, 'Read the page again.', true);
          }
          await sleep(100);
        }
      }
      return c.ctx.browser.wait(c.tab, w);
    }
  }
}

export async function actVerb(ctx: VerbContext, p: ActParams): Promise<PageView> {
  const session = ctx.sessions.get(ctx.caller, p.session ?? 'default');
  return runExclusive(session, () => actLocked(ctx, session, p));
}

async function actLocked(ctx: VerbContext, session: Session, p: ActParams): Promise<PageView> {
  const started = Date.now();
  const tab = p.tab ?? session.activeTab;
  if (tab && session.tabs.has(tab) && !ctx.browser.has(tab)) {
    session.tabs.delete(tab); // the browser lost it (crash); do not keep the session pinned open
    if (session.activeTab === tab) session.activeTab = undefined;
  }
  if (!tab || !session.tabs.has(tab)) {
    throw ScraperError.from('no_tab', 'This session has no open browser tab to act on.', 'Call read with interactive: true first to open one.', true);
  }
  const c: Ctx = {
    ctx, session, tab,
    table: tableFor(session, tab),
    page: ctx.browser.page(tab),
    cdp: await ctx.browser.cdp(tab),
    remapped: [],
  };
  for (const step of p.steps) await runStep(c, step);
  ctx.browser.assertNavigationOk(tab, started);

  // Keep the shared (and, for a named profile, persisted) jar current: a login done with act must survive a restart.
  session.cookies.absorb(await ctx.browser.getCookies(tab));
  const snap = await ctx.browser.snapshot(tab);
  if (classify({ status: snap.status, headers: {}, html: snap.html }) === 'challenge') throw blocked(new URL(snap.url).host, true);
  assertNoHandoff(snap.html);
  const built = buildPageView(snap.html, snap.url);
  session.lastHtml = snap.html;
  session.lastUrl = snap.url;
  const elements = c.table.sync(await collectElements(c.cdp), { markChanges: true });
  c.remapped.push(...c.table.lastRemapped); // handles re-bound to the element that replaced theirs during this action
  const view: PageView = paginate(
    session,
    {
      url: snap.url, status: snap.status, title: built.title, contentType: 'text/html', engine: 'browser',
      elapsedMs: Date.now() - started, tab, elements, links: built.links, forms: built.forms,
    },
    built.markdown, 0, DEFAULT_MAX_CHARS,
  );
  if (c.remapped.length) view.remapped = [...new Set(c.remapped)];
  return view;
}
