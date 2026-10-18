import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createSession } from '../src/prompts.mjs';
import { prepareContext } from '../src/context.mjs';
import { Agent, DIARY_REQUEST } from '../src/agent.mjs';
import { TOOLS } from '../src/tools.mjs';

test('new sessions reuse rules, persona and environment before changed diaries and memories', t => {
  const root = mkdtempSync(join(tmpdir(), 'perch-cache-')), store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const slot = store.createSlot(), profile = { model: 'mock', workspace: join(root, 'files'), permissions: 'ask', maxContextChars: 400000 };
  store.updatePersona(slot.id, '你叫小栖，喜欢电影和散步。');
  const first = createSession(store, slot.id, profile, TOOLS);
  const original = structuredClone(first);
  store.addDiary(slot.id, '今天聊了电影。', 'fixture-diary');
  store.put('memory', { id: 'fixture-memory', slotId: slot.id, content: '用户喜欢喜剧。', timestamp: 1 });
  const next = createSession(store, slot.id, profile, TOOLS);
  const a = prepareContext(store, first).messages, b = prepareContext(store, next).messages;
  assert.deepEqual(a.slice(0, 5), b.slice(0, 5));
  assert.notDeepEqual(a[5], b[5]);
  assert.notDeepEqual(a[6], b[6]);
  assert.deepEqual(first, original);
  assert.deepEqual(first.tools, next.tools);
  assert.deepEqual(prepareContext(store, next, { diary: true }).messages, b);
  assert.ok(!JSON.stringify(b).includes(next.id));
});

test('first turn makes one real request; next turn preserves the complete sent prefix', async t => {
  const root = mkdtempSync(join(tmpdir(), 'perch-cache-')), store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const slot = store.createSlot(), session = createSession(store, slot.id, { model: 'mock', workspace: root, permissions: 'ask', maxContextChars: 400000 }, TOOLS);
  const requests = [];
  const agent = new Agent(store, () => '', async (p, k, messages) => {
    requests.push(structuredClone(messages));
    return { message: { content: '一起聊一聊。' }, finish: 'stop', usage: { input: 100, cached: 0, output: 5, reported: true, ratio: 0 } };
  });
  await agent.run(session.id, '你好');
  assert.equal(requests.length, 1);
  assert.equal(store.usages(session.id)[0].cached, 0);
  await agent.run(session.id, '接着说');
  assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0]);
  await agent.run(session.id, DIARY_REQUEST, () => {}, { diary: true });
  assert.deepEqual(requests[2].slice(0, requests[1].length), requests[1]);
});
