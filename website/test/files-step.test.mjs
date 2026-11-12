import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, json } from './helpers.mjs';

// T41 / S26: optional files step, typed confirmation, no button overflow.
const here = path.dirname(fileURLToPath(import.meta.url));
const js = fs.readFileSync(path.join(here, '..', 'public', 'chat-widget.js'), 'utf8');
const css = fs.readFileSync(path.join(here, '..', 'public', 'chat-widget.css'), 'utf8');
const wfPath = path.join(here, '..', '..', 'n8n', 'ht-pcb-intake.workflow.ts');
const wf = fs.existsSync(wfPath) ? fs.readFileSync(wfPath, 'utf8') : null;

async function withServer(opts, fn) {
  const s = await start(opts);
  try { await fn(s); } finally { await s.close(); }
}

// ---------- server: heldFiles ----------
test('T41 server: heldFiles (names of files already attached) is forwarded to n8n when present', () => withServer({}, async (s) => {
  const res = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'Attached: a.pdf', heldFiles: ['a.pdf', 'b.zip'] });
  assert.equal(res.status, 200);
  assert.deepEqual(s.calls.intake[0].heldFiles, ['a.pdf', 'b.zip']);
  assert.equal(s.calls.sf.length, 0);
}));

test('T41 server: without heldFiles (or an empty list) the n8n payload has no heldFiles key', () => withServer({}, async (s) => {
  await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi' });
  await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi', heldFiles: [] });
  assert.equal('heldFiles' in s.calls.intake[0], false);
  assert.equal('heldFiles' in s.calls.intake[1], false);
}));

test('T41 server: heldFiles must be an array of at most 5 strings of at most 100 characters', async () => {
  await withServer({}, async (s) => {
    const bad = [
      'a.pdf',
      { 0: 'a.pdf' },
      ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf', '6.pdf'],
      ['x'.repeat(101)],
      [42],
      [null],
      ['']
    ];
    for (const heldFiles of bad) {
      const res = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi', heldFiles });
      assert.equal(res.status, 400, JSON.stringify(heldFiles).slice(0, 60));
      const j = await res.json();
      assert.equal(j.success, false);
      assert.match(j.errorMessage, /heldFiles/);
    }
    assert.equal(s.calls.intake.length, 0, 'rejected input never reaches n8n');
    const ok = await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'hi', heldFiles: ['x'.repeat(100), 'b', 'c', 'd', 'e'] });
    assert.equal(ok.status, 200);
  });
});

test('T41 server: asking "files" is passed through and never blocks complete or the missing list', () => withServer({
  intakeImpl: async () => ({ reply: 'Do you have a fabrication drawing or Gerber files?', quickReplies: [{ label: 'Attach files', value: 'Attach files' }, { label: 'No files', value: 'No files' }], fieldUpdates: {}, asking: 'files' })
}, async (s) => {
  const full = { name: 'Vince Carter', company: 'Summit Avionics', email: 'v@summit.example', phone: '+1 555 0100', boardType: 'Rigid PCB', singleUpOrArray: 'Single Up', unitOfMeasure: 'mm', width: 100, length: 80, layers: 4, quantity: 500, itarClassification: 'Commercial' };
  const j = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: full, message: 'nothing else' })).json();
  assert.equal(j.asking, 'files');
  assert.equal(j.complete, true);
  assert.deepEqual(j.missing, []);
  assert.equal('files' in j.fields, false);
  const j2 = await (await json(s.base, 'POST', '/api/intake', { history: [], fields: {}, message: 'x' })).json();
  assert.equal(j2.asking, 'files');
  assert.equal(j2.complete, false);
}));

// ---------- widget: typed confirmation matcher ----------
function loadMatcher() {
  const m = js.match(/\/\/ <confirm-intent>([\s\S]*?)\/\/ <\/confirm-intent>/);
  assert.ok(m, 'confirm-intent block present');
  return new Function(m[1] + '\nreturn isConfirmIntent;')();
}
const ACCEPT = ['confirm', 'Confirm', 'i confirm', 'I confirm.', 'yes confirm', 'confirmed', 'send it', 'Send it!', 'submit', 'yes, send', 'Yes, send', 'go ahead', 'looks good, send', 'Looks good, send it', '  CONFIRM  ', 'ok, go ahead', 'please confirm'];
const REJECT = [
  '', '   ', 'yes', 'no', 'ok', 'thanks',
  'i confirm but change the width to 500',
  'confirm, but switch the width',
  'the width i want to switch for 500mm',
  'i want to add a file for drawing fabrication',
  'send it to my other email',
  'go ahead and change the quantity',
  'submit the drawing later',
  'looks good, but make it 8 layers',
  'how do i confirm?',
  'do not confirm yet',
  'x'.repeat(200)
];
test('T41 widget: the typed-confirmation matcher accepts short confirmations (case-insensitive)', () => {
  const f = loadMatcher();
  for (const t of ACCEPT) assert.equal(f(t), true, t);
});
test('T41 widget: the matcher rejects change requests, questions, other intents and long text', () => {
  const f = loadMatcher();
  for (const t of REJECT) assert.equal(f(t), false, JSON.stringify(t).slice(0, 60));
  assert.equal(f(null), false);
  assert.equal(f(undefined), false);
});

test('T41 widget: a confirm intent with the summary visible runs the Confirm path and never calls /api/intake', () => {
  // the intake branch of the composer checks the matcher first and returns before sendCustomer (the only /api/intake caller)
  const branch = js.slice(js.indexOf("if (S.phase === 'intake') {"), js.indexOf('if (sending || !S.conversationId) return;'));
  const iConfirm = branch.indexOf('typedConfirm(');
  const iSend = branch.indexOf('sendCustomer(');
  assert.ok(iConfirm >= 0 && iSend > iConfirm, 'typedConfirm is tried before sendCustomer');
  assert.match(branch, /if \(typedConfirm\(t\)\) \{[^}]*return;/);
  const fn = js.slice(js.indexOf('function typedConfirm('), js.indexOf('function typedConfirm(') + 1800);
  assert.match(fn, /summaryEl/);
  assert.match(fn, /S\.editing/);
  assert.match(fn, /isConfirmIntent\(/);
  assert.match(fn, /requiredMissing\(\)/);
  assert.match(fn, /requestSubmit\(\)/);
  assert.ok(!fn.includes('requestIntake') && !fn.includes('sendCustomer') && !fn.includes('/api/intake'), 'no intake call from the confirm path');
  // missing required fields: local reply, no server call, points at the field
  assert.match(fn, /Missing|missing/);
});

// ---------- widget: files step ----------
test('T41 widget: a quick reply with the files action opens the picker instead of sending text', () => {
  assert.match(js, /FILES_ACTION = 'Attach files'/);
  assert.match(js, /if \(c\.value === FILES_ACTION\) \{[^}]*fileInput\.click\(\)[^}]*return;/);
  assert.match(js, /OPTIONAL_FIELDS = \['leadTimeDays', 'comment', 'files'\]/);
});

test('T41 widget: after choosing files during the intake a customer turn "Attached: ..." continues the conversation, and held names are sent', () => {
  assert.match(js, /sendCustomer\(\('Attached: ' \+ /);
  assert.match(js, /body\.heldFiles = heldNames\(\)/);
  assert.match(js, /body: JSON\.stringify\(intakeBody\(message, prior\)\)/);
  assert.match(js, /function heldNames\(\) \{[^}]*heldFiles\.map\(function \(f\) \{ return String\(f\.name\)\.slice\(0, 100\); \}\)\.slice\(0, 5\)/);
  // files are still held and uploaded right after Confirm (existing path)
  assert.match(js, /heldFiles\.push\(f\)/);
  assert.match(js, /uploadBatch\(heldFiles\.splice\(0, heldFiles\.length\), true\)/);
  // "No files" is plain text: no special handling besides the files action
  assert.ok(!/value === 'No files'/.test(js));
});

test('T41 widget: the summary Files row still lists held files and hints at the paperclip when empty', () => {
  assert.match(js, /None yet\. Use the paperclip to add drawings or Gerbers\./);
  assert.match(js, /heldFiles\.map\(function \(f\) \{ return f\.name; \}\)\.join\(', '\)/);
});

// ---------- overflow ----------
test('T41 css: the summary actions row wraps, buttons shrink and long labels wrap; narrow screens stack full-width buttons', () => {
  assert.match(css, /\.htcw-actions\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.htcw-actions\{[^}]*min-width:0/);
  assert.match(css, /\.htcw-btn\{[^}]*min-width:0/);
  assert.match(css, /\.htcw-btn\{[^}]*white-space:normal/);
  assert.match(css, /\.htcw-btn\{[^}]*max-width:100%/);
  assert.match(css, /@media \(max-width:480px\)\{[\s\S]*\.htcw-actions\{flex-direction:column[\s\S]*?\.htcw-actions \.htcw-btn\{width:100%/);
  // chips rows and the tray never push the panel wider
  assert.match(css, /\.htcw-qr-btn\{[^}]*max-width:100%/);
  assert.match(css, /\.htcw-qr-btn\{[^}]*white-space:normal/);
  assert.match(css, /\.htcw-log\{[^}]*overflow-x:hidden/);
  assert.match(css, /\.htcw-card\{[^}]*min-width:0/);
});

// ---------- n8n intake workflow (code nodes evaluated with stubs) ----------
function nodeCode(name) {
  const i = wf.indexOf("name: '" + name + "'");
  const a = wf.indexOf('jsCode: `', i) + 'jsCode: `'.length;
  const b = wf.indexOf('`\n    },', a);
  return new Function('return `' + wf.slice(a, b) + '`')();
}
function runValidar(body) {
  const code = nodeCode('Validar Entrada').replace('__HT_AGENT_SECRET__', 's3cret');
  const fn = new Function('$input', code);
  return fn({ first: () => ({ json: { headers: { 'x-ht-agent-secret': 's3cret' }, body } }) })[0].json;
}
function runGuard(entJson, llmOutput) {
  const code = nodeCode('Guard de Salida');
  const fn = new Function('$', code);
  const stub = (n) => ({ first: () => ({ json: n === 'Validar Entrada' ? entJson : { output: typeof llmOutput === 'string' ? llmOutput : JSON.stringify(llmOutput) } }) });
  return fn(stub)[0].json;
}
const REQ_FIELDS = { name: 'Vince Carter', company: 'Summit', email: 'v@summit.example', phone: '+1 555 0100', boardType: 'Rigid PCB', singleUpOrArray: 'Single Up', unitOfMeasure: 'mm', width: 100, length: 80, layers: 4, quantity: 500, itarClassification: 'Commercial' };
const ent = (over) => ({ ok: true, fields: REQ_FIELDS, deferred: [], message: null, history: [], heldFiles: [], ...over });
const asst = (text, options) => ({ role: 'assistant', text, ...(options ? { options } : {}) });
const files = (r) => r.quickReplies.map((q) => q.value);

test('T41 n8n: Validar Entrada accepts heldFiles (max 5 names, 100 chars) and puts them in the prompt', { skip: !wf }, () => {
  const r = runValidar({ history: [], fields: {}, message: 'Attached: a.pdf', heldFiles: ['a.pdf', 1, 'x'.repeat(300), 'c.zip', 'd', 'e', 'f'] });
  assert.equal(r.ok, true);
  assert.equal(r.heldFiles.length, 5);
  assert.ok(r.heldFiles.every((n) => typeof n === 'string' && n.length <= 100));
  assert.match(r.sistema, /a\.pdf/);
  assert.match(r.sistema, /files step/i);
  assert.match(r.sistema, /Never tell the customer to confirm first/i);
  const none = runValidar({ history: [], fields: {}, message: 'hi' });
  assert.deepEqual(none.heldFiles, []);
});

test('T41 n8n: the files step comes after the comment and before the summary, with Attach files / No files', { skip: !wf }, () => {
  const hist = [asst('Last: lead time?', ['5 days (quick turn)', 'No rush, skip']), asst('Anything else?', ['Nothing else', 'Add a note'])];
  const r = runGuard(ent({ message: 'Nothing else', history: hist }), { reply: 'Great, you can review the summary now.', askField: '', quickReplies: [], fieldUpdates: {} });
  assert.equal(r.asking, 'files');
  assert.equal(r.reply, 'Do you have a fabrication drawing or Gerber files? You can attach them now (optional).');
  assert.deepEqual(files(r), ['Attach files', 'No files']);
  assert.ok(/Attach files/.test(r.quickReplies[0].label));
});

test('T41 n8n: after "No files" (or attached files) the summary is due: no files question again', { skip: !wf }, () => {
  const hist = [asst('Last: lead time?', ['5 days (quick turn)', 'No rush, skip']), asst('Anything else?', ['Nothing else', 'Add a note']), asst('Do you have a fabrication drawing or Gerber files?', ['📎 Attach files', 'No files'])];
  const a = runGuard(ent({ message: 'No files', history: hist }), { reply: 'No problem, you can review the summary now.', askField: '', quickReplies: [], fieldUpdates: {} });
  assert.equal(a.asking, null);
  assert.deepEqual(a.quickReplies, []);
  const b = runGuard(ent({ message: 'Attached: FC-100.pdf', history: hist, heldFiles: ['FC-100.pdf'] }), { reply: 'Thanks, I see FC-100.pdf attached. You can review the summary now.', askField: '', quickReplies: [], fieldUpdates: {} });
  assert.equal(b.asking, null);
  assert.deepEqual(b.quickReplies, []);
});

test('T41 n8n: files already attached skip the files step even before it was asked', { skip: !wf }, () => {
  const hist = [asst('Last: lead time?', ['5 days (quick turn)', 'No rush, skip']), asst('Anything else?', ['Nothing else', 'Add a note'])];
  const r = runGuard(ent({ message: 'Nothing else', history: hist, heldFiles: ['FC-100.pdf'] }), { reply: 'Great, you can review the summary now.', askField: '', quickReplies: [], fieldUpdates: {} });
  assert.equal(r.asking, null);
});

test('T41 n8n: any customer message about adding, sending or attaching a file shows the buttons, even after the summary', { skip: !wf }, () => {
  const hist = [asst('Anything else?', ['Nothing else', 'Add a note']), asst('Thanks Vince. You can review your quote request summary now.')];
  for (const m of ['i want to add a file for drawing fabrication', 'Can I send a Gerber?', 'let me attach the drawing', 'I would like to upload a PDF', 'where do I add the files?']) {
    const r = runGuard(ent({ message: m, history: hist, deferred: [] }), { reply: "I've noted that you'd like to provide a fabrication drawing. You can review your quote request summary now.", askField: '', quickReplies: [], fieldUpdates: {} });
    assert.equal(r.asking, 'files', m);
    assert.deepEqual(files(r), ['Attach files', 'No files'], m);
    assert.ok(!/review your quote request summary now/i.test(r.reply), m);
    assert.match(r.reply, /attach/i);
    assert.ok(!/confirm/i.test(r.reply), 'never tell them to confirm first: ' + m);
  }
  // LLM output unusable: the net still answers
  const u = runGuard(ent({ message: 'i want to add a file', history: hist }), 'garbage');
  assert.equal(u.asking, 'files');
  assert.deepEqual(files(u), ['Attach files', 'No files']);
});

test('T41 n8n: negations, "No files" and the Attached turn are not file requests', { skip: !wf }, () => {
  const hist = [asst('Do you have a fabrication drawing or Gerber files?', ['📎 Attach files', 'No files'])];
  for (const m of ['No files', "I don't want to add a file", 'Attached: a.pdf', 'the width i want to switch for 500mm']) {
    const r = runGuard(ent({ message: m, history: hist, heldFiles: m.startsWith('Attached') ? ['a.pdf'] : [] }), { reply: 'Got it. You can review the summary now.', askField: '', quickReplies: [], fieldUpdates: {} });
    assert.notEqual(r.asking, 'files', m);
  }
});

test('T41 n8n: askField "files" from the LLM gets the fixed buttons; the files step is optional (does not defer required fields)', { skip: !wf }, () => {
  const r = runGuard(ent({ message: 'hi', history: [] }), { reply: 'Sure, you can attach it now.', askField: 'files', quickReplies: [], fieldUpdates: {} });
  assert.equal(r.asking, 'files');
  assert.deepEqual(files(r), ['Attach files', 'No files']);
  const half = runGuard(ent({ fields: { name: 'V' }, message: 'hi' }), { reply: 'Sure, attach it. Which company?', askField: 'files', quickReplies: [], fieldUpdates: {} });
  assert.equal(half.asking, 'files');
});

test('T41 n8n: never repeats "review the summary" twice in a row; points to Confirm instead', { skip: !wf }, () => {
  const hist = [asst('Last: lead time?', ['5 days (quick turn)', 'No rush, skip']), asst('Anything else?', ['Nothing else', 'Add a note']), asst('Files?', ['\u{1F4CE} Attach files', 'No files']), asst('Thanks. You can review your quote request summary now.')];
  const r = runGuard(ent({ message: 'ok and now?', history: hist }), { reply: 'Thanks for confirming. You can review your quote request summary now.', askField: '', quickReplies: [], fieldUpdates: {} });
  assert.ok(!/review your quote request summary now/i.test(r.reply));
  assert.match(r.reply, /Confirm/);
});

test('T41 n8n: the prompt covers the typed-confirm rule and the files rules', { skip: !wf }, () => {
  const r = runValidar({ history: [asst('You can review the summary now.')], fields: REQ_FIELDS, message: 'how do I finish?' });
  assert.match(r.sistema, /tap Confirm \(or type "confirm"\)/);
  assert.match(r.sistema, /summary (is )?already (been )?shown/i);
  assert.match(r.sistema, /Do you have a fabrication drawing or Gerber files\? You can attach them now \(optional\)\./);
});

test('T41 n8n: a bare number after the layers buttons is the layers value, not the Nth option (live bug: "4" became 6)', { skip: !wf }, () => {
  const half = { name: 'V', company: 'S', email: 'v@summit.example', phone: '+1 555 0100', boardType: 'Rigid PCB', singleUpOrArray: 'Single Up', unitOfMeasure: 'mm', width: 100, length: 80 };
  const hist = [asst('How many copper layers does it have?', ['1', '2', '4', '6', '8', 'Other'])];
  const wrong = runGuard(ent({ fields: half, message: '4', history: hist }), { reply: 'Thanks, I have noted 6 layers. How many boards do you need?', askField: 'quantity', quickReplies: [], fieldUpdates: { layers: 6 } });
  assert.equal(wrong.fieldUpdates.layers, 4);
  assert.match(wrong.reply, /4 layers/);
  assert.ok(!/6/.test(wrong.reply));
  assert.equal(wrong.asking, 'quantity');
  const right = runGuard(ent({ fields: half, message: '8', history: hist }), { reply: 'Thanks, 8 layers. How many boards do you need?', askField: 'quantity', quickReplies: [], fieldUpdates: { layers: 8 } });
  assert.equal(right.fieldUpdates.layers, 8);
  assert.match(right.reply, /^Thanks, 8 layers/);
  const sys = runValidar({ history: hist, fields: half, message: '4' }).sistema;
  assert.match(sys, /bare number is NOT an ordinal/);
});
