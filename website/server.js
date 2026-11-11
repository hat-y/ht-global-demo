import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import path from 'node:path';
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
      maxTrackedIps: num('RATE_MAX_TRACKED_IPS', 10000)
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

function validateQuote(body) {
  const out = {};
  out.name = str(body, 'name', 120, { required: true });
  out.company = str(body, 'company', 120, { required: true });
  const email = str(body, 'email', 254 + 1, { required: false });
  if (!email || email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, 'A valid email is required.');
  out.email = email;
  out.phone = str(body, 'phone', 40);
  out.comment = str(body, 'comment', 2000);
  out.message = str(body, 'message', 2000);
  for (const k of ['boardType', 'unitOfMeasure', 'itarClassification']) out[k] = str(body, k, 80);
  out.layers = num(body, 'layers', 1, 64, { integer: true });
  out.quantity = num(body, 'quantity', 1, 1000000, { integer: true });
  out.width = num(body, 'width', 0, 10000);
  out.length = num(body, 'length', 0, 10000);
  out.leadTimeDays = num(body, 'leadTimeDays', 0, 365);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
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

async function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(type)) throw new HttpError(415, 'Content-Type must be application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
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
  return parsed;
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

export function createServer({ callSalesforce, notifyAgent: notify = () => {}, now = () => Date.now(), log = (line) => console.log(line), config = {} } = {}) {
  const defaults = configFromEnv({});
  const cfg = {
    publicDir: config.publicDir || path.join(__dirname, 'public'),
    trustProxy: config.trustProxy ?? defaults.trustProxy,
    limits: {
      post: { ...defaults.limits.post, ...(config.limits && config.limits.post) },
      patch: { ...defaults.limits.patch, ...(config.limits && config.limits.patch) },
      messages: { ...defaults.limits.messages, ...(config.limits && config.limits.messages) },
      maxTrackedIps: (config.limits && config.limits.maxTrackedIps) || defaults.limits.maxTrackedIps
    }
  };
  const limiter = createRateLimiter(cfg.limits, now);

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
        const body = await readJsonBody(req);
        if (typeof body.website === 'string' ? body.website.trim() !== '' : body.website != null && body.website !== false) {
          return send(res, 200, { success: true }); // honeypot: pretend it worked
        }
        if (req.method === 'POST') {
          const data = await upstream(req, res, 'POST', validateQuote(body));
          if (!data) return;
          notify('rfq_created', data.conversationId, data.quoteId);
          return send(res, 200, data);
        }
        const patch = validatePatch(body);
        const data = await upstream(req, res, 'PATCH', patch);
        if (!data) return;
        notify('customer_message', patch.conversationId, patch.quoteId);
        return send(res, 200, data);
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
        const extra = error.status === 413 ? { Connection: 'close' } : {};
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
    notifyAgent,
    log: (line) => console.log(line),
    config: configFromEnv()
  });
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
