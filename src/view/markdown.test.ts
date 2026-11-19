import { describe, expect, it } from 'vitest';
import { buildPageView } from './markdown.js';

const quotes = ['Albert Einstein', 'J.K. Rowling', 'Jane Austen'];
const html = `<html><head><title>Quotes</title></head><body><div class="container">
${quotes
  .map(
    (a, i) => `<div class="quote" itemscope itemtype="http://schema.org/CreativeWork">
  <span class="text" itemprop="text">“A fairly long quotation number ${i} that is here so the page has enough text to count as an article body for extraction.”</span>
  <span>by <small class="author" itemprop="author">${a}</small></span></div>`,
  )
  .join('\n')}
</div></body></html>`;

describe('buildPageView', () => {
  it('keeps every author name, including the first one Readability would lift out as the byline', () => {
    const { markdown } = buildPageView(html, 'http://quotes.test/');
    for (const a of quotes) expect(markdown).toContain(a);
  });

  it('keeps a real article byline in the text', () => {
    const body = `<article><h1>Title</h1><p class="byline">By Ada Lovelace</p>${'<p>Body text of the article goes on for a while here. </p>'.repeat(12)}</article>`;
    expect(buildPageView(`<html><head><title>T</title></head><body>${body}</body></html>`, 'http://a.test/').markdown).toContain('Ada Lovelace');
  });
});
