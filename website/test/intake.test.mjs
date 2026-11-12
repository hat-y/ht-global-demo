import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start, json, validQuote, QID, CID } from './helpers.mjs';

async function withServer(opts, fn) {
  const s = await start(opts);
  try { await fn(s); } finally { await s.close(); }
}
const ORDER = ['name', 'company', 'email', 'phone', 'boardType', 'singleUpOrArray', 'unitOfMeasure', 'width', 'length', 'layers', 'quantity', 'itarClassification'];
const FULL = { name: 'Vince Carter', company: 'Summit Avionics', email: 'vince@summit.example', phone: '+1 555 0100', boardType: 'Rigid PCB', singleUpOrArray: 'Single Up', unitOfMeasure: 'mm', width: 100, length: 80, layers: 4, quantity: 500, itarClassification: 'Commercial' };

test('intake happy path: forwards history/fields/message to n8n and returns reply, chips, merged fields, missing, complete', () => withServer({
  intakeImpl: async () => ({
    reply: 'Great, a rigid board. How many layers?',
    quickReplies: [{ label: '2', value: '2 layers' }, { label: '4', value: '4 layers' }],
    fieldUpdates: { boardType: 'Rigid PCB' }
  })
}, async (s) => {
  const body = { history: [{ role: 'assistant', text: 'Hi! What do you need?' }], fields: { name: 'Vince Carter' }, message: 'a rigid board' };
  const res = await json(s.base, 'POST', '/api/intake', body);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.reply, 'Great, a rigid board. How many layers?');
  assert.deepEqual(j.quickReplies, [{ label: '2', value: '2 layers' }, { label: '4', value: '4 layers' }]);
  assert.deepEqual(j.fields, { name: 'Vince Carter', boardType: 'Rigid PCB' });
  assert.deepEqual(j.missing, ORDER.filter((k) => k !== 'name' && k !== 'boardType'));
  assert.equal(j.complete, false);
  assert.deepEqual(s.calls.intake, [{ history: body.history, fields: { name: 'Vince Carter' }, message: 'a rigid board' }]);
  assert.equal(s.calls.sf.length, 0, 'nothing is written to Salesforce');
  assert.equal(res.headers.get('cache-control'), 'no-store');
}));

test('intake: first open (message null) is forwarded as null', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: null });
  assert.equal(res.status, 200);
  assert.equal(s.calls.intake[0].message, null);
  assert.equal((await res.json()).reply, 'Hello!');
}));

test('intake: fieldUpdates are validated with the quote rules: invalid values dropped, valid kept and normalized', () => withServer({
  intakeImpl: async () => ({
    reply: 'ok',
    fieldUpdates: {
      email: 'not-an-email', layers: 99, quantity: '500', width: -3, length: '80', boardType: 'flex', singleUpOrArray: 'Sideways',
      unitOfMeasure: 'in', itarClassification: 'commercial', leadTimeDays: 400, phone: '+1 555 0100', bogus: 'x', comment: 'x'.repeat(2500)
    }
  })
}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi' })).json();
  assert.deepEqual(j.fields, { quantity: 500, length: 80, boardType: 'Flex PCB', unitOfMeasure: 'inches', itarClassification: 'Commercial', phone: '+1 555 0100', comment: 'x'.repeat(2000) });
  assert.ok(j.missing.includes('email') && j.missing.includes('layers') && j.missing.includes('width') && j.missing.includes('singleUpOrArray'));
  assert.equal('bogus' in j.fields, false);
}));

test('intake: an invalid update never replaces an existing valid value', () => withServer({
  intakeImpl: async () => ({ reply: 'ok', fieldUpdates: { quantity: 0, layers: 6 } })
}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { quantity: 100 }, message: 'hi' })).json();
  assert.equal(j.fields.quantity, 100);
  assert.equal(j.fields.layers, 6);
}));

test('intake: missing and complete are computed server-side even when n8n claims otherwise', () => withServer({
  intakeImpl: async () => ({ reply: 'All done!', quickReplies: [], fieldUpdates: { name: 'Vince' }, complete: true, missing: [] })
}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi' })).json();
  assert.equal(j.complete, false);
  assert.deepEqual(j.missing, ORDER.filter((k) => k !== 'name'));
}));

test('intake: complete is true when every required field is valid (optional ones are not required)', () => withServer({
  intakeImpl: async () => ({ reply: 'Looks complete.', fieldUpdates: { itarClassification: 'Commercial' } })
}, async (s) => {
  const { itarClassification, ...rest } = FULL;
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: rest, message: 'commercial' })).json();
  assert.equal(j.complete, true);
  assert.deepEqual(j.missing, []);
  assert.deepEqual(j.fields, FULL);
}));

test('intake: quick replies are capped at 7, labels at 40 chars, sanitized, junk dropped', () => withServer({
  intakeImpl: async () => ({
    reply: 'Pick one',
    quickReplies: [
      ...Array.from({ length: 9 }, (_, i) => ({ label: `Option ${i}`, value: `v${i}` })),
    ]
  })
}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi' })).json();
  assert.equal(j.quickReplies.length, 7);
}));

test('intake: quick reply label cut to 40 chars, control characters removed, non-string/empty entries dropped, bare strings accepted', () => withServer({
  intakeImpl: async () => ({
    reply: 'Pick\u0000 one',
    quickReplies: [{ label: 'L'.repeat(60), value: 'long' }, { label: 'A\u0007B', value: 'ab' }, { label: '', value: 'x' }, { label: 5 }, null, 'Plain', { label: 'No value' }]
  })
}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi' })).json();
  assert.equal(j.reply, 'Pick one');
  assert.deepEqual(j.quickReplies, [{ label: 'L'.repeat(40), value: 'long' }, { label: 'AB', value: 'ab' }, { label: 'Plain', value: 'Plain' }, { label: 'No value', value: 'No value' }]);
}));

test('intake: n8n failure → 200 with a deterministic fallback that asks for the first missing field with its chips, and logs it', () => withServer({
  intakeImpl: async () => { throw new Error('boom'); }
}, async (s) => {
  const first = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: null });
  assert.equal(first.status, 200);
  const a = await first.json();
  assert.match(a.reply, /name/i);
  assert.deepEqual(a.quickReplies, []);
  assert.equal(a.complete, false);
  assert.equal(a.missing[0], 'name');
  assert.ok(s.calls.logs.some((l) => l.includes('intake_fallback')));
  assert.ok(!JSON.stringify(a).includes('boom'));

  const board = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { name: 'A', company: 'B', email: 'a@b.co', phone: '1' }, message: null })).json();
  assert.match(board.reply, /type of board/i);
  assert.deepEqual(board.quickReplies.map((q) => q.value), ['Rigid PCB', 'Flex PCB', 'Rigid-Flex PCB', 'HDI PCB', 'Metal Core PCB', 'High Frequency PCB']);
}));

test('intake fallback parses the answer to its own question, so the intake never loops', () => withServer({
  intakeImpl: async () => { throw new Error('down'); }
}, async (s) => {
  let state = { history: [], fields: {}, message: null };
  const answers = ['Vince Carter', 'Summit Avionics', 'vince@summit.example', '+1 555 0100', 'Rigid PCB', 'Single Up', 'mm', '100', '80', '4', '500', 'Commercial'];
  let j = await (await json(s.base, 'POST', '/api/intake', state)).json();
  for (const answer of answers) {
    state = { history: [...state.history, ...(state.message ? [{ role: 'customer', text: state.message }] : []), { role: 'assistant', text: j.reply }], fields: j.fields, message: answer };
    j = await (await json(s.base, 'POST', '/api/intake', state)).json();
  }
  assert.equal(j.complete, true);
  assert.deepEqual(j.fields, FULL);
  assert.match(j.reply, /summary/i);
}));

test('intake fallback re-asks with a hint when the answer does not fit', () => withServer({
  intakeImpl: async () => { throw new Error('down'); }
}, async (s) => {
  const first = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { name: 'A', company: 'B', email: 'a@b.co', phone: '1' }, message: null })).json();
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: first.reply }], fields: { name: 'A', company: 'B', email: 'a@b.co', phone: '1' }, message: 'something odd' })).json();
  assert.match(j.reply, /^Sorry, I didn.t catch that\./);
  assert.equal(j.quickReplies.length, 6);
  assert.equal('boardType' in j.fields, false);
}));

test('intake: an empty or invalid n8n answer also falls back; a webhook timeout never reaches the visitor as an error', () => withServer({
  intakeImpl: async () => ({ reply: '   ', fieldUpdates: {} })
}, async (s) => {
  const res = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: null });
  assert.equal(res.status, 200);
  assert.match((await res.json()).reply, /name/i);
}));

test('intake: the default n8n call sends X-HT-Agent-Secret and the same {history, fields, message}, with a 15 s timeout, and falls back on an HTTP error', async () => {
  const seen = [];
  const n8n = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      seen.push({ secret: req.headers['x-ht-agent-secret'], body: JSON.parse(data), url: req.url });
      if (seen.length === 1) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ reply: 'From n8n', quickReplies: [], fieldUpdates: { name: 'Zed' } })); }
      else { res.writeHead(500); res.end('nope'); }
    });
  });
  await new Promise((r) => n8n.listen(0, '127.0.0.1', r));
  const prev = { u: process.env.N8N_INTAKE_WEBHOOK_URL, s: process.env.N8N_AGENT_SECRET };
  process.env.N8N_INTAKE_WEBHOOK_URL = `http://127.0.0.1:${n8n.address().port}/webhook/ht-global/pcb-intake`;
  process.env.N8N_AGENT_SECRET = 'sekret';
  const { createServer } = await import('../server.js');
  const { makePublicDir } = await import('./helpers.mjs');
  const server = createServer({ callSalesforce: async () => ({ success: true }), log: () => {}, config: { publicDir: makePublicDir() } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await (await json(base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi' })).json();
    assert.equal(ok.reply, 'From n8n');
    assert.deepEqual(ok.fields, { name: 'Zed' });
    assert.equal(seen[0].secret, 'sekret');
    assert.equal(seen[0].url, '/webhook/ht-global/pcb-intake');
    assert.deepEqual(seen[0].body, { history: [], fields: {}, message: 'hi' });
    const bad = await json(base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi' });
    assert.equal(bad.status, 200);
    assert.match((await bad.json()).reply, /name/i);
    delete process.env.N8N_INTAKE_WEBHOOK_URL;
    const unset = await json(base, 'POST', '/api/intake', { history: [], fields: {}, message: null });
    assert.equal(unset.status, 200);
  } finally {
    if (prev.u === undefined) delete process.env.N8N_INTAKE_WEBHOOK_URL; else process.env.N8N_INTAKE_WEBHOOK_URL = prev.u;
    if (prev.s === undefined) delete process.env.N8N_AGENT_SECRET; else process.env.N8N_AGENT_SECRET = prev.s;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await new Promise((r) => n8n.close(r));
  }
});

test('intake: rate limit per IP → 429 with Retry-After, n8n not called', () => withServer({ config: { limits: { intake: { max: 2, windowMs: 600000 } } } }, async (s) => {
  for (let i = 0; i < 2; i++) assert.equal((await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: null })).status, 200);
  const res = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: null });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  assert.deepEqual(await res.json(), { success: false, errorMessage: 'Too many requests. Please try again later.' });
  assert.equal(s.calls.intake.length, 2);
}));

test('intake: the intake bucket is separate from the quote bucket', () => withServer({ config: { limits: { intake: { max: 1, windowMs: 600000 } } } }, async (s) => {
  await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: null });
  assert.equal((await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: null })).status, 429);
  assert.equal((await json(s.base, 'POST', '/api/quote', validQuote)).status, 200);
}));

test('intake: input caps → 400 and n8n is not called', () => withServer({}, async (s) => {
  const turn = (i) => ({ role: i % 2 ? 'customer' : 'assistant', text: 'x' });
  const bad = [
    { history: Array.from({ length: 31 }, (_, i) => turn(i)), fields: {}, message: 'hi' },
    { history: [{ role: 'assistant', text: 'x'.repeat(2001) }], fields: {}, message: 'hi' },
    { history: [{ role: 'robot', text: 'x' }], fields: {}, message: 'hi' },
    { history: [{ role: 'customer', text: 5 }], fields: {}, message: 'hi' },
    { history: 'nope', fields: {}, message: 'hi' },
    { history: [], fields: {}, message: 'x'.repeat(2001) },
    { history: [], fields: {}, message: 42 },
    { history: [], fields: {}, message: '   ' },
    { history: [], fields: { color: 'blue' }, message: 'hi' },
    { history: [], fields: [], message: 'hi' }
  ];
  for (const b of bad) {
    const res = await json(s.base, 'POST', '/api/intake', b);
    assert.equal(res.status, 400, JSON.stringify(b).slice(0, 80));
    assert.equal((await res.json()).success, false);
  }
  assert.equal(s.calls.intake.length, 0);
  // exactly at the caps is accepted
  const ok = await json(s.base, 'POST', '/api/intake', { history: Array.from({ length: 30 }, (_, i) => ({ ...turn(i), text: 'y'.repeat(2000) })), fields: {}, message: 'z'.repeat(2000) });
  assert.equal(ok.status, 200);
}));

test('intake: only POST, JSON content type, and the honeypot is respected (no n8n call)', () => withServer({}, async (s) => {
  assert.equal((await fetch(`${s.base}/api/intake`)).status, 405);
  assert.equal((await fetch(`${s.base}/api/intake`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  const res = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi', website: 'http://spam' });
  assert.equal(res.status, 200);
  assert.equal(s.calls.intake.length, 0);
  assert.equal(s.calls.sf.length, 0);
}));

test('intake: tolerates missing history/fields (treated as empty)', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/intake', { message: null });
  assert.equal(res.status, 200);
  assert.deepEqual(s.calls.intake[0], { history: [], fields: {}, message: null });
}));

// ---------- POST /api/quote transcript ----------
test('POST /api/quote passes a valid transcript to Salesforce (blank turns dropped, trimmed)', () => withServer({}, async (s) => {
  const transcript = [{ role: 'assistant', text: 'Hi!' }, { role: 'customer', text: ' Rigid, 4 layers ' }, { role: 'customer', text: '   ' }];
  const res = await json(s.base, 'POST', '/api/quote', { ...validQuote, transcript });
  assert.equal(res.status, 200);
  assert.deepEqual(s.calls.sf[0].body.transcript, [{ role: 'assistant', text: 'Hi!' }, { role: 'customer', text: 'Rigid, 4 layers' }]);
  assert.deepEqual(s.calls.notify, [['rfq_created', CID, QID]]);
}));

test('POST /api/quote transcript: 60 items of 2000 chars are accepted; 61 items, 2001 chars, bad role, non-array → 400 with no Salesforce call', () => withServer({ config: { limits: { post: { max: 50, windowMs: 600000 } } } }, async (s) => {
  const ok = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'customer' : 'assistant', text: 'x'.repeat(2000) }));
  assert.equal((await json(s.base, 'POST', '/api/quote', { ...validQuote, transcript: ok })).status, 200);
  assert.equal(s.calls.sf[0].body.transcript.length, 60);
  const before = s.calls.sf.length;
  const bad = [
    [...ok, { role: 'customer', text: 'one more' }],
    [{ role: 'customer', text: 'x'.repeat(2001) }],
    [{ role: 'robot', text: 'hi' }],
    [{ role: 'customer' }],
    'not an array'
  ];
  for (const transcript of bad) {
    const res = await json(s.base, 'POST', '/api/quote', { ...validQuote, transcript });
    assert.equal(res.status, 400, JSON.stringify(transcript).slice(0, 60));
  }
  assert.equal(s.calls.sf.length, before);
}));

test('POST /api/quote without a transcript sends none, and a plain body is still capped at 16 KB', () => withServer({}, async (s) => {
  await json(s.base, 'POST', '/api/quote', validQuote);
  assert.equal('transcript' in s.calls.sf[0].body, false);
  const res = await json(s.base, 'POST', '/api/quote', JSON.stringify({ ...validQuote, comment: 'x'.repeat(16 * 1024) }));
  assert.equal(res.status, 413);
}));

// ---- S24: deferred required fields and option descriptions ----
test('intake: deferred is accepted, forwarded to n8n, echoed (only still-missing names) and moved to the end of missing', () => withServer({
  intakeImpl: async () => ({ reply: 'ok', quickReplies: [], fieldUpdates: { phone: '+1 555 0100' } })
}, async (s) => {
  const body = { history: [], fields: { name: 'Jordan', company: 'Acme' }, deferred: ['email', 'phone', 'name', 'bogus'], message: 'later' };
  const j = await (await json(s.base, 'POST', '/api/intake', body)).json();
  assert.deepEqual(j.deferred, ['email']); // phone got filled, name already present, bogus unknown
  assert.deepEqual(j.missing, ORDER.filter((k) => !['name', 'company', 'phone', 'email'].includes(k)).concat(['email']));
  assert.equal(j.complete, false);
  assert.deepEqual(s.calls.intake[0].deferred, ['email', 'phone']);
}));

test('intake: n8n may add to deferred; names are validated and deduplicated', () => withServer({
  intakeImpl: async () => ({ reply: 'No worries', quickReplies: [], fieldUpdates: {}, deferred: ['email', 'email', 'nope', 7] })
}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { name: 'A' }, message: 'x' })).json();
  assert.deepEqual(j.deferred, ['email']);
  assert.equal(j.missing[j.missing.length - 1], 'email');
  assert.equal(j.missing[0], 'company');
}));

test('intake: no deferred → [] in the response and the payload to n8n is unchanged', () => withServer({}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: null })).json();
  assert.deepEqual(j.deferred, []);
  assert.deepEqual(j.missing, ORDER);
  assert.equal('deferred' in s.calls.intake[0], false);
}));

test('intake: deferred must be an array of at most 12 strings → 400 and n8n not called', () => withServer({}, async (s) => {
  for (const bad of ['email', { a: 1 }, new Array(13).fill('email'), [1]]) {
    const res = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, deferred: bad, message: 'x' });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(s.calls.intake.length, 0);
}));

test('intake: complete ignores deferred (all required present)', () => withServer({}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: FULL, deferred: ['email'], message: 'x' })).json();
  assert.equal(j.complete, true);
  assert.deepEqual(j.missing, []);
  assert.deepEqual(j.deferred, []);
}));

test('intake: quick reply description is kept (sanitized, ≤ 60) and dropped when invalid or too long', () => withServer({
  intakeImpl: async () => ({ reply: 'Pick', quickReplies: [
    { label: 'Rigid PCB', value: 'Rigid PCB', description: 'Standard FR-4,\u0007 the most common choice' },
    { label: 'Flex PCB', value: 'Flex PCB', description: 'x'.repeat(61) },
    { label: 'HDI PCB', value: 'HDI PCB', description: 42 },
    { label: 'Array', value: 'Array', description: '   ' },
    { label: 'Other', value: 'Other' }
  ], fieldUpdates: {} })
}, async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'x' })).json();
  assert.deepEqual(j.quickReplies, [
    { label: 'Rigid PCB', value: 'Rigid PCB', description: 'Standard FR-4, the most common choice' },
    { label: 'Flex PCB', value: 'Flex PCB' },
    { label: 'HDI PCB', value: 'HDI PCB' },
    { label: 'Array', value: 'Array' },
    { label: 'Other', value: 'Other' }
  ]);
}));

test('intake fallback respects deferred: asks the next field, then the deferred one last', () => withServer({
  intakeImpl: async () => { throw new Error('down'); }
}, async (s) => {
  let j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { name: 'A', company: 'B' }, deferred: ['email'], message: null })).json();
  assert.match(j.reply, /phone number/);
  assert.deepEqual(j.deferred, ['email']);
  assert.equal(j.missing[j.missing.length - 1], 'email');
  const rest = { ...FULL }; delete rest.email;
  j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: rest, deferred: ['email'], message: null })).json();
  assert.match(j.reply, /email/i);
  assert.deepEqual(j.missing, ['email']);
}));

test('intake: asking is passed through when it is a field name, null otherwise', () => withServer({
  intakeImpl: async (p) => ({ reply: 'ok', fieldUpdates: {}, asking: p.message === 'a' ? 'email' : 'bogus' })
}, async (s) => {
  assert.equal((await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'a' })).json()).asking, 'email');
  assert.equal((await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'b' })).json()).asking, null);
}));
