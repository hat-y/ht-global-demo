// Usage: node scripts/n8n-deploy.mjs <validate|create> <workflow.ts> | update-code <workflow.ts> <workflowId> <node name>
// Substitutes placeholders from the environment / ignored files (never printed) and calls the n8n MCP.
import fs from 'node:fs';
const [action, file, id] = process.argv.slice(2);
const read = (p) => Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n').map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^["']|["']$/g, '')]));
const cfg = read(process.env.HOME + '/.config/n8n-mcp.env');
const web = read(new URL('../website/.env', import.meta.url).pathname);
const subs = {
  __HT_AGENT_SECRET__: web.N8N_AGENT_SECRET,
  __OPENROUTER_CREDENTIAL_ID__: process.env.OPENROUTER_CREDENTIAL_ID,
  __SF_JWT_CREDENTIAL_ID__: process.env.SF_JWT_CREDENTIAL_ID,
  __SF_INSTANCE_URL__: process.env.SF_INSTANCE_URL
};
let code = fs.readFileSync(file, 'utf8');
for (const [k, v] of Object.entries(subs)) { if (code.includes(k)) { if (!v) throw new Error('missing ' + k); code = code.split(k).join(v); } }
const call = async (name, args) => {
  const r = await fetch(cfg.N8N_MCP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.N8N_MCP_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text(); const line = t.split('\n').find(l => l.startsWith('data: ')) || t;
  return JSON.parse(line.replace(/^data: /, ''));
};
if (action === 'update-code') {
  // Usage: update-code <workflow.ts> <workflowId> <node name>: pushes only that Code node's jsCode (evaluated from the TS template literal).
  const nodeName = process.argv[5];
  const i = code.indexOf("name: '" + nodeName + "'");
  const a = code.indexOf('jsCode: `', i) + 'jsCode: `'.length;
  const b = code.indexOf('`\n    },', a);
  const jsCode = new Function('return `' + code.slice(a, b) + '`')();
  const out = await call('update_workflow', { workflowId: id, operations: [{ type: 'updateNodeParameters', nodeName, parameters: { jsCode } }] });
  console.log(JSON.stringify(out.result?.structuredContent ?? out).slice(0, 1500));
  process.exit(0);
}
const tool = { validate: 'validate_workflow', create: 'create_workflow_from_code', }[action];
const args = { code };
const out = await call(tool, args);
let s = JSON.stringify(out.result?.structuredContent ?? out);
for (const v of Object.values(subs)) if (v) s = s.split(v).join('«redacted»');
console.log(s.slice(0, 3000));
