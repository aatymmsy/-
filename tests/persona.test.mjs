import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePersona, personaChoices } from '../src/persona.mjs';
import { Store } from '../src/store.mjs';
import { createSession, SYSTEM } from '../src/prompts.mjs';
import { startApp } from '../src/server.mjs';

const keys = ['null', 'verylow', 'low', 'medium', 'high', 'dilei', 'kindergarten', 'tutor', 'kemonomimi', 'kemonomimi-cat'];
const fixture = (affection = 1000, outfit = 'outfit10') => ({ persona: '', save: { slotId: 5, data: {
  gameData: { currentOutfit: outfit, characterStats: { affection: 0 }, characterSystemData: { stats: { affection }, currentPersonaPackId: null } }, diary: [],
  prompts: Object.fromEntries(keys.map(key => [`sister-${key}`, { data: { name: 'Yuki', description: key === 'high' ? '我是小雪，这是当前角色的正文身份。' : `其他设定：${key}`, personality: `性格：${key}`, scenario: `场景：${key}`, creator_notes: `作者要求：${key}` } }]))
} } });

test('多卡导入依据存档当前状态，忽略首卡、过期元数据及对象顺序', () => {
  const slot = fixture(), result = resolvePersona(slot);
  assert.equal(Object.keys(slot.save.data.prompts)[0], 'sister-null');
  assert.equal(result.key, 'sister-high'); assert.equal(result.source, 'affection');
  for (const field of ['description', 'personality', 'scenario', 'creator_notes']) assert.ok(result.text.includes(slot.save.data.prompts['sister-high'].data[field]));
  assert.match(result.text, /小雪/); assert.doesNotMatch(result.text, /其他设定/);
  slot.save.data.prompts = Object.fromEntries(Object.entries(slot.save.data.prompts).reverse());
  assert.deepEqual(resolvePersona(slot), result);
  assert.equal(personaChoices(slot).length, 10);
});
test('好感度分段及旧存档备用字段与游戏一致', () => {
  for (const [a, key] of [[-31, 'verylow'], [-30, 'low'], [0, 'low'], [29, 'low'], [30, 'medium'], [69, 'medium'], [70, 'high'], [1000, 'high']]) assert.equal(resolvePersona(fixture(a)).key, `sister-${key}`);
  const slot = fixture(); delete slot.save.data.gameData.characterSystemData.stats;
  slot.save.data.gameData.characterStats.affection = 80;
  assert.equal(resolvePersona(slot).key, 'sister-high');
});
test('特殊服装优先于好感度；兽耳形态分开选择', () => {
  for (const [outfit, key] of [[13, 'dilei'], [14, 'kindergarten'], [15, 'tutor'], [16, 'low'], [17, 'medium'], [18, 'verylow'], [19, 'null'], [20, 'kemonomimi']]) {
    const result = resolvePersona(fixture(1000, `outfit${outfit}`));
    assert.equal(result.key, `sister-${key}`); assert.equal(result.source, 'outfit');
  }
  const slot = fixture(1000, 'outfit20'); slot.save.data.gameData.characterSystemData.kemonomimiCatForm = true;
  assert.equal(resolvePersona(slot).key, 'sister-kemonomimi-cat');
});
test('人工覆盖和选卡优先，缺卡及不完整多卡状态明确提示', () => {
  const slot = fixture(); slot.personaKey = 'sister-medium';
  assert.equal(resolvePersona(slot).key, 'sister-medium');
  slot.persona = '自定义双人角色，由 B 写日记';
  assert.equal(resolvePersona(slot).text, slot.persona);
  slot.persona = ''; slot.personaKey = null;
  delete slot.save.data.prompts['sister-high']; assert.match(resolvePersona(slot).error, /sister-high/);
  const unknown = fixture(); unknown.save.data.gameData = {};
  assert.equal(resolvePersona(unknown).source, 'unresolved'); assert.ok(resolvePersona(unknown).error);
  unknown.save.data.prompts = { custom: { description: '唯一角色' } };
  assert.equal(resolvePersona(unknown).key, 'custom');
  unknown.save.data.gameData.characterSystemData = { currentPersonaPackId: 'missing-pack' };
  assert.match(resolvePersona(unknown).error, /missing-pack/);
});
test('正常聊天没有内置工作身份，正确人设进入新快照，旧会话及原存档保留', t => {
  const root = mkdtempSync(join(tmpdir(), 'meiju-persona-')), store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const save = fixture().save, original = structuredClone(save), slot = store.importSave(save);
  const config = { model: 'test', workspace: root, permissions: 'full' }, a = createSession(store, slot.id, config, []);
  assert.equal(a.personaKey, 'sister-high'); assert.match(a.system.find(m=>m.content.startsWith('本会话人设')).content, /小雪/);
  assert.doesNotMatch(SYSTEM, /你是用户的桌面助手|以桌面助手身份工作/);
  assert.match(SYSTEM, /用户提出具体工作需求时/);
  store.append(a.id, { role: 'user', content: '旧消息' });
  store.updatePersona(slot.id, '', undefined, 'sister-medium');
  const b = createSession(store, slot.id, config, []);
  assert.equal(b.personaKey, 'sister-medium'); assert.equal(store.get('session', a.id).prefixHash, a.prefixHash);
  assert.equal(store.messages(a.id)[0].content, '旧消息'); assert.deepEqual(store.get('slot', slot.id).save, original);
  assert.throws(() => store.updatePersona(slot.id, '', undefined, 'not-a-card'));
  store.updatePersona(slot.id, '旧覆盖'); store.importSave(save, slot.id);
  assert.equal(store.get('slot', slot.id).persona, ''); assert.equal(store.get('slot', slot.id).personaKey, null);
  assert.ok(readdirSync(join(root, 'backups')).length >= 3);
});
test('HTTP 导入解析、预览、手动选卡及返回自动选择，导出无损', async t => {
  const root = mkdtempSync(join(tmpdir(), 'meiju-persona-http-')), app = await startApp({ root, port: 0, syncPort: 0 });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const token = (await (await fetch(app.url)).text()).match(/name="agent-token" content="([^"]+)"/)[1];
  const api = async (path, body) => {
    const r = await fetch(`${app.url}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Agent-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const save = fixture().save, imported = await api('/import', { save }), id = imported.body.id;
  const preview = await api(`/slots/${id}/persona`);
  assert.equal(preview.body.current.key, 'sister-high'); assert.equal(preview.body.choices.length, 10);
  assert.equal((await api(`/slots/${id}/persona?key=sister-medium`)).body.card.key, 'sister-medium');
  assert.equal((await api(`/slots/${id}/persona?key=absent`)).status, 400);
  await api(`/slots/${id}/persona`, { persona: '', personaKey: 'sister-medium' });
  assert.equal((await api('/sessions', { slotId: id })).body.personaKey, 'sister-medium');
  await api(`/slots/${id}/persona`, { persona: '', personaKey: '' });
  assert.equal((await api('/sessions', { slotId: id })).body.personaKey, 'sister-high');
  assert.deepEqual((await api(`/slots/${id}/export`)).body, save);
  const unresolved = fixture().save; unresolved.data.gameData = {};
  const u = (await api('/import', { save: unresolved })).body.id;
  assert.equal((await api('/sessions', { slotId: u })).status, 400);
  assert.equal((await api('/state')).body.slots.find(s => s.id === u).personaInfo.source, 'unresolved');
});
