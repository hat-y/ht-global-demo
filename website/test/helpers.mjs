import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

export const QID = '0Q0g70000029ZgXCAU';
export const CID = 'a0Bg7000001AbCdEAK';

export function makePublicDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htweb-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>home</html>');
  fs.writeFileSync(path.join(dir, 'quote.html'), '<html>quote</html>');
  fs.writeFileSync(path.join(dir, '.secret'), 'hidden');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'a.png'), 'png');
  fs.writeFileSync(path.join(dir, 'assets', 'f.woff2'), 'font');
  fs.writeFileSync(path.join(dir, 'assets', 'i.ico'), 'ico');
  fs.writeFileSync(path.join(dir, 'assets', 'x.jpg'), 'jpg');
  fs.writeFileSync(path.join(dir, 'assets', 'x.webp'), 'webp');
  fs.writeFileSync(path.join(dir, 'assets', 'm.json'), '{}');
  fs.writeFileSync(path.join(dir, 'assets', 'n.txt'), 'txt');
  fs.writeFileSync(path.join(dir, 'chat-widget.js'), '/* widget */');
  fs.writeFileSync(path.join(dir, 'chat-widget.css'), '/* widget */');
  fs.writeFileSync(path.join(path.dirname(dir), path.basename(dir) + '-outside.txt'), 'outside');
  return dir;
}

export async function start(overrides = {}) {
  const calls = { sf: [], notify: [], logs: [] };
  const deps = {
    callSalesforce: async (method, body, query) => {
      calls.sf.push({ method, body, query });
      if (overrides.sfImpl) return overrides.sfImpl(method, body, query);
      if (method === 'GET') return { success: true, messages: [] };
      return { success: true, conversationId: CID, quoteId: QID };
    },
    notifyAgent: (...args) => calls.notify.push(args),
    now: overrides.now || (() => Date.now()),
    log: (line) => calls.logs.push(line),
    config: { publicDir: overrides.publicDir || makePublicDir(), ...(overrides.config || {}) }
  };
  const server = createServer(deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    calls,
    port,
    stats: () => server.limiterStats(),
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  };
}

export const validQuote = { name: 'Vince Carter', company: 'Summit Avionics', email: 'vince@summit.example', phone: '+1 555 0100', layers: 4, quantity: 100, width: 100, length: 80, boardType: 'Rigid PCB', unitOfMeasure: 'mm', itarClassification: 'Commercial', comment: 'Need quote', message: 'Need quote' };

export function json(base, method, urlPath, body, headers = {}) {
  return fetch(base + urlPath, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}

// raw request: no URL normalisation
export function raw(port, method, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}
