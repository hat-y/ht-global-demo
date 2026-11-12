import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, upload, MAGIC, QID, CID } from './helpers.mjs';

const GENERIC = { success: false, errorMessage: 'Something went wrong. Please try again.' };
const named = (name, extra = {}) => ({ 'X-File-Name': encodeURIComponent(name), ...extra });
const LIMITS = { upload: { max: 1000, windowMs: 1000 } };

async function withServer(opts, fn) {
  const s = await start(opts);
  try { await fn(s); } finally { await s.close(); }
}
const nothingStored = (s) => {
  assert.equal(s.calls.upload.length, 0, 'no file was stored');
  assert.equal(s.calls.sf.filter((c) => c.method !== 'GET').length, 0, 'no conversation message / flag was written');
  assert.equal(s.calls.notify.length, 0, 'the agent was not notified');
};
const clean = { config: { limits: LIMITS } };

// ---------- happy path ----------
test('upload pdf: verifies the pair first, stores the file on the quote, adds the 📎 message, notifies the agent', () => withServer(clean, async (s) => {
  const body = Buffer.concat([MAGIC.pdf(), Buffer.alloc(1200 * 1024)]);
  const res = await upload(s.base, { headers: named('drawing.pdf'), body });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { success: true, file: { name: 'drawing.pdf', size: body.length, gerbers: false } });
  // 1) pair verification goes first and is verify-only
  assert.equal(s.calls.sf[0].method, 'GET');
  const q = new URLSearchParams(s.calls.sf[0].query);
  assert.deepEqual([q.get('conversationId'), q.get('quoteId'), q.get('verify')], [CID, QID, '1']);
  // 2) the file goes to the quote
  assert.equal(s.calls.upload.length, 1);
  assert.equal(s.calls.upload[0].quoteId, QID);
  assert.equal(s.calls.upload[0].name, 'drawing.pdf');
  assert.ok(Buffer.compare(s.calls.upload[0].buffer, body) === 0);
  // 3) the conversation message (English), no Gerbers flag
  assert.equal(s.calls.sf[1].method, 'PATCH');
  assert.deepEqual(s.calls.sf[1].body, { conversationId: CID, quoteId: QID, message: '\u{1F4CE} Attached: drawing.pdf (1.2 MB)' });
  assert.deepEqual(s.calls.notify, [['customer_message', CID, QID]]);
}));

test('upload message size format: bytes, KB and MB', () => withServer(clean, async (s) => {
  await upload(s.base, { headers: named('a.csv'), body: Buffer.from('a,b\n1,2\n') });
  await upload(s.base, { headers: named('b.pdf'), body: Buffer.concat([MAGIC.pdf(), Buffer.alloc(340 * 1024)]) });
  const msgs = s.calls.sf.filter((c) => c.method === 'PATCH').map((c) => c.body.message);
  assert.match(msgs[0], /^\u{1F4CE} Attached: a\.csv \(8 B\)$/u);
  assert.match(msgs[1], /^\u{1F4CE} Attached: b\.pdf \(340 KB\)$/u);
}));

for (const [name, magic] of [['board.zip', 'zip'], ['top.gbr', 'text'], ['odb.tgz', 'gz'], ['BOARD.ZIP', 'zip'], ['TOP.GBR', 'text']]) {
  test(`Gerber/ODB++ ${name} sets gerbersReceived on the conversation message`, () => withServer(clean, async (s) => {
    const res = await upload(s.base, { headers: named(name), body: MAGIC[magic]() });
    assert.equal(res.status, 200);
    assert.equal(res.json.file.gerbers, true);
    const patch = s.calls.sf.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.gerbersReceived, true);
  }));
}

for (const [name, magic] of [['a.pdf', 'pdf'], ['a.doc', 'ole'], ['a.docx', 'zip'], ['a.xls', 'ole'], ['a.xlsx', 'zip'], ['a.csv', 'csv'], ['a.jpg', 'jpg'], ['a.JPEG', 'jpg'], ['a.png', 'png']]) {
  test(`allowed non-Gerber type ${name} is stored and does NOT set the Gerbers flag`, () => withServer(clean, async (s) => {
    const res = await upload(s.base, { headers: named(name), body: MAGIC[magic]() });
    assert.equal(res.status, 200);
    assert.equal(res.json.file.gerbers, false);
    assert.equal('gerbersReceived' in s.calls.sf.find((c) => c.method === 'PATCH').body, false);
  }));
}

// ---------- 1. ids and pair, BEFORE storing anything ----------
test('ids must look like Salesforce ids: 400 and no Salesforce call at all', () => withServer(clean, async (s) => {
  for (const query of ['', `?conversationId=${CID}`, `?quoteId=${QID}`, `?conversationId=x&quoteId=${QID}`, `?conversationId=${CID}&quoteId=0Q0'; DROP`]) {
    const res = await upload(s.base, { query, headers: named('a.pdf'), body: MAGIC.pdf() });
    assert.equal(res.status, 400, query);
    assert.equal(res.json.success, false);
  }
  assert.equal(s.calls.sf.length, 0);
  nothingStored(s);
}));

test('a conversation/quote pair that does not match is rejected with 404 and nothing is stored', () => withServer({ ...clean, sfImpl: (m) => (m === 'GET' ? { success: false, errorMessage: 'Conversation not found' } : { success: true }) }, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { success: false, errorMessage: 'Conversation not found.' });
  assert.equal(s.calls.sf.length, 1); // only the verification
  nothingStored(s);
}));

test('pair verification failure upstream → 502 generic and nothing stored', () => withServer({ ...clean, sfImpl: () => { throw new Error('boom at /run/secrets/key'); } }, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, GENERIC);
  nothingStored(s);
}));

// ---------- 2. file name / extension ----------
test('extensions outside the allowlist are rejected with 415 before any Salesforce call', () => withServer(clean, async (s) => {
  for (const name of ['a.exe', 'a.pdf.exe', 'a.html', 'a.svg', 'a.js', 'a.php', 'a.gz', 'a.tar', 'a.txt', 'a.bat', 'a.docm', 'a', 'a.', '.pdf', '.gitignore']) {
    const res = await upload(s.base, { headers: named(name), body: MAGIC.pdf() });
    assert.equal(res.status, 415, name);
    assert.equal(res.json.success, false);
  }
  assert.equal(s.calls.sf.length, 0);
  nothingStored(s);
}));

test('double extensions that hide an executable/script type are rejected even when the last one is allowed', () => withServer(clean, async (s) => {
  for (const name of ['invoice.exe.pdf', 'x.php.png', 'x.HTML.jpg', 'x.js.zip', 'x.vbs.csv', 'x.sh.zip']) {
    const res = await upload(s.base, { headers: named(name), body: MAGIC.zip() });
    assert.equal(res.status, 415, name);
  }
  nothingStored(s);
}));

test('dots in a normal file name are fine (rev1.2_board.pdf)', () => withServer(clean, async (s) => {
  const res = await upload(s.base, { headers: named('rev1.2_board v3.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 200);
  assert.equal(res.json.file.name, 'rev1.2_board v3.pdf');
}));

test('names with path separators, NUL or control characters → 400 and nothing stored', () => withServer(clean, async (s) => {
  for (const name of ['../a.pdf', 'dir/a.pdf', 'dir\\a.pdf', 'a\u0000.pdf', 'a\nb.pdf', 'C:\\x\\a.pdf']) {
    const res = await upload(s.base, { headers: named(name), body: MAGIC.pdf() });
    assert.equal(res.status, 400, JSON.stringify(name));
  }
  const missing = await upload(s.base, { headers: {}, body: MAGIC.pdf() });
  assert.equal(missing.status, 400);
  const badEncoding = await upload(s.base, { headers: { 'X-File-Name': '%E0%A4%A' }, body: MAGIC.pdf() });
  assert.equal(badEncoding.status, 400);
  nothingStored(s);
}));

test('the stored name is sanitized (same name in the Salesforce file and in the message)', () => withServer(clean, async (s) => {
  const res = await upload(s.base, { headers: named('my <board> "final" #1 (rev 2)?.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 200);
  const safe = 'my _board_ _final_ _1 (rev 2)_.pdf';
  assert.equal(res.json.file.name, safe);
  assert.equal(s.calls.upload[0].name, safe);
  assert.ok(s.calls.sf.find((c) => c.method === 'PATCH').body.message.includes(`Attached: ${safe} (`));
}));

test('long names are shortened to 100 characters and keep the extension', () => withServer(clean, async (s) => {
  const res = await upload(s.base, { headers: named('x'.repeat(200) + '.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 200);
  assert.equal(res.json.file.name.length, 100);
  assert.ok(res.json.file.name.endsWith('.pdf'));
}));

// ---------- 3. size ----------
test('Content-Length over the limit → 413 immediately, nothing stored, no Salesforce call', () => withServer({ config: { limits: LIMITS, upload: { maxBytes: 1024 } } }, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf'), body: Buffer.concat([MAGIC.pdf(), Buffer.alloc(2048)]) });
  assert.equal(res.status, 413);
  assert.equal(s.calls.sf.length, 0);
  nothingStored(s);
}));

test('streamed body (no Content-Length) is cut off with 413 as soon as it exceeds the limit', () => withServer({ config: { limits: LIMITS, upload: { maxBytes: 1024 } } }, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf'), body: Buffer.concat([MAGIC.pdf(), Buffer.alloc(8192)]), chunked: true });
  assert.equal(res.status, 413);
  nothingStored(s);
}));

test('Content-Length that lies (smaller than the real body) cannot smuggle more bytes than it declares', () => withServer({ config: { limits: LIMITS, upload: { maxBytes: 1024 } } }, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf', { 'Content-Length': '100' }), body: Buffer.concat([MAGIC.pdf(), Buffer.alloc(8192)]), chunked: true }).catch(() => ({ status: 0 }));
  assert.ok([0, 200, 400, 413].includes(res.status), String(res.status));
  for (const f of s.calls.upload) assert.ok(f.buffer.length <= 100, 'never more than the declared length');
}));

test('6 MB file against the default limit → 413 and nothing stored; exactly 5 MB is accepted', async () => {
  await withServer(clean, async (s) => {
    const big = Buffer.alloc(6 * 1024 * 1024);
    MAGIC.pdf().copy(big);
    const res = await upload(s.base, { headers: named('big.pdf'), body: big });
    assert.equal(res.status, 413);
    nothingStored(s);
  });
  await withServer(clean, async (s) => {
    const edge = Buffer.alloc(5 * 1024 * 1024);
    MAGIC.pdf().copy(edge);
    const res = await upload(s.base, { headers: named('edge.pdf'), body: edge });
    assert.equal(res.status, 200);
    assert.equal(s.calls.sf.find((c) => c.method === 'PATCH').body.message, '\u{1F4CE} Attached: edge.pdf (5.0 MB)');
  });
});

test('empty file → 400 and nothing stored', () => withServer(clean, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf'), body: Buffer.alloc(0), chunked: true });
  assert.equal(res.status, 400);
  nothingStored(s);
}));

// ---------- 4. magic bytes ----------
test('content that does not match the extension → 415 and nothing stored', () => withServer(clean, async (s) => {
  const exe = Buffer.from('MZ\x90\x00 this is a Windows executable');
  const cases = [
    ['fake.pdf', exe], ['fake.png', MAGIC.pdf()], ['fake.jpg', MAGIC.png()], ['fake.zip', MAGIC.pdf()], ['fake.docx', exe],
    ['fake.xlsx', MAGIC.ole()], ['fake.doc', MAGIC.zip()], ['fake.xls', exe], ['fake.tgz', MAGIC.zip()],
    ['fake.csv', Buffer.concat([Buffer.from('a,b\n'), Buffer.from([0x00, 0x01]), Buffer.from('x')])],
    ['fake.gbr', Buffer.concat([Buffer.from('G04*\n'), Buffer.from([0xff, 0xfe, 0xfa])])],
    ['fake.csv', Buffer.concat([MAGIC.zip(), Buffer.from('a,b')])]
  ];
  for (const [name, body] of cases) {
    const res = await upload(s.base, { headers: named(name), body });
    assert.equal(res.status, 415, name);
    assert.deepEqual(res.json, { success: false, errorMessage: 'The file content does not match its type.' });
  }
  assert.equal(s.calls.sf.filter((c) => c.method !== 'GET').length, 0);
  nothingStored(s);
}));

test('a .exe renamed to .pdf is a 415 (the real E2E negative case)', () => withServer(clean, async (s) => {
  const res = await upload(s.base, { headers: named('invoice.pdf'), body: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]) });
  assert.equal(res.status, 415);
  nothingStored(s);
}));

// ---------- 5. content type, method ----------
test('Content-Type must be application/octet-stream → 415', () => withServer(clean, async (s) => {
  for (const type of ['application/json', 'text/plain', 'multipart/form-data; boundary=x']) {
    const res = await upload(s.base, { headers: named('a.pdf', { 'Content-Type': type }), body: MAGIC.pdf() });
    assert.equal(res.status, 415, type);
  }
  nothingStored(s);
}));

test('only POST is allowed on /api/quote/files', () => withServer(clean, async (s) => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    const res = await fetch(`${s.base}/api/quote/files?conversationId=${CID}&quoteId=${QID}`, { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST');
    await res.text();
  }
  assert.equal(s.calls.sf.length, 0);
}));

// ---------- 6. rate limit and concurrency ----------
test('per-IP upload limit: the 11th upload in the window is 429 with Retry-After and stores nothing', () => withServer({}, async (s) => {
  for (let i = 0; i < 10; i++) {
    const res = await upload(s.base, { headers: named(`a${i}.pdf`), body: MAGIC.pdf() });
    assert.equal(res.status, 200, String(i));
  }
  const res = await upload(s.base, { headers: named('a11.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers['retry-after']) >= 1);
  assert.deepEqual(res.json, { success: false, errorMessage: 'Too many requests. Please try again later.' });
  assert.equal(s.calls.upload.length, 10);
}));

test('the upload limit is configurable and independent from the other buckets', () => withServer({ config: { limits: { upload: { max: 1, windowMs: 60000 } } } }, async (s) => {
  assert.equal((await upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() })).status, 200);
  assert.equal((await upload(s.base, { headers: named('b.pdf'), body: MAGIC.pdf() })).status, 429);
  const msg = await fetch(`${s.base}/api/quote/messages?conversationId=${CID}&quoteId=${QID}`);
  assert.equal(msg.status, 200);
  await msg.text();
}));

test('rate limit is checked before the body is read: a limited client never reaches Salesforce', () => withServer({ config: { limits: { upload: { max: 1, windowMs: 60000 } } } }, async (s) => {
  await upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() });
  const before = s.calls.sf.length;
  const res = await upload(s.base, { headers: named('b.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 429);
  assert.equal(s.calls.sf.length, before);
}));

test('too many uploads in flight at once → 429 (memory bound)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withServer({ config: { limits: LIMITS, upload: { maxConcurrent: 1 } }, uploadImpl: async () => { await gate; return { id: '068g7000000AbCdAAK' }; } }, async (s) => {
    const first = upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() });
    while (s.calls.upload.length < 1) await new Promise((r) => setTimeout(r, 10));
    const second = await upload(s.base, { headers: named('b.pdf'), body: MAGIC.pdf() });
    assert.equal(second.status, 429);
    release();
    assert.equal((await first).status, 200);
    const third = await upload(s.base, { headers: named('c.pdf'), body: MAGIC.pdf() });
    assert.equal(third.status, 200);
  });
});

// ---------- 7. failures: generic bodies, no half-state surprises ----------
test('Salesforce file storage failure → 502 generic, detail only in the log, no message written, agent not notified', () => withServer({ ...clean, uploadImpl: async () => { throw new Error('INSUFFICIENT_ACCESS at /run/secrets/ht/server.key'); } }, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, GENERIC);
  assert.equal(res.body.includes('INSUFFICIENT'), false);
  assert.equal(s.calls.sf.filter((c) => c.method === 'PATCH').length, 0);
  assert.equal(s.calls.notify.length, 0);
  assert.ok(s.calls.logs.some((l) => l.includes('upload_failed')));
}));

test('message write failure after the file was stored → 200 stored:true, messageLogged:false, no agent notify, one upload, logged', () => withServer({ ...clean, sfImpl: (m) => (m === 'GET' ? { success: true } : { success: false, errorMessage: 'FIELD_CUSTOM_VALIDATION secret detail' }) }, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { success: true, stored: true, messageLogged: false });
  assert.equal(s.calls.notify.length, 0);
  assert.equal(s.calls.upload.length, 1);
  assert.ok(s.calls.logs.some((l) => l.includes('upload_without_message')));
  assert.equal(s.calls.logs.some((l) => l.includes('secret detail') && !l.includes('upstream_unsuccessful')), false);
}));

test('message write throwing after the file was stored → same 200 messageLogged:false', () => withServer({ ...clean, sfImpl: (m) => { if (m === 'GET') return { success: true }; throw new Error('down'); } }, async (s) => {
  const res = await upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { success: true, stored: true, messageLogged: false });
  assert.equal(s.calls.notify.length, 0);
}));

// ---------- stalled bodies ----------
function stalledUpload(base, headers) {
  const url = new URL(base + `/api/quote/files?conversationId=${CID}&quoteId=${QID}`);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'POST', path: url.pathname + url.search, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '5000', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: data }); });
    });
    req.on('error', (e) => { if (!req.res) reject(e); });
    req.write(MAGIC.pdf()); // a few bytes, then silence
  });
}
test('upload body that stalls past the idle timeout → 408 generic + Connection: close, nothing stored, slot released', () => withServer({ config: { limits: LIMITS, upload: { idleTimeoutMs: 150, maxConcurrent: 1 } } }, async (s) => {
  const res = await stalledUpload(s.base, named('slow.pdf'));
  assert.equal(res.status, 408);
  assert.equal(res.headers.connection, 'close');
  assert.deepEqual(JSON.parse(res.body), GENERIC);
  assert.equal(s.calls.upload.length, 0);
  assert.equal(s.calls.sf.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(s.calls.notify.length, 0);
  const ok = await upload(s.base, { headers: named('a.pdf'), body: MAGIC.pdf() });
  assert.equal(ok.status, 200, 'the single slot is free again');
}));

// ---------- text types: NUL / invalid UTF-8 ----------
for (const [name, body] of [
  ['nul.csv', Buffer.from('a,b\n1,\x002\n', 'latin1')],
  ['nul.gbr', Buffer.from('G04*\x00M02*\n', 'latin1')],
  ['bad.csv', Buffer.from([0x61, 0x2c, 0xc3, 0x28, 0x0a])],
  ['bad.gbr', Buffer.from([0x47, 0x30, 0x34, 0xff, 0xfe, 0x2a])]
]) {
  test(`${name}: NUL byte or invalid UTF-8 → 415 and nothing stored`, () => withServer(clean, async (s) => {
    const res = await upload(s.base, { headers: named(name), body });
    assert.equal(res.status, 415);
    assert.deepEqual(res.json, { success: false, errorMessage: 'The file content does not match its type.' });
    nothingStored(s);
  }));
}

// ---------- 8. logging ----------
test('one JSON log line per stored upload: name, size, type, quote id; never the content', () => withServer(clean, async (s) => {
  const body = Buffer.concat([MAGIC.pdf(), Buffer.from('SUPER-SECRET-CONTENT')]);
  await upload(s.base, { headers: named('drawing.pdf'), body });
  const lines = s.calls.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === 'file_uploaded');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, 'drawing.pdf');
  assert.equal(lines[0].size, body.length);
  assert.equal(lines[0].type, 'pdf');
  assert.equal(lines[0].quoteId, QID);
  assert.equal(JSON.stringify(s.calls.logs).includes('SUPER-SECRET'), false);
}));

test('security headers are present on upload responses (success and error)', () => withServer(clean, async (s) => {
  for (const name of ['a.pdf', 'a.exe']) {
    const res = await upload(s.base, { headers: named(name), body: MAGIC.pdf() });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
  }
}));

// ---------- PRESERVE: existing JSON routes keep their limits ----------
test('PRESERVE: JSON endpoints still reject bodies over 16 KB and keep application/json only', () => withServer({}, async (s) => {
  const big = await fetch(`${s.base}/api/quote`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: CID, quoteId: QID, message: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
  await big.text();
  const octet = await fetch(`${s.base}/api/quote`, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: '{}' });
  assert.equal(octet.status, 415);
  await octet.text();
}));

test('PRESERVE: PATCH /api/quote does not accept a client-supplied gerbersReceived flag', () => withServer({}, async (s) => {
  const res = await fetch(`${s.base}/api/quote`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: CID, quoteId: QID, message: 'hi', gerbersReceived: true }) });
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(s.calls.sf[0].body, { conversationId: CID, quoteId: QID, message: 'hi' });
}));

// ---------- batches: one agent reply per batch ----------
test('more=1 (not the last file of the batch) writes the message but does not notify the agent; the last one does', () => withServer(clean, async (s) => {
  const first = await upload(s.base, { query: `?conversationId=${CID}&quoteId=${QID}&more=1`, headers: named('a.pdf'), body: MAGIC.pdf() });
  assert.equal(first.status, 200);
  assert.equal(s.calls.sf.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(s.calls.notify.length, 0);
  const last = await upload(s.base, { headers: named('b.pdf'), body: MAGIC.pdf() });
  assert.equal(last.status, 200);
  assert.deepEqual(s.calls.notify, [['customer_message', CID, QID]]);
}));
