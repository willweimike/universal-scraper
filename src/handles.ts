import type { Session } from './daemon/sessions.js';
import type { ElementRef } from './protocol.js';

export interface NodeSig {
  backendNodeId: number;
  role: string;
  name: string;
  /** Root-first `role:name` of the non-trivial ancestors; used to break ties on re-resolution. */
  ancestors: string[];
  href?: string;
  inputType?: string;
}

export type Resolution =
  | { kind: 'same'; sig: NodeSig }
  | { kind: 'remapped'; sig: NodeSig }
  | { kind: 'stale'; candidates: NodeSig[] };

const path = (s: NodeSig): string => s.ancestors.join('>');

/** Per-tab handle bookkeeping: ids are monotonic and never reused. */
export class HandleTable {
  private seq = 0;
  /** Incremented on every sync; lets us tell a replacement (minted when the old node vanished) from a pre-existing sibling. */
  private gen = 0;
  private byHandle = new Map<string, NodeSig>();
  private byNode = new Map<number, string>();
  private mintedAt = new Map<string, number>();
  private orphanedAt = new Map<string, number>();
  private listed = new Map<string, string>();
  /** Handles the last sync re-bound to the element that replaced theirs. */
  lastRemapped: string[] = [];

  allocate(sig: NodeSig): string {
    const existing = this.byNode.get(sig.backendNodeId);
    if (existing) {
      this.byHandle.set(existing, sig);
      return existing;
    }
    const handle = `e${++this.seq}`;
    this.byHandle.set(handle, sig);
    this.byNode.set(sig.backendNodeId, handle);
    this.mintedAt.set(handle, this.gen);
    return handle;
  }

  get(handle: string): NodeSig | undefined {
    return this.byHandle.get(handle);
  }

  private rebind(handle: string, old: NodeSig, sig: NodeSig): void {
    this.byNode.delete(old.backendNodeId);
    this.byHandle.set(handle, sig);
    this.byNode.set(sig.backendNodeId, handle);
    this.orphanedAt.delete(handle);
  }

  /** Finds the node a handle now refers to: same node, a unique replacement, or stale with candidates. */
  resolve(handle: string, fresh: NodeSig[]): Resolution {
    const old = this.byHandle.get(handle);
    if (!old) return { kind: 'stale', candidates: [] };
    const same = fresh.find((f) => f.backendNodeId === old.backendNodeId);
    if (same) {
      this.byHandle.set(handle, same);
      this.orphanedAt.delete(handle);
      return { kind: 'same', sig: same };
    }
    // A node that already had its own handle before ours vanished is a sibling, not a replacement: never re-bind to it.
    const orphanGen = this.orphanedAt.get(handle) ?? this.gen + 1;
    const isReplacement = (f: NodeSig) => {
      const owner = this.byNode.get(f.backendNodeId);
      return owner === undefined || owner === handle || (this.mintedAt.get(owner) ?? 0) >= orphanGen;
    };
    let candidates = fresh.filter((f) => f.role === old.role && f.name === old.name && isReplacement(f));
    if (candidates.length > 1) {
      const narrowed = candidates.filter((c) => path(c) === path(old));
      if (narrowed.length === 1) candidates = narrowed;
    }
    if (candidates.length === 1) {
      this.rebind(handle, old, candidates[0]);
      return { kind: 'remapped', sig: candidates[0] };
    }
    return { kind: 'stale', candidates };
  }

  /**
   * Allocates handles for a fresh element listing. A handle whose element vanished is re-bound right here when exactly
   * one unclaimed element replaced it, so a re-render does not leave two handles for one element. With markChanges,
   * elements are flagged new or changed since the last sync.
   */
  sync(fresh: NodeSig[], opts: { markChanges: boolean }): ElementRef[] {
    this.gen++;
    this.lastRemapped = [];
    const freshIds = new Set(fresh.map((f) => f.backendNodeId));
    const orphans: string[] = [];
    for (const [h, s] of this.byHandle) {
      if (freshIds.has(s.backendNodeId)) this.orphanedAt.delete(h);
      else {
        if (!this.orphanedAt.has(h)) this.orphanedAt.set(h, this.gen);
        orphans.push(h);
      }
    }
    let unowned = fresh.filter((f) => !this.byNode.has(f.backendNodeId));
    let pending = orphans;
    for (const keyOf of [(s: NodeSig) => `${s.role}\u0000${s.name}`, (s: NodeSig) => `${s.role}\u0000${s.name}\u0000${path(s)}`]) {
      const group = <T,>(items: T[], k: (t: T) => string) => {
        const m = new Map<string, T[]>();
        for (const it of items) m.set(k(it), [...(m.get(k(it)) ?? []), it]);
        return m;
      };
      const byOrphan = group(pending, (h) => keyOf(this.byHandle.get(h)!));
      const byFresh = group(unowned, keyOf);
      for (const [key, hs] of byOrphan) {
        const fs = byFresh.get(key);
        if (hs.length !== 1 || fs?.length !== 1) continue;
        this.rebind(hs[0], this.byHandle.get(hs[0])!, fs[0]);
        this.lastRemapped.push(hs[0]);
        pending = pending.filter((h) => h !== hs[0]);
        unowned = unowned.filter((f) => f !== fs[0]);
      }
    }

    const next = new Map<string, string>();
    const out: ElementRef[] = [];
    for (const sig of fresh) {
      const handle = this.allocate(sig);
      const key = `${sig.role}|${sig.name}`;
      let state: 'new' | 'changed' | undefined;
      if (opts.markChanges) {
        if (!this.listed.has(handle)) state = 'new';
        else if (this.listed.get(handle) !== key) state = 'changed';
      }
      next.set(handle, key);
      out.push(toRef(handle, sig, state));
    }
    this.listed = next;
    return out;
  }
}

export function toRef(handle: string, sig: NodeSig, state?: 'new' | 'changed'): ElementRef {
  return {
    handle,
    role: sig.role,
    name: sig.name,
    ...(sig.href ? { href: sig.href } : {}),
    ...(sig.inputType ? { inputType: sig.inputType } : {}),
    ...(state ? { state } : {}),
  };
}

export function tableFor(session: Session, tab: string): HandleTable {
  let t = session.handles.get(tab);
  if (!t) session.handles.set(tab, (t = new HandleTable()));
  return t;
}
