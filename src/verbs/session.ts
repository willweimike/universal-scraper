import type { VerbContext } from '../protocol.js';

export async function sessionListVerb(ctx: VerbContext): Promise<{ sessions: string[] }> {
  return { sessions: ctx.sessions.list(ctx.caller) };
}

/** Closes the session's browser tabs, then forgets the session. */
export async function sessionCloseVerb(ctx: VerbContext, p: { session: string }): Promise<{ closed: boolean }> {
  const s = ctx.sessions.peek(ctx.caller, p.session);
  if (!s) return { closed: false };
  await Promise.all([...s.tabs.keys()].map((id) => ctx.browser.close(id)));
  await ctx.browser.closeSession(`${ctx.caller}\u0000${p.session}`);
  return { closed: ctx.sessions.close(ctx.caller, p.session) };
}
