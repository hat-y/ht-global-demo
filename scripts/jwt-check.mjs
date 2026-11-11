// Proves the n8n JWT bearer flow for ht-global. Prints HTTP statuses only (never tokens).
// Usage: node scripts/jwt-check.mjs  (reads .secrets/ht-global-n8n/{server.key,config.json})
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
const assertion = `${head}.${body}.${sig}`;

const tok = await fetch(`${loginUrl}/services/oauth2/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
});
const tj = await tok.json();
console.log('token', tok.status, tok.ok ? 'ok' : tj.error + ': ' + tj.error_description);
if (!tok.ok) process.exit(1);

const h = { authorization: `Bearer ${tj.access_token}` };
const base = tj.instance_url || instanceUrl;
const d = await fetch(`${base}/services/data/v63.0/sobjects/Quote/describe`, { headers: h });
const dj = await d.json();
console.log('Quote describe', d.status, 'createable=' + dj.createable);
const q = await fetch(`${base}/services/data/v63.0/query?q=${encodeURIComponent('SELECT Id FROM Conversation__c LIMIT 1')}`, { headers: h });
const qj = await q.json();
console.log('SOQL Conversation__c', q.status, 'totalSize=' + qj.totalSize);
