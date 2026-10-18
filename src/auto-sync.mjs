import '../public/sync-engine.js';
import { id, hasSaveFile, phoneSlotNumber, validateSave } from './store.mjs';
import { indexDiaries, saveMemory, forgetMemory } from './memory.mjs';
const engine = globalThis.MeijuSyncEngine;

export function portableMemory(store, slotId) {
  indexDiaries(store, slotId);
  const records = store.list('memory').filter(m => m.slotId === slotId && !m.sourceKey?.startsWith('diary:')).map(m => ({ key: m.sourceKey || `desktop:${m.id}`, parentKey: m.parentKey, content: m.content, kind: m.kind || 'fact', source: m.source, timestamp: m.timestamp }));
  const prefix = `${slotId}:`;
  const forgotten = store.list('memory_tombstone').filter(m => m.id.startsWith(prefix)).map(m => ({ key: m.id.slice(prefix.length), timestamp: m.timestamp }));
  return engine.mergeMemories({ records, forgotten });
}
function importMemory(store, slotId, bundle) {
  for (const m of bundle.forgotten) {
    const old = store.list('memory').find(row => row.slotId === slotId && row.sourceKey === m.key);
    if (old) forgetMemory(store, old.id);
    store.put('memory_tombstone', { id: `${slotId}:${m.key}`, timestamp: m.timestamp });
  }
  for (const m of bundle.records) saveMemory(store, { slotId, sourceKey: m.key, parentKey: m.parentKey, content: m.content, source: m.source || '双端同步记忆', kind: m.kind, timestamp: m.timestamp });
  indexDiaries(store, slotId);
}
export function reconcile(store, number, body, deviceId) {
  if (!Number.isInteger(number) || number < 1 || number > 10) throw new Error('同步槽位号无效');
  if (body.save != null) { validateSave(body.save); if (body.save.slotId !== number || !hasSaveFile(body.save)) throw new Error('来源槽位号不匹配或为空'); }
  return store.transaction(() => {
    const occupied = store.list('slot').filter(s => phoneSlotNumber(s) === number && hasSaveFile(s.save));
    if (occupied.length > 1) throw new Error(`电脑槽位 ${number} 存在多个独立存档，已保留，需先在电脑区分槽位号`);
    const old = occupied[0];
    if (old ? body.remoteId !== old.id || body.baseRevision !== old.revision : body.remoteId != null || body.baseRevision != null) {
      const e = new Error('电脑存档在同步期间发生变化，请再次点击同步'); e.status = 409; throw e;
    }
    let pc = old ? structuredClone(old.save) : null;
    if (pc) pc.data.localMemory = engine.mergeMemories(pc.data.localMemory, portableMemory(store, old.id));
    const merged = engine.mergeSaves(pc, body.save || null, number);
    if (!merged.save) return { empty: true, number };
    const changedPC = !old || engine.stable(engine.meaningful(old.save)) !== engine.stable(engine.meaningful(merged.save));
    let next = old;
    if (changedPC) {
      const empty = !old && store.list('slot').find(s => phoneSlotNumber(s) === number && !hasSaveFile(s.save));
      if (old || empty) store.backup(old || empty, 'before-auto-sync');
      next = store.put('slot', { ...(old || empty || {}), id: old?.id || empty?.id || id(), phoneSlot: number, name: old?.name || empty?.name || `手机槽位 ${number}`, persona: old?.persona || '', personaKey: old?.personaKey || null,
        revision: id(), updatedAt: Date.now(), save: merged.save });
    }
    importMemory(store, next.id, merged.save.data.localMemory);
    const report = { number, base: merged.base, changedPC, recentDifferent: merged.recentDifferent, addedToPC: merged.addedToPC, addedToPhone: merged.addedToPhone, diaries: merged.save.data.diary.length };
    store.put('sync_receipt', { id: `${deviceId}:${number}`, ...report, timestamp: Date.now() });
    return { ...report, slotId: next.id, revision: next.revision, save: merged.save };
  });
}
