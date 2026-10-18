import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{Store}from'../src/store.mjs';import{rememberChat,migrateMemories}from'../src/memory.mjs';import{TOOLS}from'../src/tools.mjs';import{createSession}from'../src/prompts.mjs';import{Agent}from'../src/agent.mjs';import'../public/chat-display.js';
const e=globalThis.MeijuSyncEngine;
const response='恭喜呀，今晚庆祝一下。<记忆>[{"speaker":"小雪","text":"哥哥今天绘画得奖了，我替他开心。","kind":"event"},{"speaker":"小雨","text":"哥哥答应冬天带我穷游，我要记住这个约定。","kind":"event"}]</记忆>';
function setup(t){const root=mkdtempSync(join(tmpdir(),'meiju-persona-memory-')),store=new Store(root),slot=store.createSlot();t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return{store,slot,session:createSession(store,slot.id,{workspace:root,permissions:'workspace',model:'test',maxContextChars:400000},TOOLS)};}
test('双人人设各自署名，以角色自己的话记事实；无抽取模板且不重复保存用户原话',()=>{
 const notes=e.chatNotes('今天绘画得奖了，冬天带你穷游。',response);assert.equal(notes.length,2);assert.equal(notes[0].content,'小雪：哥哥今天绘画得奖了，我替他开心。');assert.equal(notes[1].source,'角色记忆 · 小雨');assert.ok(notes.every(m=>m.content.length<=120&&!m.content.includes('角色说')));
 assert.equal(e.stripMemory(response),'恭喜呀，今晚庆祝一下。');assert.ok(!JSON.stringify(globalThis.MeijuDisplay.parts(response)).includes('speaker'));
});
test('零碎动作/未说明对象/我叫您不会进入记忆；旧模板含糊记录不会从同步复活',()=>{
 for(const text of ['水好了我叫您，衣服我拿那件软的出来。','左肩归我，说好的。','小雪明天就去寻。'])assert.deepEqual(e.chatNotes(text,text),[]);
 assert.deepEqual(e.mergeMemories({records:[{key:'chat:old',content:'角色说：左肩归我，说好的。',kind:'event'}]}).records,[]);
 const row=e.mergeMemories({records:[{key:'chat:user',content:'哥哥（用户）说：明天要出差。',kind:'event'}]}).records[0];assert.equal(row.content,'哥哥：明天要出差。');
 const voiced={key:'chat:voice',content:'小雪：哥哥说：明天出差，我会想他。',kind:'event'};assert.equal(e.mergeMemories({records:[voiced]}).records[0].content,voiced.content);
});
test('不接受泛称角色或损坏的记忆标签，不在代码块内抽取，不自动猜测另一个人物',()=>{
 for(const r of ['<记忆>坏JSON</记忆>','<记忆>[{"speaker":"角色","text":"我答应了。"}]</记忆>','```xml\n'+response+'\n```'])assert.deepEqual(e.chatNotes('',r),[]);
 assert.equal(e.stripMemory('```xml\n'+response+'\n```'),'```xml\n'+response+'\n```');
});
test('迁移先保留旧记忆备份，清理泛称角色句，不改变人设、日记、原聊天，反复执行无重复',t=>{
 const{store,slot,session}=setup(t);store.append(session.id,{role:'user',content:'明天要出差。'});store.append(session.id,{role:'assistant',content:'小雪明天就去寻。'});
 store.put('memory',{id:'bad',slotId:slot.id,sessionId:session.id,sourceKey:'chat:old',content:'角色说：小雪明天就去寻。',source:'聊天原话 · 角色',kind:'event'});const save=structuredClone(store.get('slot',slot.id)),messages=store.messages(session.id);migrateMemories(store);migrateMemories(store);
 assert.equal(store.get('memory','bad'),null);assert.equal(store.list('memory').length,1);assert.ok(store.get('memory_migration_backup','persona-v1').records.some(m=>m.id==='bad'));assert.deepEqual(store.get('slot',slot.id),save);assert.deepEqual(store.messages(session.id),messages);
});
test('一次正常请求同时产出正文和角色记忆，隐藏元数据，不额外请求；纯记忆标签不当成功',async t=>{
 const{store,session}=setup(t);let calls=0;const agent=new Agent(store,()=>'',async()=>{calls++;return{message:{content:response},finish:'stop',usage:{}};});const r=await agent.run(session.id,'绘画得奖啦');assert.equal(calls,1);assert.equal(r.content,'恭喜呀，今晚庆祝一下。');assert.equal(store.list('memory').length,2);
 const other=createSession(store,session.slotId,session.profile,TOOLS);const blank=new Agent(store,()=>'',async()=>({message:{content:response.slice(response.indexOf('<记忆>'))},finish:'stop',usage:{}}));await assert.rejects(blank.run(other.id,'你好'),/连续返回空/);assert.equal(store.messages(other.id).length,1);
});
