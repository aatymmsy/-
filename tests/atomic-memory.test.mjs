import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../src/store.mjs';
import { indexDiaries, saveMemory, forgetMemory } from '../src/memory.mjs';
import { portableMemory, reconcile } from '../src/auto-sync.mjs';
import { normalizeUsage, usageSummary } from '../src/provider.mjs';
const e = globalThis.MeijuSyncEngine;
function setup(t, diary = []) {
  const root = mkdtempSync(join(tmpdir(), 'meiju-atomic-')), store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const slot = store.importSave({ version: '1.0.0', slotId: 5, data: { gameData: { version: '1.0.0', timeSystem: { currentDay: 5 } }, diary, prompts: {} } });
  return { store, slot };
}
test('两端共用短条规则：聊天提取短条，每条120字以内，长事实拆分不省略', () => {
  const long = '我们约好周末一起去植物园看兰花。' + '她把窗帘拉上，'.repeat(40) + '记住，下次带相机。';
  const notes = e.chatNotes(long,'').map(m=>m.content); assert.ok(notes.length <= 3 && notes.every(s => typeof s === 'string' && s.length <= 120)); assert.ok(!notes.includes(long));
  const fact = '我喜欢植物园，'.repeat(40), records = e.mergeMemories({ records: [{ key: 'legacy', content: fact, kind: 'fact' }] }).records;
  assert.equal(records.map(m => m.content).join(''), fact); assert.ok(records.every(m => m.parentKey === 'legacy' && m.content.length <= 120));
  assert.deepEqual(e.mergeMemories({ records }).records, records);
});
test('停止日记索引并清理旧派生条目，原日记/存档完全不改', t => {
  const diary = { diaryId: 'one', timestamp: 1, content: '今天一起去看了兰花。' + '沿路的天气很好。'.repeat(60) + '约好明年再来。' };
  const { store, slot } = setup(t, [diary]), before = structuredClone(slot.save);
  const key = `diary:${hash({ id: 'one', timestamp: 1, content: diary.content })}`;
  store.put('memory', { id: 'legacy', slotId: slot.id, sourceKey: key, kind: 'event', content: diary.content });
  indexDiaries(store, slot.id); const rows = store.list('memory'); assert.equal(rows.length,0); assert.equal(store.get('memory', 'legacy'), null); assert.deepEqual(store.get('slot', slot.id).save, before);
  store.put('memory_tombstone', { id: `${slot.id}:${key}`, timestamp: 10 }); indexDiaries(store, slot.id); assert.equal(store.list('memory').length, 0); assert.deepEqual(store.get('slot', slot.id).save, before);
});
test('长事实的来源和会话保留，逐条忘记后旧端同步不会复活，父级忘记清除子条', t => {
  const { store, slot } = setup(t), content = '我最喜欢兰花，'.repeat(40);
  const saved = saveMemory(store, { slotId: slot.id, sessionId: 'session', sourceKey: 'long', source: '用户原话', content });
  const records = portableMemory(store, slot.id).records; assert.ok(records.length > 1); assert.equal(records.map(m => m.content).join(''), content); assert.ok(store.list('memory').every(m => m.sessionId === 'session' && m.source === '用户原话'));
  const gone = saved.records[0]; forgetMemory(store, gone.id);
  const old = structuredClone(slot.save); old.data.localMemory = { records: [{ key: 'long', kind: 'fact', content }] };
  reconcile(store, 5, { save: old, remoteId: slot.id, baseRevision: slot.revision }, 'phone');
  assert.ok(!store.list('memory').some(m => m.sourceKey === gone.sourceKey));
  store.put('memory_tombstone', { id: `${slot.id}:long`, timestamp: 20 }); indexDiaries(store, slot.id); assert.equal(store.list('memory').length, 0);
});
test('首条真实0%与未上报分开统计，下一条真实命中不覆盖历史或伪造首条', () => {
  const first = normalizeUsage({ prompt_tokens: 8000, prompt_cache_hit_tokens: 0 });
  const next = normalizeUsage({ prompt_tokens: 8100, prompt_cache_hit_tokens: 7900 });
  assert.equal(first.ratio, 0); assert.equal(first.reported, true);
  assert.equal(normalizeUsage({ prompt_tokens: 8000 }).ratio, null);
  const s = usageSummary([first, next]); assert.equal(s.ratio, 7900 / 16100); assert.equal(s.last.ratio, 7900 / 8100); assert.equal(first.ratio, 0);
});
