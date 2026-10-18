import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createSession, requestMessages } from '../src/prompts.mjs';
import { TOOLS, executeTool, runCommand } from '../src/tools.mjs';
import { Agent, DIARY_REQUEST } from '../src/agent.mjs';
import { normalizeUsage, usageSummary } from '../src/provider.mjs';
import { SyncService } from '../src/sync.mjs';
import { startApp } from '../src/server.mjs';
import http from 'node:http';
import { SyncClient } from '../src/sync-client.mjs';

const fixture = () => ({ version: '1.0.0', slotId: 5, timestamp: 123, unknown: { preserve: true }, data: { gameData: { playerProgress: { coins: 1234 }, characterSystemData: { custom: '保留' } }, diary: [{ content: '旧日记', diaryId: 'old' }, { content: '' }], prompts: { 'sister-null': { data: { name: 'A与B', description: '两个人物', creator_notes: 'B写日记' } } }, settings: { custom: 'original' }, other: { unknown: [1, 2] } } });
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'meiju-agent-test-')), store = new Store(root), slot = store.createSlot();
  const profile = { baseURL: 'http://127.0.0.1:1/v1', model: 'test-model', maxTokens: 8192, tokenParameter: 'max_tokens', temperature: null, extraBody: {}, workspace: join(root, 'files'), permissions: 'workspace', maxContextChars: 400000, timeoutMs: 1000 };
  t.after(() => { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, store, slot, profile, session: createSession(store, slot.id, profile, TOOLS) };
}
const reply = (content, finish = 'stop', cached = 800) => ({ message: { content }, finish, usage: normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: cached } }) });
const call = (name, args, key = 'call-1') => ({ id: key, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('主动开聊使用当前人设和历史，不夹带草稿图片，失败重试不重复开场', async t => {
  const { store, session } = setup(t), requests = [];
  let fail = true;
  const agent = new Agent(store, () => '', async (p, k, messages) => {
    requests.push(structuredClone(messages));
    if (fail) throw new Error('模拟网络失败');
    return reply('如果今晚可以随便挑一部电影，你会想看什么？');
  });
  await assert.rejects(agent.run(session.id, '不应发送的草稿', () => {}, { firstSpeak: true, images: ['invalid-draft-image'] }), /模拟网络失败/);
  const request = globalThis.MeijuConversationStarter.request;
  assert.deepEqual(store.messages(session.id), [{ role: 'user', content: request }]);
  assert.equal(store.get('session', session.id).title, '随便聊聊');
  assert.deepEqual(requests[0].slice(0, session.system.length), session.system);
  fail = false;
  await agent.run(session.id, undefined, () => {}, { retry: true });
  assert.equal(store.messages(session.id).filter(m => m.role === 'user').length, 1);
  assert.equal(store.list('memory').length, 0);
  await agent.run(session.id, '我喜欢喜剧');
  await agent.run(session.id, undefined, () => {}, { firstSpeak: true });
  assert.ok(requests.at(-1).some(m => m.content === '我喜欢喜剧'));
  assert.equal(requests.at(-1).at(-1).content, request);
  assert.equal(store.get('session', session.id).closed, false);
});

test('主动开聊 HTTP 入口接受空输入，已结束会话拒绝请求', async t => {
  const root = mkdtempSync(join(tmpdir(), 'meiju-starter-test-'));
  const app = await startApp({ root, port: 0, callModel: async () => reply('今天想和你聊点轻松的。') });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const html = await (await fetch(app.url)).text();
  const headers = { 'X-Agent-Token': html.match(/name="agent-token" content="([^"]+)"/)[1] };
  const script = await fetch(`${app.url}/conversation-starter.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(await script.text(), /MeijuConversationStarter/);
  const state = await (await fetch(`${app.url}/api/state`, { headers })).json();
  const session = await (await fetch(`${app.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ slotId: state.slots[0].id }) })).json();
  const run = body => fetch(`${app.url}/api/sessions/${session.id}/run`, { method: 'POST', headers, body: JSON.stringify(body) });
  const events = (await (await run({ firstSpeak: true })).text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'done');
  const saved = await (await fetch(`${app.url}/api/sessions/${session.id}`, { headers })).json();
  assert.equal(saved.messages[0].content, globalThis.MeijuConversationStarter.request);
  assert.equal(saved.messages[1].content, '今天想和你聊点轻松的。');
  await (await run({ diary: true })).text();
  assert.equal((await run({ firstSpeak: true })).status, 409);
});

test('手机 JSON 无损导入导出，原字段和空日记保留，替换先备份', t => {
  const { store, root, slot } = setup(t), save = fixture();
  const imported = store.importSave(save);
  assert.deepEqual(store.get('slot', imported.id).save, save);
  store.importSave(save, slot.id);
  assert.equal(readdirSync(join(root, 'backups')).length, 1);
  const backup = JSON.parse(readFileSync(join(root, 'backups', readdirSync(join(root, 'backups'))[0])));
  assert.deepEqual(backup.slot.save, slot.save);
  assert.throws(() => store.importSave({ data: { diary: [] } }, slot.id));
  assert.deepEqual(store.get('slot', slot.id).save, save);
});
test('会话人设、工具、参数和参考日记是快照，重启后请求前缀一致', async t => {
  const { store, slot, profile, session, root } = setup(t);
  const requests = [];
  const agent = new Agent(store, () => '', async (p, k, messages, tools) => { requests.push(structuredClone({ p, messages, tools })); return reply('回复'); });
  await agent.run(session.id, '第一条');
  store.updatePersona(slot.id, '后来修改的人设'); profile.model = 'changed';
  store.close(); const reopened = new Store(root);
  const next = new Agent(reopened, () => '', async (p, k, messages, tools) => { requests.push(structuredClone({ p, messages, tools })); return reply('第二条回复'); });
  await next.run(session.id, '第二条');
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
  assert.deepEqual(requests[1].tools, requests[0].tools);
  assert.deepEqual(requests[1].p, requests[0].p);
  reopened.close();
});
test('空回复重试一次；失败保留任务，重试不重复插入用户消息', async t => {
  const { store, session } = setup(t); let count = 0;
  const agent = new Agent(store, () => '', async () => { count++; return reply(count <= 2 ? '' : '已恢复'); });
  await assert.rejects(agent.run(session.id, '测试'), /连续返回空/);
  assert.equal(count, 2); assert.equal(store.messages(session.id).length, 1);
  await agent.run(session.id, undefined, () => {}, { retry: true });
  assert.equal(store.messages(session.id).filter(m => m.role === 'user').length, 1);
  assert.equal(store.messages(session.id).at(-1).content, '已恢复');
});
test('输出被 length 截断时接续，保留每段文本和原请求', async t => {
  const { store, session } = setup(t); let count = 0;
  const agent = new Agent(store, () => '', async () => ++count === 1 ? reply('前半段', 'length') : reply('后半段'));
  const result = await agent.run(session.id, '写长文');
  assert.equal(result.content, '前半段后半段');
  assert.equal(store.messages(session.id)[1].content, '前半段');
  assert.match(store.messages(session.id)[2].content, /中断处继续/);
});
test('工具调用及结果有序落盘，产出文件、覆盖备份、工具结果可复用', async t => {
  const { store, session, root } = setup(t); const requests = []; let n = 0;
  writeFileSync(join(root, 'files', 'result.txt'), 'old');
  const agent = new Agent(store, () => '', async (p, k, messages) => { requests.push(structuredClone(messages)); return ++n === 1 ? { ...reply(null), message: { content: '开始写入', tool_calls: [call('files_write', { path: 'result.txt', content: 'new' })] } } : reply('已生成文件'); });
  await agent.run(session.id, '产出文件');
  assert.equal(readFileSync(join(root, 'files', 'result.txt'), 'utf8'), 'new');
  const artifact = store.list('artifact')[0]; assert.equal(readFileSync(artifact.backup, 'utf8'), 'old');
  assert.equal(requests[1].at(-1).role, 'tool');
  assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0]);
});
test('工作目录权限阻止目录逃逸和命令；完全权限允许本机命令', async t => {
  const { store, session, root } = setup(t);
  await assert.rejects(executeTool(store, session, call('files_write', { path: '../escape.txt', content: 'x' })), /超出工作目录/);
  await assert.rejects(executeTool(store, session, call('command_run', { command: 'echo forbidden' })), /完全权限/);
  session.profile.permissions = 'full';
  const out = await executeTool(store, session, call('command_run', { command: process.platform === 'win32' ? "Write-Output 'agent-ok'" : "printf agent-ok" }));
  assert.equal(out.code, 0); assert.match(out.output, /agent-ok/);
});
test('命令超时终止，返回明确超时状态', async () => {
  const result = await runCommand(process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10', tmpdir(), undefined, 250);
  assert.equal(result.timedOut, true);
});
test('日记由模型概括后写入，空日记失败时会话不关闭，重试幂等', async t => {
  const { store, session, slot } = setup(t); let n = 0;
  const agent = new Agent(store, () => '', async () => reply(++n <= 2 ? '' : '今天一起整理了文件，也聊了新的计划。'));
  await assert.rejects(agent.run(session.id, DIARY_REQUEST, () => {}, { diary: true }));
  assert.equal(store.get('session', session.id).closed, false);
  assert.equal(store.get('slot', slot.id).save.data.diary.length, 0);
  await agent.run(session.id, undefined, () => {}, { retry: true });
  assert.equal(store.get('session', session.id).closed, true);
  const diary = store.get('slot', slot.id).save.data.diary;
  assert.equal(diary.length, 1); assert.match(diary[0].content, /一起整理/);
  store.addDiary(slot.id, 'duplicate', session.id);
  assert.equal(store.get('slot', slot.id).save.data.diary.length, 1);
});
test('中断的工具不会自动重放，未知结果落盘后由模型检查', async t => {
  const { store, session, root } = setup(t);
  store.append(session.id, { role: 'user', content: '写文件' });
  store.append(session.id, { role: 'assistant', content: null, tool_calls: [call('files_write', { path: 'never.txt', content: 'bad' })] });
  store.put('session', { ...session, status: 'interrupted' });
  const agent = new Agent(store, () => '', async (p, k, messages) => { assert.match(messages.at(-1).content, /结果未知/); return reply('需要检查'); });
  await agent.run(session.id, undefined, () => {}, { retry: true });
  assert.equal(store.list('artifact').length, 0);
});
test('缓存统计兼容 OpenAI/DeepSeek，未知值不伪造0，累计按token加权', () => {
  const a = normalizeUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } });
  const b = normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 20 });
  const unknown = normalizeUsage({ prompt_tokens: 500 });
  const broken = normalizeUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 100 });
  assert.equal(unknown.ratio, null); assert.equal(broken.reported, false);
  const s = usageSummary([a, b, unknown]); assert.equal(s.ratio, 820 / 1100); assert.equal(s.measured, 2); assert.equal(s.requests, 3);
});
test('同步配对、鉴权、版本冲突保留，未配对和命令路径不能访问', async t => {
  const { store, slot } = setup(t), sync = new SyncService(store);
  await sync.start(0); t.after(() => sync.stop());
  const url = `http://127.0.0.1:${sync.port}`;
  assert.equal((await fetch(`${url}/v1/slots`)).status, 401);
  const pairing = await fetch(`${url}/v1/pair`, { method: 'POST', body: JSON.stringify({ code: sync.info().pairingCode, name: 'test-phone' }) });
  const device = await pairing.json(), headers = { Authorization: `Bearer ${device.token}` };
  assert.ok(device.token);
  assert.equal((await fetch(`${url}/api/config`, { headers })).status, 404);
  const snapshot = await (await fetch(`${url}/v1/slots/${slot.id}`, { headers })).json();
  const first = await fetch(`${url}/v1/slots/${slot.id}`, { method: 'POST', headers, body: JSON.stringify({ baseRevision: snapshot.revision, save: fixture() }) });
  assert.equal(first.status, 200);
  const second = await fetch(`${url}/v1/slots/${slot.id}`, { method: 'POST', headers, body: JSON.stringify({ baseRevision: snapshot.revision, save: { ...fixture(), timestamp: 999 } }) });
  assert.equal(second.status, 409); assert.equal(store.list('conflict').length, 1); assert.equal(store.get('slot', slot.id).save.timestamp, 123);
  sync.revoke(device.deviceId);
  assert.equal((await fetch(`${url}/v1/slots`, { headers })).status, 401);
  await sync.stop();
});
test('本机 HTTP 运行通路与统计；拒绝跨站请求和错误 Host', async t => {
  const root = mkdtempSync(join(tmpdir(), 'meiju-http-test-'));
  const app = await startApp({ root, port: 0, callModel: async () => reply('端到端回复') });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const html = await (await fetch(app.url)).text(), token = html.match(/name="agent-token" content="([^"]+)"/)[1];
  const headers = { 'X-Agent-Token': token };
  assert.equal((await fetch(`${app.url}/api/state`)).status, 403);
  assert.equal((await fetch(`${app.url}/api/state`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const invalidHost = await new Promise((resolve, reject) => { const req = http.get(`${app.url}/api/state`, { headers: { ...headers, Host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); }); req.on('error', reject); });
  assert.equal(invalidHost, 403);
  const state = await (await fetch(`${app.url}/api/state`, { headers })).json(); assert.ok(!('apiKey' in state.config));
  const session = await (await fetch(`${app.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ slotId: state.slots[0].id }) })).json();
  const run = await fetch(`${app.url}/api/sessions/${session.id}/run`, { method: 'POST', headers, body: JSON.stringify({ text: '你好' }) });
  const events = (await run.text()).trim().split('\n').map(x => JSON.parse(x)); assert.equal(events.at(-1).type, 'done');
  const result = await (await fetch(`${app.url}/api/sessions/${session.id}`, { headers })).json();
  assert.equal(result.messages.at(-1).content, '端到端回复'); assert.equal(result.usage.last.ratio, .8);
});
test('实际 Chat Completions HTTP 请求保留工具及前缀，使用真实返回 usage', async t => {
  const root = mkdtempSync(join(tmpdir(), 'meiju-provider-test-')), requests = [];
  const mock = http.createServer(async (req, res) => {
    const parts = []; for await (const p of req) parts.push(p);
    const body = JSON.parse(Buffer.concat(parts)); requests.push(body);
    assert.equal(req.headers.authorization, 'Bearer test-local-secret');
    res.setHeader('Content-Type', 'application/json');
    const message = requests.length === 1 ? { role: 'assistant', content: null, tool_calls: [call('files_write', { path: 'http-result.md', content: '# 实际工具往返' })] } : { role: 'assistant', content: '文件已经写入。' };
    res.end(JSON.stringify({ choices: [{ message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: requests.length === 1 ? 0 : 1600 } } }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const app = await startApp({ root, port: 0 });
  t.after(async () => { await app.close(); await new Promise(r => mock.close(r)); rmSync(root, { recursive: true, force: true }); });
  const token = (await (await fetch(app.url)).text()).match(/name="agent-token" content="([^"]+)"/)[1];
  const headers = { 'X-Agent-Token': token };
  const post = (path, body) => fetch(`${app.url}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('/config', { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, model: 'local-mock', apiKey: 'test-local-secret', permissions: 'full' })).status, 200);
  const state = await (await fetch(`${app.url}/api/state`, { headers })).json();
  const s = await (await post('/sessions', { slotId: state.slots[0].id })).json();
  const events = await (await post(`/sessions/${s.id}/run`, { text: '生成 md 文件' })).text(); assert.match(events, /"type":"done"/);
  assert.equal(requests.length, 2); assert.equal(requests[0].max_tokens, 8192);
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
  assert.deepEqual(requests[1].tools, requests[0].tools);
  assert.equal(readFileSync(join(root, 'files', 'http-result.md'), 'utf8'), '# 实际工具往返');
  const result = await (await fetch(`${app.url}/api/sessions/${s.id}`, { headers })).json();
  assert.equal(result.usage.ratio, .4); assert.equal(result.artifacts.length, 1);
});
test('启动同步决策区分首次绑定、仅本地变化、仅远端变化和分叉', () => {
  assert.equal(SyncClient.decide({ remoteRevision: 'b', localChanged: true }), 'choose-first-sync');
  assert.equal(SyncClient.decide({ lastRevision: 'a', remoteRevision: 'a', localChanged: false }), 'unchanged');
  assert.equal(SyncClient.decide({ lastRevision: 'a', remoteRevision: 'a', localChanged: true }), 'push');
  assert.equal(SyncClient.decide({ lastRevision: 'a', remoteRevision: 'b', localChanged: false }), 'pull');
  assert.equal(SyncClient.decide({ lastRevision: 'a', remoteRevision: 'b', localChanged: true }), 'conflict');
});
test('上下文保护不裁剪旧消息，停止会中断请求并保留可重试状态', async t => {
  const { store, session } = setup(t);
  const limited = { ...session, profile: { ...session.profile, maxContextChars: 10 } }; store.put('session', limited);
  const agent = new Agent(store, () => '', async () => { throw new Error('不应调用'); });
  await assert.rejects(agent.run(session.id, '不要删除历史'), /上下文保护上限/);
  assert.equal(store.messages(session.id)[0].content, '不要删除历史');
  store.put('session', { ...store.get('session', session.id), profile: session.profile });
  const slow = new Agent(store, () => '', async (p, k, m, ts, signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('任务已停止')), { once: true }); }));
  const running = slow.run(session.id, undefined, () => {}, { retry: true });
  slow.stop(session.id); await assert.rejects(running, /停止/);
  assert.equal(store.get('session', session.id).status, 'error'); assert.equal(store.messages(session.id).length, 1);
});
test('重复启动端口冲突时不触碰现有会话的运行状态', async t => {
  const root = mkdtempSync(join(tmpdir(), 'meiju-duplicate-test-'));
  const app = await startApp({ root, port: 0 });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  app.store.put('session', { id: 'already-running', status: 'running' });
  await assert.rejects(startApp({ root, port: app.server.address().port }), { code: 'EADDRINUSE' });
  assert.equal(app.store.get('session', 'already-running').status, 'running');
});
