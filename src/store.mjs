import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validatePersonaKey } from './persona.mjs';

export const id = () => randomUUID();
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const hasSaveFile = save => Boolean(save?.data && (Object.keys(save.data.gameData || {}).some(k => k !== 'version') || save.data.diary?.length || Object.keys(save.data.prompts || {}).length));
export const phoneSlotNumber = slot => slot.phoneSlot ?? slot.save?.slotId;
export function atomicJSON(path, value) {
  const temp = `${path}.${id()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
  try { chmodSync(path, 0o600); } catch {}
}
export function validateSave(save) {
  if (!save || typeof save !== 'object' || Array.isArray(save) || !save.data?.gameData || typeof save.data.gameData !== 'object' || Array.isArray(save.data.gameData)) throw new Error('不是可识别的空间文件，原文件未改动');
  if (save.data.diary !== undefined && !Array.isArray(save.data.diary)) throw new Error('存档 diary 字段应为数组');
  if (save.data.diary?.some(d => !d || typeof d !== 'object' || (d.content != null && typeof d.content !== 'string'))) throw new Error('存档中的日记格式无效');
  if (save.data.prompts != null && (typeof save.data.prompts !== 'object' || Array.isArray(save.data.prompts))) throw new Error('存档 prompts 字段应为对象');
  return save;
}
export class Store {
  constructor(root) {
    this.root = root;
    for (const sub of ['', 'backups', 'files']) mkdirSync(join(root, sub), { recursive: true });
    this.db = new DatabaseSync(join(root, 'agent.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_session ON messages(session,seq);
      CREATE TABLE IF NOT EXISTS usages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, json TEXT NOT NULL);`);
    for (const session of this.list('session')) if (session.status === 'running') this.put('session', { ...session, status: 'interrupted', error: '上次运行中断，可重试；已完成工具不会自动重做' });
  }
  close() { this.db.close(); }
  get(kind, key) { const r = this.db.prepare('SELECT json FROM docs WHERE kind=? AND id=?').get(kind, key); return r ? JSON.parse(r.json) : null; }
  list(kind) { return this.db.prepare('SELECT json FROM docs WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(r.json)); }
  put(kind, value) { this.db.prepare('INSERT INTO docs VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind, value.id, JSON.stringify(value)); return value; }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  append(session, message) { this.db.prepare('INSERT INTO messages(session,json) VALUES (?,?)').run(session, JSON.stringify(message)); }
  messages(session) { return this.db.prepare('SELECT json FROM messages WHERE session=? ORDER BY seq').all(session).map(r => JSON.parse(r.json)); }
  usage(session, usage) { this.db.prepare('INSERT INTO usages(session,json) VALUES (?,?)').run(session, JSON.stringify(usage)); }
  usages(session) { return this.db.prepare('SELECT json FROM usages WHERE session=? ORDER BY seq').all(session).map(r => JSON.parse(r.json)); }
  createSlot(name = '新存档') {
    const slotId = id();
    const used = new Set(this.list('slot').map(phoneSlotNumber));
    const phoneSlot = Array.from({ length: 10 }, (_, i) => i + 1).find(n => !used.has(n)) || null;
    return this.put('slot', { id: slotId, phoneSlot, name, revision: id(), updatedAt: Date.now(), persona: '', save: { version: '1.0.0', slotId: phoneSlot, data: { gameData: { version: '1.0.0' }, diary: [], prompts: {} } } });
  }
  backup(slot, reason) {
    const path = join(this.root, 'backups', `${slot.id}-${Date.now()}-${id()}.json`);
    atomicJSON(path, { reason, slot });
    return path;
  }
  importSave(save, slotId) {
    validateSave(save);
    const prior = slotId ? this.get('slot', slotId) : null;
    if (slotId && !prior) throw new Error('槽位不存在');
    if (prior) this.backup(prior, 'before-import');
    return this.put('slot', { id: prior?.id || id(), phoneSlot: prior ? phoneSlotNumber(prior) : save.slotId, name: prior?.name || `导入空间 ${save.slotId ?? '?'}`, revision: id(), updatedAt: Date.now(), persona: '', personaKey: null, save: structuredClone(save) });
  }
  fillMissingPhoneSlot(number, save) {
    if (!Number.isInteger(number) || number < 1 || number > 10 || save?.slotId !== number) throw new Error('同步槽位号不匹配');
    validateSave(save); if (!hasSaveFile(save)) throw new Error('来源槽位没有存档文件');
    return this.transaction(() => {
      const matches = this.list('slot').filter(s => phoneSlotNumber(s) === number);
      const existing = matches.find(s => hasSaveFile(s.save));
      if (existing) return { filled: false, occupied: true, slotId: existing.id };
      const empty = matches[0]; if (empty) this.backup(empty, 'before-first-pair-fill');
      const slot = this.put('slot', { ...(empty || {}), id: empty?.id || id(), phoneSlot: number, name: empty?.name || `导入空间 ${number}`, persona: empty?.persona || '', personaKey: empty?.personaKey || null, save: structuredClone(save), revision: id(), updatedAt: Date.now() });
      return { filled: true, slotId: slot.id, revision: slot.revision };
    });
  }
  updatePersona(slotId, persona, name, personaKey = undefined) {
    const slot = this.get('slot', slotId); if (!slot) throw new Error('槽位不存在');
    if (typeof persona !== 'string') throw new Error('人设应为文本');
    const key = personaKey === undefined ? slot.personaKey ?? null : personaKey || null;
    validatePersonaKey(slot, key);
    this.backup(slot, 'before-persona');
    return this.put('slot', { ...slot, persona, personaKey: key, name: name || slot.name, revision: id(), updatedAt: Date.now() });
  }
  addDiary(slotId, content, sessionId) {
    if (typeof content !== 'string' || !content.trim()) throw new Error('日记为空，未写入');
    return this.transaction(() => {
      const previous = this.list('diary').find(d => d.sessionId === sessionId);
      if (previous) return previous;
      const slot = this.get('slot', slotId); if (!slot) throw new Error('槽位不存在');
      this.backup(slot, 'before-diary');
      const diary = { id: id(), slotId, sessionId, content, timestamp: Date.now() };
      const next = structuredClone(slot);
      next.save.data.diary ??= [];
      next.save.data.diary.push({ diaryId: diary.id, timestamp: diary.timestamp, date: new Date(diary.timestamp).toLocaleDateString('zh-CN'), content, mode: 'desktop-agent' });
      next.revision = id(); next.updatedAt = Date.now();
      this.put('slot', next); this.put('diary', diary);
      return diary;
    });
  }
  syncSnapshot(slotId) {
    const s = this.get('slot', slotId); if (!s) throw new Error('槽位不存在');
    return { slotId: s.id, revision: s.revision, name: s.name, save: s.save, persona: s.persona, personaKey: s.personaKey ?? null };
  }
  pushSnapshot(slotId, baseRevision, payload, deviceId) {
    validateSave(payload.save);
    if (payload.persona !== undefined && typeof payload.persona !== 'string') throw new Error('同步人设应为文本');
    if (payload.personaKey !== undefined) validatePersonaKey({ save: payload.save }, payload.personaKey);
    return this.transaction(() => {
      const slot = this.get('slot', slotId); if (!slot) throw new Error('槽位不存在');
      if (slot.revision !== baseRevision) {
        const conflict = this.put('conflict', { id: id(), slotId, deviceId, baseRevision, currentRevision: slot.revision, payload, timestamp: Date.now() });
        return { conflict: conflict.id, revision: slot.revision };
      }
      this.backup(slot, 'before-sync');
      const next = this.put('slot', { ...slot, save: payload.save, persona: payload.persona ?? slot.persona, personaKey: payload.personaKey === undefined ? slot.personaKey ?? null : payload.personaKey || null, revision: id(), updatedAt: Date.now() });
      return { revision: next.revision };
    });
  }
}
