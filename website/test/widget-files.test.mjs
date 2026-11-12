import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const js = fs.readFileSync(path.join(dir, 'chat-widget.js'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'chat-widget.css'), 'utf8');

test('widget: paperclip button in the composer is labelled, a real button, and opens a multi-file picker with the accepted types', () => {
  assert.match(js, /'aria-label': 'Attach files/);
  assert.match(js, /class: 'htcw-clip'/);
  assert.match(js, /type: 'file'[^)]*multiple/);
  for (const ext of ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'jpg', 'jpeg', 'png', 'zip', 'gbr', 'tgz']) assert.ok(js.includes(`'${ext}'`), ext);
});

test('widget: client-side limits mirror the server (5 MB, 5 files, type allowlist) with English errors', () => {
  assert.match(js, /MAX_FILE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(js, /MAX_FILES = 5/);
  assert.match(js, /The limit is 5 MB per file/);
  assert.match(js, /You can attach up to 5 files at a time/);
  assert.match(js, /isn\\u2019t accepted|isn't accepted/);
});

test('widget: uploads the raw file with X-File-Name, reports progress, announces status politely and offers Retry', () => {
  assert.match(js, /\/api\/quote\/files\?/);
  assert.match(js, /application\/octet-stream/);
  assert.match(js, /X-File-Name/);
  assert.match(js, /encodeURIComponent\(file\.name\)/);
  assert.match(js, /xhr\.upload\.onprogress/);
  assert.match(js, /'aria-live': 'polite'/);
  assert.match(js, /text: 'Retry'/);
  assert.match(js, /more=1/);
});

test('widget: successful upload shows a "📎 name (size)" bubble', () => {
  assert.match(js, /\\uD83D\\uDCCE|\u{1F4CE}/u);
  assert.match(js, /fmtSize\(/);
});

test('widget: Details step has an optional "Drawings, stack-up or Gerbers" file field, uploaded right after the quote is created', () => {
  assert.match(js, /Drawings, stack-up or Gerbers/);
  assert.match(js, /formFiles/);
  assert.match(js, /uploadBatch\(formFiles/);
});

test('widget: file UI uses textContent only (no innerHTML with data) and has styles', () => {
  const uses = js.match(/\.innerHTML\s*=/g) || [];
  assert.equal(uses.length, 1, 'only the static svg helper uses innerHTML');
  for (const cls of ['htcw-clip', 'htcw-files', 'htcw-file', 'htcw-sr']) assert.ok(css.includes(cls), cls);
});

test('PRESERVE: widget still has the honeypot, quantity validation and message send', () => {
  assert.match(js, /website: honeypotValue\(\)/);
  assert.match(js, /Please enter a quantity\./);
  assert.match(js, /method: 'PATCH'/);
});

test('widget: files in the Details step send filesPending:true only when there are files; batch uploads use more=1 except the last', () => {
  assert.match(js, /filesPending/);
  assert.match(js, /if \(formFiles\.length\) payload\.filesPending = true/);
  assert.match(js, /sendFile\(files\[i\], addRow\(files\[i\]\), !last\)/);
});

test('widget: if no upload of the form batch notified the agent it sends one chat message via PATCH', () => {
  assert.match(js, /I tried to attach files but some could not be uploaded\./);
  assert.match(js, /notified/);
});

test('widget: a stored-but-not-logged response (messageLogged:false) counts as uploaded without retry', () => {
  assert.match(js, /json\.stored/);
  assert.match(js, /messageLogged/);
});
