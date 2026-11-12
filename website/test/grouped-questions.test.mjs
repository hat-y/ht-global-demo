import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, json } from './helpers.mjs';

// T42 / S27: grouped questions (name+company, email+phone, size+unit).
const here = path.dirname(fileURLToPath(import.meta.url));
const wf = fs.readFileSync(path.join(here, '..', '..', 'n8n', 'ht-pcb-intake.workflow.ts'), 'utf8');

async function withDown(fn) {
  const s = await start({ intakeImpl: async () => { throw new Error('down'); } });
  try { await fn(s); } finally { await s.close(); }
}
// one fallback turn: prior = previous response (its reply becomes the last assistant turn)
async function turn(s, prior, message, deferred) {
  const body = { history: prior ? [{ role: 'assistant', text: prior.reply }] : [], fields: prior ? prior.fields : {}, message };
  if (deferred) body.deferred = deferred;
  return (await json(s.base, 'POST', '/api/intake', body)).json();
}
const ALL_BUT = { name: 'A B', company: 'C', email: 'a@b.co', phone: '5550100', boardType: 'Rigid PCB', singleUpOrArray: 'Single Up' };

// ---------- server fallback ----------
test('T42 fallback: the first open asks name and company together; email+phone and size are grouped too, with no chips', () => withDown(async (s) => {
  const a = await turn(s, null, null);
  assert.match(a.reply, /What.s your name and company\?$/);
  assert.deepEqual(a.quickReplies, []);
  assert.equal(a.asking, 'name');
  const b = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { name: 'A', company: 'B' }, message: null })).json();
  assert.match(b.reply, /What.s the best email and phone number to reach you\?$/);
  assert.deepEqual(b.quickReplies, []);
  const c = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: ALL_BUT, message: null })).json();
  assert.match(c.reply, /What.s the board size\? For example 100 × 80 mm or 4 × 3 in\.$/);
  assert.deepEqual(c.quickReplies, []);
  assert.equal(c.asking, 'width');
  assert.equal(c.sf, undefined);
  assert.equal(s.calls.sf.length, 0);
}));

test('T42 fallback: name and company in one answer', () => withDown(async (s) => {
  for (const [msg, name, company] of [
    ['Sam Rivera, Northpeak', 'Sam Rivera', 'Northpeak'],
    ["I'm Sam Rivera from Northpeak Drones", 'Sam Rivera', 'Northpeak Drones'],
    ['Hi, my name is Sam Rivera at Northpeak', 'Sam Rivera', 'Northpeak'],
    ['Sam Rivera - Northpeak', 'Sam Rivera', 'Northpeak'],
    ['Sam Rivera with Northpeak', 'Sam Rivera', 'Northpeak']
  ]) {
    const first = await turn(s, null, null);
    const j = await turn(s, first, msg);
    assert.equal(j.fields.name, name, msg);
    assert.equal(j.fields.company, company, msg);
    assert.match(j.reply, /email and phone number/);
  }
}));

test('T42 fallback: a partial name/company answer asks only for the missing part', () => withDown(async (s) => {
  const first = await turn(s, null, null);
  const j = await turn(s, first, 'Sam Rivera');
  assert.deepEqual(j.fields, { name: 'Sam Rivera' });
  assert.equal(j.reply, 'Thanks, Sam. And your company?');
  assert.deepEqual(j.quickReplies, []);
  const k = await turn(s, j, 'Northpeak');
  assert.equal(k.fields.company, 'Northpeak');
  assert.match(k.reply, /email and phone number/);
}));

test('T42 fallback: email and phone in one answer, or one at a time', () => withDown(async (s) => {
  const base = { history: [], fields: { name: 'A', company: 'B' }, message: null };
  const ask = await (await json(s.base, 'POST', '/api/intake', base)).json();
  const both = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: ask.reply }], fields: ask.fields, message: 'sam@northpeak.example, 555 0100' })).json();
  assert.equal(both.fields.email, 'sam@northpeak.example');
  assert.equal(both.fields.phone, '555 0100');
  assert.match(both.reply, /type of board/i);
  const only = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: ask.reply }], fields: ask.fields, message: 'sam@northpeak.example' })).json();
  assert.equal(only.fields.email, 'sam@northpeak.example');
  assert.equal('phone' in only.fields, false);
  assert.match(only.reply, /phone number/);
  assert.doesNotMatch(only.reply, /email/i);
  const ph = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: only.reply }], fields: only.fields, message: '+1 555 0100' })).json();
  assert.equal(ph.fields.phone, '+1 555 0100');
}));

test('T42 fallback: board size accepts the sample formats and captures width, length and unit together', () => withDown(async (s) => {
  const ask = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: ALL_BUT, message: null })).json();
  for (const [msg, w, l, u] of [
    ['100x80mm', 100, 80, 'mm'],
    ['4 by 3 inches', 4, 3, 'inches'],
    ['100 mm x 80 mm', 100, 80, 'mm'],
    ['4"x3"', 4, 3, 'inches'],
    ['60 × 40 mm', 60, 40, 'mm'],
    ['It is 2.5 x 1.5 in', 2.5, 1.5, 'inches']
  ]) {
    const j = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: ask.reply }], fields: ask.fields, message: msg })).json();
    assert.equal(j.fields.width, w, msg);
    assert.equal(j.fields.length, l, msg);
    assert.equal(j.fields.unitOfMeasure, u, msg);
    assert.match(j.reply, /layers/i, msg);
  }
}));

test('T42 fallback: a size without a unit asks only the unit, with mm / inches chips', () => withDown(async (s) => {
  const ask = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: ALL_BUT, message: null })).json();
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: ask.reply }], fields: ask.fields, message: '4 x 3' })).json();
  assert.equal(j.fields.width, 4);
  assert.equal(j.fields.length, 3);
  assert.equal('unitOfMeasure' in j.fields, false);
  assert.match(j.reply, /mm or inches\?$/);
  assert.deepEqual(j.quickReplies.map((q) => q.value), ['mm', 'inches']);
  assert.equal(j.asking, 'unitOfMeasure');
  const k = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: j.reply }], fields: j.fields, message: 'inches' })).json();
  assert.equal(k.fields.unitOfMeasure, 'inches');
  assert.match(k.reply, /layers/i);
}));

test('T42 fallback: a lone unit then a bare number, and a bare number first, are understood', () => withDown(async (s) => {
  const ask = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: ALL_BUT, message: null })).json();
  const u = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: ask.reply }], fields: ask.fields, message: 'mm' })).json();
  assert.equal(u.fields.unitOfMeasure, 'mm');
  assert.match(u.reply, /board size in mm/);
  const w = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: ask.reply }], fields: ask.fields, message: '100' })).json();
  assert.equal(w.fields.width, 100);
  assert.equal('length' in w.fields, false);
  assert.equal('unitOfMeasure' in w.fields, false);
}));

test('T42 fallback: a size answer that does not parse re-asks with a hint and changes nothing', () => withDown(async (s) => {
  const ask = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: ALL_BUT, message: null })).json();
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [{ role: 'assistant', text: ask.reply }], fields: ask.fields, message: 'pretty small' })).json();
  assert.match(j.reply, /^Sorry, I didn.t catch that\. What.s the board size\?/);
  assert.deepEqual(j.fields, ALL_BUT);
}));

test('T42 fallback: a deferred field is asked alone, even when its group partner is pending', () => withDown(async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { name: 'A', company: 'B' }, deferred: ['email'], message: null })).json();
  assert.match(j.reply, /phone number/);
  assert.doesNotMatch(j.reply, /email/i);
  const k = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { ...ALL_BUT, phone: undefined, name: 'A', company: 'B' }, deferred: ['email'], message: null })).json();
  assert.ok(k.reply);
}));

test('T42 preserve: option fields stay alone with their chips', () => withDown(async (s) => {
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { name: 'A', company: 'B', email: 'a@b.co', phone: '5550100' }, message: null })).json();
  assert.match(j.reply, /type of board/i);
  assert.equal(j.quickReplies.length, 6);
  const q = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: { ...ALL_BUT, unitOfMeasure: 'mm', width: 1, length: 2, layers: 4 }, message: null })).json();
  assert.match(q.reply, /How many boards/);
}));

// ---------- n8n nodes ----------
function nodeCode(name) {
  const i = wf.indexOf("name: '" + name + "'");
  const a = wf.indexOf('jsCode: `', i) + 'jsCode: `'.length;
  const b = wf.indexOf('`\n    },', a);
  return new Function('return `' + wf.slice(a, b) + '`')();
}
function runValidar(body) {
  const code = nodeCode('Validar Entrada').replace('__HT_AGENT_SECRET__', 's3cret');
  return new Function('$input', code)({ first: () => ({ json: { headers: { 'x-ht-agent-secret': 's3cret' }, body } }) })[0].json;
}
function runGuard(entJson, llmOutput) {
  const fn = new Function('$', nodeCode('Guard de Salida'));
  const stub = (n) => ({ first: () => ({ json: n === 'Validar Entrada' ? entJson : { output: typeof llmOutput === 'string' ? llmOutput : JSON.stringify(llmOutput) } }) });
  return fn(stub)[0].json;
}
const ent = (over) => ({ ok: true, fields: {}, deferred: [], message: null, history: [], heldFiles: [], ...over });
const vals = (r) => r.quickReplies.map((q) => q.value);
const NC = { name: 'Sam Rivera', company: 'Northpeak' };
const EP = { ...NC, email: 's@n.example', phone: '5550100' };
const BT = { ...EP, boardType: 'Rigid PCB', singleUpOrArray: 'Single Up' };

test('T42 n8n prompt: the first open asks for name and company', () => {
  const r = runValidar({ history: [], fields: {}, message: null });
  assert.match(r.sistema, /ask for their name and company/);
  assert.doesNotMatch(r.sistema, /ONE TOPIC PER MESSAGE/);
  assert.match(r.sistema, /GROUPED QUESTIONS/);
  assert.match(r.sistema, /Only these three groups|only these three groups/i);
  assert.match(r.sistema, /ONLY for the missing part/);
  assert.match(r.sistema, /askField "width"/);
  assert.match(r.sistema, /unit alone/);
});

const nl = (t) => t.match(/\nNext field to ask,[^\n]*/)[0];
test('T42 n8n prompt: the next-field line names the group when its partner is also pending', () => {
  assert.match(runValidar({ history: [], fields: {}, message: 'hi' }).sistema, /\nNext field to ask,[^\n]*name and company \(together\)/);
  assert.match(runValidar({ history: [], fields: NC, message: 'x' }).sistema, /\nNext field to ask,[^\n]*email and phone \(together\)/);
  assert.match(runValidar({ history: [], fields: BT, message: 'x' }).sistema, /\nNext field to ask,[^\n]*board size with its unit \(together\)/);
  // partner already known: single field only
  const one = runValidar({ history: [], fields: { name: 'Sam' }, message: 'x' }).sistema;
  assert.match(one, /\nNext field to ask,[^\n]*company\./);
  assert.doesNotMatch(nl(one), /together/);
  // a deferred partner is not grouped
  const def = runValidar({ history: [], fields: NC, deferred: ['email'], message: 'x' }).sistema;
  assert.match(def, /\nNext field to ask,[^\n]*: phone\./);
  assert.doesNotMatch(nl(def), /together/);
  // option fields are never grouped
  assert.doesNotMatch(nl(runValidar({ history: [], fields: EP, message: 'x' }).sistema), /together/);
});

test('T42 n8n guard (a): unit buttons are dropped when the reply asks for the size and width is missing', () => {
  const r = runGuard(ent({ fields: BT, message: 'Single up' }), { reply: 'Got it. What is the board size, and in mm or inches?', askField: 'unitOfMeasure', quickReplies: [], fieldUpdates: {} });
  assert.deepEqual(r.quickReplies, []);
  assert.equal(r.asking, 'width');
  const x = runGuard(ent({ fields: BT, message: 'Single up' }), { reply: 'Is it 100 x 80 mm or inches?', askField: 'unitOfMeasure', quickReplies: [], fieldUpdates: {} });
  assert.deepEqual(x.quickReplies, []);
  assert.equal(x.asking, 'width');
});

test('T42 n8n guard (a): the unit buttons stay when the size is known', () => {
  const r = runGuard(ent({ fields: BT, message: '4 x 3' }), { reply: 'Thanks! Is that in mm or inches?', askField: 'unitOfMeasure', quickReplies: [], fieldUpdates: { width: 4, length: 3 } });
  assert.deepEqual(vals(r), ['mm', 'inches']);
  assert.equal(r.asking, 'unitOfMeasure');
  assert.deepEqual(r.fieldUpdates, { width: 4, length: 3 });
});

test('T42 n8n guard (b): the forgot-the-buttons net never adds mm/inches while the size is missing', () => {
  const r = runGuard(ent({ fields: BT, message: 'Single up' }), { reply: 'What size is the board, in mm or inches?', askField: '', quickReplies: [], fieldUpdates: {} });
  assert.deepEqual(r.quickReplies, []);
  // with the size known the net still adds the unit buttons (existing behavior)
  const k = runGuard(ent({ fields: BT, message: '4 x 3' }), { reply: 'Is that in mm or inches?', askField: '', quickReplies: [], fieldUpdates: { width: 4, length: 3 } });
  assert.deepEqual(vals(k), ['mm', 'inches']);
});

test('T42 n8n guard (c): an unusable LLM asks the group question for name+company, email+phone and size', () => {
  const bad = 'not json';
  const a = runGuard(ent({ fields: {}, message: 'hello' }), bad);
  assert.match(a.reply, /name and company\?$/);
  assert.deepEqual(a.quickReplies, []);
  const b = runGuard(ent({ fields: NC, message: 'x' }), bad);
  assert.match(b.reply, /best email and phone number to reach you\?$/);
  const c = runGuard(ent({ fields: BT, message: 'x' }), bad);
  assert.match(c.reply, /board size\? For example 100 × 80 mm or 4 × 3 in\.$/);
  assert.deepEqual(c.quickReplies, []);
  assert.equal(c.asking, 'width');
  const d = runGuard(ent({ fields: { ...BT, width: 4, length: 3 }, message: 'x' }), bad);
  assert.match(d.reply, /mm or inches\?$/);
  assert.deepEqual(vals(d), ['mm', 'inches']);
  const e = runGuard(ent({ fields: { name: 'Sam' }, message: 'x' }), bad);
  assert.doesNotMatch(e.reply, /name/i);
  assert.match(e.reply, /company/i);
  // a deferred partner is asked alone
  const f = runGuard(ent({ fields: NC, deferred: ['email'], message: 'x' }), bad);
  assert.match(f.reply, /phone/);
  assert.doesNotMatch(f.reply, /email/i);
});

test('T42 n8n guard (c): the ordinal net asks the next group question without buttons', () => {
  const hist = [{ role: 'assistant', text: 'Single up or array?', options: ['Single up', 'Array (panel)'] }];
  const r = runGuard(ent({ fields: { ...EP, boardType: 'Rigid PCB' }, message: 'the first one', history: hist }), { reply: 'ok', askField: '', quickReplies: [], fieldUpdates: {} });
  assert.deepEqual(r.fieldUpdates, { singleUpOrArray: 'Single Up' });
  assert.match(r.reply, /board size\?/);
  assert.deepEqual(r.quickReplies, []);
  assert.equal(r.asking, 'width');
});

test('T42 n8n guard (d): ASK.name greets and asks name and company', () => {
  assert.ok(wf.includes(`name: "Hi! I'm HT Global's quote assistant. What's your name and company?",`));
});

test('T42 n8n guard preserve: option fields keep their own buttons', () => {
  const r = runGuard(ent({ fields: EP, message: 'x' }), { reply: 'What type of board do you need?', askField: 'boardType', quickReplies: [], fieldUpdates: {} });
  assert.equal(r.quickReplies.length, 7);
  const l = runGuard(ent({ fields: { ...BT, unitOfMeasure: 'mm', width: 1, length: 2 }, message: 'x' }), { reply: 'How many layers?', askField: 'layers', quickReplies: [], fieldUpdates: {} });
  assert.deepEqual(vals(l), ['1', '2', '4', '6', '8', 'Other']);
});

test('T42 n8n guard (e): an LLM that asks the unit alone while the size is unknown is turned into the size question', () => {
  const r = runGuard(ent({ fields: BT, message: 'Single up' }), { reply: 'Thanks, noted. Which unit do your board dimensions use?', askField: 'unitOfMeasure', quickReplies: [], fieldUpdates: {} });
  assert.match(r.reply, /board size\? For example 100 × 80 mm or 4 × 3 in\.$/);
  assert.deepEqual(r.quickReplies, []);
  assert.equal(r.asking, 'width');
  // a customer question about the unit keeps the LLM answer and the buttons
  const q = runGuard(ent({ fields: BT, message: 'what is the unit for?' }), { reply: 'It tells us how to read your dimensions. mm or inches?', askField: 'unitOfMeasure', quickReplies: [], fieldUpdates: {} });
  assert.deepEqual(vals(q), ['mm', 'inches']);
  // the size known: unit alone is right
  const k = runGuard(ent({ fields: BT, message: '4 x 3' }), { reply: 'Which unit?', askField: 'unitOfMeasure', quickReplies: [], fieldUpdates: { width: 4, length: 3 } });
  assert.deepEqual(vals(k), ['mm', 'inches']);
});
test('T42 n8n prompt: never ask the unit alone before the size is known', () => {
  assert.match(runValidar({ history: [], fields: BT, message: 'x' }).sistema, /NEVER ask for the unit alone before the size is known/);
});
