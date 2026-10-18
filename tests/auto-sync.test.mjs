import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { reconcile } from '../src/auto-sync.mjs';
import { saveMemory, forgetMemory } from '../src/memory.mjs';
import { createSession } from '../src/prompts.mjs';
import { TOOLS } from '../src/tools.mjs';
const e = globalThis.MeijuSyncEngine;
const diary = (content, timestamp, diaryId) => ({ content, timestamp, ...(diaryId ? { diaryId } : {}) });
const fixture = (n, diaries, coins = 100, timestamp = 1000) => ({ version: '1.0.0', slotId: n, timestamp: Date.now(), unknown: '保留', data: { gameData: { version: '1.0.0', timestamp, characterStats: { affection: 100 }, playerProgress: { coins }, characterSystemData: {}, timeSystem: { currentDay: 6 }, inventory: {}, shopSystem: {} }, diary: diaries, prompts: { 'sister-high': { data: { name: '小雪', description: '以存档人设正常聊天' } } }, extra: { keep: '原文' } } });
function setup(t) { const root = mkdtempSync(join(tmpdir(), 'auto-sync-')); const store = new Store(root); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return { root, store }; }

test('更多日记的完整存档作为主体，双端分支按生成时间插入，人设及未知字段保留', () => {
  const a = fixture(5, [diary('共同', 1), diary('PC独有', 4)], 10), b = fixture(5, [diary('共同', 1), diary('手机独有', 2), diary('手机后续', 3)], 99);
  const before = structuredClone([a, b]), r = e.mergeSaves(a, b, 5);
  assert.equal(r.base, 'phone'); assert.equal(r.save.data.gameData.playerProgress.coins, 99); assert.equal(r.addedToPC, 2); assert.equal(r.addedToPhone, 1);
  assert.deepEqual(r.save.data.diary.map(d => d.content), ['共同', '手机独有', '手机后续', 'PC独有']); assert.deepEqual(r.save.data.prompts, b.data.prompts); assert.deepEqual(r.save.data.extra, b.data.extra); assert.deepEqual([a, b], before);
});
test('日记数相同时比较生成时间，导出时间不算新进度', () => {
  const a = fixture(1, [diary('PC', '2026-10-17T10:00:00Z')], 10), b = fixture(1, [diary('手机', '2026-10-17T09:00:00Z')], 20); b.timestamp += 100000;
  assert.equal(e.mergeSaves(a, b, 1).base, 'pc');
});
test('最近五篇相同也检查更早分支；不漏掉较早不同内容', () => {
  const tail = Array.from({ length: 5 }, (_, i) => diary('共同' + i, 10 + i));
  const r = e.mergeSaves(fixture(2, [diary('PC早期', 1), ...tail]), fixture(2, [diary('手机早期', 2), ...tail]), 2);
  assert.equal(r.recentDifferent, false); assert.equal(r.save.data.diary.length, 7); assert.equal(r.addedToPC, 1); assert.equal(r.addedToPhone, 1);
});
test('相同时间/ID的不同正文均保留，自动生成不冲突的日记ID；精确相同正文只保留一份', () => {
  const a = [diary('版本甲', 1, 'same'), diary('共同', 2, 'a')], b = [diary('版本乙', 1, 'same'), diary('共同', 2, 'b')];
  const r = e.mergeDiaries(a, b); assert.equal(r.length, 3); assert.equal(new Set(r.map(d => d.diaryId)).size, 3);
  assert.deepEqual(e.mergeDiaries(r, a), r); assert.deepEqual(e.mergeDiaries(a, b), e.mergeDiaries(b, a));
});
test('完整合并重复执行稳定，数字和ISO时间都能排序；空记录保留', () => {
  const a = fixture(3, [diary('', 1, 'empty'), diary('甲', '2026-10-17T10:00:00Z')]);
  const b = fixture(3, [diary('乙', Date.parse('2026-10-17T11:00:00Z'))]);
  const one = e.mergeSaves(a, b, 3).save; assert.equal(one.data.diary.length, 3); assert.deepEqual(e.mergeSaves(one, a, 3).save.data.diary, one.data.diary); assert.deepEqual(e.mergeSaves(one, one, 3).save.data.diary, one.data.diary);
});
test('每槽位 CAS、空槽补齐、同步前备份，错误槽位和并发旧版本不写入', t => {
  const { store, root } = setup(t), s = store.importSave(fixture(5, [diary('旧', 1)]));
  const r = reconcile(store, 5, { save: fixture(5, [diary('旧', 1), diary('新', 2)]), remoteId: s.id, baseRevision: s.revision }, 'phone');
  assert.equal(r.save.data.diary.length, 2); assert.ok(readdirSync(join(root, 'backups')).length > 0); const after = structuredClone(store.get('slot', s.id));
  assert.throws(() => reconcile(store, 5, { save: fixture(5, []), remoteId: s.id, baseRevision: s.revision }, 'phone'), /发生变化/); assert.deepEqual(store.get('slot', s.id), after);
  assert.throws(() => reconcile(store, 2, { save: fixture(3, []) }, 'phone'), /不匹配/);
  assert.equal(reconcile(store, 2, { save: fixture(2, [diary('填空', 1)]) }, 'phone').save.slotId, 2);
  const same = reconcile(store, 5, { save: r.save, remoteId: s.id, baseRevision: r.revision }, 'phone'); assert.equal(same.changedPC, false); assert.equal(same.revision, r.revision);
});
test('重复编号的独立电脑存档不擅自选取；占位槽不会被当成有效存档', t => {
  const { store } = setup(t); store.createSlot(); const s = store.importSave(fixture(1, []));
  assert.ok(reconcile(store, 1, { save: fixture(1, [diary('手机', 1)]), remoteId: s.id, baseRevision: s.revision }, 'phone'));
  store.importSave(fixture(1, [])); assert.throws(() => reconcile(store, 1, { save: fixture(1, []) }, 'phone'), /多个独立存档/);
});
test('事实/事件记忆双向同步，忘记标记优先，旧副本不能复活；原会话前缀固定', t => {
  const { store } = setup(t), s = store.importSave(fixture(5, []));
  const keep = saveMemory(store, { slotId: s.id, content: 'PC喜欢兰花', sourceKey: 'pc-fact' });
  const gone = saveMemory(store, { slotId: s.id, content: '不再记住', sourceKey: 'forgot' }); forgetMemory(store, gone.id);
  const session = createSession(store, s.id, { baseURL: 'http://localhost:1/v1', model: 'test', workspace: '.', permissions: 'workspace' }, TOOLS), before = structuredClone(session.system);
  const mobile = fixture(5, [diary('一起赏兰花', 1)]); mobile.data.localMemory = { records: [{ key: 'mobile-fact', content: '手机约好周末旅行', kind: 'event', timestamp: 10 }, { key: 'forgot', content: '不再记住', kind: 'fact', timestamp: 20 }] };
  const r = reconcile(store, 5, { save: mobile, remoteId: s.id, baseRevision: s.revision }, 'phone');
  assert.ok(r.save.data.localMemory.records.some(m => m.key === keep.sourceKey)); assert.ok(!r.save.data.localMemory.records.some(m => m.key === 'forgot')); assert.ok(store.list('memory').some(m => m.sourceKey === 'mobile-fact'));
  assert.deepEqual(store.get('session', session.id).system, before); assert.equal(store.list('memory').filter(m => m.sourceKey === 'mobile-fact').length, 1);
});
