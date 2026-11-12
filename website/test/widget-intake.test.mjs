import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const js = fs.readFileSync(path.join(dir, 'chat-widget.js'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'chat-widget.css'), 'utf8');

test('widget intake: the 3-step form flow is gone', () => {
  for (const gone of ['STEP_TITLES', 'buildCard', 'renderForm', 'runIntro', 'Open my quote', "'Continue'", 'htcw-steps']) {
    assert.ok(!js.includes(gone) && !css.includes(gone), gone);
  }
});

test('widget intake: first open posts /api/intake with message null; later turns send history, fields and the message', () => {
  assert.match(js, /requestIntake\(null, \[\]\)/);
  assert.match(js, /fetch\('\/api\/intake'/);
  assert.match(js, /body: JSON\.stringify\(\{ history: serverHistory\(prior\), fields: S\.fields, deferred: S\.deferred, message: message, website: honeypotValue\(\) \}\)/);
  assert.match(js, /SEND_HISTORY = 30/);
});

test('widget intake: quick replies are buttons in a labelled group, a click sends the chip value, older chips are disabled', () => {
  assert.match(js, /class: 'htcw-qr' \+ \(cards \? ' htcw-qr-cards' : ''\), role: 'group', 'aria-label': 'Quick replies'/);
  assert.match(js, /type: 'button', class: 'htcw-qr-btn'/);
  assert.match(js, /sendCustomer\(c\.value\)/);
  assert.match(js, /function disableChips/);
  assert.match(js, /b\.disabled = true/);
  for (const cls of ['htcw-qr', 'htcw-qr-btn']) assert.ok(css.includes(cls), cls);
});

test('widget intake: typing dots while waiting, replies announced by the aria-live log, focus returns to the input', () => {
  assert.match(js, /role: 'log', 'aria-live': 'polite'/);
  assert.match(js, /typing\.hidden = false/);
  assert.match(js, /input\.focus\(\{ preventScroll: true \}\)/);
});

test('widget intake: progress hint "N of 12 details"', () => {
  assert.match(js, /REQUIRED_COUNT = 12/);
  assert.match(js, /' of ' \+ REQUIRED_COUNT \+ ' details'/);
});

test('widget summary: the card appears when complete, lists Contact / Board / Delivery & compliance and the optional notes, with Confirm and Change something', () => {
  assert.match(js, /if \(inReview\(\)\) renderSummary\(true\)/);
  assert.match(js, /Here\\u2019s what I have/);
  for (const t of ["title: 'Contact'", "title: 'Board'", "title: 'Delivery & compliance'"]) assert.ok(js.includes(t), t);
  assert.match(js, /text: 'Confirm'/);
  assert.match(js, /text: 'Change something'/);
  assert.match(js, /h\('form', \{ class: 'htcw-card htcw-sum'/);
});

test('widget summary: edit mode has labelled inputs and chips for the enums, validated with the form rules', () => {
  assert.match(js, /function buildEditCard/);
  assert.match(js, /h\('label', \{ for: id \}/);
  assert.match(js, /chips\('boardType', 'Board type'/);
  assert.match(js, /fieldProblem\(f\.name, f\.control\.value\)/);
  assert.match(js, /text: 'Save changes'/);
});

test('widget confirm: POST /api/quote with the fields, the transcript (max 60, 2000 chars) and the honeypot, then the chat phase', () => {
  assert.match(js, /transcript: S\.history\.slice\(-SEND_TRANSCRIPT\)/);
  assert.match(js, /SEND_TRANSCRIPT = 60/);
  assert.match(js, /String\(e\.text\)\.slice\(0, MAX_TURN_CHARS\)/);
  assert.match(js, /website: honeypotValue\(\)/);
  assert.match(js, /fetch\('\/api\/quote', \{ method: 'POST'/);
  assert.match(js, /startChat\(result\)/);
  assert.match(js, /S\.phase = 'chat'/);
});

test('widget confirm: the polled thread never replays the intake transcript (baseline = server time at creation)', () => {
  assert.match(js, /S\.baseline = result\.serverTime/);
  assert.match(js, /pollAfter = S\.baseline/);
  assert.match(js, /var pollAfter = S\.baseline \|\| null/);
});

test('widget persistence: history, fields and summary state live in sessionStorage; a reload resumes without replaying answered questions', () => {
  for (const k of ['history:', 'fields:', 'editing:', 'editDraft:', 'complete:']) assert.ok(js.includes(k), k);
  assert.match(js, /sessionStorage\.setItem\(STORE_KEY/);
  assert.match(js, /function resumeIntake/);
  assert.match(js, /if \(!S\.history\.length\) \{ requestIntake\(null, \[\]\); return; \}/);
  assert.match(js, /S\.history\.forEach\(function \(e, i\) \{ appendHistory/);
});

test('widget: "Start a new quote" resets the intake and the chat still has its menu, paperclip, polling and Escape handling', () => {
  assert.match(js, /function resetAll/);
  assert.match(js, /Start a new quote/);
  assert.match(js, /e\.key === 'Escape'/);
  assert.match(js, /\/api\/quote\/messages\?/);
  assert.match(js, /class: 'htcw-clip'/);
});

test('widget: the data-driven UI uses textContent only (assistant and customer text is never parsed as HTML)', () => {
  const uses = js.match(/\.innerHTML\s*=/g) || [];
  assert.equal(uses.length, 1, 'only the static svg helper uses innerHTML');
});

test('widget summary css exists', () => {
  for (const cls of ['htcw-sum-title', 'htcw-sum-row', 'htcw-sum-group', 'htcw-muted']) assert.ok(css.includes(cls), cls);
});

test('widget S24: quick replies with a description render as option cards (2 columns, 1 under 420 px), chips stay as they are', () => {
  for (const c of ['htcw-qr-card', 'htcw-qr-title', 'htcw-qr-desc']) assert.ok(js.includes(c) && css.includes(c), c);
  assert.match(css, /\.htcw-qr-cards\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media \(max-width:419px\)\{#htcw \.htcw-qr-cards\{grid-template-columns:minmax\(0,1fr\)\}\}/);
  assert.match(css, /\.htcw-qr-card:focus-visible\{outline:3px solid/);
  assert.match(js, /type: 'button', class: 'htcw-qr-btn', text: c\.label/);
  assert.match(js, /c\.description\.length <= 60/);
});

test('widget S24: deferred is persisted, sent and read back; the summary waits for missing required fields', () => {
  assert.match(js, /deferred: \[\]/);
  assert.match(js, /S\.deferred = Array\.isArray\(result\.deferred\)/);
  assert.match(js, /function missingRow/);
  assert.match(js, /text: 'Missing'/);
  assert.match(js, /confirmBtn\.disabled = requiredMissing\(\)\.length > 0/);
  assert.ok(css.includes('.htcw-missing-tag') && css.includes('.htcw-sum-missing'));
});

test('widget S24: old cards are disabled after a choice, like chips', () => {
  assert.match(js, /querySelectorAll\('\.htcw-qr-btn'\)[\s\S]{0,60}b\.disabled = true/);
  assert.ok(css.includes('.htcw-qr-card:disabled'));
});

test('widget (T40): the options shown on assistant turns are sent in history', () => {
  assert.match(js, /t\.options = e\.chips\.map\(function \(c\) \{ return String\(c\.label\)\.slice\(0, 40\); \}\)\.slice\(0, 8\)/);
  assert.match(js, /e\.role === 'assistant' && e\.chips && e\.chips\.length/);
});

test('widget (T40): when complete but the assistant asks an optional field, its chips show and the summary waits', () => {
  assert.match(js, /OPTIONAL_FIELDS = \['leadTimeDays', 'comment'\]/);
  assert.match(js, /function inReview\(\) \{ return !S\.awaitOpt && !!\(S\.complete \|\| S\.review\); \}/);
  assert.match(js, /S\.awaitOpt = S\.complete && OPTIONAL_FIELDS\.indexOf\(result\.asking \|\| ''\) >= 0/);
  // a customer answer (chip or typed) releases the wait; the next response decides again
  assert.match(js, /S\.editing = false; S\.editDraft = null; S\.review = false; S\.awaitOpt = false;/);
  assert.match(js, /awaitOpt: false/);
});
