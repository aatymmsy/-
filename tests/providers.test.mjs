import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../src/server.mjs';
import { listModels } from '../src/provider.mjs';
import { normalizeBaseURL, inferProvider } from '../src/providers.mjs';

async function endpoint(t, handler) {
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}
test('模型发现读取当前接口，携带 Key、去重排序并保留实际 ID', async t => {
  const base = await endpoint(t, (req, res) => {
    assert.equal(req.url, '/custom/v1/models'); assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Bearer draft-test-key');
    res.end(JSON.stringify({ data: [{ id: 'z-model', name: 'Z 模型' }, { id: 'a-model' }, { id: 'z-model' }, { name: 'invalid' }, { id: '' }] }));
  });
  const result = await listModels(`${base}/custom/v1/`, 'draft-test-key');
  assert.deepEqual(result.models, [{ id: 'a-model', name: 'a-model' }, { id: 'z-model', name: 'Z 模型' }]);
  assert.ok(result.fetchedAt);
});
test('鉴权失败、接口缺失、空列表及非兼容响应都有明确反馈', async t => {
  const base = await endpoint(t, (req, res) => {
    if (req.url === '/unauthorized/models') { res.writeHead(401); res.end('should-not-echo-secrets'); }
    else if (req.url === '/missing/models') { res.writeHead(404); res.end(); }
    else if (req.url === '/empty/models') res.end(JSON.stringify({ data: [] }));
    else if (req.url === '/null/models') res.end('null');
    else res.end('<html>not an API</html>');
  });
  await assert.rejects(listModels(`${base}/unauthorized`), /401.*Key 无效/);
  await assert.rejects(listModels(`${base}/missing`), /404.*手动填写/);
  assert.deepEqual((await listModels(`${base}/empty`)).models, []);
  await assert.rejects(listModels(`${base}/null`), /data 列表/);
  await assert.rejects(listModels(`${base}/html`), /不是有效 JSON/);
});
test('模型列表超时可退出，重定向不转发密钥', async t => {
  let leaked = false;
  const other = await endpoint(t, (req, res) => { leaked = true; res.end('{"data":[]}'); });
  const base = await endpoint(t, (req, res) => {
    if (req.url === '/redirect/models') { res.writeHead(302, { Location: `${other}/models` }); res.end(); }
    else { const timer = setTimeout(() => res.end('{"data":[]}'), 1000); res.on('close', () => clearTimeout(timer)); }
  });
  await assert.rejects(listModels(`${base}/slow`, '', { timeoutMs: 50 }), /超时/);
  await assert.rejects(listModels(`${base}/redirect`, 'test-private-key'), /重定向/);
  assert.equal(leaked, false);
});
test('同步可用未保存 Key，不修改配置；已存 Key 仅复用到同地址', async t => {
  const requests = [];
  const base = await endpoint(t, (req, res) => { requests.push({ url: req.url, auth: req.headers.authorization || '' }); res.end('{"data":[{"id":"live-model"}]}'); });
  const root = mkdtempSync(join(tmpdir(), 'meiju-model-settings-')), app = await startApp({ root, port: 0 });
  t.after(async () => { await app.close(); rmSync(root, { force: true, recursive: true }); });
  const token = (await (await fetch(app.url)).text()).match(/name="agent-token" content="([^"]+)"/)[1];
  const headers = { 'X-Agent-Token': token };
  const post = async (path, body) => { const res = await fetch(`${app.url}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(res.status, 200); return res.json(); };
  const state = async () => (await (await fetch(`${app.url}/api/state`, { headers })).json()).config;
  await post('/config', { baseURL: `${base}/saved/v1`, apiKey: 'stored-test-key', model: 'old-model' });
  const before = readFileSync(join(root, 'config.json'), 'utf8');
  const result = await post('/models', { baseURL: `${base}/draft/v1`, apiKey: 'draft-test-key' });
  assert.equal(result.models[0].id, 'live-model'); assert.equal(requests.at(-1).auth, 'Bearer draft-test-key');
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), before);
  await post('/models', { baseURL: `${base}/saved/v1/` }); assert.equal(requests.at(-1).auth, 'Bearer stored-test-key');
  await post('/models', { baseURL: `${base}/other/v1` }); assert.equal(requests.at(-1).auth, '');
  await post('/models', { baseURL: `${base}/saved/v1`, apiKey: '' }); assert.equal(requests.at(-1).auth, '');
  assert.equal((await state()).hasKey, true);
  await post('/config', { baseURL: `${base}/other/v1`, model: 'new-model' }); assert.equal((await state()).hasKey, false);
  assert.ok(!JSON.stringify(await state()).includes('stored-test-key'));
});
test('厂商预设无硬编码模型，基础地址校验排除凭据和查询参数', () => {
  assert.equal(inferProvider('https://api.openai.com/v1/'), 'openai'); assert.equal(inferProvider('https://gateway.example/v1'), 'custom');
  assert.equal(normalizeBaseURL(' https://api.deepseek.com/ '), 'https://api.deepseek.com');
  assert.throws(() => normalizeBaseURL('file:///c:/')); assert.throws(() => normalizeBaseURL('https://user:secret@example.com/v1'));
  assert.throws(() => normalizeBaseURL('https://example.com/v1?api_key=private'));
});
