import fs from 'node:fs';
const cfg = Object.fromEntries(fs.readFileSync('/home/hat/.config/n8n-mcp.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const [method, tool, args] = process.argv.slice(2);
const body = method==='list' ? {jsonrpc:'2.0',id:1,method:'tools/list',params:{}} : {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:JSON.parse(args||'{}')}};
const res = await fetch(cfg.N8N_MCP_URL,{method:'POST',headers:{Authorization:'Bearer '+cfg.N8N_MCP_TOKEN,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(body)});
const t = await res.text(); const line = t.split('\n').find(l=>l.startsWith('data: '));
console.log(res.status, line ? line.slice(6) : t.slice(0,500));
