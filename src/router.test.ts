import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { checkRobots, clearRobotsCache, classify, detectHandoff, DomainLimiter } from './router.js';

const article = `<html><body><article>${'<p>This is a long readable paragraph of real content for people. </p>'.repeat(20)}</article></body></html>`;
const spaShell = '<html><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script src="/app.js"></script></body></html>';

describe('classify', () => {
  it('returns null for a normal article', () => {
    expect(classify({ status: 200, headers: {}, html: article })).toBeNull();
  });
  it('returns null for a plain 404 page', () => {
    expect(classify({ status: 404, headers: {}, html: '<html><body><p>Not found</p></body></html>' })).toBeNull();
  });
  it('detects an empty SPA shell', () => {
    expect(classify({ status: 200, headers: {}, html: spaShell })).toBe('empty_spa_shell');
  });
  it('detects a JavaScript-required page without a root container', () => {
    const html = '<html><body><p>Please enable JavaScript to view this page.</p><script>1</script></body></html>';
    expect(classify({ status: 200, headers: {}, html })).toBe('js_required');
  });
  it('detects a bot challenge by header and by body', () => {
    expect(classify({ status: 403, headers: { 'cf-mitigated': 'challenge' }, html: '<html></html>' })).toBe('challenge');
    expect(classify({ status: 503, headers: {}, html: '<html><title>Just a moment...</title></html>' })).toBe('challenge');
  });
  it('detects rate limiting', () => {
    expect(classify({ status: 429, headers: {}, html: '<html><body>slow down</body></html>' })).toBe('rate_limited');
  });
  it('detects a page that is almost all markup', () => {
    const html = `<html><body>${'<div><span></span></div>'.repeat(400)}<p>hi</p></body></html>`;
    expect(classify({ status: 200, headers: {}, html })).toBe('low_text_ratio');
  });
});

describe('DomainLimiter', () => {
  it('runs at most 4 calls per host at once; the 5th waits', async () => {
    const limiter = new DomainLimiter(4);
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const tasks = Array.from({ length: 6 }, () =>
      limiter.run('a.test', () => new Promise<void>((resolve) => {
        running++;
        peak = Math.max(peak, running);
        gates.push(() => { running--; resolve(); });
      })),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(running).toBe(4);
    gates.splice(0).forEach((g) => g());
    await new Promise((r) => setTimeout(r, 20));
    gates.splice(0).forEach((g) => g());
    await Promise.all(tasks);
    expect(peak).toBe(4);
  });
  it('does not limit across different hosts', async () => {
    const limiter = new DomainLimiter(1);
    const order: string[] = [];
    await Promise.all([
      limiter.run('a.test', async () => { order.push('a'); }),
      limiter.run('b.test', async () => { order.push('b'); }),
    ]);
    expect(order.sort()).toEqual(['a', 'b']);
  });
});

describe('checkRobots', () => {
  const cfg = loadConfig({});
  const robots = 'User-agent: *\nDisallow: /private\nAllow: /private/open\n';

  it('reports a disallowed path and an allowed one', async () => {
    clearRobotsCache();
    const f = async () => ({ status: 200, text: robots });
    expect(await checkRobots('http://r.test/private/x', cfg, f)).toBe('disallowed');
    expect(await checkRobots('http://r.test/private/open/x', cfg, f)).toBe('allowed');
    expect(await checkRobots('http://r.test/public', cfg, f)).toBe('allowed');
  });
  it('treats a missing robots.txt as allowed and a failure as unknown', async () => {
    clearRobotsCache();
    expect(await checkRobots('http://a.test/x', cfg, async () => ({ status: 404, text: '' }))).toBe('allowed');
    clearRobotsCache();
    expect(await checkRobots('http://b.test/x', cfg, async () => { throw new Error('boom'); })).toBe('unknown');
  });
  it('fetches robots.txt once per origin', async () => {
    clearRobotsCache();
    let calls = 0;
    const f = async () => { calls++; return { status: 200, text: robots }; };
    await checkRobots('http://c.test/a', cfg, f);
    await checkRobots('http://c.test/b', cfg, f);
    expect(calls).toBe(1);
  });
});

describe('detectHandoff', () => {
  it('flags a page that is just a CAPTCHA widget', () => {
    expect(detectHandoff('<html><body><h1>Verify</h1><div class="g-recaptcha" data-sitekey="x"></div></body></html>')).toBe('captcha');
    expect(detectHandoff('<html><body><iframe src="https://challenges.cloudflare.com/turnstile/v0/x"></iframe></body></html>')).toBe('captcha');
  });
  it('flags a page that is just a one-time-code prompt', () => {
    expect(detectHandoff('<html><body><form><input name="otp" autocomplete="one-time-code"><button>Verify</button></form></body></html>')).toBe('mfa');
  });
  it('does not flag a long article that merely embeds a CAPTCHA widget', () => {
    const html = `<html><body><article>${'<p>Plenty of real content for a person to read here today. </p>'.repeat(30)}</article><div class="g-recaptcha"></div></body></html>`;
    expect(detectHandoff(html)).toBeNull();
  });
  it('does not flag an ordinary login form', () => {
    expect(detectHandoff('<html><body><form><input name="user"><input name="pass" type="password"><button>Sign in</button></form></body></html>')).toBeNull();
  });
});

describe('checkRobots with a hostile robots.txt', () => {
  it('matches wildcard rules in linear time instead of backtracking', async () => {
    clearRobotsCache();
    const cfg = loadConfig({});
    const hostile = `User-agent: *\nDisallow: /${'*a'.repeat(25)}*b\n`;
    const started = Date.now();
    const status = await checkRobots(`http://h.test/${'a'.repeat(60)}`, cfg, async () => ({ status: 200, text: hostile }));
    expect(Date.now() - started).toBeLessThan(500);
    expect(status).toBe('allowed');
  });
  it('supports * and $ anchors', async () => {
    clearRobotsCache();
    const cfg = loadConfig({});
    const f = async () => ({ status: 200, text: 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/x\n' });
    expect(await checkRobots('http://g.test/a/b.pdf', cfg, f)).toBe('disallowed');
    expect(await checkRobots('http://g.test/a/b.pdf?x=1', cfg, f)).toBe('allowed');
    expect(await checkRobots('http://g.test/tmp123/x', cfg, f)).toBe('disallowed');
  });
});
