import { runExclusive } from '../daemon/sessions.js';
import { ScraperError } from '../errors.js';
import { tableFor } from '../handles.js';
import type { ExtractParams, VerbContext } from '../protocol.js';
import { extractFromHtml } from '../view/extract.js';
import { resolveHandle } from './target.js';

const noPage = () => ScraperError.from('no_tab', 'There is no page in this session to extract from.', 'Call read first (interactive: true if you need element handles).', true);

async function scoped(ctx: VerbContext, p: ExtractParams, tab: string | undefined, hasTab: boolean, session: ReturnType<VerbContext['sessions']['get']>) {
  if (!hasTab) throw noPage();
  if (!p.target) throw ScraperError.from('internal', `extract "${p.kind}" needs a target handle.`, 'Pass target with a handle from the element list.', false);
  if (p.kind === 'attr' && !p.attr) throw ScraperError.from('internal', 'extract "attr" needs an attribute name.', 'Pass attr, for example "href".', false);
  const cdp = await ctx.browser.cdp(tab!);
  const sig = await resolveHandle(cdp, tableFor(session, tab!), p.target);
  const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId: sig.backendNodeId })) as any;
  try {
    const call = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration:
        p.kind === 'attr'
          ? 'function (a) { return this.getAttribute(a); }'
          : 'function () { return String(this.innerText ?? this.textContent ?? "").trim(); }',
      arguments: p.kind === 'attr' ? [{ value: p.attr }] : [],
    });
    return (call as any).result.value ?? null;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}

export async function extractVerb(ctx: VerbContext, p: ExtractParams): Promise<{ kind: ExtractParams['kind']; data: unknown }> {
  const session = ctx.sessions.get(ctx.caller, p.session ?? 'default');
  return runExclusive(session, () => extractLocked(ctx, p, session));
}

async function extractLocked(ctx: VerbContext, p: ExtractParams, session: ReturnType<VerbContext['sessions']['get']>): Promise<{ kind: ExtractParams['kind']; data: unknown }> {
  const tab = p.tab ?? session.activeTab;
  const hasTab = !!tab && session.tabs.has(tab) && ctx.browser.has(tab);

  if (p.kind === 'attr' || (p.kind === 'text' && p.target)) {
    return { kind: p.kind, data: await scoped(ctx, p, tab, hasTab, session) };
  }
  let html = session.lastHtml;
  let url = session.lastUrl;
  if (hasTab) {
    const snap = await ctx.browser.snapshot(tab!);
    html = snap.html;
    url = snap.url;
  }
  if (!html || !url) throw noPage();
  return { kind: p.kind, data: extractFromHtml(html, p.kind as Exclude<ExtractParams['kind'], 'attr'>, url) };
}
