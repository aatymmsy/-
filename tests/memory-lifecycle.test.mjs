import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hasSaveFile } from '../src/store.mjs';
import { saveMemory, indexDiaries, searchMemories, forgetMemory, rememberChat } from '../src/memory.mjs';
import { Agent, DIARY_REQUEST } from '../src/agent.mjs';
import { createSession, requestMessages } from '../src/prompts.mjs';
import { TOOLS } from '../src/tools.mjs';
import { SyncService } from '../src/sync.mjs';

const fixture = (slotId = 5, diary = []) => ({ version: '1.0.0', slotId, data: { gameData: { version: '1.0.0', characterStats: { affection: 1000 }, playerProgress: { coins: 100 }, characterSystemData: {}, timeSystem: { currentDay: 6 }, inventory: {}, shopSystem: {} }, diary, prompts: { 'sister-high': { data: { description: '正常聊天的人设' } }, 'sister-null': { data: { description: '正常聊天的人设' } } } } });
const answer = content => ({ message: { content }, finish: 'stop', usage: { input: 1, cached: 0 } });
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'meiju-lifecycle-')), store = new Store(root);
  const profile = { baseURL: 'http://127.0.0.1:1/v1', model: 'test', maxTokens: 8192, extraBody: {}, workspace: join(root, 'files'), permissions: 'workspace', maxContextChars: 400000, timeoutMs: 1000 };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const slot = store.importSave(fixture());
  return { root, store, slot, profile, session: createSession(store, slot.id, profile, TOOLS) };
}
test('原有和新日记都不会生成记忆，历史日记本身保留',t=>{
 const {store,slot}=setup(t);const diary=[{diaryId:'one',content:'约好明年去旅行。'}];store.importSave(fixture(5,diary),slot.id);const before=structuredClone(store.get('slot',slot.id).save);assert.equal(indexDiaries(store,slot.id),0);assert.equal(store.list('memory').length,0);assert.deepEqual(store.get('slot',slot.id).save,before);
});

test('较早事件可跨新会话检索，保留6000字日记且已有会话前缀不变', t => {
  const { store, slot, profile, session } = setup(t);
  store.importSave(fixture(5, [{ diaryId: 'early', content: '我们在青海湖约定每年一起旅行。' }, { diaryId: 'long', content: '晚'.repeat(7000) }]), slot.id);
  rememberChat(store,slot.id,session.id,'我们约好每年去青海湖旅行。','我答应你。');
  const old = structuredClone(requestMessages(store, session));
  const next = createSession(store, slot.id, profile, TOOLS);
  assert.ok(next.system.find(m=>m.content.startsWith('参考日记')).content.includes('晚'.repeat(6000))); assert.ok(!next.system.find(m=>m.content.startsWith('参考日记')).content.includes('晚'.repeat(6001)));
  assert.match(searchMemories(store, slot.id, '青海湖旅行')[0].content, /青海湖/);
  assert.deepEqual(requestMessages(store, session), old);
});
test('日记写入仅保存日记，不产生派生记忆', async t => {
  const { store, slot, session } = setup(t); const agent = new Agent(store, () => '', async () => answer('今天一起去了植物园，还约好下周看兰花。'));
  await agent.run(session.id, DIARY_REQUEST, () => {}, { diary: true });
  assert.equal(store.list('memory').length,0);assert.equal(store.get('slot',slot.id).save.data.diary.length,1);
});
test('丢弃当前会话清除本次记忆、历史与usage，其他会话、日记和文件不变', async t => {
  const { store, root, slot, session, profile } = setup(t); const other = createSession(store, slot.id, profile, TOOLS);
  const keep = saveMemory(store, { slotId: slot.id, sessionId: other.id, content: '一直喜欢兰花', source: '用户说' });
  const bad = saveMemory(store, { slotId: slot.id, sessionId: session.id, content: '错误的聊天走向', source: '本次' });
  store.append(session.id, { role: 'user', content: '删除的内容' }); store.usage(session.id, { input: 10 });
  writeFileSync(join(root, 'files', 'keep.txt'), '产出保留');
  const agent = new Agent(store, () => ''); await agent.remove(session.id, true);
  assert.equal(store.get('session', session.id), null); assert.equal(store.messages(session.id).length, 0); assert.equal(store.usages(session.id).length, 0);
  assert.equal(store.get('memory', bad.id), null); assert.ok(store.get('memory', keep.id)); assert.ok(store.get('session', other.id)); assert.equal(readFileSync(join(root, 'files', 'keep.txt'), 'utf8'), '产出保留'); assert.equal(store.get('slot', slot.id).save.data.diary.length, 0);
});
test('生成中丢弃会终止模型，延迟响应不复活聊天、不生成日记', async t => {
  const { store, session } = setup(t); let started;
  const ready = new Promise(r => { started = r; });
  const agent = new Agent(store, () => '', async (p, k, m, tools, signal) => { started(); await new Promise(r => signal.addEventListener('abort', r, { once: true })); return answer('取消后到达的内容'); });
  const run = agent.run(session.id, '开始'); await ready;
  const removed = agent.remove(session.id, true); await assert.rejects(run, /已停止/); await removed;
  assert.equal(store.get('session', session.id), null); assert.equal(store.messages(session.id).length, 0); assert.equal(store.list('diary').length, 0);
});
test('删除往期只清聊天，保留日记、事件及其来源；忘记事件后不自动复活', async t => {
  const { store, slot, session } = setup(t); const agent = new Agent(store, () => '', async () => answer('我们约好下周再去植物园。'));
  rememberChat(store,slot.id,session.id,'明天去出差','我答应冬天带你旅行。');
  await agent.run(session.id, DIARY_REQUEST, () => {}, { diary: true }); const original = structuredClone(store.get('slot', slot.id).save);
  await agent.remove(session.id, false); assert.deepEqual(store.get('slot', slot.id).save, original); assert.equal(store.list('memory').length, 1);
  for(const m of store.list('memory'))forgetMemory(store,m.id);assert.equal(indexDiaries(store,slot.id),0);assert.equal(store.list('memory').length,0);
});
test('首次补空槽幂等，已有不同文件也绝不覆盖；占位空间先备份', async t => {
  const { store, slot } = setup(t); const sync = new SyncService(store); await sync.start(0); t.after(() => sync.stop());
  const url = `http://127.0.0.1:${sync.port}`;
  const pair = await (await fetch(url + '/v1/pair', { method: 'POST', body: JSON.stringify({ code: sync.info().pairingCode }) })).json();
  const headers = { Authorization: `Bearer ${pair.token}` }, post = (n, save) => fetch(`${url}/v1/bootstrap/${n}`, { method: 'POST', headers, body: JSON.stringify({ save }) });
  const original = structuredClone(store.get('slot', slot.id)); const other = fixture(5); other.data.gameData.playerProgress.coins = 999;
  assert.equal((await (await post(5, other)).json()).filled, false); assert.deepEqual(store.get('slot', slot.id), original);
  assert.equal((await (await post(2, fixture(2))).json()).filled, true); assert.equal((await (await post(2, fixture(2))).json()).filled, false);
  const list = await (await fetch(url + '/v1/slots', { headers })).json(); assert.equal(list.filter(x => x.phoneSlot === 2 && x.occupied).length, 1);
  assert.equal((await post(3, fixture(4))).status, 400);
  const empty = store.createSlot('新空间'); assert.equal(hasSaveFile(empty.save), false);
});
