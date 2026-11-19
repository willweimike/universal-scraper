import type { CDPSession } from 'puppeteer-core';
import type { NodeSig } from '../handles.js';

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'spinbutton', 'listbox', 'treeitem',
]);
const SKIP_IN_PATH = new Set(['RootWebArea', 'generic', 'none', 'presentation', 'StaticText', 'InlineTextBox', 'paragraph', 'LineBreak']);

const enabled = new WeakSet<CDPSession>();

/** Interactive elements of the page from the full accessibility tree, joined with their DOM node ids. */
export async function collectElements(cdp: CDPSession): Promise<NodeSig[]> {
  if (!enabled.has(cdp)) {
    await cdp.send('Accessibility.enable');
    enabled.add(cdp);
  }
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: any[] };
  const byId = new Map<string, any>(nodes.map((n) => [n.nodeId, n]));
  const out: NodeSig[] = [];
  for (const n of nodes) {
    const role: string | undefined = n.role?.value;
    if (n.ignored || !role || !INTERACTIVE.has(role) || !n.backendDOMNodeId) continue;
    const ancestors: string[] = [];
    for (let p = byId.get(n.parentId); p; p = byId.get(p.parentId)) {
      const r: string | undefined = p.role?.value;
      if (!r || p.ignored || SKIP_IN_PATH.has(r)) continue;
      ancestors.unshift(`${r}:${String(p.name?.value ?? '').slice(0, 60)}`);
    }
    const url = n.properties?.find((x: any) => x.name === 'url')?.value?.value;
    out.push({
      backendNodeId: n.backendDOMNodeId,
      role,
      name: String(n.name?.value ?? ''),
      ancestors,
      ...(role === 'link' && url ? { href: String(url) } : {}),
    });
  }
  return out;
}
