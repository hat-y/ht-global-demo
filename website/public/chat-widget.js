/* HT Global Quote Assistant: floating chat launcher + guided RFQ + live chat.
 * Single implementation shared by every page (home and /quote). No dependencies, no build step.
 *
 * Step 1 (form): a guided 3-step form rendered inside the conversation. Submits to POST /api/quote.
 * Step 2 (chat): free text via PATCH /api/quote; replies (n8n assistant + Sellium team) arrive by
 *                polling GET /api/quote/messages (4 s, paused while hidden, 15 s after 2 min idle,
 *                deduped by id, rendered with textContent only).
 * State (quoteId, conversationId, thread, draft) lives in sessionStorage so it survives navigation.
 */
(function () {
  'use strict';
  if (window.HTChatWidget) return;

  var STORE_KEY = 'htcw.v1';
  var POLL_FAST_MS = 4000;
  var POLL_SLOW_MS = 15000;
  var SLOW_AFTER_MS = 120000;
  var TYPING_MAX_MS = 45000;
  var MAX_THREAD = 200;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var BOARD_TYPES = ['Rigid PCB', 'Flex PCB', 'Rigid-Flex PCB', 'HDI PCB', 'Metal Core PCB', 'High Frequency PCB'];
  var LAYERS = ['1', '2', '4', '6', '8', '10', '12', '14', '16', '18', '20'];
  var LEAD_TIMES = ['3', '4', '5', '6', '7', '10', '15'];
  var STEP_TITLES = ['Contact', 'Board', 'Details'];

  var scriptEl = document.currentScript;
  var autoOpen = !!(scriptEl && scriptEl.hasAttribute('data-autoopen'));

  // ---------- state ----------
  function freshState() {
    return {
      phase: 'form',
      intro: 0, // opening sequence progress: 0 nothing, 1 hello shown, 2 explainer shown, 3 form card shown
      step: 1,
      draft: { boardType: 'Rigid PCB', layers: '2', unitOfMeasure: 'mm', itarClassification: 'Commercial' },
      quoteId: null,
      conversationId: null,
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
          if (typeof parsed.intro !== 'number') st.intro = 3; // session from before the intro existed: never replay it
          return st;
        }
      }
    } catch (e) { /* storage unavailable or corrupt: start fresh */ }
    return freshState();
  }
  function save() {
    try {
      if (S.thread.length > MAX_THREAD) S.thread = S.thread.slice(-MAX_THREAD);
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
  var menuBtn = h('button', { type: 'button', class: 'htcw-iconbtn', 'aria-label': 'Quote options', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, svg(ICON_MORE));
  var closeBtn = h('button', { type: 'button', class: 'htcw-iconbtn', 'aria-label': 'Close chat' }, svg(ICON_CLOSE));
  var menu = h('div', { class: 'htcw-menu', role: 'menu', hidden: true });
  var header = h('div', { class: 'htcw-head' },
    h('span', { class: 'htcw-avatar', 'aria-hidden': 'true', text: 'HT' }),
    h('div', { class: 'htcw-headtext' }, titleEl, h('p', { class: 'htcw-sub', text: 'Usually replies in seconds' })),
    menuBtn, closeBtn, menu);

  var log = h('div', { class: 'htcw-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversation', tabindex: '-1' });
  var typing = h('div', { class: 'htcw-typing', role: 'status', hidden: true },
    h('span', { class: 'htcw-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('span', { class: 'htcw-typing-text', text: 'Assistant is replying…' }));
  var composerErr = h('p', { class: 'htcw-err htcw-composer-err', role: 'alert', hidden: true });
  var input = h('textarea', { class: 'htcw-input', rows: '1', maxlength: '4000', placeholder: 'Type your message…', 'aria-label': 'Message to the HT Global assistant' });
  var sendBtn = h('button', { type: 'submit', class: 'htcw-send', 'aria-label': 'Send message' }, svg(ICON_SEND));
  var composer = h('form', { class: 'htcw-composer', hidden: true, novalidate: true }, composerErr, h('div', { class: 'htcw-row' }, input, sendBtn));
  var panel = h('section', {
    id: 'htcw-panel', class: 'htcw-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'htcw-title', hidden: true
  }, header, log, typing, composer);

  root.appendChild(panel);
  root.appendChild(launcher);
  root.appendChild(tip);

  // ---------- thread rendering ----------
  function scrollDown() { log.scrollTop = log.scrollHeight; }

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
  function transient(who, text, sender) {
    var el = bubble({ who: who, text: text, sender: sender });
    log.appendChild(el);
    scrollDown();
    return el;
  }

  // ---------- form phase ----------
  var ASSISTANT = 'HT Global assistant';
  var INTRO = [
    'Hi! I\u2019m the HT Global quote assistant.',
    'First, I\u2019ll show you a short form for your contact and board details. Once it\u2019s sent, we can chat about anything else your PCB needs, like finish, stack-up or delivery.'
  ];
  // Typing pause before each intro step: hello, explainer, form card. Long enough to read as the assistant writing.
  var INTRO_TYPING_MS = [900, 1600, 1200];
  function prompts(step) {
    var first = (S.draft.name || '').trim().split(/\s+/)[0];
    if (step === 2) return 'Thanks' + (first ? ', ' + first : '') + '. What kind of board do you need?';
    return 'Nearly there. Size, lead time and classification help our team quote faster. Everything here is optional except the classification.';
  }
  function summary(step) {
    var d = S.draft;
    if (step === 1) return [d.name, d.company, d.email, d.phone].filter(Boolean).join(' \u00b7 ');
    if (step === 2) {
      var parts = [d.boardType, d.layers + ' layer' + (d.layers === '1' ? '' : 's')];
      if (d.quantity) parts.push('qty ' + d.quantity);
      return parts.join(' \u00b7 ');
    }
    return '';
  }

  var activeCard = null;
  var introTimer = null;
  function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function renderForm() {
    clearTimeout(introTimer);
    introTimer = null;
    activeCard = null;
    log.textContent = '';
    composer.hidden = true;
    typing.hidden = true;
    for (var i = 0; i < Math.min(S.intro, 2); i++) transient('agent', INTRO[i], ASSISTANT);
    if (S.intro < 3) { if (S.intro > 0 || isOpen) runIntro(); return; } // a never-opened chat starts its intro on first open
    for (var s = 1; s < S.step; s++) {
      transient('user', summary(s));
      transient('agent', prompts(s + 1), ASSISTANT);
    }
    log.appendChild(buildCard(S.step));
    scrollDown();
  }
  // Opening sequence: typing -> hello -> typing -> explainer -> typing -> form card. Progress is kept in S.intro,
  // so closing the panel never loses it and a reload resumes where it was (a finished intro never replays).
  function runIntro() {
    clearTimeout(introTimer);
    introTimer = null;
    var instant = reducedMotion();
    if (!instant) { typing.hidden = false; scrollDown(); }
    var run = function () {
      introTimer = null;
      typing.hidden = true;
      if (S.intro === 0) {
        transient('agent', INTRO[0], ASSISTANT);
        S.intro = 1; save();
        runIntro();
      } else if (S.intro === 1) {
        transient('agent', INTRO[1], ASSISTANT);
        S.intro = 2; save();
        runIntro();
      } else if (S.intro === 2) {
        S.intro = 3; save();
        var card = buildCard(S.step);
        if (!instant) card.classList.add('htcw-card-in');
        log.appendChild(card);
        scrollDown();
        if (isOpen && menu.hidden) focusFirstIn(card);
      }
    };
    if (instant) run(); else introTimer = setTimeout(run, INTRO_TYPING_MS[S.intro]);
  }

  var uid = 0;
  function field(opts) {
    var id = 'htcw-f-' + (++uid);
    var errId = id + '-err';
    var control;
    if (opts.kind === 'textarea') control = h('textarea', { id: id, name: opts.name, rows: '3', maxlength: '2000', placeholder: opts.placeholder || null });
    else if (opts.kind === 'select') {
      control = h('select', { id: id, name: opts.name });
      opts.options.forEach(function (o) { control.appendChild(h('option', { value: o[0], text: o[1] })); });
    } else {
      control = h('input', {
        id: id, name: opts.name, type: opts.type || 'text', autocomplete: opts.autocomplete || null,
        inputmode: opts.inputmode || null, placeholder: opts.placeholder || null, min: opts.min || null, step: opts.step || null, maxlength: opts.maxlength || null
      });
    }
    if (opts.required) control.setAttribute('aria-required', 'true');
    control.value = S.draft[opts.name] != null ? S.draft[opts.name] : '';
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
  function chips(name, label, values, opts) {
    opts = opts || {};
    var group = h('fieldset', { class: 'htcw-chips' + (opts.full === false ? '' : ' htcw-full') }, h('legend', { text: label }));
    var list = h('div', { class: 'htcw-chiplist' });
    values.forEach(function (v, i) {
      var id = 'htcw-r-' + name + '-' + (++uid);
      var radio = h('input', { type: 'radio', id: id, name: 'htcw-' + name, value: v[0] });
      if ((S.draft[name] || values[0][0]) === v[0]) radio.checked = true;
      list.appendChild(h('span', { class: 'htcw-chip' }, radio, h('label', { for: id, text: v[1] })));
    });
    group.appendChild(list);
    return {
      el: group, name: name,
      value: function () { var c = group.querySelector('input:checked'); return c ? c.value : values[0][0]; }
    };
  }

  function buildCard(step) {
    var fields = [];
    var grid = h('div', { class: 'htcw-grid' });
    var chipSets = [];
    function add(f) { fields.push(f); grid.appendChild(f.el); return f; }
    function addChips(c) { chipSets.push(c); grid.appendChild(c.el); }

    if (step === 1) {
      add(field({ name: 'name', label: 'Your name', required: true, autocomplete: 'name', full: true }));
      add(field({ name: 'company', label: 'Company', required: true, autocomplete: 'organization', full: true }));
      add(field({ name: 'email', label: 'Work email', type: 'email', required: true, autocomplete: 'email', inputmode: 'email', full: true }));
      add(field({ name: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel', inputmode: 'tel', full: true }));
    } else if (step === 2) {
      addChips(chips('boardType', 'Board type', BOARD_TYPES.map(function (b) { return [b, b]; })));
      add(field({ name: 'layers', label: 'Layers', kind: 'select', options: LAYERS.map(function (l) { return [l, l]; }) }));
      add(field({ name: 'quantity', label: 'Quantity', type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder: 'e.g. 100' }));
    } else {
      add(field({ name: 'width', label: 'Width', type: 'number', min: '0', step: 'any', inputmode: 'decimal' }));
      add(field({ name: 'length', label: 'Length', type: 'number', min: '0', step: 'any', inputmode: 'decimal' }));
      addChips(chips('unitOfMeasure', 'Unit', [['mm', 'mm'], ['in', 'inches']], { full: false }));
      add(field({ name: 'leadTimeDays', label: 'Lead time', kind: 'select', options: [['', 'No preference']].concat(LEAD_TIMES.map(function (l) { return [l, l + ' days']; })) }));
      addChips(chips('itarClassification', 'Classification', [
        ['Commercial', 'Commercial (not ITAR/EAR controlled)'],
        ['ITAR/EAR', 'ITAR/EAR controlled']
      ]));
      add(field({ name: 'comment', label: 'Anything else?', kind: 'textarea', placeholder: 'Finish, stackup, impedance, special requirements', full: true }));
    }

    var status = h('p', { class: 'htcw-err htcw-card-err', role: 'alert', hidden: true });
    var primary = h('button', { type: 'submit', class: 'htcw-btn htcw-primary', text: step === 3 ? 'Open my quote' : 'Continue' });
    var actions = h('div', { class: 'htcw-actions' });
    if (step > 1) actions.appendChild(h('button', { type: 'button', class: 'htcw-btn htcw-ghost', 'data-back': '', text: 'Back' }));
    actions.appendChild(primary);

    var steps = h('ol', { class: 'htcw-steps', 'aria-label': 'Progress' });
    STEP_TITLES.forEach(function (t, i) {
      steps.appendChild(h('li', { class: i + 1 < step ? 'done' : i + 1 === step ? 'now' : '', 'aria-current': i + 1 === step ? 'step' : null, text: t }));
    });

    // Honeypot: invisible to people, bots fill it. The server drops the request silently if it is non-empty.
    var trap = h('div', { 'aria-hidden': 'true', style: 'position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden' },
      h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' }));
    var card = h('form', { class: 'htcw-card', novalidate: true, 'aria-label': 'Step ' + step + ' of 3: ' + STEP_TITLES[step - 1] },
      steps, grid, status, actions, trap);
    activeCard = card;

    function collect() {
      fields.forEach(function (f) { S.draft[f.name] = f.control.value; });
      chipSets.forEach(function (c) { S.draft[c.name] = c.value(); });
      save();
    }
    card.addEventListener('input', collect);
    card.addEventListener('change', collect);

    function validate() {
      var ok = true, firstBad = null;
      fields.forEach(function (f) { f.clear(); });
      function bad(f, msg) { f.fail(msg); ok = false; if (!firstBad) firstBad = f.control; }
      fields.forEach(function (f) {
        var v = f.control.value.trim();
        if (f.name === 'name' && !v) bad(f, 'Please enter your name.');
        if (f.name === 'company' && !v) bad(f, 'Please enter your company name.');
        if (f.name === 'email') {
          if (!v) bad(f, 'Please enter your email address.');
          else if (!EMAIL_RE.test(v)) bad(f, 'That email doesn\u2019t look right. Use a format like name@company.com.');
        }
        if (f.name === 'quantity' && v && !(Number(v) >= 1 && isFinite(Number(v)))) bad(f, 'Enter a quantity of 1 or more.');
        if ((f.name === 'width' || f.name === 'length') && v && !(Number(v) > 0 && isFinite(Number(v)))) bad(f, 'Enter a size greater than 0.');
      });
      if (firstBad) firstBad.focus();
      return ok;
    }

    card.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-back]')) {
        collect();
        S.step = Math.max(1, S.step - 1);
        save();
        renderForm();
        focusFirstIn(activeCard);
      }
    });
    card.addEventListener('submit', function (e) {
      e.preventDefault();
      collect();
      if (!validate()) return;
      if (step < 3) {
        S.step = step + 1;
        save();
        renderForm();
        focusFirstIn(activeCard);
        return;
      }
      submitQuote(primary, status);
    });
    return card;
  }

  function focusFirstIn(card) {
    if (!card) return;
    var f = card.querySelector('input:not([type=radio]), select, textarea, input[type=radio]:checked');
    if (f) f.focus({ preventScroll: true });
  }

  function numOrNull(v) {
    if (v === '' || v == null) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function honeypotValue() {
    var el = document.querySelector('.htcw-card input[name="website"]');
    return el ? el.value : '';
  }

  async function submitQuote(button, status) {
    var d = S.draft;
    var payload = {
      name: (d.name || '').trim(), company: (d.company || '').trim(), email: (d.email || '').trim(), phone: (d.phone || '').trim(),
      boardType: d.boardType, unitOfMeasure: d.unitOfMeasure,
      width: numOrNull(d.width), length: numOrNull(d.length), layers: numOrNull(d.layers),
      leadTimeDays: numOrNull(d.leadTimeDays), quantity: numOrNull(d.quantity),
      itarClassification: d.itarClassification, comment: (d.comment || '').trim(),
      message: (d.comment || '').trim() || null,
      website: honeypotValue()
    };
    status.hidden = true;
    button.disabled = true;
    button.textContent = 'Opening your quote…';
    try {
      var res = await fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      var result = await res.json();
      if (!result.success) throw new Error(result.errorMessage || 'Quote creation failed');
      startChat(result, payload);
    } catch (err) {
      status.textContent = 'We couldn\u2019t open your quote: ' + (err && err.message ? err.message : 'network error') + '. Please try again.';
      status.hidden = false;
      button.disabled = false;
      button.textContent = 'Open my quote';
    }
  }

  // ---------- chat phase ----------
  function startChat(result, payload) {
    S.quoteId = result.quoteId;
    S.conversationId = result.conversationId;
    S.phase = 'chat';
    S.seen = [];
    pollAfter = null;
    S.thread = [];
    var d = S.draft;
    var bits = [d.boardType, d.layers + ' layers'];
    if (payload.quantity) bits.push('qty ' + payload.quantity);
    if (payload.width && payload.length) bits.push(payload.width + ' \u00d7 ' + payload.length + ' ' + d.unitOfMeasure);
    if (payload.leadTimeDays) bits.push(payload.leadTimeDays + '-day lead time');
    bits.push(d.itarClassification);
    S.thread.push({ who: 'agent', sender: ASSISTANT, text: 'Thanks' + (d.name ? ', ' + d.name.trim().split(/\s+/)[0] : '') + '. Your quote request is open with HT Global.' });
    S.thread.push({ who: 'user', text: 'Quote request for ' + payload.company + ': ' + bits.join(' \u00b7 ') });
    if (payload.comment) S.thread.push({ who: 'user', text: payload.comment });
    S.thread.push({ who: 'agent', sender: ASSISTANT, text: 'Tell me anything else about the job, like finish, stackup, impedance or delivery. I\u2019ll reply here, and our team can join in too.' });
    S.pendingSince = Date.now();
    save();
    renderChat();
    schedulePoll(POLL_FAST_MS);
    updateTyping();
    input.focus();
  }

  function renderChat() {
    activeCard = null;
    log.textContent = '';
    S.thread.forEach(function (e) { log.appendChild(bubble(e)); });
    composer.hidden = false;
    scrollDown();
    updateTyping();
  }

  var typingTimer = null;
  function updateTyping() {
    clearTimeout(typingTimer);
    typingTimer = null;
    if (S.phase !== 'chat' || !S.pendingSince) { typing.hidden = true; return; }
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

  // ---------- polling (T5 logic) ----------
  var pollTimer = null;
  var pollAfter = null;
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
        if (result.serverTime) pollAfter = new Date(new Date(result.serverTime).getTime() - 10000).toISOString();
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
    if (S.phase === 'form' && S.intro === 0) renderForm();
    scrollDown();
    if (opts.focus !== false) {
      setTimeout(function () {
        if (S.phase === 'chat') input.focus(); else focusFirstIn(activeCard);
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
    if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
  });

  function resetAll() {
    clearTimeout(pollTimer); pollTimer = null;
    clearTimeout(typingTimer); typingTimer = null;
    clearTimeout(introTimer); introTimer = null;
    var wasOpen = isOpen;
    S = freshState();
    S.open = wasOpen;
    pollAfter = null; unread = 0; renderBadge();
    input.value = ''; autoGrow();
    composerErr.hidden = true;
    save();
    renderForm();
    if (wasOpen && S.intro >= 3) focusFirstIn(activeCard);
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
      // re-render local history, then reconcile with the server (GET without "after" returns everything)
      renderChat();
      lastActivity = Date.now();
      schedulePoll(0);
    } else {
      S.phase = 'form';
      renderForm();
    }
    if (S.open === true) open({ focus: false }); // restore a panel that was open before the reload
    else if (autoOpen && S.open !== false) {
      // /quote opens the assistant by itself, but only once the page is loaded and visible,
      // so the visitor actually sees the assistant introduce the form.
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
