import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, json, raw, validQuote, QID, CID, makePublicDir } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOO_MANY = { success: false, errorMessage: 'Too many requests. Please try again later.' };
const GENERIC = { success: false, errorMessage: 'Something went wrong. Please try again.' };

async function withServer(opts, fn) {
  const s = await start(opts);
  try { await fn(s); } finally { await s.close(); }
}

// ---------- existing behaviour ----------
test('POST /api/quote happy path returns the Salesforce result and notifies rfq_created', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/quote', validQuote);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, conversationId: CID, quoteId: QID });
  assert.equal(s.calls.sf.length, 1);
  assert.equal(s.calls.sf[0].method, 'POST');
  assert.equal(s.calls.sf[0].body.company, 'Summit Avionics');
  assert.deepEqual(s.calls.notify, [['rfq_created', CID, QID]]);
}));

test('PATCH /api/quote happy path notifies customer_message', () => withServer({}, async (s) => {
  const res = await json(s.base, 'PATCH', '/api/quote', { conversationId: CID, quoteId: QID, message: 'hello' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.deepEqual(s.calls.sf[0].body, { conversationId: CID, quoteId: QID, message: 'hello' });
  assert.deepEqual(s.calls.notify, [['customer_message', CID, QID]]);
}));

test('GET /api/quote/messages passes conversationId/quoteId/after through', () => withServer({}, async (s) => {
  const res = await fetch(`${s.base}/api/quote/messages?conversationId=${CID}&quoteId=${QID}&after=2026-01-01T00:00:00Z&evil=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { success: true, messages: [] });
  const q = new URLSearchParams(s.calls.sf[0].query);
  assert.equal(s.calls.sf[0].method, 'GET');
  assert.equal(q.get('conversationId'), CID);
  assert.equal(q.get('quoteId'), QID);
  assert.equal(q.get('after'), '2026-01-01T00:00:00Z');
  assert.equal(q.get('evil'), null);
}));

test('widget JS/CSS are revalidated on every load; images keep a 1 h cache', () => withServer({}, async (s) => {
  for (const f of ['/chat-widget.js', '/chat-widget.css']) {
    const res = await fetch(s.base + f);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    await res.text();
  }
  const img = await fetch(s.base + '/assets/a.png');
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('cache-control'), 'public, max-age=3600');
  await img.text();
}));

test('/quote serves quote.html', () => withServer({}, async (s) => {
  const res = await fetch(s.base + '/quote');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(await res.text(), '<html>quote</html>');
}));

// ---------- 1 rate limit ----------
test('POST /api/quote: 6th request in the window is 429 with Retry-After and never reaches Salesforce', () => withServer({}, async (s) => {
  for (let i = 0; i < 5; i++) assert.equal((await json(s.base, 'POST', '/api/quote', validQuote)).status, 200);
  const res = await json(s.base, 'POST', '/api/quote', validQuote);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), TOO_MANY);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(s.calls.sf.length, 5);
}));

test('PATCH /api/quote: 31st request in the window is 429', () => withServer({}, async (s) => {
  const body = { conversationId: CID, quoteId: QID, message: 'hi' };
  for (let i = 0; i < 30; i++) assert.equal((await json(s.base, 'PATCH', '/api/quote', body)).status, 200);
  const res = await json(s.base, 'PATCH', '/api/quote', body);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), TOO_MANY);
  assert.ok(res.headers.get('retry-after'));
  assert.equal(s.calls.sf.length, 30);
}));

test('GET /api/quote/messages: 121st request in a minute is 429', () => withServer({}, async (s) => {
  const url = `/api/quote/messages?conversationId=${CID}&quoteId=${QID}`;
  for (let i = 0; i < 120; i++) assert.equal((await fetch(s.base + url)).status, 200);
  const res = await fetch(s.base + url);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), TOO_MANY);
  assert.ok(res.headers.get('retry-after'));
  assert.equal(s.calls.sf.length, 120);
}));

test('rate limit window resets after it expires', () => {
  let t = 1_000_000;
  return withServer({ now: () => t }, async (s) => {
    for (let i = 0; i < 5; i++) await json(s.base, 'POST', '/api/quote', validQuote);
    assert.equal((await json(s.base, 'POST', '/api/quote', validQuote)).status, 429);
    t += 10 * 60 * 1000 + 1;
    assert.equal((await json(s.base, 'POST', '/api/quote', validQuote)).status, 200);
  });
});

test('limits are configurable', () => withServer({ config: { limits: { post: { max: 1, windowMs: 60000 } } } }, async (s) => {
  assert.equal((await json(s.base, 'POST', '/api/quote', validQuote)).status, 200);
  assert.equal((await json(s.base, 'POST', '/api/quote', validQuote)).status, 429);
}));

test('TRUST_PROXY uses the LAST X-Forwarded-For address as client IP', () => withServer({ config: { trustProxy: true } }, async (s) => {
  for (let i = 0; i < 5; i++) {
    // attacker-controlled first hop changes, real client (appended by Caddy) is constant
    assert.equal((await json(s.base, 'POST', '/api/quote', validQuote, { 'X-Forwarded-For': `9.9.9.${i}, 203.0.113.7` })).status, 200);
  }
  assert.equal((await json(s.base, 'POST', '/api/quote', validQuote, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.7' })).status, 429);
  // a different real client is not limited
  assert.equal((await json(s.base, 'POST', '/api/quote', validQuote, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.8' })).status, 200);
}));

test('without TRUST_PROXY X-Forwarded-For is ignored (socket address is used)', () => withServer({}, async (s) => {
  for (let i = 0; i < 5; i++) await json(s.base, 'POST', '/api/quote', validQuote, { 'X-Forwarded-For': `9.9.9.${i}` });
  assert.equal((await json(s.base, 'POST', '/api/quote', validQuote, { 'X-Forwarded-For': '8.8.8.8' })).status, 429);
}));

test('rate limiter memory is bounded: expired entries are evicted and the number of IPs is capped', () => {
  let t = 5_000_000;
  return withServer({ now: () => t, config: { trustProxy: true, limits: { maxTrackedIps: 3 } } }, async (s) => {
    for (let i = 0; i < 10; i++) await json(s.base, 'POST', '/api/quote', validQuote, { 'X-Forwarded-For': `10.0.0.${i}` });
    assert.ok(s.stats().tracked <= 3);
    t += 11 * 60 * 1000;
    await json(s.base, 'POST', '/api/quote', validQuote, { 'X-Forwarded-For': '10.0.1.1' });
    assert.equal(s.stats().tracked, 1);
  });
});

// ---------- 2 body limits ----------
test('body over 16 KB → 413 and no Salesforce call', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/quote', JSON.stringify({ ...validQuote, comment: 'x'.repeat(16 * 1024) }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).success, false);
  assert.equal(s.calls.sf.length, 0);
}));

test('invalid JSON → 400 (not 500) and no Salesforce call', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/quote', '{not json');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { success: false, errorMessage: 'Invalid JSON body.' });
  assert.equal(s.calls.sf.length, 0);
}));

test('non-JSON content type on POST and PATCH → 415', () => withServer({}, async (s) => {
  for (const method of ['POST', 'PATCH']) {
    const res = await fetch(s.base + '/api/quote', { method, headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(validQuote) });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).success, false);
  }
  const noType = await fetch(s.base + '/api/quote', { method: 'POST', body: '{}' });
  assert.equal(noType.status, 415);
  assert.equal(s.calls.sf.length, 0);
}));

// ---------- 3 validation ----------
test('POST validation rejects bad input with 400 and a clear message, never calling Salesforce', () => withServer({ config: { limits: { post: { max: 1000, windowMs: 1000 } } } }, async (s) => {
  const cases = [
    [{ ...validQuote, name: undefined }, 'name is required.'],
    [{ ...validQuote, company: '  ' }, 'company is required.'],
    [{ ...validQuote, email: undefined }, 'A valid email is required.'],
    [{ ...validQuote, email: 'not-an-email' }, 'A valid email is required.'],
    [{ ...validQuote, email: 'a@b.co' + 'x'.repeat(260) }, 'A valid email is required.'],
    [{ ...validQuote, layers: 0 }, 'layers must be a whole number between 1 and 64.'],
    [{ ...validQuote, layers: 65 }, 'layers must be a whole number between 1 and 64.'],
    [{ ...validQuote, quantity: 0 }, 'quantity must be a whole number between 1 and 1000000.'],
    [{ ...validQuote, quantity: 1000001 }, 'quantity must be a whole number between 1 and 1000000.'],
    [{ ...validQuote, width: -1 }, 'width must be a number between 0 and 10000.'],
    [{ ...validQuote, length: 10001 }, 'length must be a number between 0 and 10000.'],
    [{ ...validQuote, leadTimeDays: 366 }, 'leadTimeDays must be a number between 0 and 365.'],
    [{ ...validQuote, width: 'abc' }, 'width must be a number between 0 and 10000.'],
    [{ ...validQuote, name: 123 }, 'name must be a string.'],
    [[1, 2], 'Request body must be a JSON object.']
  ];
  for (const [body, msg] of cases) {
    const res = await json(s.base, 'POST', '/api/quote', body);
    assert.equal(res.status, 400, msg);
    assert.deepEqual(await res.json(), { success: false, errorMessage: msg });
  }
  assert.equal(s.calls.sf.length, 0);
}));

test('POST trims, caps lengths and drops unknown fields', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/quote', {
    ...validQuote, name: '  ' + 'n'.repeat(200) + '  ', company: 'c'.repeat(200), phone: 'p'.repeat(100),
    comment: 'k'.repeat(3000), message: 'm'.repeat(3000), boardType: 'b'.repeat(200), isAdmin: true, __proto__x: 1, extra: 'drop me'
  });
  assert.equal(res.status, 200);
  const b = s.calls.sf[0].body;
  assert.equal(b.name.length, 120);
  assert.equal(b.name[0], 'n');
  assert.equal(b.company.length, 120);
  assert.equal(b.phone.length, 40);
  assert.equal(b.comment.length, 2000);
  assert.equal(b.message.length, 2000);
  assert.equal(b.boardType.length, 80);
  assert.equal(b.isAdmin, undefined);
  assert.equal(b.extra, undefined);
  assert.equal(b.email, 'vince@summit.example');
  assert.equal(b.layers, 4);
}));

test('POST accepts null optional numbers (widget sends null when empty)', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/quote', { name: 'A', company: 'B', email: 'a@b.co', width: null, length: null, leadTimeDays: null, quantity: 5, layers: 2 });
  assert.equal(res.status, 200);
  assert.equal(s.calls.sf.length, 1);
}));

test('POST requires quantity: missing, null or blank → 400 "Quantity is required." and no Salesforce call', () => withServer({ config: { limits: { post: { max: 1000, windowMs: 1000 } } } }, async (s) => {
  for (const q of [undefined, null, '', '   ']) {
    const res = await json(s.base, 'POST', '/api/quote', { ...validQuote, quantity: q });
    assert.equal(res.status, 400, String(q));
    assert.deepEqual(await res.json(), { success: false, errorMessage: 'Quantity is required.' });
  }
  assert.equal(s.calls.sf.length, 0);
  const ok = await json(s.base, 'POST', '/api/quote', { ...validQuote, quantity: '120' });
  assert.equal(ok.status, 200);
  assert.equal(s.calls.sf[0].body.quantity, 120);
}));

test('PATCH validation: ids shaped like Salesforce ids and 1..2000 char message', () => withServer({ config: { limits: { patch: { max: 1000, windowMs: 1000 } } } }, async (s) => {
  const bad = [
    [{ conversationId: 'short', quoteId: QID, message: 'x' }, 'conversationId must be a Salesforce id.'],
    [{ conversationId: CID, quoteId: "0Q0'; DROP", message: 'x' }, 'quoteId must be a Salesforce id.'],
    [{ conversationId: CID, quoteId: QID, message: '   ' }, 'message is required.'],
    [{ conversationId: CID, quoteId: QID }, 'message is required.'],
    [{ conversationId: CID, quoteId: QID, message: 'x'.repeat(2001) }, 'message must be at most 2000 characters.']
  ];
  for (const [body, msg] of bad) {
    const res = await json(s.base, 'PATCH', '/api/quote', body);
    assert.equal(res.status, 400, msg);
    assert.deepEqual(await res.json(), { success: false, errorMessage: msg });
  }
  assert.equal(s.calls.sf.length, 0);
  assert.equal((await json(s.base, 'PATCH', '/api/quote', { conversationId: '001ABCDEFGHIJKL', quoteId: QID, message: 'x'.repeat(2000) })).status, 200);
}));

test('GET messages requires id-shaped conversationId and quoteId', () => withServer({}, async (s) => {
  for (const q of ['', `?conversationId=${CID}`, `?quoteId=${QID}`, `?conversationId=bad&quoteId=${QID}`, `?conversationId=${CID}&quoteId=a%27b`]) {
    const res = await fetch(`${s.base}/api/quote/messages${q}`);
    assert.equal(res.status, 400, q);
    assert.equal((await res.json()).success, false);
  }
  assert.equal(s.calls.sf.length, 0);
}));

// ---------- 4 honeypot ----------
test('honeypot: non-empty "website" → 200 {success:true} without Salesforce or n8n', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/quote', { ...validQuote, website: 'http://spam.example' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(s.calls.sf.length, 0);
  assert.equal(s.calls.notify.length, 0);
}));

test('empty "website" field is not a honeypot hit', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/quote', { ...validQuote, website: '' });
  assert.equal(res.status, 200);
  assert.equal(s.calls.sf.length, 1);
  assert.equal(s.calls.sf[0].body.website, undefined);
}));

test('widget marks Quantity as required with inline validation', async () => {
  const fs = await import('node:fs');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-widget.js'), 'utf8');
  assert.match(js, /name: 'quantity', label: 'Quantity', required: true/);
  assert.match(js, /Please enter a quantity\./);
});

test('widget form has a hidden honeypot input and sends it', async () => {
  const fs = await import('node:fs');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-widget.js'), 'utf8');
  assert.match(js, /name: 'website'/);
  assert.match(js, /'aria-hidden': 'true'/);
  assert.match(js, /tabindex: '-1'/);
  assert.match(js, /autocomplete: 'off'/);
  assert.match(js, /website: honeypotValue\(\)/);
});

// ---------- 5 headers ----------
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://www.htglobalcircuits.com https://fonts.googleapis.com; img-src 'self' data: https://www.htglobalcircuits.com https://htglobalcircuits.com https://www.details-enterprise-7.com; font-src 'self' data: https://www.htglobalcircuits.com https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'";

function assertSecurityHeaders(res) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(res.headers.get('content-security-policy'), CSP);
}

test('security headers on static, API, error and 429 responses', () => withServer({ config: { limits: { post: { max: 1, windowMs: 60000 } } } }, async (s) => {
  assertSecurityHeaders(await fetch(s.base + '/'));
  assertSecurityHeaders(await fetch(s.base + '/api/health'));
  assertSecurityHeaders(await fetch(s.base + '/nope'));
  assertSecurityHeaders(await json(s.base, 'POST', '/api/quote', '{bad'));
  assertSecurityHeaders(await json(s.base, 'POST', '/api/quote', validQuote));
  const limited = await json(s.base, 'POST', '/api/quote', validQuote);
  assert.equal(limited.status, 429);
  assertSecurityHeaders(limited);
}));

test('/robots.txt disallows everything', () => withServer({}, async (s) => {
  const res = await fetch(s.base + '/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(await res.text(), 'User-agent: *\nDisallow: /\n');
}));

test('real index.html and quote.html carry the noindex meta tag and the repo has a robots.txt file', async () => {
  const fs = await import('node:fs');
  for (const f of ['index.html', 'quote.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  }
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'public', 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
});

// ---------- 6 static ----------
test('static: content types', () => withServer({}, async (s) => {
  const expect = { '/assets/a.png': 'image/png', '/assets/f.woff2': 'font/woff2', '/assets/i.ico': 'image/x-icon', '/assets/x.jpg': 'image/jpeg', '/assets/x.webp': 'image/webp', '/assets/m.json': 'application/json', '/assets/n.txt': 'text/plain' };
  for (const [p, ct] of Object.entries(expect)) {
    const res = await fetch(s.base + p);
    assert.equal(res.status, 200, p);
    assert.ok(res.headers.get('content-type').startsWith(ct), `${p}: ${res.headers.get('content-type')}`);
  }
}));

test('static: path traversal (raw, encoded, double-encoded, sibling prefix) → 404 without leaking paths', () => withServer({}, async (s) => {
  const dir = s; void dir;
  const attempts = ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/%2e%2e%2fserver.js', '/assets/..%2f..%2fserver.js', '/..%5cserver.js', '/%252e%252e/server.js', '/..//..//etc/passwd', '/%00', '/assets/%'];
  for (const p of attempts) {
    const res = await raw(s.port, 'GET', p);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(res.body, /\/tmp|\/home|htweb|ENOENT|server\.js/);
  }
}));

test('static: dotfiles and directories are not served', () => withServer({}, async (s) => {
  assert.equal((await fetch(s.base + '/.secret')).status, 404);
  assert.equal((await fetch(s.base + '/assets/')).status, 404);
  assert.equal((await fetch(s.base + '/assets')).status, 404);
}));

test('static: only GET/HEAD; HEAD returns headers without body', () => withServer({}, async (s) => {
  const head = await fetch(s.base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await fetch(s.base + '/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.equal((await fetch(s.base + '/index.html', { method: 'DELETE' })).status, 405);
}));

test('unknown path → 404 body without filesystem paths', () => withServer({}, async (s) => {
  const res = await fetch(s.base + '/does/not/exist.html');
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.doesNotMatch(text, /\/tmp|\/home|ENOENT|htweb/);
  assert.ok(text.length < 300);
}));

test('API routes: unsupported methods → 405 with Allow, never calling Salesforce; unknown /api path → 404', () => withServer({}, async (s) => {
  const del = await fetch(s.base + '/api/quote', { method: 'DELETE' });
  assert.equal(del.status, 405);
  assert.equal(del.headers.get('allow'), 'POST, PATCH');
  const get = await fetch(s.base + '/api/quote');
  assert.equal(get.status, 405);
  const post = await json(s.base, 'POST', '/api/quote/messages', {});
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  const health = await json(s.base, 'POST', '/api/health', {});
  assert.equal(health.status, 405);
  assert.equal((await fetch(s.base + '/api/other')).status, 404);
  assert.equal(s.calls.sf.length, 0);
}));

// ---------- 7 errors ----------
test('Salesforce failure → 502 generic body, detail logged as one JSON line without secrets or message bodies', () => withServer({ sfImpl: () => { throw new Error('JWT login failed: invalid_grant at /run/secrets/ht/server.key'); } }, async (s) => {
  const res = await json(s.base, 'POST', '/api/quote', { ...validQuote, comment: 'TOP-SECRET-COMMENT' });
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), GENERIC);
  assert.doesNotMatch(text, /JWT|secrets|invalid_grant/);
  assert.equal(s.calls.notify.length, 0);
  const errLines = s.calls.logs.filter((l) => l.includes('invalid_grant'));
  assert.equal(errLines.length, 1);
  const parsed = JSON.parse(errLines[0]);
  assert.equal(parsed.level, 'error');
  assert.doesNotMatch(s.calls.logs.join('\n'), /TOP-SECRET-COMMENT|vince@summit/);
}));

test('Salesforce success:false answer → 502 generic (no upstream text leaked)', () => withServer({ sfImpl: () => ({ success: false, errorMessage: 'INTERNAL: field Foo__c missing' }) }, async (s) => {
  const res = await json(s.base, 'PATCH', '/api/quote', { conversationId: CID, quoteId: QID, message: 'hi' });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), GENERIC);
  assert.equal(s.calls.notify.length, 0);
}));

// ---------- 8 health ----------
test('GET /api/health → 200 {ok:true} only', () => withServer({}, async (s) => {
  const res = await fetch(s.base + '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
}));

// ---------- 9 process ----------
test('node server.js: startup log line, listens on PORT, SIGTERM exits 0', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', N8N_AGENT_WEBHOOK_URL: '', N8N_AGENT_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no startup line: ' + out)), 5000);
    child.stdout.on('data', () => {
      const m = out.match(/"msg":"listening".*?"port":(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
  });
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.deepEqual(await res.json(), { ok: true });
  const exit = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  child.kill('SIGTERM');
  const { code } = await exit;
  assert.equal(code, 0);
  assert.match(out, /"host":"0\.0\.0\.0"/);
});
