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
  const calls = { sf: [], notify: [], logs: [], upload: [], intake: [] };
  const deps = {
    callSalesforce: async (method, body, query) => {
      calls.sf.push({ method, body, query });
      if (overrides.sfImpl) return overrides.sfImpl(method, body, query);
      if (method === 'GET') return { success: true, messages: [] };
      return { success: true, conversationId: CID, quoteId: QID };
    },
    callIntake: async (payload) => {
      calls.intake.push(payload);
      if (overrides.intakeImpl) return overrides.intakeImpl(payload);
      return { reply: 'Hello!', quickReplies: [], fieldUpdates: {} };
    },
    uploadFile: async (file) => {
      calls.upload.push(file);
      if (overrides.uploadImpl) return overrides.uploadImpl(file);
      return { id: '068g7000000AbCdAAK' };
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

export const validQuote = { name: 'Vince Carter', company: 'Summit Avionics', email: 'vince@summit.example', phone: '+1 555 0100', layers: 4, quantity: 100, width: 100, length: 80, boardType: 'Rigid PCB', singleUpOrArray: 'Single Up', unitOfMeasure: 'mm', itarClassification: 'Commercial', comment: 'Need quote', message: 'Need quote' };

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

// raw file upload: resolves with the response as soon as it arrives (the server may answer before the body is sent)
export function upload(base, { query, headers = {}, body, chunked = false }) {
  const url = new URL(base + '/api/quote/files' + (query === undefined ? `?conversationId=${CID}&quoteId=${QID}` : query));
  return new Promise((resolve, reject) => {
    const h = { 'Content-Type': 'application/octet-stream', ...headers };
    if (!chunked && body) h['Content-Length'] = String(body.length);
    const req = http.request({ host: url.hostname, port: url.port, method: 'POST', path: url.pathname + url.search, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: data, json: j }); });
    });
    req.on('error', (e) => { if (!req.res) reject(e); });
    if (body) {
      const step = 1024 * 1024;
      let i = 0;
      const pump = () => {
        while (i < body.length) {
          const ok = req.write(body.subarray(i, i + step));
          i += step;
          if (!ok) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
    } else req.end();
  });
}

export const MAGIC = {
  pdf: () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'),
  zip: () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest-of-zip')]),
  png: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]),
  jpg: () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')]),
  gz: () => Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from('gzdata')]),
  ole: () => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('ole')]),
  text: () => Buffer.from('G04 Gerber test*\nG75*\n%FSLAX24Y24*%\nM02*\n'),
  csv: () => Buffer.from('layer,thickness\nL1,0.035\n')
};
