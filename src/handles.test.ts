import { describe, expect, it } from 'vitest';
import { HandleTable, type NodeSig } from './handles.js';

const sig = (backendNodeId: number, role: string, name: string, ancestors: string[] = []): NodeSig => ({ backendNodeId, role, name, ancestors });

describe('HandleTable', () => {
  it('allocates monotonic ids and reuses the handle for the same node', () => {
    const t = new HandleTable();
    expect(t.allocate(sig(10, 'button', 'A'))).toBe('e1');
    expect(t.allocate(sig(11, 'button', 'B'))).toBe('e2');
    expect(t.allocate(sig(10, 'button', 'A'))).toBe('e1');
    expect(t.allocate(sig(12, 'link', 'C'))).toBe('e3');
  });

  it('never reuses an id, even after the node it named is gone', () => {
    const t = new HandleTable();
    t.allocate(sig(1, 'button', 'A'));
    t.resolve('e1', []); // node gone
    expect(t.allocate(sig(2, 'button', 'Z'))).toBe('e2');
  });

  it('resolves to the same node while it is still in the tree', () => {
    const t = new HandleTable();
    const h = t.allocate(sig(10, 'button', 'Refresh'));
    expect(t.resolve(h, [sig(10, 'button', 'Refresh'), sig(11, 'button', 'Add')]).kind).toBe('same');
  });

  it('re-binds the handle to a unique role+name match after the node is replaced', () => {
    const t = new HandleTable();
    const h = t.allocate(sig(10, 'button', 'Delete Item B'));
    const r = t.resolve(h, [sig(20, 'button', 'Delete Item B'), sig(21, 'button', 'Delete Item C')]);
    expect(r).toMatchObject({ kind: 'remapped', sig: { backendNodeId: 20 } });
    expect(t.resolve(h, [sig(20, 'button', 'Delete Item B')]).kind).toBe('same');
  });

  it('is stale with candidates when two nodes match', () => {
    const t = new HandleTable();
    const h = t.allocate(sig(10, 'button', 'Go'));
    const r = t.resolve(h, [sig(20, 'button', 'Go', ['group:x']), sig(21, 'button', 'Go', ['group:y'])]);
    expect(r.kind).toBe('stale');
    expect((r as any).candidates).toHaveLength(2);
  });

  it('is stale with no candidates when nothing matches', () => {
    const t = new HandleTable();
    const h = t.allocate(sig(10, 'button', 'Go'));
    expect(t.resolve(h, [sig(20, 'link', 'Elsewhere')])).toEqual({ kind: 'stale', candidates: [] });
  });

  it('breaks a role+name tie with the ancestor path', () => {
    const t = new HandleTable();
    const h = t.allocate(sig(10, 'button', 'Go', ['dialog:Settings']));
    const r = t.resolve(h, [sig(20, 'button', 'Go', ['dialog:Settings']), sig(21, 'button', 'Go', ['main:'])]);
    expect(r).toMatchObject({ kind: 'remapped', sig: { backendNodeId: 20 } });
  });

  it('treats an unknown handle as stale', () => {
    expect(new HandleTable().resolve('e99', [sig(1, 'button', 'A')])).toEqual({ kind: 'stale', candidates: [] });
  });
});

describe('HandleTable.sync', () => {
  it('lists every element without state on the first sync', () => {
    const t = new HandleTable();
    const refs = t.sync([sig(1, 'button', 'A'), sig(2, 'link', 'B')], { markChanges: false });
    expect(refs.map((r) => [r.handle, r.state])).toEqual([['e1', undefined], ['e2', undefined]]);
  });

  it('marks new and changed elements on later syncs', () => {
    const t = new HandleTable();
    t.sync([sig(1, 'button', 'A'), sig(2, 'button', 'B')], { markChanges: false });
    const refs = t.sync([sig(1, 'button', 'A'), sig(2, 'button', 'B2'), sig(3, 'button', 'C')], { markChanges: true });
    expect(refs.map((r) => [r.handle, r.state])).toEqual([['e1', undefined], ['e2', 'changed'], ['e3', 'new']]);
  });
});

describe('HandleTable re-binding', () => {
  it('sync re-binds an orphaned handle to its unique replacement and reports it', () => {
    const t = new HandleTable();
    t.sync([sig(10, 'button', 'Delete Item B'), sig(11, 'button', 'Add')], { markChanges: false });
    const refs = t.sync([sig(20, 'button', 'Delete Item B'), sig(11, 'button', 'Add')], { markChanges: true });
    expect(refs.map((r) => r.handle)).toEqual(['e1', 'e2']); // e1 now names the new node: no duplicate handle is minted
    expect(t.lastRemapped).toEqual(['e1']);
  });

  it('does not re-bind when the replacement is ambiguous, and offers both as candidates', () => {
    const t = new HandleTable();
    t.sync([sig(10, 'button', 'Go')], { markChanges: false });
    t.sync([sig(20, 'button', 'Go'), sig(21, 'button', 'Go')], { markChanges: true });
    expect(t.lastRemapped).toEqual([]);
    const r = t.resolve('e1', [sig(20, 'button', 'Go'), sig(21, 'button', 'Go')]);
    expect(r.kind).toBe('stale');
    expect((r as any).candidates).toHaveLength(2);
  });

  it('never re-binds a vanished handle to a look-alike sibling that already had its own handle', () => {
    const t = new HandleTable();
    const rowA = sig(1, 'button', 'Delete', ['row:A']);
    const rowB = sig(2, 'button', 'Delete', ['row:B']);
    t.sync([rowA, rowB], { markChanges: false }); // e1 = row A, e2 = row B
    t.sync([rowB], { markChanges: true }); // row A was deleted
    expect(t.lastRemapped).toEqual([]);
    expect(t.resolve('e1', [rowB])).toEqual({ kind: 'stale', candidates: [] }); // must not delete row B instead
  });
});
