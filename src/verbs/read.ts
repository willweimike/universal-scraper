import { ScraperError } from '../errors.js';
import type { PageView, ReadParams, VerbContext } from '../protocol.js';
import { routeRead } from '../router.js';
import { assertPublicUrl } from '../safety/ssrf.js';
import { bindProfile } from '../session/profiles.js';
import { continueRead, DEFAULT_MAX_CHARS } from '../view/page.js';

export async function readVerb(ctx: VerbContext, p: ReadParams): Promise<PageView> {
  const started = Date.now();
  // A read of a URL does not depend on earlier state, so a session lost in a restart is simply recreated.
  const session = ctx.sessions.get(ctx.caller, p.session ?? 'default', { share: p.share, forgive: !!p.url && !p.cursor });
  const maxChars = p.maxChars ?? DEFAULT_MAX_CHARS;
  if (p.cursor) return continueRead(session, p.cursor, maxChars);
  if (!p.url) throw ScraperError.from('internal', 'read needs a url or a cursor.', 'Pass url, or the cursor from a truncated read.', false);
  assertPublicUrl(p.url, ctx.cfg);
  if (p.profile) bindProfile(ctx.cfg, ctx.caller, session, p.profile);
  return routeRead(ctx, session, p, started, maxChars);
}
