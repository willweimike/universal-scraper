import { describe, expect, it } from 'vitest';
import { extractFromHtml } from './extract.js';

const base = 'http://site.test/page';

describe('extractFromHtml', () => {
  it('tables: uses thead headers and keys rows by header', () => {
    const html = '<table><thead><tr><th>Name</th><th>Price</th></tr></thead><tbody><tr><td>Widget</td><td>49</td></tr><tr><td>Gadget</td><td>19</td></tr></tbody></table>';
    expect(extractFromHtml(html, 'tables', base)).toEqual([
      { headers: ['Name', 'Price'], rows: [{ Name: 'Widget', Price: '49' }, { Name: 'Gadget', Price: '19' }] },
    ]);
  });

  it('tables: falls back to a first row of th cells', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    expect(extractFromHtml(html, 'tables', base)).toEqual([{ headers: ['A', 'B'], rows: [{ A: '1', B: '2' }] }]);
  });

  it('tables: names columns col1, col2 when there are no headers', () => {
    const html = '<table><tr><td>x</td><td>y</td></tr></table>';
    expect(extractFromHtml(html, 'tables', base)).toEqual([{ headers: ['col1', 'col2'], rows: [{ col1: 'x', col2: 'y' }] }]);
  });

  it('lists: one array per list, nested lists reported separately', () => {
    const html = '<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>one</li></ol>';
    expect(extractFromHtml(html, 'lists', base)).toEqual([['a', 'b'], ['c'], ['one']]);
  });

  it('structured: parses JSON-LD (flattening @graph), skips malformed blocks, reads Open Graph and microdata', () => {
    const html = `<head>
      <script type="application/ld+json">{"@graph":[{"@type":"Product","name":"A"},{"@type":"Brand","name":"B"}]}</script>
      <script type="application/ld+json">{not json</script>
      <meta property="og:title" content="Hello"><meta property="og:image" content="/i.png">
    </head><body><div itemscope itemtype="https://schema.org/Person"><span itemprop="name">Ada</span><a itemprop="url" href="/ada">x</a></div></body>`;
    const out = extractFromHtml(html, 'structured', base) as any;
    expect(out.jsonLd.map((o: any) => o['@type'])).toEqual(['Product', 'Brand']);
    expect(out.openGraph).toEqual({ 'og:title': 'Hello', 'og:image': '/i.png' });
    expect(out.microdata).toEqual([{ type: 'https://schema.org/Person', properties: { name: 'Ada', url: 'http://site.test/ada' } }]);
  });

  it('links: absolute hrefs with text, skipping links without text', () => {
    const html = '<a href="/a">Alpha</a><a href="b">Beta</a><a href="/c"> </a>';
    expect(extractFromHtml(html, 'links', base)).toEqual([
      { text: 'Alpha', href: 'http://site.test/a' },
      { text: 'Beta', href: 'http://site.test/b' },
    ]);
  });

  it('text: visible page text without scripts and styles, whitespace collapsed', () => {
    const html = '<body><style>p{}</style><p>Hello   <b>world</b></p><script>var x=1</script><noscript>no</noscript></body>';
    expect(extractFromHtml(html, 'text', base)).toBe('Hello world');
  });
});
