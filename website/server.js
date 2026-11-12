import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createSign, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORG_ALIAS = process.env.SF_ORG_ALIAS || 'ht-global';

// Tiny .env reader (no dependencies). Real environment variables win over the file.
function loadEnvFile() {
  try {
    const text = readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // no .env: the quote agent trigger stays disabled
  }
}

function logLine(obj) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}
let agentDisabledLogged = false;
// Fire-and-forget: tells the n8n quote agent that there is something to answer.
// Never blocks or fails the visitor request; gives up after 5 s.
function notifyAgent(event, conversationId, quoteId) {
  const AGENT_URL = process.env.N8N_AGENT_WEBHOOK_URL || '';
  const AGENT_SECRET = process.env.N8N_AGENT_SECRET || '';
  if (!AGENT_URL || !AGENT_SECRET) {
    if (!agentDisabledLogged) {
      agentDisabledLogged = true;
      logLine({ level: 'info', msg: 'agent_trigger_disabled' });
    }
    return;
  }
  if (!conversationId || !quoteId) return;
  fetch(AGENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HT-Agent-Secret': AGENT_SECRET },
    body: JSON.stringify({ event, conversationId, quoteId }),
    signal: AbortSignal.timeout(5000)
  })
    .then((r) => {
      if (!r.ok) logLine({ level: 'warn', msg: 'agent_webhook_status', event, status: r.status });
    })
    .catch((e) => logLine({ level: 'warn', msg: 'agent_webhook_failed', event }));
}

function runSf(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('sf', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `sf exited with ${code}`));
        return;
      }
      resolve(stdout);
    });
    if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

async function callSalesforceCli(method, body, query) {
  const payload = JSON.stringify(body || {});
  const endpoint = '/services/apexrest/htglobal/quote' + (query ? `?${query}` : '');
  const args = ['api', 'request', 'rest', endpoint, '-o', ORG_ALIAS, '-X', method];
  if (method !== 'GET') {
    args.push('-H', 'Content-Type: application/json', '-b', payload);
  }
  args.push('--json');
  const stdout = await runSf(args);

  const parsed = JSON.parse(stdout);
  if (parsed.status && parsed.status !== 0 && parsed.result == null) {
    throw new Error(parsed.message || 'Salesforce API request failed');
  }

  let result = parsed.result;
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'body')) {
    result = result.body;
  }
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch {
      return { success: false, errorMessage: result };
    }
  }
  if (Array.isArray(result)) {
    return {
      success: false,
      errorMessage: result.map((item) => item.message || JSON.stringify(item)).join('; ')
    };
  }
  if (result && typeof result === 'object') {
    return result;
  }
  return { success: false, errorMessage: 'Empty Salesforce response' };
}

// Optional: call Salesforce as the n8n integration user (JWT bearer) instead of the sf CLI session.
// Enable with SF_AUTH=jwt and SF_JWT_DIR (a folder with config.json {clientId, username, instanceUrl,
// loginUrl?} and server.key). Records created this way are owned by the integration user, which is
// what lets the quote agent write replies into the thread (the conversation object is Private).
const jwtDir = () => process.env.SF_JWT_DIR || path.join(__dirname, '..', '.secrets', 'ht-global-n8n');
let jwtCache = null;
async function jwtSession() {
  if (jwtCache && jwtCache.expires > Date.now()) return jwtCache;
  const cfg = JSON.parse(readFileSync(path.join(jwtDir(), 'config.json'), 'utf8'));
  const key = readFileSync(path.join(jwtDir(), 'server.key'), 'utf8');
  const loginUrl = cfg.loginUrl || 'https://login.salesforce.com';
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({ iss: cfg.clientId, sub: cfg.username, aud: loginUrl, exp: Math.floor(Date.now() / 1000) + 180 });
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key).toString('base64url');
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`JWT login failed: ${json.error || res.status}`);
  jwtCache = { token: json.access_token, instanceUrl: json.instance_url || cfg.instanceUrl, expires: Date.now() + 10 * 60 * 1000 };
  return jwtCache;
}

async function callSalesforceJwt(method, body, query) {
  const session = await jwtSession();
  const res = await fetch(`${session.instanceUrl}/services/apexrest/htglobal/quote${query ? `?${query}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return { success: false, errorMessage: parsed.map((i) => i.message || JSON.stringify(i)).join('; ') };
    }
    return parsed;
  } catch {
    return { success: false, errorMessage: text || 'Empty Salesforce response' };
  }
}



// ---------------------------------------------------------------------------
// Hardening: limits, validation, headers, static files
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 16 * 1024;
// Bodies that carry a chat transcript (up to 60 x 2000 chars) or an intake history are larger.
const MAX_TRANSCRIPT_BODY_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_ITEMS = 60;
const MAX_HISTORY_ITEMS = 30;
const MAX_TURN_CHARS = 2000;
const MAX_HISTORY_OPTIONS = 8;
const MAX_OPTION_CHARS = 40;
const INTAKE_TIMEOUT_MS = 15000;
// Default 5 MB per file: the demo org (Developer Edition) has 20 MB of file storage in total.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const TEN_MIN = 10 * 60 * 1000;
const GENERIC_ERROR = { success: false, errorMessage: 'Something went wrong. Please try again.' };

// Remote hosts the cloned Elementor pages load from (see public/*.html).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://www.htglobalcircuits.com https://fonts.googleapis.com",
  "img-src 'self' data: https://www.htglobalcircuits.com https://htglobalcircuits.com https://www.details-enterprise-7.com",
  "font-src 'self' data: https://www.htglobalcircuits.com https://fonts.gstatic.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': CSP
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function contentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}


export function configFromEnv(env = process.env) {
  const num = (name, fallback) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    trustProxy: env.TRUST_PROXY === '1',
    limits: {
      post: { max: num('RATE_POST_MAX', 5), windowMs: num('RATE_POST_WINDOW_SEC', 600) * 1000 },
      patch: { max: num('RATE_PATCH_MAX', 30), windowMs: num('RATE_PATCH_WINDOW_SEC', 600) * 1000 },
      messages: { max: num('RATE_MESSAGES_MAX', 120), windowMs: num('RATE_MESSAGES_WINDOW_SEC', 60) * 1000 },
      upload: { max: num('RATE_UPLOAD_MAX', 10), windowMs: num('RATE_UPLOAD_WINDOW_SEC', 600) * 1000 },
      intake: { max: num('RATE_INTAKE_MAX', 60), windowMs: num('RATE_INTAKE_WINDOW_SEC', 600) * 1000 },
      maxTrackedIps: num('RATE_MAX_TRACKED_IPS', 10000)
    },
    upload: {
      maxBytes: num('UPLOAD_MAX_BYTES', MAX_UPLOAD_BYTES),
      maxConcurrent: num('UPLOAD_MAX_CONCURRENT', 2),
      idleTimeoutMs: num('UPLOAD_IDLE_TIMEOUT_SEC', 30) * 1000
    }
  };
}

function createRateLimiter(limits, now) {
  const hits = new Map(); // `${bucket}|${ip}` -> { count, resetAt }; Map keeps insertion order
  const cap = limits.maxTrackedIps;
  function evictExpired(t) {
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }
  return {
    // returns 0 when allowed, otherwise the Retry-After seconds
    check(bucket, ip) {
      const rule = limits[bucket];
      const t = now();
      const key = `${bucket}|${ip}`;
      let entry = hits.get(key);
      if (entry && entry.resetAt <= t) {
        hits.delete(key);
        entry = undefined;
      }
      if (!entry) {
        if (hits.size >= cap) {
          evictExpired(t);
          while (hits.size >= cap) hits.delete(hits.keys().next().value); // oldest first
        }
        entry = { count: 0, resetAt: t + rule.windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count > rule.max ? Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) : 0;
    },
    stats() {
      evictExpired(now());
      return { tracked: hits.size };
    }
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(body, key, max, { required = false } = {}) {
  const v = body[key];
  if (v == null || v === '') {
    if (required) throw new HttpError(400, `${key} is required.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string.`);
  const t = v.trim();
  if (!t) {
    if (required) throw new HttpError(400, `${key} is required.`);
    return undefined;
  }
  return t.slice(0, max);
}

function num(body, key, min, max, { integer = false } = {}) {
  let v = body[key];
  if (v == null || v === '') return undefined;
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  const ok = typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
  if (!ok) throw new HttpError(400, `${key} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`);
  return v;
}

function blank(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
function requireField(body, key, label) {
  if (blank(body[key])) throw new HttpError(400, `${label} is required.`);
}
// Width and length must be greater than 0 (HT's Instant Quote form requires a real size).
function size(body, key, label) {
  let v = body[key];
  if (typeof v === 'string') v = Number(v);
  if (!(typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10000)) throw new HttpError(400, `${label} must be greater than 0 and at most 10000.`);
  return v;
}

// ---- field rules shared by POST /api/quote and POST /api/intake ----
// Required set mirrors HT's Instant Quote form, in form order. Optional: leadTimeDays, comment.
const REQUIRED_ORDER = ['name', 'company', 'email', 'phone', 'boardType', 'singleUpOrArray', 'unitOfMeasure', 'width', 'length', 'layers', 'quantity', 'itarClassification'];
const FIELD_NAMES = [...REQUIRED_ORDER, 'leadTimeDays', 'comment'];
const ENUMS = {
  boardType: ['Rigid PCB', 'Flex PCB', 'Rigid-Flex PCB', 'HDI PCB', 'Metal Core PCB', 'High Frequency PCB'],
  singleUpOrArray: ['Single Up', 'Array'],
  unitOfMeasure: ['mm', 'inches'],
  itarClassification: ['Commercial', 'ITAR/EAR']
};
const ENUM_ALIASES = {
  unitOfMeasure: { in: 'inches', inch: 'inches', millimeters: 'mm', millimetres: 'mm', millimeter: 'mm', millimetre: 'mm' },
  singleUpOrArray: { 'single-up': 'Single Up', single: 'Single Up', singleup: 'Single Up', panel: 'Array', panelized: 'Array' },
  itarClassification: { itar: 'ITAR/EAR', ear: 'ITAR/EAR', 'itar/ear controlled': 'ITAR/EAR', 'itar / ear': 'ITAR/EAR' }
};
function matchEnum(name, value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  const hit = ENUMS[name].find((e) => e.toLowerCase() === v);
  if (hit) return hit;
  const alias = ENUM_ALIASES[name] && ENUM_ALIASES[name][v];
  if (alias) return alias;
  if (name === 'boardType') return ENUMS.boardType.find((e) => e.toLowerCase() === `${v} pcb`);
  return undefined;
}
// One rule per field: takes the body and the key, returns the normalized value or throws HttpError.
const FIELD_RULES = {
  name: (b, k) => str(b, k, 120, { required: true }),
  company: (b, k) => str(b, k, 120, { required: true }),
  email: (b, k) => {
    const email = str(b, k, 254 + 1, { required: false });
    if (!email || email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, 'A valid email is required.');
    return email;
  },
  phone: (b, k) => str(b, k, 40),
  boardType: (b, k) => str(b, k, 80),
  singleUpOrArray: (b, k) => str(b, k, 80),
  unitOfMeasure: (b, k) => str(b, k, 80),
  itarClassification: (b, k) => str(b, k, 80),
  width: (b, k) => size(b, k, 'Width'),
  length: (b, k) => size(b, k, 'Length'),
  layers: (b, k) => num(b, k, 1, 64, { integer: true }),
  quantity: (b, k) => num(b, k, 1, 1000000, { integer: true }),
  leadTimeDays: (b, k) => num(b, k, 0, 365),
  comment: (b, k) => str(b, k, 2000)
};

// Validates one field for the intake: returns the normalized value, or undefined when it is not acceptable.
function intakeField(name, raw) {
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) return undefined;
  try {
    let value = raw;
    if (ENUMS[name]) {
      value = matchEnum(name, raw);
      if (value === undefined) return undefined;
    }
    return FIELD_RULES[name]({ [name]: value }, name);
  } catch {
    return undefined;
  }
}
function normalizeIntakeFields(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const name of FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
    const v = intakeField(name, raw[name]);
    if (v !== undefined) out[name] = v;
  }
  return out;
}
// Missing required fields in form order; deferred ones (the customer will give them later) go last.
function missingFields(fields, deferred = []) {
  const miss = REQUIRED_ORDER.filter((k) => fields[k] === undefined);
  return miss.filter((k) => !deferred.includes(k)).concat(miss.filter((k) => deferred.includes(k)));
}
// Keeps only valid, still-missing required names, deduplicated, in form order.
function cleanDeferred(raw, fields) {
  if (!Array.isArray(raw)) return [];
  return REQUIRED_ORDER.filter((k) => raw.includes(k) && fields[k] === undefined);
}

function validateTranscript(raw) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, 'transcript must be an array.');
  if (raw.length > MAX_TRANSCRIPT_ITEMS) throw new HttpError(400, `transcript must have at most ${MAX_TRANSCRIPT_ITEMS} items.`);
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || (item.role !== 'assistant' && item.role !== 'customer')) throw new HttpError(400, 'transcript role must be assistant or customer.');
    if (typeof item.text !== 'string') throw new HttpError(400, 'transcript text must be a string.');
    if (item.text.length > MAX_TURN_CHARS) throw new HttpError(400, `transcript text must be at most ${MAX_TURN_CHARS} characters.`);
    const text = item.text.trim();
    if (text) out.push({ role: item.role, text });
  }
  return out;
}

function validateQuote(body) {
  const out = {};
  out.name = FIELD_RULES.name(body, 'name');
  out.company = FIELD_RULES.company(body, 'company');
  out.email = FIELD_RULES.email(body, 'email');
  requireField(body, 'phone', 'Phone');
  requireField(body, 'boardType', 'Board type');
  requireField(body, 'singleUpOrArray', 'Single up or array');
  requireField(body, 'unitOfMeasure', 'Unit of measure');
  requireField(body, 'width', 'Width');
  requireField(body, 'length', 'Length');
  requireField(body, 'layers', 'Layers');
  requireField(body, 'quantity', 'Quantity');
  requireField(body, 'itarClassification', 'Classification');
  out.phone = FIELD_RULES.phone(body, 'phone');
  out.comment = FIELD_RULES.comment(body, 'comment');
  out.message = str(body, 'message', 2000);
  for (const k of ['boardType', 'singleUpOrArray', 'unitOfMeasure', 'itarClassification']) out[k] = FIELD_RULES[k](body, k);
  out.width = FIELD_RULES.width(body, 'width');
  out.length = FIELD_RULES.length(body, 'length');
  out.layers = FIELD_RULES.layers(body, 'layers');
  out.quantity = FIELD_RULES.quantity(body, 'quantity');
  out.leadTimeDays = FIELD_RULES.leadTimeDays(body, 'leadTimeDays');
  out.transcript = validateTranscript(body.transcript);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ---- conversational intake (POST /api/intake) ----
const FALLBACK_PROMPTS = {
  name: 'What\u2019s your name?',
  company: 'Which company are you with?',
  email: 'What\u2019s your work email?',
  phone: 'What\u2019s the best phone number to reach you?',
  boardType: 'What type of board do you need?',
  singleUpOrArray: 'Do you need single up or an array?',
  unitOfMeasure: 'Will you give the board size in mm or inches?',
  width: 'What\u2019s the board width? Just the number, in the unit you chose.',
  length: 'And the board length?',
  layers: 'How many layers? A whole number from 1 to 64.',
  quantity: 'How many boards do you need?',
  itarClassification: 'Last required detail: is this job Commercial or ITAR/EAR controlled?'
};
const FALLBACK_GREETING = 'Hi! I\u2019m the HT Global quote assistant. I\u2019ll ask a few quick questions to get your quote started. ';
const FALLBACK_COMPLETE = 'I have everything I need. Please check the summary below and confirm when it looks right.';
const OPTION_HINTS = {
  'Rigid PCB': 'Standard FR-4, the most common choice',
  'Flex PCB': 'Bends to fit tight or moving spaces',
  'Rigid-Flex PCB': 'Rigid and flexible sections in one board',
  'HDI PCB': 'Microvias and very fine lines for dense designs',
  'Metal Core PCB': 'Metal base that dissipates heat (LEDs, power)',
  'High Frequency PCB': 'Low-loss materials for RF and microwave',
  'Single Up': 'Individual loose boards',
  Array: 'Several boards joined in a panel for assembly',
  Commercial: 'No export restrictions',
  'ITAR/EAR': 'US export-controlled design'
};
const fallbackQuickReplies = (name) => (ENUMS[name] || []).map((v) => (OPTION_HINTS[v] ? { label: v, value: v, description: OPTION_HINTS[v] } : { label: v, value: v }));

// Deterministic reply used when the AI agent is unavailable: never a dead end. If the last assistant
// turn was this fallback's own question, the customer's answer is parsed for that field.
function intakeFallback({ history, fields, message, deferred = [] }) {
  const merged = { ...fields };
  const target = missingFields(merged, deferred)[0];
  let prefix = '';
  if (target) {
    const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant');
    const asked = lastAssistant && lastAssistant.text.endsWith(FALLBACK_PROMPTS[target]);
    if (message != null && asked) {
      const v = intakeField(target, message);
      if (v !== undefined) merged[target] = v;
      else prefix = 'Sorry, I didn\u2019t catch that. ';
    } else if (message != null) {
      prefix = 'Sorry, I had a hiccup. ';
    } else if (!history.length) {
      prefix = FALLBACK_GREETING;
    }
  }
  const next = missingFields(merged, deferred)[0];
  if (!next) return { reply: FALLBACK_COMPLETE, quickReplies: [], fieldUpdates: merged, asking: null };
  return { reply: prefix + FALLBACK_PROMPTS[next], quickReplies: fallbackQuickReplies(next), fieldUpdates: merged, asking: next };
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(CONTROL_CHARS, '').trim().slice(0, max) : '';
}
function cleanQuickReplies(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const label = cleanText(typeof item === 'string' ? item : item && item.label, 40);
    const value = cleanText(typeof item === 'string' ? item : item && (item.value ?? item.label), 200) || label;
    const description = item && typeof item === 'object' ? cleanText(item.description, 61) : '';
    if (label && value && !out.some((q) => q.label === label)) out.push(description && description.length <= 60 ? { label, value, description } : { label, value });
    if (out.length >= 7) break;
  }
  return out;
}

function validateIntake(body) {
  const history = [];
  if (body.history != null) {
    if (!Array.isArray(body.history)) throw new HttpError(400, 'history must be an array.');
    if (body.history.length > MAX_HISTORY_ITEMS) throw new HttpError(400, `history must have at most ${MAX_HISTORY_ITEMS} items.`);
    for (const t of body.history) {
      if (!t || typeof t !== 'object' || (t.role !== 'assistant' && t.role !== 'customer')) throw new HttpError(400, 'history role must be assistant or customer.');
      if (typeof t.text !== 'string') throw new HttpError(400, 'history text must be a string.');
      if (t.text.length > MAX_TURN_CHARS) throw new HttpError(400, `history text must be at most ${MAX_TURN_CHARS} characters.`);
      const turn = { role: t.role, text: t.text };
      if (t.options != null) {
        // T40: labels of the option buttons an assistant turn showed, so the agent can resolve "the second one"
        if (t.role !== 'assistant') throw new HttpError(400, 'history options are only allowed on assistant turns.');
        if (!Array.isArray(t.options) || t.options.length > MAX_HISTORY_OPTIONS) throw new HttpError(400, `history options must be an array of at most ${MAX_HISTORY_OPTIONS} labels.`);
        const options = t.options.map((o) => {
          const label = typeof o === 'string' ? cleanText(o, MAX_OPTION_CHARS + 1) : '';
          if (!label || label.length > MAX_OPTION_CHARS) throw new HttpError(400, `history option labels must be 1 to ${MAX_OPTION_CHARS} characters.`);
          return label;
        });
        if (options.length) turn.options = options;
      }
      history.push(turn);
    }
  }
  let message = null;
  if (body.message != null) {
    if (typeof body.message !== 'string') throw new HttpError(400, 'message must be a string or null.');
    if (body.message.length > MAX_TURN_CHARS) throw new HttpError(400, `message must be at most ${MAX_TURN_CHARS} characters.`);
    message = body.message.trim();
    if (!message) throw new HttpError(400, 'message must not be empty.');
  }
  let fields = {};
  if (body.fields != null) {
    if (typeof body.fields !== 'object' || Array.isArray(body.fields)) throw new HttpError(400, 'fields must be an object.');
    const unknown = Object.keys(body.fields).filter((k) => !FIELD_NAMES.includes(k));
    if (unknown.length) throw new HttpError(400, `Unknown field: ${unknown[0].slice(0, 40)}.`);
    fields = normalizeIntakeFields(body.fields);
  }
  let deferred = [];
  if (body.deferred != null) {
    if (!Array.isArray(body.deferred) || body.deferred.length > 12 || body.deferred.some((d) => typeof d !== 'string')) throw new HttpError(400, 'deferred must be an array of at most 12 field names.');
    deferred = cleanDeferred(body.deferred, fields);
  }
  return { history, fields, message, deferred };
}

// Default n8n call: POST N8N_INTAKE_WEBHOOK_URL (synchronous answer), 15 s timeout.
async function callIntakeWebhook(payload) {
  const url = process.env.N8N_INTAKE_WEBHOOK_URL || '';
  const secret = process.env.N8N_AGENT_SECRET || '';
  if (!url || !secret) throw new Error('intake webhook not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HT-Agent-Secret': secret },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(INTAKE_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`intake webhook status ${res.status}`);
  return res.json();
}

function validateIds(src) {
  const get = (k) => (typeof src[k] === 'string' ? src[k].trim() : '');
  const conversationId = get('conversationId');
  const quoteId = get('quoteId');
  if (!SF_ID.test(conversationId)) throw new HttpError(400, 'conversationId must be a Salesforce id.');
  if (!SF_ID.test(quoteId)) throw new HttpError(400, 'quoteId must be a Salesforce id.');
  return { conversationId, quoteId };
}

function validatePatch(body) {
  const ids = validateIds(body);
  const message = str(body, 'message', 100000, { required: true });
  if (message.length > 2000) throw new HttpError(400, 'message must be at most 2000 characters.');
  return { ...ids, message };
}

// max: hard cap while reading. softMax(parsed): optional second check once the body is parsed
// (a plain quote stays at 16 KB; only bodies with a transcript may be larger).
async function readJsonBody(req, max = MAX_BODY_BYTES, softMax) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(type)) throw new HttpError(415, 'Content-Type must be application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, 'Request body too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Request body must be a JSON object.');
  if (softMax && size > softMax(parsed)) throw new HttpError(413, 'Request body too large.');
  return parsed;
}


// ---------------------------------------------------------------------------
// File uploads (RFQ drawings, stack-ups, Gerbers)
// ---------------------------------------------------------------------------

// extension -> kind of content it must start with (see contentMatches)
const UPLOAD_TYPES = {
  pdf: 'pdf', doc: 'ole', docx: 'zip', xls: 'ole', xlsx: 'zip', csv: 'text', jpg: 'jpg', jpeg: 'jpg', png: 'png',
  zip: 'zip', gbr: 'text', tgz: 'gz'
};
const GERBER_EXTENSIONS = new Set(['zip', 'gbr', 'tgz']);
// "invoice.exe.pdf": the inner extension of a double-extension name must not be an executable or script type.
const DANGEROUS_INNER = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'js', 'jse', 'mjs', 'vbs', 'vbe', 'wsf', 'ps1', 'sh', 'bash', 'jar', 'msi', 'dll', 'hta',
  'lnk', 'reg', 'html', 'htm', 'xhtml', 'svg', 'php', 'py', 'pl', 'cgi', 'asp', 'aspx', 'jsp', 'apk', 'app', 'dmg', 'docm', 'xlsm'
]);
const MAX_NAME_CHARS = 100;

function checkFileName(rawHeader) {
  if (typeof rawHeader !== 'string' || !rawHeader) throw new HttpError(400, 'File name is required.');
  let name;
  try {
    name = decodeURIComponent(rawHeader);
  } catch {
    throw new HttpError(400, 'File name is not valid.');
  }
  if (!name.trim() || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, 'File name is not valid.');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(UPLOAD_TYPES, ext)) throw new HttpError(415, 'This file type is not accepted.');
  const inner = name.slice(0, dot).match(/\.([A-Za-z0-9]{1,8})$/);
  if (inner && DANGEROUS_INNER.has(inner[1].toLowerCase())) throw new HttpError(415, 'This file type is not accepted.');
  let stem = name.slice(0, dot).replace(/[^\p{L}\p{N}._() \-]/gu, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!stem) stem = 'file';
  stem = stem.slice(0, MAX_NAME_CHARS - ext.length - 1);
  return { name: `${stem}.${ext}`, ext };
}

const MAGIC_PREFIX = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
  zip: [0x50, 0x4b, 0x03, 0x04],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
  gz: [0x1f, 0x8b],
  ole: [0xd0, 0xcf, 0x11, 0xe0]
};
function contentMatches(kind, buf) {
  if (kind === 'text') {
    // valid UTF-8 and no control characters other than TAB, LF, FF, CR (so no NUL and no binary headers)
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) return false;
      if (b === 0x7f) return false;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return true;
    } catch {
      return false;
    }
  }
  const prefix = MAGIC_PREFIX[kind];
  return buf.length >= prefix.length && prefix.every((b, i) => buf[i] === b);
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1023.5 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function readUploadBody(req, declared, max, idleMs = 30000) {
  const known = Number.isFinite(declared) && declared > 0;
  const buf = known ? Buffer.allocUnsafe(declared) : null; // exact allocation: no second copy for the common (browser) case
  const chunks = [];
  let size = 0;
  const it = req[Symbol.asyncIterator]();
  for (;;) {
    // no data for idleMs: give up (a slow client must not hold an upload slot)
    let timer;
    const idle = new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, 'Something went wrong. Please try again.')), idleMs); });
    let step;
    try {
      step = await Promise.race([it.next(), idle]);
    } finally {
      clearTimeout(timer);
    }
    if (step.done) break;
    const chunk = step.value;
    if (size + chunk.length > max) throw new HttpError(413, `File too large. The limit is ${Math.round(max / 1048576)} MB per file.`);
    if (buf) {
      if (size + chunk.length > declared) throw new HttpError(400, 'Request body does not match Content-Length.');
      chunk.copy(buf, size);
    } else {
      chunks.push(chunk);
    }
    size += chunk.length;
  }
  if (buf) {
    if (size !== declared) throw new HttpError(400, 'Request body does not match Content-Length.');
    return buf;
  }
  return Buffer.concat(chunks, size);
}

// Stores the file as a Salesforce File (ContentVersion) published to the quote. Multipart upload with
// the binary part streamed from the buffer (no base64, no extra copy).
async function uploadFileJwt({ quoteId, name, buffer }) {
  const session = await jwtSession();
  const boundary = 'htupl' + randomUUID().replace(/-/g, '');
  const entity = JSON.stringify({ FirstPublishLocationId: quoteId, PathOnClient: name, Title: name });
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="entity_content"\r\nContent-Type: application/json\r\n\r\n${entity}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="VersionData"; filename="${asciiName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  async function* parts() { yield head; yield buffer; yield tail; }
  const res = await fetch(`${session.instanceUrl}/services/data/v62.0/sobjects/ContentVersion`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(head.length + buffer.length + tail.length)
    },
    body: Readable.from(parts()),
    duplex: 'half',
    signal: AbortSignal.timeout(120000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok || !json || json.success !== true) throw new Error(`ContentVersion insert failed: ${res.status} ${text.slice(0, 300)}`);
  return { id: json.id };
}

async function uploadFileUnsupported() {
  throw new Error('File upload needs SF_AUTH=jwt');
}

function resolveStatic(publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '/') decoded = '/index.html';
  if (decoded === '/quote' || decoded === '/instant-quote') decoded = '/quote.html';
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.'))) return null; // dotfiles and ..
  const absolute = path.resolve(publicDir, ...segments);
  if (!absolute.startsWith(path.resolve(publicDir) + path.sep)) return null;
  return absolute;
}

export function createServer({ callSalesforce, callIntake = callIntakeWebhook, uploadFile = uploadFileUnsupported, notifyAgent: notify = () => {}, now = () => Date.now(), log = (line) => console.log(line), config = {} } = {}) {
  const defaults = configFromEnv({});
  const cfg = {
    publicDir: config.publicDir || path.join(__dirname, 'public'),
    trustProxy: config.trustProxy ?? defaults.trustProxy,
    limits: {
      post: { ...defaults.limits.post, ...(config.limits && config.limits.post) },
      patch: { ...defaults.limits.patch, ...(config.limits && config.limits.patch) },
      messages: { ...defaults.limits.messages, ...(config.limits && config.limits.messages) },
      upload: { ...defaults.limits.upload, ...(config.limits && config.limits.upload) },
      intake: { ...defaults.limits.intake, ...(config.limits && config.limits.intake) },
      maxTrackedIps: (config.limits && config.limits.maxTrackedIps) || defaults.limits.maxTrackedIps
    },
    upload: { ...defaults.upload, ...(config.upload || {}) }
  };
  const limiter = createRateLimiter(cfg.limits, now);
  let uploadsInFlight = 0;

  const emit = (obj) => log(JSON.stringify({ ts: new Date(now()).toISOString(), ...obj }));

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '');
      const last = xff.split(',').pop().trim();
      if (last) return last;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function send(res, status, payload, extra = {}) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const type = typeof payload === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
    res.writeHead(status, { 'Content-Type': type, ...extra });
    res.end(body);
  }
  const fail = (res, status, message, extra) => send(res, status, { success: false, errorMessage: message }, extra);
  const notFound = (res) => send(res, 404, '<!doctype html><title>Not found</title><h1>Not found</h1>');

  function limited(req, res, bucket) {
    const retry = limiter.check(bucket, clientIp(req));
    if (!retry) return false;
    fail(res, 429, 'Too many requests. Please try again later.', { 'Retry-After': String(retry) });
    return true;
  }

  // Salesforce answers: success only passes through; anything else is a generic 502.
  async function upstream(req, res, method, body, query) {
    let data;
    try {
      data = await callSalesforce(method, body, query);
    } catch (error) {
      emit({ level: 'error', msg: 'upstream_error', method: req.method, path: req._path, detail: String((error && error.message) || error).slice(0, 300) });
      send(res, 502, GENERIC_ERROR);
      return null;
    }
    if (!data || data.success !== true) {
      const detail = data && typeof data.errorMessage === 'string' ? data.errorMessage.slice(0, 300) : 'empty or unsuccessful response';
      emit({ level: 'error', msg: 'upstream_unsuccessful', method: req.method, path: req._path, detail });
      send(res, 502, GENERIC_ERROR);
      return null;
    }
    return data;
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return notFound(res);
      }
      const pathname = url.pathname;
      req._path = pathname;

      if (pathname === '/api/quote') {
        if (req.method !== 'POST' && req.method !== 'PATCH') return fail(res, 405, 'Method not allowed.', { Allow: 'POST, PATCH' });
        if (limited(req, res, req.method === 'POST' ? 'post' : 'patch')) return;
        const body = await readJsonBody(req, MAX_TRANSCRIPT_BODY_BYTES, (p) => (p.transcript != null ? MAX_TRANSCRIPT_BODY_BYTES : MAX_BODY_BYTES));
        if (typeof body.website === 'string' ? body.website.trim() !== '' : body.website != null && body.website !== false) {
          return send(res, 200, { success: true }); // honeypot: pretend it worked
        }
        if (req.method === 'POST') {
          if (body.filesPending != null && typeof body.filesPending !== 'boolean') throw new HttpError(400, 'filesPending must be a boolean.');
          const data = await upstream(req, res, 'POST', validateQuote(body));
          if (!data) return;
          // the widget uploads files right after: the last upload notifies the agent, so it answers once
          if (body.filesPending !== true) notify('rfq_created', data.conversationId, data.quoteId);
          return send(res, 200, data);
        }
        const patch = validatePatch(body);
        const data = await upstream(req, res, 'PATCH', patch);
        if (!data) return;
        notify('customer_message', patch.conversationId, patch.quoteId);
        return send(res, 200, data);
      }

      if (pathname === '/api/intake') {
        if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.', { Allow: 'POST' });
        if (limited(req, res, 'intake')) return;
        const body = await readJsonBody(req, MAX_TRANSCRIPT_BODY_BYTES);
        if (typeof body.website === 'string' ? body.website.trim() !== '' : body.website != null && body.website !== false) {
          return send(res, 200, { success: true, reply: '', quickReplies: [], fields: {}, missing: REQUIRED_ORDER.slice(), deferred: [], asking: null, complete: false }); // honeypot
        }
        const input = validateIntake(body);
        let answer = null;
        try {
          answer = await callIntake({ history: input.history, fields: input.fields, message: input.message, ...(input.deferred.length ? { deferred: input.deferred } : {}) });
          if (!answer || typeof answer !== 'object' || !cleanText(answer.reply, 1500)) throw new Error('intake answer without a reply');
        } catch (error) {
          emit({ level: 'warn', msg: 'intake_fallback', detail: String((error && error.message) || error).slice(0, 300) });
          answer = intakeFallback(input);
        }
        // never trust the agent: fieldUpdates go through the same rules as POST /api/quote; missing/complete are computed here
        const fields = { ...input.fields, ...normalizeIntakeFields(answer.fieldUpdates) };
        const deferred = cleanDeferred([...input.deferred, ...(Array.isArray(answer.deferred) ? answer.deferred : [])], fields);
        const missing = missingFields(fields, deferred);
        return send(res, 200, {
          success: true,
          reply: cleanText(answer.reply, 1500),
          quickReplies: cleanQuickReplies(answer.quickReplies),
          fields,
          missing,
          deferred: missing.length ? deferred : [],
          asking: FIELD_NAMES.includes(answer.asking) ? answer.asking : null,
          complete: missing.length === 0
        }, { 'Cache-Control': 'no-store' });
      }

      if (pathname === '/api/quote/files') {
        if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.', { Allow: 'POST' });
        if (limited(req, res, 'upload')) return;
        const ids = validateIds({ conversationId: url.searchParams.get('conversationId'), quoteId: url.searchParams.get('quoteId') });
        if (!/^application\/octet-stream\s*(;|$)/.test(String(req.headers['content-type'] || '').toLowerCase())) {
          throw new HttpError(415, 'Content-Type must be application/octet-stream.');
        }
        const file = checkFileName(req.headers['x-file-name']);
        const declared = req.headers['content-length'] === undefined ? NaN : Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > cfg.upload.maxBytes) throw new HttpError(413, `File too large. The limit is ${Math.round(cfg.upload.maxBytes / 1048576)} MB per file.`);
        if (declared === 0) throw new HttpError(400, 'The file is empty.');
        if (uploadsInFlight >= cfg.upload.maxConcurrent) {
          return fail(res, 429, 'Too many requests. Please try again later.', { 'Retry-After': '10' });
        }
        uploadsInFlight += 1;
        try {
          // 1) the conversation/quote pair must match before a single byte is read or stored
          let pair;
          try {
            pair = await callSalesforce('GET', null, new URLSearchParams({ ...ids, verify: '1' }).toString());
          } catch (error) {
            emit({ level: 'error', msg: 'upstream_error', method: 'GET', path: pathname, detail: String((error && error.message) || error).slice(0, 300) });
            return send(res, 502, GENERIC_ERROR);
          }
          if (!pair || pair.success !== true) return fail(res, 404, 'Conversation not found.');
          // 2) body, streamed with a hard cap; content must match the extension
          const buffer = await readUploadBody(req, declared, cfg.upload.maxBytes, cfg.upload.idleTimeoutMs);
          if (!buffer.length) throw new HttpError(400, 'The file is empty.');
          if (!contentMatches(UPLOAD_TYPES[file.ext], buffer)) throw new HttpError(415, 'The file content does not match its type.');
          // 3) the file, on the quote
          try {
            await uploadFile({ quoteId: ids.quoteId, name: file.name, buffer });
          } catch (error) {
            emit({ level: 'error', msg: 'upload_failed', name: file.name, size: buffer.length, type: file.ext, quoteId: ids.quoteId, detail: String((error && error.message) || error).slice(0, 300) });
            return send(res, 502, GENERIC_ERROR);
          }
          emit({ level: 'info', msg: 'file_uploaded', name: file.name, size: buffer.length, type: file.ext, quoteId: ids.quoteId });
          // 4) the conversation message (+ Gerbers flag) and the agent
          const gerbers = GERBER_EXTENSIONS.has(file.ext);
          const patch = { ...ids, message: `\u{1F4CE} Attached: ${file.name} (${formatSize(buffer.length)})` };
          if (gerbers) patch.gerbersReceived = true;
          let data = null;
          try {
            data = await callSalesforce('PATCH', patch);
          } catch (error) {
            emit({ level: 'error', msg: 'upstream_error', method: 'PATCH', path: pathname, detail: String((error && error.message) || error).slice(0, 300) });
          }
          if (!data || data.success !== true) {
            if (data) emit({ level: 'error', msg: 'upstream_unsuccessful', method: 'PATCH', path: pathname, detail: typeof data.errorMessage === 'string' ? data.errorMessage.slice(0, 300) : 'empty or unsuccessful response' });
            // the file is stored: answering an error would make the client retry and duplicate it
            emit({ level: 'warn', msg: 'upload_without_message', name: file.name, quoteId: ids.quoteId });
            return send(res, 200, { success: true, stored: true, messageLogged: false });
          }
          // the widget sends more=1 for every file of a batch except the last: one agent reply per batch
          if (url.searchParams.get('more') !== '1') notify('customer_message', ids.conversationId, ids.quoteId);
          return send(res, 200, { success: true, file: { name: file.name, size: buffer.length, gerbers } });
        } finally {
          uploadsInFlight -= 1;
        }
      }

      if (pathname === '/api/quote/messages') {
        if (req.method !== 'GET') return fail(res, 405, 'Method not allowed.', { Allow: 'GET' });
        if (limited(req, res, 'messages')) return;
        const ids = validateIds({ conversationId: url.searchParams.get('conversationId'), quoteId: url.searchParams.get('quoteId') });
        const query = new URLSearchParams(ids);
        const after = url.searchParams.get('after');
        if (after) query.set('after', after.slice(0, 80));
        const data = await upstream(req, res, 'GET', null, query.toString());
        if (!data) return;
        return send(res, 200, data, { 'Cache-Control': 'no-store' });
      }

      if (pathname === '/api/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
        return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
      }

      if (pathname.startsWith('/api/')) return fail(res, 404, 'Not found.');

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, '<!doctype html><title>Method not allowed</title><h1>Method not allowed</h1>', { Allow: 'GET, HEAD' });
      }

      if (pathname === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('User-agent: *\nDisallow: /\n');
      }

      const absolute = resolveStatic(cfg.publicDir, pathname);
      if (!absolute) return notFound(res);
      let info;
      try {
        info = await stat(absolute);
      } catch {
        return notFound(res);
      }
      if (!info.isFile()) return notFound(res);
      const file = await readFile(absolute);
      const headers = { 'Content-Type': contentType(absolute) };
      // Our own widget code changes with every deploy: revalidate it each load. Cloned images and fonts can be cached.
      if (/[\\/]chat-widget\.(js|css)$/.test(absolute)) headers['Cache-Control'] = 'no-cache';
      else if (!absolute.endsWith('.html')) headers['Cache-Control'] = 'public, max-age=3600';
      res.writeHead(200, headers);
      return res.end(file);
    } catch (error) {
      if (error instanceof HttpError) {
        const extra = error.status === 413 || error.status === 408 ? { Connection: 'close' } : {};
        return fail(res, error.status, error.message, extra);
      }
      emit({ level: 'error', msg: 'unhandled_error', method: req.method, path: req._path, detail: String((error && error.message) || error).slice(0, 300) });
      if (!res.headersSent) send(res, 500, GENERIC_ERROR);
      else res.end();
    }
  });
  server.limiterStats = () => limiter.stats();
  return server;
}

// ---------------------------------------------------------------------------
// Entry point: `node server.js`
// ---------------------------------------------------------------------------

async function callSalesforceDispatch(method, body, query) {
  if (process.env.SF_AUTH === 'jwt') return callSalesforceJwt(method, body, query);
  return callSalesforceCli(method, body, query);
}

function main() {
  loadEnvFile();
  const port = Number(process.env.PORT || 4173);
  const server = createServer({
    callSalesforce: callSalesforceDispatch,
    uploadFile: process.env.SF_AUTH === 'jwt' ? uploadFileJwt : uploadFileUnsupported,
    notifyAgent,
    log: (line) => console.log(line),
    config: configFromEnv()
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.listen(port, '0.0.0.0', () => {
    logLine({ level: 'info', msg: 'listening', host: '0.0.0.0', port: server.address().port });
  });
  const shutdown = (signal) => {
    logLine({ level: 'info', msg: 'shutdown', signal });
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
