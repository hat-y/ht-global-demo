// Calls /conversation/v1/context as the n8n integration user (JWT). Prints status + body only, never tokens.
// Usage: node scripts/ctx-check.mjs <conversationId>
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.secrets', 'ht-global-n8n');
const { clientId, username, instanceUrl, loginUrl = 'https://login.salesforce.com' } = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
const key = readFileSync(join(dir, 'server.key'), 'utf8');
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const head = b64({ alg: 'RS256', typ: 'JWT' });
const body = b64({ iss: clientId, sub: username, aud: loginUrl, exp: Math.floor(Date.now() / 1000) + 180 });
const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
const tok = await fetch(`${loginUrl}/services/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
const tj = await tok.json();
if (!tok.ok) { console.log('token', tok.status, tj.error); process.exit(1); }
const r = await fetch(`${tj.instance_url || instanceUrl}/services/apexrest/conversation/v1/context?conversationId=${process.argv[2]}&format=json&messageLimit=30&hoursBack=720`, { headers: { authorization: `Bearer ${tj.access_token}` } });
const t = await r.text();
console.log('status', r.status);
console.log(t.slice(0, 600));
const m = t.match(/"(autoReply|humanInTheLoop|isHumanInTheLoop)"\s*:\s*\w+/g); if (m) console.log(m.join(' '));
