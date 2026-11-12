/* HT Global Quote Assistant: floating chat launcher + conversational RFQ intake + live chat.
 * Single implementation shared by every page (home and /quote). No dependencies, no build step.
 *
 * Phase "intake": the AI assistant talks to the visitor in natural English (POST /api/intake), offers quick-reply
 *                 buttons for the options, and fills the quote fields as the visitor answers. When every required
 *                 field is in, an editable summary card ("Here's what I have") offers Confirm / Change something.
 *                 Nothing is created in Salesforce before Confirm.
 * Phase "chat":   Confirm posts POST /api/quote with the fields and the whole intake as a transcript; from then on
 *                 free text goes via PATCH /api/quote; replies (n8n assistant + Sellium team) arrive by polling
 *                 GET /api/quote/messages (4 s, paused while hidden, 15 s after 2 min idle, deduped by id,
 *                 rendered with textContent only).
 * Files: the paperclip in the composer uploads the raw file to POST /api/quote/files (type, size and count are
 *        checked here too; the server is the authority). During the intake files are held client-side and
 *        uploaded right after the quote is created.
 * State (history, fields, summary state, quoteId, conversationId, thread) lives in sessionStorage so a reload resumes.
 */
(function () {
  'use strict';
  if (window.HTChatWidget) return;

  var STORE_KEY = 'htcw.v1';
  var POLL_FAST_MS = 4000;
  var POLL_SLOW_MS = 15000;
  var SLOW_AFTER_MS = 120000;
  var TYPING_MAX_MS = 45000;
  var REPLY_MIN_MS = 700; // an assistant reply never pops in faster than this: it "types" first
  var MAX_THREAD = 200;
  var MAX_HISTORY = 120;
  var SEND_HISTORY = 30; // /api/intake accepts at most 30 earlier turns
  var SEND_TRANSCRIPT = 60; // POST /api/quote accepts at most 60 turns
  var MAX_TURN_CHARS = 2000;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var BOARD_TYPES = ['Rigid PCB', 'Flex PCB', 'Rigid-Flex PCB', 'HDI PCB', 'Metal Core PCB', 'High Frequency PCB'];
  var FILES_ACTION = 'Attach files'; // the quick-reply value that opens the file picker
  var OPTIONAL_FIELDS = ['leadTimeDays', 'comment', 'files']; // asked after the required ones; the summary waits for them
  var REQUIRED_COUNT = 12; // name, company, email, phone, board type, single up/array, unit, width, length, layers, quantity, classification
  var NUMERIC = { width: 1, length: 1, layers: 1, quantity: 1, leadTimeDays: 1 };
  var FILE_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'jpg', 'jpeg', 'png', 'zip', 'gbr', 'tgz'];
  var FILE_ACCEPT = FILE_EXT.map(function (e) { return '.' + e; }).join(',');
  var FILE_TYPES_TEXT = 'pdf, doc, docx, xls, xlsx, csv, jpg, png, zip, gbr or tgz';
  var MAX_FILE_BYTES = 5 * 1024 * 1024; // must match the server's UPLOAD_MAX_BYTES
  var MAX_FILES = 5;
  var RISKY_INNER = ['exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'js', 'jse', 'mjs', 'vbs', 'vbe', 'wsf', 'ps1', 'sh', 'bash', 'jar', 'msi', 'dll', 'hta', 'lnk', 'reg', 'html', 'htm', 'xhtml', 'svg', 'php', 'py', 'pl', 'cgi', 'asp', 'aspx', 'jsp', 'apk', 'app', 'dmg', 'docm', 'xlsm'];
  var SUB_DEFAULT = 'Usually replies in seconds';

  var scriptEl = document.currentScript;
  var autoOpen = !!(scriptEl && scriptEl.hasAttribute('data-autoopen'));

  // ---------- state ----------
  function freshState() {
    return {
      phase: 'intake', // 'intake' | 'chat'
      history: [], // intake turns: { role: 'assistant'|'customer', text, chips?: [{label,value}], note?: true }
      fields: {}, // validated by the server on every turn
      missing: [],
      deferred: [], // required fields the customer will give later: asked again once, at the end
      reasked: false, // the deferred field was asked again already
      review: false, // show the summary although a deferred field is still missing
      complete: false,
      awaitOpt: false, // complete, but the assistant is still asking an optional field (lead time / notes): no summary yet
      editing: false, // summary card in edit mode
      editDraft: null,
      quoteId: null,
      conversationId: null,
      baseline: null, // server time at creation: messages up to here are the intake transcript
      thread: [],
      seen: [],
      pendingSince: null,
      open: undefined
    };
  }
  var S = load();
  function load() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          var st = Object.assign(freshState(), parsed);
          if (st.phase !== 'chat') st.phase = 'intake'; // sessions of the old form flow start the intake
          if (!Array.isArray(st.history)) st.history = [];
          if (!st.fields || typeof st.fields !== 'object') st.fields = {};
          if (!Array.isArray(st.deferred)) st.deferred = [];
          return st;
        }
      }
    } catch (e) { /* storage unavailable or corrupt: start fresh */ }
    return freshState();
  }
  function save() {
    try {
      if (S.thread.length > MAX_THREAD) S.thread = S.thread.slice(-MAX_THREAD);
      if (S.history.length > MAX_HISTORY) S.history = S.history.slice(-MAX_HISTORY);
      sessionStorage.setItem(STORE_KEY, JSON.stringify(S));
    } catch (e) { /* ignore quota / private mode */ }
  }

  // ---------- tiny DOM helpers (textContent only, never innerHTML with data) ----------
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (attrs[k] == null || attrs[k] === false) continue;
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function svg(markup) {
    // static, developer-authored markup only
    var wrap = document.createElement('span');
    wrap.innerHTML = markup;
    var s = wrap.firstChild;
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    return s;
  }
  var ICON_CHAT =
    '<svg xmlns="' + SVG_NS + '" viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M5 5h22a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H16l-6 5v-5H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>' +
    '<circle cx="9" cy="11.5" r="1.7"/><path d="M10.7 11.5H16l3 4h1.6"/><circle cx="22.4" cy="15.5" r="1.7"/>' +
    '<circle cx="9" cy="17.5" r="1.7"/><path d="M10.7 17.5H14"/></svg>';
  var ICON_CLOSE = '<svg xmlns="' + SVG_NS + '" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';
  var ICON_MORE = '<svg xmlns="' + SVG_NS + '" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  var ICON_SEND = '<svg xmlns="' + SVG_NS + '" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 5l7 7-7 7"/></svg>';

  var ICON_CLIP = '<svg xmlns="' + SVG_NS + '" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3"/></svg>';

  // ---------- DOM skeleton ----------
  var root = h('div', { id: 'htcw' });
  var launcher = h('button', {
    type: 'button', class: 'htcw-launcher', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'aria-controls': 'htcw-panel', 'aria-label': 'Open HT Global quote assistant, get an instant quote'
  }, svg(ICON_CHAT));
  var badge = h('span', { class: 'htcw-badge', 'aria-hidden': 'true', hidden: true });
  launcher.appendChild(badge);
  var tip = h('span', { class: 'htcw-tip', 'aria-hidden': 'true', text: 'Get an instant quote' });

  var titleEl = h('h2', { class: 'htcw-title', id: 'htcw-title', text: 'HT Global Quote Assistant' });
  var subEl = h('p', { class: 'htcw-sub', text: SUB_DEFAULT });
  var menuBtn = h('button', { type: 'button', class: 'htcw-iconbtn', 'aria-label': 'Quote options', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, svg(ICON_MORE));
  var closeBtn = h('button', { type: 'button', class: 'htcw-iconbtn', 'aria-label': 'Close chat' }, svg(ICON_CLOSE));
  var menu = h('div', { class: 'htcw-menu', role: 'menu', hidden: true });
  var header = h('div', { class: 'htcw-head' },
    h('span', { class: 'htcw-avatar', 'aria-hidden': 'true', text: 'HT' }),
    h('div', { class: 'htcw-headtext' }, titleEl, subEl),
    menuBtn, closeBtn, menu);

  var log = h('div', { class: 'htcw-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversation', tabindex: '-1' });
  var typing = h('div', { class: 'htcw-typing', role: 'status', hidden: true },
    h('span', { class: 'htcw-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('span', { class: 'htcw-typing-text', text: 'Assistant is replying…' }));
  var composerErr = h('p', { class: 'htcw-err htcw-composer-err', role: 'alert', hidden: true });
  var input = h('textarea', { class: 'htcw-input', rows: '1', maxlength: '2000', placeholder: 'Type your answer…', 'aria-label': 'Message to the HT Global assistant' });
  var sendBtn = h('button', { type: 'submit', class: 'htcw-send', 'aria-label': 'Send message' }, svg(ICON_SEND));
  var clipBtn = h('button', { type: 'button', class: 'htcw-clip', 'aria-label': 'Attach files (' + FILE_TYPES_TEXT + '; up to 5 MB each, 5 at a time)' }, svg(ICON_CLIP));
  var fileInput = h('input', { type: 'file', class: 'htcw-fileinput', multiple: true, accept: FILE_ACCEPT, tabindex: '-1', 'aria-hidden': 'true' });
  var fileTray = h('ul', { class: 'htcw-files', 'aria-label': 'Attachments', hidden: true });
  var fileLive = h('p', { class: 'htcw-sr', role: 'status', 'aria-live': 'polite' });
  var composer = h('form', { class: 'htcw-composer', novalidate: true }, composerErr, fileTray, fileLive, h('div', { class: 'htcw-row' }, clipBtn, fileInput, input, sendBtn));
  // Honeypot: invisible to people, bots fill it. The server drops the request silently if it is non-empty.
  var trap = h('div', { 'aria-hidden': 'true', style: 'position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden' },
    h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' }));
  var panel = h('section', {
    id: 'htcw-panel', class: 'htcw-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'htcw-title', hidden: true
  }, header, log, typing, composer, trap);

  root.appendChild(panel);
  root.appendChild(launcher);
  root.appendChild(tip);

  // ---------- thread rendering ----------
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  var ASSISTANT = 'HT Global assistant';

  function bubble(entry) {
    var cls = 'htcw-msg ' + (entry.who === 'user' ? 'htcw-user' : 'htcw-agent');
    var el = h('div', { class: cls });
    if (entry.sender) el.appendChild(h('span', { class: 'htcw-who', text: entry.sender }));
    el.appendChild(h('span', { class: 'htcw-text', text: entry.text }));
    return el;
  }
  function addEntry(entry, persist) {
    if (persist !== false) { S.thread.push(entry); save(); }
    var el = bubble(entry);
    log.appendChild(el);
    scrollDown();
    return el;
  }

  // ---------- intake phase ----------
  var intakeToken = 0; // bumps on reset, so a late answer of an abandoned intake is ignored
  var intakeBusy = false;
  var summaryEl = null;
  var retryEl = null;

  function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function firstName() { return (S.fields.name || '').trim().split(/\s+/)[0] || ''; }

  function updateProgress() {
    var done = S.complete ? REQUIRED_COUNT : (S.missing && S.missing.length ? REQUIRED_COUNT - S.missing.length : 0);
    subEl.textContent = S.phase === 'intake' && done > 0 ? done + ' of ' + REQUIRED_COUNT + ' details' : SUB_DEFAULT;
  }

  // review = the summary card is due: everything is in, or only postponed fields are missing and they were asked once
  function inReview() { return !S.awaitOpt && !!(S.complete || S.review); }
  function chipRow(entry, enabled) {
    var cards = entry.chips.some(function (c) { return c.description; });
    var group = h('div', { class: 'htcw-qr' + (cards ? ' htcw-qr-cards' : ''), role: 'group', 'aria-label': 'Quick replies' });
    entry.chips.forEach(function (c) {
      var b = c.description
        ? h('button', { type: 'button', class: 'htcw-qr-btn htcw-qr-card', disabled: !enabled },
          h('span', { class: 'htcw-qr-title', text: c.label }), h('span', { class: 'htcw-qr-desc', text: c.description }))
        : h('button', { type: 'button', class: 'htcw-qr-btn', text: c.label, disabled: !enabled });
      b.addEventListener('click', function () {
        if (c.value === FILES_ACTION) { if (!intakeBusy && S.phase === 'intake') fileInput.click(); return; } // the picker, not a text turn
        sendCustomer(c.value);
      });
      group.appendChild(b);
    });
    return group;
  }
  function disableChips() {
    Array.prototype.forEach.call(log.querySelectorAll('.htcw-qr-btn'), function (b) { b.disabled = true; });
  }
  function appendHistory(entry, live) {
    log.appendChild(bubble({ who: entry.role === 'assistant' ? 'agent' : 'user', sender: entry.role === 'assistant' ? ASSISTANT : null, text: entry.text }));
    if (entry.chips && entry.chips.length) log.appendChild(chipRow(entry, live));
    scrollDown();
  }

  function renderIntake() {
    activeSummaryCleanup();
    log.textContent = '';
    retryEl = null;
    typing.hidden = true;
    composer.hidden = false;
    input.placeholder = 'Type your answer…';
    var last = S.history.length - 1;
    S.history.forEach(function (e, i) { appendHistory(e, i === last && !inReview()); });
    if (inReview() && last >= 0 && S.history[last].role === 'assistant') renderSummary(false);
    heldTray();
    updateProgress();
    scrollDown();
  }

  // Greets (first open) or resumes after a reload that interrupted a request.
  function resumeIntake() {
    if (S.phase !== 'intake' || intakeBusy || retryEl) return;
    if (!S.history.length) { requestIntake(null, []); return; }
    var last = S.history[S.history.length - 1];
    if (last.role === 'customer' && !last.note) requestIntake(last.text, S.history.slice(0, -1));
  }

  function serverHistory(list) {
    return list.slice(-SEND_HISTORY).map(function (e) {
      var t = { role: e.role, text: String(e.text).slice(0, MAX_TURN_CHARS) };
      // the option buttons this turn showed, so "the second one" can be resolved server-side
      if (e.role === 'assistant' && e.chips && e.chips.length) t.options = e.chips.map(function (c) { return String(c.label).slice(0, 40); }).slice(0, 8);
      return t;
    });
  }

  function heldNames() { return heldFiles.map(function (f) { return String(f.name).slice(0, 100); }).slice(0, 5); }
  function intakeBody(message, prior) {
    var body = { history: serverHistory(prior), fields: S.fields, deferred: S.deferred, message: message, website: honeypotValue() };
    if (heldFiles.length) body.heldFiles = heldNames(); // so the assistant acknowledges them and does not ask for files again
    return body;
  }

  async function requestIntake(message, prior) {
    var token = ++intakeToken;
    intakeBusy = true;
    sendBtn.disabled = true;
    composerErr.hidden = true;
    if (retryEl) { retryEl.remove(); retryEl = null; }
    typing.hidden = false; scrollDown();
    var started = Date.now();
    var failed = null;
    try {
      var res = await fetch('/api/intake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intakeBody(message, prior))
      });
      var result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.errorMessage || 'The assistant could not answer');
      var wait = REPLY_MIN_MS - (Date.now() - started);
      if (wait > 0) await delay(wait);
      if (token !== intakeToken) return;
      S.fields = result.fields || {};
      S.missing = Array.isArray(result.missing) ? result.missing : [];
      S.complete = !!result.complete;
      var prevDeferred = S.deferred || [];
      S.deferred = Array.isArray(result.deferred) ? result.deferred.filter(function (n) { return S.missing.indexOf(n) >= 0; }) : [];
      var onlyDeferred = S.missing.length > 0 && S.missing.every(function (n) { return S.deferred.indexOf(n) >= 0; });
      var grew = S.deferred.some(function (n) { return prevDeferred.indexOf(n) < 0; });
      S.review = false;
      S.awaitOpt = S.complete && OPTIONAL_FIELDS.indexOf(result.asking || '') >= 0;
      // the summary is due when only postponed fields are left and they were asked once (or postponed again, or the assistant wrapped up)
      if (onlyDeferred) {
        var asking = result.asking || '';
        var askedDeferred = S.deferred.indexOf(asking) >= 0;
        if (S.reasked || grew || !asking) S.review = true;
        else if (askedDeferred) S.reasked = true;
      }
      var chips = (Array.isArray(result.quickReplies) ? result.quickReplies : []).slice(0, 7).filter(function (c) { return c && c.label && c.value; })
        .map(function (c) { return typeof c.description === 'string' && c.description.trim() && c.description.length <= 60 ? { label: c.label, value: c.value, description: c.description.trim() } : { label: c.label, value: c.value }; });
      var entry = { role: 'assistant', text: String(result.reply || ''), chips: chips };
      S.history.push(entry);
      disableChips();
      typing.hidden = true;
      appendHistory(entry, !inReview());
      if (inReview()) renderSummary(true);
      updateProgress();
      save();
    } catch (err) {
      failed = err;
    } finally {
      if (token === intakeToken) {
        intakeBusy = false;
        typing.hidden = true;
        sendBtn.disabled = false;
      }
    }
    if (token !== intakeToken) return;
    if (failed) {
      if (message == null) {
        // the greeting failed: say so in the chat and offer a retry
        var row = h('div', { class: 'htcw-retry' },
          bubble({ who: 'agent', sender: ASSISTANT, text: 'I couldn\u2019t connect just now.' }),
          h('button', { type: 'button', class: 'htcw-btn htcw-ghost', text: 'Try again' }));
        row.querySelector('button').addEventListener('click', function () { row.remove(); retryEl = null; requestIntake(null, []); });
        retryEl = row;
        log.appendChild(row);
        scrollDown();
      } else {
        // take the message back so nothing is lost
        var i = S.history.length - 1;
        if (i >= 0 && S.history[i].role === 'customer' && S.history[i].text === message) S.history.pop();
        save();
        var bubbles = log.querySelectorAll('.htcw-user');
        if (bubbles.length) bubbles[bubbles.length - 1].remove();
        input.value = message; autoGrow();
        composerErr.textContent = 'Message not sent: ' + (failed && failed.message ? failed.message : 'network error') + '. Your text is still in the box, so you can try again.';
        composerErr.hidden = false;
      }
    }
    if (isOpen) input.focus({ preventScroll: true });
  }

  function sendCustomer(text) {
    text = String(text || '').trim();
    if (!text || intakeBusy || S.phase !== 'intake') return false;
    if (text.length > MAX_TURN_CHARS) {
      composerErr.textContent = 'Please keep each message under 2000 characters.';
      composerErr.hidden = false;
      return false;
    }
    var prior = S.history.slice();
    removeSummary();
    S.editing = false; S.editDraft = null; S.review = false; S.awaitOpt = false;
    disableChips();
    var entry = { role: 'customer', text: text };
    S.history.push(entry);
    save();
    appendHistory(entry, false);
    input.value = ''; autoGrow();
    requestIntake(text, prior);
    return true;
  }

  // ---------- typed confirmation ----------
  // <confirm-intent>
  // A short message that only confirms ("confirm", "i confirm", "yes, send", "go ahead"...). Anything with a
  // change request, a question or extra words does not match: it goes to the assistant as usual.
  var CONFIRM_RE = /^(?:(?:ok|okay|yes|yep|yeah|sure|please)\s+)?(?:i\s+)?(?:confirm|confirmed|confirm it|send|send it|send it in|send it off|submit|submit it|go ahead|go ahead and send|go ahead and submit|looks good send|looks good send it|looks good submit|all good send it)(?:\s+please)?$/;
  function isConfirmIntent(text) {
    if (typeof text !== 'string' || text.length > 40) return false;
    var t = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return !!t && CONFIRM_RE.test(t);
  }
  // </confirm-intent>
  // With the summary card on screen, a typed confirmation does what the Confirm button does. Returns true when handled.
  function typedConfirm(text) {
    if (!summaryEl || S.editing || S.phase !== 'intake' || !isConfirmIntent(text)) return false;
    var miss = requiredMissing();
    if (miss.length) {
      // Confirm is waiting for a required field: say so here, without calling the assistant, and point at it
      var names = miss.map(function (n) { return LABELS[n]; });
      var say = 'Almost there: ' + names.join(', ') + (names.length === 1 ? ' is' : ' are') + ' still marked Missing in the summary. Please fill ' + (names.length === 1 ? 'it' : 'them') + ' in, then tap Confirm.';
      summaryEl.parentNode.insertBefore(bubble({ who: 'user', text: text }), summaryEl);
      summaryEl.parentNode.insertBefore(bubble({ who: 'agent', sender: ASSISTANT, text: say }), summaryEl);
      var first = summaryEl.querySelector('.htcw-sum-missing input, .htcw-sum-missing select');
      if (first) first.focus({ preventScroll: false });
      return true;
    }
    summaryEl.requestSubmit(); // the card's submit handler = the Confirm button
    return true;
  }

  // ---------- files held during the intake ----------
  function heldTray() {
    fileTray.textContent = '';
    heldFiles.forEach(function (f) {
      var rm = h('button', { type: 'button', class: 'htcw-link', 'aria-label': 'Remove ' + f.name, text: 'Remove' });
      rm.addEventListener('click', function () {
        heldFiles.splice(heldFiles.indexOf(f), 1);
        heldTray();
        if (summaryEl) renderSummary(false);
        input.focus();
      });
      fileTray.appendChild(h('li', { class: 'htcw-file' },
        h('span', { class: 'htcw-file-name', text: f.name + ' (' + fmtSize(f.size) + ')' }),
        h('span', { class: 'htcw-file-status', text: 'Sent when you confirm' }),
        h('span', { class: 'htcw-file-actions' }, rm)));
    });
    fileTray.hidden = !fileTray.children.length;
  }

  var uid = 0;

  // ---------- files: shared rules ----------
  var heldFiles = []; // files attached during the intake: held here, uploaded right after the quote is created
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1023.5 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  // returns '' when the file is acceptable, otherwise the English reason
  function checkFile(f) {
    var name = f.name || '';
    var dot = name.lastIndexOf('.');
    var ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    var inner = name.slice(0, Math.max(dot, 0)).match(/\.([A-Za-z0-9]{1,8})$/);
    if (FILE_EXT.indexOf(ext) === -1 || (inner && RISKY_INNER.indexOf(inner[1].toLowerCase()) !== -1)) {
      return name + ' isn\u2019t accepted. Use ' + FILE_TYPES_TEXT + '.';
    }
    if (f.size === 0) return name + ' is empty.';
    if (f.size > MAX_FILE_BYTES) return name + ' is ' + fmtSize(f.size) + '. The limit is 5 MB per file.';
    return '';
  }
  // keeps what is acceptable, up to MAX_FILES in total, and says why the rest was left out
  function pickFiles(list, already) {
    var ok = [], errors = [];
    for (var i = 0; i < list.length; i++) {
      var why = checkFile(list[i]);
      if (why) { errors.push(why); continue; }
      if (already + ok.length >= MAX_FILES) { errors.push('You can attach up to 5 files at a time. ' + list[i].name + ' was left out.'); continue; }
      ok.push(list[i]);
    }
    return { ok: ok, errors: errors };
  }


  // ---------- summary card ----------
  var GROUPS = [
    { title: 'Contact', names: ['name', 'company', 'email', 'phone'] },
    { title: 'Board', names: ['boardType', 'singleUpOrArray', 'unitOfMeasure', 'width', 'length', 'layers', 'quantity'] },
    { title: 'Delivery & compliance', names: ['leadTimeDays', 'itarClassification'] }
  ];
  var LABELS = {
    name: 'Name', company: 'Company', email: 'Email', phone: 'Phone', boardType: 'Board type', singleUpOrArray: 'Single up or array',
    unitOfMeasure: 'Unit', width: 'Width', length: 'Length', layers: 'Layers', quantity: 'Quantity', leadTimeDays: 'Lead time', itarClassification: 'Classification', comment: 'Notes'
  };
  var CHIP_VALUES = {
    boardType: BOARD_TYPES.map(function (b) { return [b, b]; }),
    singleUpOrArray: [['Single Up', 'Single up'], ['Array', 'Array']],
    unitOfMeasure: [['mm', 'mm'], ['inches', 'inches']],
    itarClassification: [['Commercial', 'Commercial (not ITAR/EAR controlled)'], ['ITAR/EAR', 'ITAR/EAR controlled']]
  };
  var CHIP_MSG = { boardType: 'Please choose a board type.', singleUpOrArray: 'Please choose single up or array.', unitOfMeasure: 'Please choose the unit.', itarClassification: 'Please choose the classification.' };

  function showValue(name) {
    var v = S.fields[name];
    if (v === undefined || v === null || v === '') return '';
    if (name === 'width' || name === 'length') return v + ' ' + (S.fields.unitOfMeasure || '');
    if (name === 'leadTimeDays') return v + (Number(v) === 1 ? ' day' : ' days');
    return String(v);
  }

  // one client rule per field, the same rules the server applies; returns '' when fine
  function fieldProblem(name, raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (name === 'name' && !v) return 'Please enter your name.';
    if (name === 'company' && !v) return 'Please enter your company name.';
    if (name === 'email') {
      if (!v) return 'Please enter your email address.';
      if (!EMAIL_RE.test(v)) return 'That email doesn\u2019t look right. Use a format like name@company.com.';
    }
    if (name === 'phone' && !v) return 'Please enter a phone number.';
    if (name === 'layers') {
      if (!v) return 'Please enter the number of layers.';
      if (!(Number(v) >= 1 && Number(v) <= 64 && Number.isInteger(Number(v)))) return 'Enter a whole number of layers from 1 to 64.';
    }
    if (name === 'quantity') {
      if (!v) return 'Please enter a quantity.';
      if (!(Number(v) >= 1 && Number.isInteger(Number(v)) && Number(v) <= 1000000)) return 'Enter a whole quantity of 1 or more.';
    }
    if (name === 'width' || name === 'length') {
      if (!v) return name === 'width' ? 'Please enter the board width.' : 'Please enter the board length.';
      if (!(Number(v) > 0 && Number(v) <= 10000)) return 'Enter a ' + name + ' greater than 0 and at most 10000.';
    }
    if (name === 'leadTimeDays' && v && !(Number(v) >= 0 && Number(v) <= 365)) return 'Enter a lead time from 0 to 365 days, or leave it empty.';
    if (CHIP_MSG[name] && !v) return CHIP_MSG[name];
    return '';
  }
  function parseValue(name, raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (v === '') return undefined;
    return NUMERIC[name] ? Number(v) : v;
  }

  function field(opts, src) {
    var id = 'htcw-f-' + (++uid);
    var errId = id + '-err';
    var control;
    if (opts.kind === 'textarea') control = h('textarea', { id: id, name: opts.name, rows: '3', maxlength: '2000', placeholder: opts.placeholder || null });
    else {
      control = h('input', {
        id: id, name: opts.name, type: opts.type || 'text', autocomplete: opts.autocomplete || null,
        inputmode: opts.inputmode || null, placeholder: opts.placeholder || null, min: opts.min || null, max: opts.max || null, step: opts.step || null, maxlength: opts.maxlength || null
      });
    }
    if (opts.required) control.setAttribute('aria-required', 'true');
    control.value = src[opts.name] != null ? src[opts.name] : '';
    var err = h('p', { class: 'htcw-err', id: errId, hidden: true });
    var wrap = h('div', { class: 'htcw-field' + (opts.full ? ' htcw-full' : '') },
      h('label', { for: id }, opts.label, opts.required ? h('span', { class: 'htcw-req', 'aria-hidden': 'true', text: ' *' }) : h('span', { class: 'htcw-opt', text: ' (optional)' })),
      control, err);
    return {
      el: wrap, control: control, name: opts.name,
      fail: function (msg) {
        err.textContent = msg; err.hidden = false;
        control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', errId);
      },
      clear: function () {
        err.hidden = true; err.textContent = '';
        control.removeAttribute('aria-invalid'); control.removeAttribute('aria-describedby');
      }
    };
  }
  function chips(name, label, values, opts, src) {
    opts = opts || {};
    var errId = 'htcw-r-' + name + '-err-' + (++uid);
    var legend = h('legend', { text: label }, opts.required ? h('span', { class: 'htcw-req', 'aria-hidden': 'true', text: ' *' }) : null);
    var group = h('fieldset', { class: 'htcw-chips' + (opts.full === false ? '' : ' htcw-full'), 'aria-required': opts.required ? 'true' : null }, legend);
    var list = h('div', { class: 'htcw-chiplist' });
    values.forEach(function (v) {
      var id = 'htcw-r-' + name + '-' + (++uid);
      var radio = h('input', { type: 'radio', id: id, name: 'htcw-' + name, value: v[0] });
      if (src[name] === v[0]) radio.checked = true;
      list.appendChild(h('span', { class: 'htcw-chip' }, radio, h('label', { for: id, text: v[1] })));
    });
    group.appendChild(list);
    var err = h('p', { class: 'htcw-err', id: errId, hidden: true });
    group.appendChild(err);
    return {
      el: group, name: name, required: !!opts.required,
      value: function () { var c = group.querySelector('input:checked'); return c ? c.value : ''; },
      first: function () { return group.querySelector('input'); },
      fail: function (msg) { err.textContent = msg; err.hidden = false; group.setAttribute('aria-invalid', 'true'); group.setAttribute('aria-describedby', errId); },
      clear: function () { err.hidden = true; err.textContent = ''; group.removeAttribute('aria-invalid'); group.removeAttribute('aria-describedby'); }
    };
  }

  function activeSummaryCleanup() { summaryEl = null; }
  function removeSummary() { if (summaryEl) { summaryEl.remove(); summaryEl = null; } }

  // The card under the assistant's last reply. announce: move focus to it only when it appears fresh.
  function renderSummary(fresh) {
    removeSummary();
    var card = S.editing ? buildEditCard() : buildViewCard();
    if (fresh && !reducedMotion()) card.classList.add('htcw-card-in');
    summaryEl = card;
    log.appendChild(card);
    // the card is taller than the log: show its top, not its bottom
    log.scrollTop += card.getBoundingClientRect().top - log.getBoundingClientRect().top - 8;
    return card;
  }

  var REQUIRED_NAMES = ['name', 'company', 'email', 'phone', 'boardType', 'singleUpOrArray', 'unitOfMeasure', 'width', 'length', 'layers', 'quantity', 'itarClassification'];
  function requiredMissing() { return REQUIRED_NAMES.filter(function (n) { return fieldProblem(n, S.fields[n]); }); }
  // A required field that is still missing: "Missing" plus an inline input; a valid value is stored at once and unlocks Confirm.
  function missingRow(name) {
    var id = 'htcw-m-' + name + '-' + (++uid);
    var errId = id + '-err';
    var control;
    var choices = CHIP_VALUES[name];
    if (choices) {
      control = h('select', { id: id, name: name, 'aria-required': 'true' }, h('option', { value: '', text: 'Choose\u2026' }));
      choices.forEach(function (v) { control.appendChild(h('option', { value: v[0], text: v[1] })); });
    } else {
      control = h('input', {
        id: id, name: name, type: name === 'email' ? 'email' : (name === 'phone' ? 'tel' : (NUMERIC[name] ? 'number' : 'text')), 'aria-required': 'true',
        autocomplete: name === 'email' ? 'email' : (name === 'phone' ? 'tel' : (name === 'name' ? 'name' : (name === 'company' ? 'organization' : null))),
        inputmode: name === 'email' ? 'email' : (name === 'phone' ? 'tel' : (NUMERIC[name] ? 'decimal' : null)),
        placeholder: name === 'email' ? 'name@company.com' : (name === 'phone' ? '+1 555 0100' : null), min: NUMERIC[name] ? '0' : null, step: NUMERIC[name] ? 'any' : null
      });
    }
    var err = h('p', { class: 'htcw-err', id: errId, hidden: true });
    var row = h('div', { class: 'htcw-sum-row htcw-sum-missing' },
      h('dt', {}, h('label', { for: id, text: LABELS[name] })),
      h('dd', {}, h('span', { class: 'htcw-missing-tag', text: 'Missing' }), control, err));
    function sync() {
      var raw = control.value;
      var problem = fieldProblem(name, raw);
      var v = parseValue(name, raw);
      if (!problem && v !== undefined) S.fields[name] = v; else delete S.fields[name];
      save();
      if (!problem) { err.hidden = true; control.removeAttribute('aria-invalid'); control.removeAttribute('aria-describedby'); }
      row.dispatchEvent(new CustomEvent('htcw-fill', { bubbles: true }));
    }
    control.addEventListener('input', sync);
    control.addEventListener('change', sync);
    control.addEventListener('blur', function () {
      var problem = control.value.trim() ? fieldProblem(name, control.value) : '';
      if (problem) { err.textContent = problem; err.hidden = false; control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', errId); }
    });
    return row;
  }

  function buildViewCard() {
    var status = h('p', { class: 'htcw-err htcw-card-err', role: 'alert', hidden: true });
    var card = h('form', { class: 'htcw-card htcw-sum', novalidate: true, 'aria-label': 'Your quote request summary' },
      h('h3', { class: 'htcw-sum-title', text: 'Here\u2019s what I have' }));
    GROUPS.forEach(function (g) {
      var dl = h('dl', { class: 'htcw-sum-list' });
      g.names.forEach(function (n) {
        var val = showValue(n);
        if (!val && REQUIRED_NAMES.indexOf(n) >= 0) { dl.appendChild(missingRow(n)); return; }
        dl.appendChild(h('div', { class: 'htcw-sum-row' }, h('dt', { text: LABELS[n] }), h('dd', { class: val ? '' : 'htcw-muted', text: val || 'Not provided' })));
      });
      card.appendChild(h('section', { class: 'htcw-sum-group', 'aria-label': g.title }, h('h4', { text: g.title }), dl));
    });
    var extra = h('dl', { class: 'htcw-sum-list' });
    extra.appendChild(h('div', { class: 'htcw-sum-row' }, h('dt', { text: LABELS.comment }), h('dd', { class: S.fields.comment ? '' : 'htcw-muted', text: S.fields.comment || 'None' })));
    extra.appendChild(h('div', { class: 'htcw-sum-row' }, h('dt', { text: 'Files' }),
      h('dd', { class: heldFiles.length ? '' : 'htcw-muted', text: heldFiles.length ? heldFiles.map(function (f) { return f.name; }).join(', ') : 'None yet. Use the paperclip to add drawings or Gerbers.' })));
    card.appendChild(h('section', { class: 'htcw-sum-group', 'aria-label': 'Notes and files' }, extra));
    var confirmBtn = h('button', { type: 'submit', class: 'htcw-btn htcw-primary', text: 'Confirm' });
    confirmBtn.disabled = requiredMissing().length > 0; // the client rule mirrors the server: Confirm waits for every required field
    card.addEventListener('htcw-fill', function () { confirmBtn.disabled = requiredMissing().length > 0; });
    var changeBtn = h('button', { type: 'button', class: 'htcw-btn htcw-ghost', 'data-change': '', text: 'Change something' });
    card.appendChild(status);
    card.appendChild(h('div', { class: 'htcw-actions' }, changeBtn, confirmBtn));
    changeBtn.addEventListener('click', function () {
      S.editing = true;
      S.editDraft = {};
      Object.keys(S.fields).forEach(function (k) { S.editDraft[k] = S.fields[k]; });
      save();
      var c = renderSummary(false);
      var f = c.querySelector('input:not([type=radio]), textarea');
      if (f) f.focus({ preventScroll: true });
    });
    card.addEventListener('submit', function (e) {
      e.preventDefault();
      confirmQuote(confirmBtn, status);
    });
    return card;
  }

  function buildEditCard() {
    var draft = S.editDraft || (S.editDraft = {});
    var fields = [], chipSets = [];
    var status = h('p', { class: 'htcw-err htcw-card-err', role: 'alert', hidden: true });
    var card = h('form', { class: 'htcw-card htcw-sum', novalidate: true, 'aria-label': 'Change your quote details' },
      h('h3', { class: 'htcw-sum-title', text: 'Change something' }));
    var grid = h('div', { class: 'htcw-grid' });
    function add(f) { fields.push(f); grid.appendChild(f.el); return f; }
    function addChips(c) { chipSets.push(c); grid.appendChild(c.el); }
    add(field({ name: 'name', label: 'Your name', required: true, autocomplete: 'name', full: true }, draft));
    add(field({ name: 'company', label: 'Company', required: true, autocomplete: 'organization', full: true }, draft));
    add(field({ name: 'email', label: 'Work email', type: 'email', required: true, autocomplete: 'email', inputmode: 'email', full: true }, draft));
    add(field({ name: 'phone', label: 'Phone', required: true, type: 'tel', autocomplete: 'tel', inputmode: 'tel', full: true }, draft));
    addChips(chips('boardType', 'Board type', CHIP_VALUES.boardType, { required: true }, draft));
    addChips(chips('singleUpOrArray', 'Single up or array', CHIP_VALUES.singleUpOrArray, { required: true, full: false }, draft));
    addChips(chips('unitOfMeasure', 'Unit of measure', CHIP_VALUES.unitOfMeasure, { required: true, full: false }, draft));
    add(field({ name: 'width', label: 'Width', required: true, type: 'number', min: '0', step: 'any', inputmode: 'decimal' }, draft));
    add(field({ name: 'length', label: 'Length', required: true, type: 'number', min: '0', step: 'any', inputmode: 'decimal' }, draft));
    add(field({ name: 'layers', label: 'Layers', required: true, type: 'number', min: '1', max: '64', step: '1', inputmode: 'numeric', placeholder: 'e.g. 4' }, draft));
    add(field({ name: 'quantity', label: 'Quantity', required: true, type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder: 'e.g. 100' }, draft));
    add(field({ name: 'leadTimeDays', label: 'Lead time in days', type: 'number', min: '0', max: '365', step: 'any', inputmode: 'decimal', placeholder: 'No preference' }, draft));
    addChips(chips('itarClassification', 'Classification', CHIP_VALUES.itarClassification, { required: true }, draft));
    add(field({ name: 'comment', label: 'Anything else?', kind: 'textarea', placeholder: 'Finish, stackup, impedance, special requirements', full: true }, draft));
    card.appendChild(grid);
    var save_ = h('button', { type: 'submit', class: 'htcw-btn htcw-primary', text: 'Save changes' });
    var cancel = h('button', { type: 'button', class: 'htcw-btn htcw-ghost', text: 'Cancel' });
    card.appendChild(status);
    card.appendChild(h('div', { class: 'htcw-actions' }, cancel, save_));

    function collect() {
      fields.forEach(function (f) { draft[f.name] = f.control.value; });
      chipSets.forEach(function (c) { draft[c.name] = c.value(); });
      save();
    }
    card.addEventListener('input', collect);
    card.addEventListener('change', collect);

    function validate() {
      var ok = true, firstBad = null;
      fields.forEach(function (f) {
        f.clear();
        var msg = fieldProblem(f.name, f.control.value);
        if (msg) { f.fail(msg); ok = false; if (!firstBad) firstBad = f.control; }
      });
      chipSets.forEach(function (c) {
        c.clear();
        if (c.required && !c.value()) { c.fail(CHIP_MSG[c.name]); ok = false; if (!firstBad) firstBad = c.first(); }
      });
      if (firstBad) firstBad.focus();
      return ok;
    }
    function leave() {
      S.editing = false; S.editDraft = null; save();
      var c = renderSummary(false);
      var b = c.querySelector('button[type=submit]');
      if (b) b.focus({ preventScroll: true });
    }
    cancel.addEventListener('click', leave);
    card.addEventListener('submit', function (e) {
      e.preventDefault();
      collect();
      if (!validate()) return;
      var changes = [];
      var next = {};
      Object.keys(LABELS).forEach(function (n) {
        var v = parseValue(n, draft[n]);
        if (v !== undefined) next[n] = v;
        if (next[n] !== S.fields[n]) changes.push(n);
      });
      S.fields = next;
      if (changes.length) {
        var parts = changes.map(function (n) {
          var v = next[n];
          if (v === undefined) return LABELS[n] + ' cleared';
          return LABELS[n] + ' ' + (n === 'comment' ? '\u201c' + String(v).slice(0, 200) + '\u201d' : v);
        });
        var entry = { role: 'customer', text: ('Updated: ' + parts.join(', ') + '.').slice(0, MAX_TURN_CHARS), note: true };
        S.history.push(entry);
        S.editing = false; S.editDraft = null;
        save();
        removeSummary();
        disableChips();
        appendHistory(entry, false);
        updateProgress();
        var c = renderSummary(false);
        var b = c.querySelector('button[type=submit]');
        if (b) b.focus({ preventScroll: true });
      } else {
        leave();
      }
    });
    return card;
  }

  function numOrNull(v) {
    if (v === '' || v == null) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function honeypotValue() {
    var el = document.querySelector('#htcw input[name="website"]');
    return el ? el.value : '';
  }

  // Confirm: creates the quote (the only write to Salesforce) with the fields and the whole intake as transcript.
  async function confirmQuote(button, status) {
    var f = S.fields;
    var bad = null;
    ['name', 'company', 'email', 'phone', 'boardType', 'singleUpOrArray', 'unitOfMeasure', 'width', 'length', 'layers', 'quantity', 'itarClassification'].forEach(function (n) {
      if (!bad && fieldProblem(n, f[n])) bad = fieldProblem(n, f[n]);
    });
    if (bad) {
      status.textContent = bad + ' Use \u201cChange something\u201d to fix it.';
      status.hidden = false;
      return;
    }
    var payload = {
      name: String(f.name).trim(), company: String(f.company).trim(), email: String(f.email).trim(), phone: String(f.phone).trim(),
      boardType: f.boardType, singleUpOrArray: f.singleUpOrArray, unitOfMeasure: f.unitOfMeasure,
      width: numOrNull(f.width), length: numOrNull(f.length), layers: numOrNull(f.layers),
      leadTimeDays: numOrNull(f.leadTimeDays), quantity: numOrNull(f.quantity),
      itarClassification: f.itarClassification, comment: String(f.comment || '').trim(),
      transcript: S.history.slice(-SEND_TRANSCRIPT).map(function (e) { return { role: e.role, text: String(e.text).slice(0, MAX_TURN_CHARS) }; }),
      website: honeypotValue()
    };
    // files follow right after: the last upload (not quote creation) wakes the assistant, so it answers once
    if (heldFiles.length) payload.filesPending = true;
    status.hidden = true;
    button.disabled = true;
    button.textContent = 'Opening your quote…';
    try {
      var res = await fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      var result = await res.json();
      if (!result.success) throw new Error(result.errorMessage || 'Quote creation failed');
      startChat(result);
    } catch (err) {
      status.textContent = 'We couldn\u2019t open your quote: ' + (err && err.message ? err.message : 'network error') + '. Please try again.';
      status.hidden = false;
      button.disabled = false;
      button.textContent = 'Confirm';
    }
  }

  // ---------- chat phase ----------
  function startChat(result) {
    intakeToken++;
    S.quoteId = result.quoteId;
    S.conversationId = result.conversationId;
    S.phase = 'chat';
    S.seen = [];
    // Messages created with the quote (the intake transcript) are older than this: the poller never replays them.
    S.baseline = result.serverTime || new Date().toISOString();
    pollAfter = S.baseline;
    S.thread = S.history.map(function (e) {
      return e.role === 'assistant' ? { who: 'agent', sender: ASSISTANT, text: e.text } : { who: 'user', text: e.text };
    });
    var first = firstName();
    S.thread.push({ who: 'agent', sender: ASSISTANT, text: 'Thanks' + (first ? ', ' + first : '') + '. Your quote request is open with HT Global. I\u2019ll reply here, and our team can join in too.' });
    S.history = []; S.complete = false; S.awaitOpt = false; S.missing = []; S.deferred = []; S.reasked = false; S.review = false; S.editing = false; S.editDraft = null;
    S.pendingSince = Date.now();
    save();
    summaryEl = null;
    input.placeholder = 'Type your message…';
    updateProgress();
    renderChat();
    schedulePoll(POLL_FAST_MS);
    updateTyping();
    input.focus();
    if (heldFiles.length) uploadBatch(heldFiles.splice(0, heldFiles.length), true);
  }

  function renderChat() {
    log.textContent = '';
    S.thread.forEach(function (e) { log.appendChild(bubble(e)); });
    composer.hidden = false;
    input.placeholder = 'Type your message…';
    fileTray.textContent = ''; fileTray.hidden = true;
    updateProgress();
    scrollDown();
    updateTyping();
  }

  var typingTimer = null;
  function updateTyping() {
    clearTimeout(typingTimer);
    typingTimer = null;
    if (S.phase !== 'chat' || !S.pendingSince) { if (!intakeBusy) typing.hidden = true; return; }
    var left = TYPING_MAX_MS - (Date.now() - S.pendingSince);
    if (left <= 0) {
      S.pendingSince = null;
      typing.hidden = true;
      addEntry({ who: 'agent', sender: ASSISTANT, text: 'This is taking a little longer than usual. Your message is with our team, and the reply will appear here as soon as it arrives.' });
      return;
    }
    typing.hidden = false;
    scrollDown();
    typingTimer = setTimeout(updateTyping, left);
  }

  var sending = false;
  composer.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (S.phase === 'intake') {
      var t = input.value.trim();
      if (!t) return;
      composerErr.hidden = true;
      if (typedConfirm(t)) { input.value = ''; autoGrow(); return; }
      sendCustomer(t);
      return;
    }
    if (sending || !S.conversationId) return;
    var text = input.value.trim();
    if (!text) return;
    sending = true;
    sendBtn.disabled = true;
    composerErr.hidden = true;
    var el = addEntry({ who: 'user', text: text });
    var entry = S.thread[S.thread.length - 1];
    input.value = '';
    autoGrow();
    try {
      var res = await fetch('/api/quote', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: S.conversationId, quoteId: S.quoteId, message: text })
      });
      var result = await res.json();
      if (!result.success) throw new Error(result.errorMessage || 'Message failed');
      S.pendingSince = Date.now();
      save();
      lastActivity = Date.now();
      updateTyping();
      schedulePoll(POLL_FAST_MS);
    } catch (err) {
      var i = S.thread.lastIndexOf(entry);
      if (i >= 0) S.thread.splice(i, 1);
      save();
      el.remove();
      input.value = text;
      autoGrow();
      composerErr.textContent = 'Message not sent: ' + (err && err.message ? err.message : 'network error') + '. Your text is still in the box, so you can try again.';
      composerErr.hidden = false;
    } finally {
      sending = false;
      sendBtn.disabled = false;
      if (isOpen) input.focus();
    }
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); }
  });
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  }
  input.addEventListener('input', autoGrow);

  // ---------- file uploads (chat) ----------
  var uploadsBusy = 0;
  function setBusy(delta) {
    uploadsBusy += delta;
    clipBtn.disabled = uploadsBusy > 0;
    clipBtn.classList.toggle('htcw-busy', uploadsBusy > 0);
  }
  function announce(text) { fileLive.textContent = ''; setTimeout(function () { fileLive.textContent = text; }, 30); }
  function trayVisibility() { fileTray.hidden = !fileTray.children.length; }

  function addRow(file) {
    var name = h('span', { class: 'htcw-file-name', text: file.name + ' (' + fmtSize(file.size) + ')' });
    var bar = h('progress', { class: 'htcw-file-bar', max: '100', value: '0', 'aria-label': 'Uploading ' + file.name });
    var status = h('span', { class: 'htcw-file-status', text: 'Waiting…' });
    var retry = h('button', { type: 'button', class: 'htcw-link', text: 'Retry', hidden: true });
    var drop = h('button', { type: 'button', class: 'htcw-link', 'aria-label': 'Dismiss ' + file.name, text: 'Dismiss', hidden: true });
    var li = h('li', { class: 'htcw-file' }, name, bar, status, h('span', { class: 'htcw-file-actions' }, retry, drop));
    fileTray.appendChild(li);
    trayVisibility();
    scrollDown();
    var row = {
      file: file, li: li, retry: retry,
      uploading: function () { bar.hidden = false; retry.hidden = true; drop.hidden = true; li.classList.remove('htcw-file-failed'); },
      progress: function (p) { bar.value = Math.round(p * 100); status.textContent = 'Uploading ' + Math.round(p * 100) + '%'; },
      failed: function (why) { bar.hidden = true; status.textContent = why; li.classList.add('htcw-file-failed'); retry.hidden = false; drop.hidden = false; },
      done: function () { li.remove(); trayVisibility(); }
    };
    drop.addEventListener('click', function () { li.remove(); trayVisibility(); input.focus(); });
    retry.addEventListener('click', async function () {
      if (uploadsBusy) return;
      setBusy(1);
      try { await sendFile(file, row, false); } finally { setBusy(-1); }
    });
    return row;
  }

  function failureText(file, status, json) {
    var msg = json && typeof json.errorMessage === 'string' ? json.errorMessage : '';
    if (status === 413) return file.name + ' is too large. The limit is 5 MB per file.';
    if (status === 415 || status === 400 || status === 429) return msg || (file.name + ' could not be attached.');
    if (status === 404) return 'This quote can\u2019t be found. Start a new quote from the menu.';
    return 'Something went wrong. Please try again.';
  }

  // Resolves true when the file is stored. more=1 tells the server this is not the last file of the batch,
  // so the assistant answers once per batch instead of once per file.
  function sendFile(file, row, more) {
    var convo = S.conversationId, quote = S.quoteId;
    return new Promise(function (resolve) {
      row.uploading();
      row.progress(0);
      announce('Uploading ' + file.name);
      var xhr = new XMLHttpRequest();
      var query = 'conversationId=' + encodeURIComponent(convo) + '&quoteId=' + encodeURIComponent(quote) + (more ? '&more=1' : '');
      xhr.open('POST', '/api/quote/files?' + query);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.timeout = 180000;
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) row.progress(e.loaded / e.total); };
      function fail(why) { row.failed(why); announce(file.name + ' failed. ' + why); resolve(false); }
      xhr.onerror = function () { fail('Network error. Check your connection and retry.'); };
      xhr.ontimeout = function () { fail('The upload timed out. Retry.'); };
      xhr.onload = function () {
        var json = null;
        try { json = JSON.parse(xhr.responseText); } catch (e) { /* not json */ }
        if (xhr.status === 200 && json && json.success) {
          row.done();
          if (convo === S.conversationId) {
            addEntry({ who: 'user', text: '\uD83D\uDCCE ' + file.name + ' (' + fmtSize(file.size) + ')' });
            S.pendingSince = Date.now();
            save();
            lastActivity = Date.now();
            updateTyping();
            schedulePoll(POLL_FAST_MS);
          }
          announce(file.name + ' attached.');
          // 'notified': the server logged the message and (unless more=1) woke the assistant; 'stored': file kept, no message
          resolve(json.stored && json.messageLogged === false ? 'stored' : 'notified');
        } else {
          fail(failureText(file, xhr.status, json));
        }
      };
      xhr.send(file);
    });
  }

  // ensureReply: the quote was created with filesPending, so no one has woken the assistant yet. If the batch
  // ends without a successful last upload doing it, one normal chat message does.
  async function uploadBatch(files, ensureReply) {
    if (!files.length || !S.conversationId) return;
    var convo = S.conversationId, quote = S.quoteId;
    var notified = false;
    setBusy(1);
    try {
      for (var i = 0; i < files.length; i++) {
        var last = i === files.length - 1;
        var r = await sendFile(files[i], addRow(files[i]), !last);
        if (last && r === 'notified') notified = true;
      }
      if (ensureReply && !notified && convo === S.conversationId) {
        var text = 'I tried to attach files but some could not be uploaded.';
        try {
          var res = await fetch('/api/quote', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: convo, quoteId: quote, message: text })
          });
          var result = await res.json();
          if (result.success) {
            addEntry({ who: 'user', text: text });
            S.pendingSince = Date.now();
            save();
            lastActivity = Date.now();
            updateTyping();
            schedulePoll(POLL_FAST_MS);
          }
        } catch (e) { /* the failed rows already show Retry */ }
      }
    } finally {
      setBusy(-1);
    }
  }

  clipBtn.addEventListener('click', function () { if (!uploadsBusy) fileInput.click(); });
  fileInput.addEventListener('change', function () {
    var intake = S.phase !== 'chat';
    var res = pickFiles(Array.prototype.slice.call(fileInput.files || []), intake ? heldFiles.length : 0);
    fileInput.value = '';
    if (res.errors.length) { composerErr.textContent = res.errors.join(' '); composerErr.hidden = false; }
    else composerErr.hidden = true;
    if (!res.ok.length) return;
    if (intake) {
      // the quote does not exist yet: hold the files and upload them right after Confirm
      res.ok.forEach(function (f) { heldFiles.push(f); });
      heldTray();
      announce(res.ok.length + (res.ok.length === 1 ? ' file' : ' files') + ' added. ' + (res.ok.length === 1 ? 'It' : 'They') + ' will be sent when you confirm.');
      // the conversation continues: the assistant acknowledges the files (if it is busy, the summary just refreshes)
      var sent = sendCustomer(('Attached: ' + res.ok.map(function (f) { return f.name; }).join(', ')).slice(0, MAX_TURN_CHARS));
      if (!sent && summaryEl && !S.editing) renderSummary(false);
    } else {
      uploadBatch(res.ok);
    }
  });

  // ---------- polling (T5 logic) ----------
  var pollTimer = null;
  var pollAfter = S.baseline || null; // the intake transcript is older than the baseline: never replayed from the server
  var lastActivity = Date.now();
  var polling = false;
  var unread = 0;

  function nextDelay() { return Date.now() - lastActivity > SLOW_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS; }
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!S.conversationId || document.hidden) return;
    pollTimer = setTimeout(pollMessages, delay == null ? nextDelay() : delay);
  }
  async function pollMessages() {
    pollTimer = null;
    if (!S.conversationId || document.hidden || polling) return;
    polling = true;
    var convo = S.conversationId;
    try {
      var params = new URLSearchParams({ conversationId: S.conversationId, quoteId: S.quoteId });
      if (pollAfter) params.set('after', pollAfter);
      var res = await fetch('/api/quote/messages?' + params, { cache: 'no-store' });
      var result = await res.json();
      if (convo !== S.conversationId) return; // a new quote was started meanwhile
      if (result.success) {
        var got = 0;
        (result.messages || []).forEach(function (m) {
          if (S.seen.indexOf(m.id) !== -1) return;
          S.seen.push(m.id);
          var sender = m.sender || (m.fromAgent ? ASSISTANT : 'HT Global team');
          S.thread.push({ who: 'agent', sender: sender, text: m.body, id: m.id });
          if (S.phase === 'chat') log.appendChild(bubble({ who: 'agent', sender: sender, text: m.body }));
          got++;
        });
        if (got) {
          lastActivity = Date.now();
          S.pendingSince = null;
          updateTyping();
          scrollDown();
          if (!isOpen) { unread += got; renderBadge(); }
        }
        if (S.seen.length > 500) S.seen = S.seen.slice(-500);
        save();
        if (result.serverTime) pollAfter = new Date(Math.max(new Date(result.serverTime).getTime() - 10000, S.baseline ? new Date(S.baseline).getTime() : 0)).toISOString();
      }
    } catch (e) {
      // transient: retry on the next tick
    } finally {
      polling = false;
      schedulePoll();
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimeout(pollTimer); pollTimer = null; }
    else if (S.conversationId) { lastActivity = Date.now(); schedulePoll(0); }
  });

  function renderBadge() {
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    launcher.setAttribute('aria-label', 'Open HT Global quote assistant' + (unread ? ', ' + unread + ' new ' + (unread === 1 ? 'reply' : 'replies') : ', get an instant quote'));
  }

  // ---------- open / close / menu ----------
  var isOpen = false;
  function open(opts) {
    opts = opts || {};
    if (isOpen) return;
    isOpen = true;
    S.open = true; save();
    panel.hidden = false;
    // next frame so the CSS transition runs
    requestAnimationFrame(function () { root.classList.add('htcw-open'); });
    launcher.setAttribute('aria-expanded', 'true');
    unread = 0; renderBadge();
    tip.classList.remove('htcw-tip-show');
    resumeIntake();
    scrollDown();
    if (opts.focus !== false) {
      setTimeout(function () {
        input.focus();
      }, 30);
    }
    if (S.conversationId) schedulePoll(0);
  }
  function close(opts) {
    if (!isOpen) return;
    isOpen = false;
    S.open = false; save();
    closeMenu();
    root.classList.remove('htcw-open');
    launcher.setAttribute('aria-expanded', 'false');
    var done = function () { if (!isOpen) panel.hidden = true; };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 200);
    if (!opts || opts.restoreFocus !== false) launcher.focus();
  }
  launcher.addEventListener('click', function () { isOpen ? close() : open(); });
  closeBtn.addEventListener('click', function () { close(); });

  function closeMenu(restore) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    if (restore) menuBtn.focus();
  }
  function buildMenu(confirming) {
    menu.textContent = '';
    if (!confirming) {
      var item = h('button', { type: 'button', role: 'menuitem', class: 'htcw-menuitem', text: 'Start a new quote' });
      item.addEventListener('click', function () {
        if (S.phase === 'chat') buildMenu(true); else { closeMenu(); resetAll(); }
      });
      menu.appendChild(item);
      return item;
    }
    var msg = h('p', { class: 'htcw-menumsg', text: 'Start over? This conversation stays on file with HT Global, but it will leave this window.' });
    var yes = h('button', { type: 'button', role: 'menuitem', class: 'htcw-menuitem htcw-menu-danger', text: 'Yes, start a new quote' });
    var no = h('button', { type: 'button', role: 'menuitem', class: 'htcw-menuitem', text: 'Keep this conversation' });
    yes.addEventListener('click', function () { closeMenu(); resetAll(); });
    no.addEventListener('click', function () { closeMenu(true); });
    menu.appendChild(msg); menu.appendChild(yes); menu.appendChild(no);
    no.focus();
    return no;
  }
  menuBtn.addEventListener('click', function () {
    if (!menu.hidden) { closeMenu(); return; }
    var first = buildMenu(false);
    menu.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    first.focus();
  });
  menu.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(menu.querySelectorAll('[role=menuitem]'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  document.addEventListener('click', function (e) {
    if (menu.hidden) return;
    // composedPath() is captured when the click is dispatched, so it still contains the menu even
    // when the clicked item was replaced in the meantime ("Start a new quote" swaps in the
    // confirmation); checking the removed element against the menu would close it at once.
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (path.indexOf(menu) !== -1 || path.indexOf(menuBtn) !== -1) return;
    closeMenu();
  });

  function resetAll() {
    clearTimeout(pollTimer); pollTimer = null;
    clearTimeout(typingTimer); typingTimer = null;
    intakeToken++;
    intakeBusy = false;
    retryEl = null;
    var wasOpen = isOpen;
    S = freshState();
    S.open = wasOpen;
    pollAfter = null; unread = 0; renderBadge();
    input.value = ''; autoGrow();
    composerErr.hidden = true;
    heldFiles = [];
    fileTray.textContent = ''; fileTray.hidden = true;
    sendBtn.disabled = false;
    save();
    renderIntake();
    if (wasOpen) { resumeIntake(); input.focus(); }
  }

  // Escape + focus trap
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!menu.hidden) closeMenu(true); else close();
      return;
    }
    if (e.key !== 'Tab') return;
    var f = Array.prototype.filter.call(
      panel.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && !el.hidden && el.type !== 'hidden' && el.getClientRects().length > 0 && !el.closest('[hidden]'); }
    );
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen && !panel.contains(document.activeElement)) close();
  });

  // ---------- boot ----------
  function boot() {
    document.body.appendChild(root);
    if (S.phase === 'chat' && S.conversationId) {
      // re-render local history, then reconcile with the server (only what is newer than the intake transcript)
      renderChat();
      lastActivity = Date.now();
      schedulePoll(0);
    } else {
      S.phase = 'intake';
      renderIntake();
    }
    if (S.open === true) open({ focus: false }); // restore a panel that was open before the reload
    else if (autoOpen && S.open !== false) {
      // /quote opens the assistant by itself, but only once the page is loaded and visible,
      // so the visitor actually sees the assistant start the conversation.
      var openWhenSeen = function () {
        if (document.visibilityState !== 'visible') {
          document.addEventListener('visibilitychange', openWhenSeen, { once: true });
          return;
        }
        setTimeout(function () { if (!isOpen && S.open !== false) open({ focus: false }); }, 700);
      };
      if (document.readyState === 'complete') openWhenSeen();
      else window.addEventListener('load', openWhenSeen, { once: true });
    } else if (!S.conversationId && !sessionStorage.getItem('htcw.tip')) {
      setTimeout(function () {
        if (isOpen) return;
        tip.classList.add('htcw-tip-show');
        try { sessionStorage.setItem('htcw.tip', '1'); } catch (e) { /* ignore */ }
        setTimeout(function () { tip.classList.remove('htcw-tip-show'); }, 7000);
      }, 1500);
    }
    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-htcw-open]');
      if (t) { e.preventDefault(); open(); }
    });
  }
  window.HTChatWidget = { open: open, close: close, reset: resetAll };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
