import type { CDPSession } from 'puppeteer-core';
import { ScraperError } from '../errors.js';
import { toRef, type HandleTable, type NodeSig } from '../handles.js';
import { collectElements } from '../view/elements.js';

/** Resolves a handle against the live page; throws stale_handle (with candidates) when it is gone or ambiguous. */
export async function resolveHandle(cdp: CDPSession, table: HandleTable, handle: string, remapped?: string[]): Promise<NodeSig> {
  const r = table.resolve(handle, await collectElements(cdp));
  if (r.kind === 'stale') {
    const candidates = r.candidates.map((sig) => toRef(table.allocate(sig), sig));
    throw new ScraperError({
      code: 'stale_handle',
      message: candidates.length
        ? `Handle ${handle} now matches ${candidates.length} elements.`
        : `Handle ${handle} no longer matches any element.`,
      recoverable: true,
      hint: candidates.length ? 'Pick one of the candidates by its handle.' : 'Read the page again to get fresh handles.',
      candidates,
    });
  }
  if (r.kind === 'remapped') remapped?.push(handle);
  return r.sig;
}
