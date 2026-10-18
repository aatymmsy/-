import http from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { hash, id, hasSaveFile, phoneSlotNumber } from './store.mjs';
import { reconcile } from './auto-sync.mjs';

export async function readJSON(req, limit = 24 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) { const e = new Error('请求过大'); e.status = 413; throw e; } chunks.push(chunk); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new Error('JSON 格式无效'); }
}
export const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
const equalHash = (a, b) => { const aa = Buffer.from(a || ''), bb = Buffer.from(b || ''); return aa.length === bb.length && timingSafeEqual(aa, bb); };
export class SyncService {
  constructor(store) { this.store = store; this.server = null; this.pin = null; this.attempts = 0; this.request = null; this.completed = new Set(); this.lastResult = null; }
  requestSync() { this.request = { id: id(), timestamp: Date.now() }; this.completed.clear(); return this.info(); }
  info() {
    const addresses = Object.values(networkInterfaces()).flat().filter(x => x.family === 'IPv4' && !x.internal).map(x => `http://${x.address}:${this.port}`);
    return { enabled: Boolean(this.server?.listening), port: this.port || 39782, addresses, pairingCode: this.pin && this.pin.expires > Date.now() ? this.pin.code : null, expires: this.pin?.expires, request: this.request, lastResult: this.lastResult, devices: this.store.list('device').map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt })), receipts: this.store.list('sync_receipt'), conflicts: this.store.list('conflict').map(c => ({ id: c.id, slotId: c.slotId, timestamp: c.timestamp })) };
  }
  renewPin() { this.pin = { code: String(randomInt(100000, 1000000)), expires: Date.now() + 300000 }; this.attempts = 0; return this.info(); }
  async start(port = 39782) {
    if (this.server?.listening) return this.info();
    this.port = port;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
    this.server = server; this.port = server.address().port; this.renewPin(); return this.info();
  }
  async stop() { const s = this.server; this.server = null; this.pin = null; if (s) await new Promise(resolve => s.close(resolve)); }
  revoke(deviceId) { this.store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('device', deviceId); }
  async handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const path = new URL(req.url, 'http://sync.local').pathname;
      const asset = { '/': ['phone.html', 'text/html'], '/phone.js': ['phone.js', 'text/javascript'], '/phone.css': ['phone.css', 'text/css'] }[path];
      if (req.method === 'GET' && asset) {
        const [file, type] = asset;
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'X-Content-Type-Options': 'nosniff' });
        res.end(readFileSync(new URL(`../public/${file}`, import.meta.url))); return;
      }
      if (req.method === 'POST' && path === '/v1/pair') {
        const body = await readJSON(req, 4096);
        if (!this.pin || this.pin.expires < Date.now() || ++this.attempts > 10 || !equalHash(String(body.code), this.pin.code)) return json(res, 401, { error: '配对码无效、过期或尝试次数过多，请在电脑刷新配对码' });
        const token = randomBytes(32).toString('hex');
        const device = { id: id(), name: String(body.name || '手机').slice(0, 80), tokenHash: hash(token), createdAt: Date.now() };
        this.store.put('device', device); this.pin = null;
        return json(res, 200, { deviceId: device.id, token });
      }
      const tokenHash = hash((req.headers.authorization || '').replace(/^Bearer /, ''));
      const device = this.store.list('device').find(d => equalHash(d.tokenHash, tokenHash));
      if (!device) return json(res, 401, { error: '需要设备配对' });
      if (req.method === 'GET' && path === '/v1/sync-request') return json(res, 200, { request: this.request && !this.completed.has(device.id) && Date.now() - this.request.timestamp < 300000 ? this.request : null });
      if (req.method === 'POST' && path === '/v1/sync-complete') {
        const body = await readJSON(req, 50000);
        if (body.id && body.id === this.request?.id) this.completed.add(device.id);
        this.lastResult = { id: body.id || null, timestamp: Date.now(), device: device.name, result: body.result };
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/v1/slots') return json(res, 200, this.store.list('slot').map(s => ({ id: s.id, name: s.name, phoneSlot: phoneSlotNumber(s), occupied: hasSaveFile(s.save), revision: s.revision, updatedAt: s.updatedAt })));
      const automatic = path.match(/^\/v1\/reconcile\/([1-9]|10)$/);
      if (automatic && req.method === 'POST') return json(res, 200, reconcile(this.store, Number(automatic[1]), await readJSON(req), device.id));
      const missing = path.match(/^\/v1\/bootstrap\/([1-9]|10)$/);
      if (missing && req.method === 'POST') {
        const body = await readJSON(req);
        return json(res, 200, this.store.fillMissingPhoneSlot(Number(missing[1]), body.save));
      }
      const match = path.match(/^\/v1\/slots\/([^/]+)$/);
      if (match && req.method === 'GET') return json(res, 200, this.store.syncSnapshot(match[1]));
      if (match && req.method === 'POST') {
        const body = await readJSON(req);
        if (typeof body.baseRevision !== 'string') throw new Error('必须提供 baseRevision');
        const value = this.store.pushSnapshot(match[1], body.baseRevision, body, device.id);
        return json(res, value.conflict ? 409 : 200, value);
      }
      return json(res, 404, { error: '同步接口不存在' });
    } catch (e) { json(res, e.status || 400, { error: e.message }); }
  }
}
