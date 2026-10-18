import { hash, id } from './store.mjs';
import '../public/sync-engine.js';
const engine = globalThis.MeijuSyncEngine;

const tokens = text => {
  const runs = String(text).normalize('NFKC').toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]+/g) || [];
  return [...new Set(runs.flatMap(s => /^[\u3400-\u9fff]+$/.test(s) ? s.length === 1 ? [s] : Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)) : [s]))];
};
export function searchMemories(store, slotId, query, limit = 8) {
  const entries = store.list('memory').filter(m => m.slotId === slotId), terms = tokens(query);
  if (!terms.length) return [];
  const docs = entries.map(m => ({ m, terms: tokens(m.content) }));
  const frequency = new Map();
  for (const doc of docs) for (const term of doc.terms) frequency.set(term, (frequency.get(term) || 0) + 1);
  const ranked = docs.map(({ m, terms: words }) => {
    let score = 0, matched = 0;
    for (const term of terms) if (words.includes(term)) {
      const df = frequency.get(term) || 0;
      score += Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)); matched++;
    }
    if (m.content.toLowerCase().includes(String(query).toLowerCase())) score += 3;
    return { ...m, score: score * (matched / terms.length) / (1 + Math.log(1 + words.length) / 12) };
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
  return ranked.slice(0, limit).map(m => ({ ...m, content: m.content.slice(0, 2500), truncated: m.content.length > 2500, related: [...new Set([m.previousId, ...(m.relatedIds || [])])].map(key => entries.find(e => e.id === key)).filter(Boolean).slice(0, 2).map(e => ({ id: e.id, content: e.content.slice(0, 400), source: e.source, timestamp: e.timestamp })) }));
}
export function saveMemory(store, { slotId, sessionId = null, content, source, kind = 'fact', sourceKey, parentKey, timestamp = Date.now(), diaryId = null }) {
  if (typeof content !== 'string' || !content.trim() || content.length > 20000) throw new Error('记忆内容应为 1–20000 字');
  if (!['fact', 'event'].includes(kind)) throw new Error('记忆类型应为 fact 或 event');
  const key = sourceKey || `manual:${sessionId}:${hash(content.trim())}`;
  const parts = engine.atomicRecord({ key, content, parentKey });
  if (parts.length !== 1 || parts[0].key !== key) {
    const records = parts.map(part => saveMemory(store, { slotId, sessionId, content: part.content, source, kind, sourceKey: part.key, parentKey: part.parentKey, timestamp, diaryId })).filter(Boolean);
    return records.length ? { ...records[0], records } : null;
  }
  const existing = store.list('memory').find(m => m.slotId === slotId && m.sourceKey === key);
  if (existing) return existing;
  if (store.get('memory_tombstone', `${slotId}:${key}`) || parentKey && store.get('memory_tombstone', `${slotId}:${parentKey}`)) return null;
  const previous = store.list('memory').filter(m => m.slotId === slotId && m.kind === kind).at(-1);
  const relatedIds = searchMemories(store, slotId, content, 2).map(m => m.id);
  return store.put('memory', { id: id(), slotId, sessionId, content: content.trim(), source: String(source || '会话中明确记录'), sourceKey: key, parentKey, kind, timestamp, diaryId, previousId: previous?.id || null, relatedIds });
}
export function indexDiaries(store, slotId) {
  const slot = store.get('slot', slotId); if (!slot) throw new Error('槽位不存在');
  // Replace legacy full-diary indexes, never delete or edit the source diaries.
  const removed = new Set();
  const tombstones = new Set(store.list('memory_tombstone').map(m => m.id));
  for (const row of store.list('memory').filter(m => m.slotId === slotId)) {
    const normalized=engine.normalizeChatRecord({...row,key:row.sourceKey});
    if(!normalized){store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('memory',row.id);removed.add(row.id);continue;}
    if(normalized.content!==row.content){row.content=normalized.content;row.source=normalized.source;store.put('memory',row);}
    if (tombstones.has(`${slotId}:${row.sourceKey}`) || row.parentKey && tombstones.has(`${slotId}:${row.parentKey}`)) {
      store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('memory', row.id); removed.add(row.id); continue;
    }
    const legacyDiary = row.sourceKey?.startsWith('diary:');
    if (!legacyDiary && row.content.length <= engine.MEMORY_LIMIT && !/[\r\n]/.test(row.content)) continue;
    store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('memory', row.id); removed.add(row.id);
    if (!legacyDiary) saveMemory(store, row);
  }
  for (const row of store.list('memory')) if (removed.has(row.previousId) || row.relatedIds?.some(key => removed.has(key))) store.put('memory', { ...row, previousId: removed.has(row.previousId) ? null : row.previousId, relatedIds: (row.relatedIds || []).filter(key => !removed.has(key)) });
  return 0;
}
export function forgetMemory(store, memoryId) {
  const memory = store.get('memory', memoryId); if (!memory) throw new Error('记忆不存在');
  if (memory.sourceKey) store.put('memory_tombstone', { id: `${memory.slotId}:${memory.sourceKey}`, timestamp: Date.now() });
  store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('memory', memoryId);
  for (const next of store.list('memory')) if (next.previousId === memoryId || next.relatedIds?.includes(memoryId)) store.put('memory', { ...next, previousId: next.previousId === memoryId ? null : next.previousId, relatedIds: (next.relatedIds || []).filter(key => key !== memoryId) });
}
export function migrateMemories(store) {
  return store.transaction(() => {
    const legacy=store.list('memory').filter(m=>m.sourceKey?.startsWith('chat:')&&/说[：:]/.test(m.content));
    if(legacy.length&&!store.get('memory_migration_backup','persona-v1'))store.put('memory_migration_backup',{id:'persona-v1',timestamp:Date.now(),records:legacy});
    for (const slot of store.list('slot')) {
      const raw = slot.save.data.localMemory;
      if (raw) {
        const normalized = engine.mergeMemories(raw);
        if (engine.stable(raw) !== engine.stable(normalized)) {
          store.backup(slot, 'before-atomic-memory');
          const next = structuredClone(slot); next.save.data.localMemory = normalized; next.revision = id(); next.updatedAt = Date.now(); store.put('slot', next);
        }
      }
      indexDiaries(store, slot.id);
      for (const session of store.list('session').filter(s => s.slotId === slot.id)) {
        let user = null;
        for (const message of store.messages(session.id)) {
          if (message.role === 'user') user = /^请结束本次会话|^上条回复因输出长度/.test(engine.chatText(message.content)) ? null : message.content;
          if (user && message.role === 'assistant' && !message.tool_calls?.length) { rememberChat(store, slot.id, session.id, user, message.content, 0); user = null; }
        }
      }
    }
  });
}

export function rememberChat(store, slotId, sessionId, user, assistant, timestamp = Date.now()) {
  const slot = store.get('slot', slotId);
  const userName = slot?.save.data.gameData.playerInfo?.name || '用户';
  const notes = engine.chatNotes(user, assistant, { userName, timestamp });
  return notes.map(note => store.list('memory').find(m=>m.slotId===slotId&&m.sessionId===sessionId&&m.content===note.content) || saveMemory(store, { ...note, source:timestamp?note.source:'历史记录（时间不明） · '+note.source, slotId, sessionId, sourceKey: 'chat:' + hash({ sessionId, content: note.content }) })).filter(Boolean);
}
