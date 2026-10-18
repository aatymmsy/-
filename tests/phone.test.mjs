import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SyncService } from '../src/sync.mjs';

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'meiju-phone-test-')), store = new Store(root), slot = store.createSlot('电脑空间');
  const sync = new SyncService(store); await sync.start(0);
  t.after(async () => { await sync.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const api = async (path, body, token = '') => {
    const r = await fetch(`http://127.0.0.1:${sync.port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  return { root, store, slot, sync, api };
}
test('手机根地址提供配对页面，静态文件可访问，存档和管理接口仍须鉴权', async t => {
  const { sync, slot, api } = await setup(t), url = `http://127.0.0.1:${sync.port}`;
  for (const [path, type] of [['/', 'text/html'], ['/phone.js', 'text/javascript'], ['/phone.css', 'text/css']]) {
    const r = await fetch(url + path); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), new RegExp(type));
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const text = await r.text(); assert.ok(!text.includes(sync.info().pairingCode)); assert.ok(!text.includes(slot.id));
  }
  assert.equal((await api('/v1/slots')).status, 401);
  assert.equal((await api(`/v1/slots/${slot.id}`)).status, 401);
  assert.equal((await api('/api/config')).status, 401);
  assert.equal((await fetch(url + '/phone.html')).status, 401);
});
test('配对码过期、错误、重复使用均拒绝；已配对凭据重启仍有效，撤销后失效', async t => {
  const { sync, store, api } = await setup(t);
  sync.pin.expires = Date.now() - 100;
  assert.equal((await api('/v1/pair', { code: sync.pin.code })).status, 401);
  sync.renewPin(); const code = sync.info().pairingCode;
  assert.equal((await api('/v1/pair', { code: 'bad' })).status, 401);
  const paired = await api('/v1/pair', { code, name: '手机浏览器' }); assert.equal(paired.status, 200);
  const { token, deviceId } = paired.body;
  assert.equal((await api('/v1/pair', { code })).status, 401);
  assert.ok(!JSON.stringify(store.list('device')).includes(token));
  await sync.stop(); await sync.start(0);
  assert.equal((await api('/v1/slots', undefined, token)).status, 200);
  assert.equal((await api('/api/config', undefined, token)).status, 404);
  sync.revoke(deviceId); assert.equal((await api('/v1/slots', undefined, token)).status, 401);
});
test('手机传档保持原格式、备份和版本冲突；下载不修改电脑存档', async t => {
  const { sync, store, slot, root, api } = await setup(t);
  const { token } = (await api('/v1/pair', { code: sync.info().pairingCode })).body;
  const list = (await api('/v1/slots', undefined, token)).body;
  assert.equal(list[0].phoneSlot, 1);
  const before = (await api(`/v1/slots/${slot.id}`, undefined, token)).body;
  assert.deepEqual(store.get('slot', slot.id).save, before.save);
  const incoming = { slotId: 5, data: { gameData: { playerProgress: { coins: 12345 } }, diary: [{ content: '手机日记' }], prompts: {}, unknown: { kept: true } } };
  assert.equal((await api(`/v1/slots/${slot.id}`, { baseRevision: before.revision, save: incoming }, token)).status, 200);
  assert.equal(readdirSync(join(root, 'backups')).length, 1);
  const downloaded = (await api(`/v1/slots/${slot.id}`, undefined, token)).body;
  assert.deepEqual(downloaded.save, incoming);
  const conflict = await api(`/v1/slots/${slot.id}`, { baseRevision: before.revision, save: before.save }, token);
  assert.equal(conflict.status, 409); assert.deepEqual(store.get('slot', slot.id).save, incoming);
  assert.ok(store.get('conflict', conflict.body.conflict));
});
