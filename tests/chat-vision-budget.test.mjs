import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {createSession,requestMessages} from '../src/prompts.mjs';
import {TOOLS,executeTool} from '../src/tools.mjs';
import {Agent,DIARY_REQUEST} from '../src/agent.mjs';
import {migrateMemories} from '../src/memory.mjs';
import {contextChars,validateImage} from '../src/images.mjs';
import {normalizeUsage,usageSummary} from '../src/provider.mjs';
const e=globalThis.MeijuSyncEngine;
const png='data:image/png;base64,'+readFileSync(new URL('../public/icon-256.png',import.meta.url)).toString('base64');
function setup(t){const root=mkdtempSync(join(tmpdir(),'meiju-chat-')),store=new Store(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const slot=store.createSlot();const profile={baseURL:'http://127.0.0.1:1/v1',model:'test',workspace:join(root,'files'),permissions:'workspace',maxContextChars:400000,maxTokens:8192};const session=createSession(store,slot.id,profile,TOOLS);return{root,store,slot,session,profile};}
const reply=content=>({message:{content},finish:'stop',usage:normalizeUsage({prompt_tokens:1000,prompt_cache_hit_tokens:800,completion_tokens:30})});
const call=(name,args,id='call')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
test('双方聊天关键信息：出差/获奖/冬天穷游/表达喜欢，问题与假设不记，带来源及时间',()=>{
 const notes=e.chatNotes('明天要出差。今天绘画得奖了！最喜欢你了！','开心~<记忆>[{"speaker":"小雪","text":"哥哥今天绘画得奖了，我替他开心！","kind":"event"},{"speaker":"小雨","text":"哥哥承诺冬天带我穷游，我很期待。","kind":"event"}]</记忆>',{userName:'哥哥',timestamp:123});
 assert.equal(notes.length,2);assert.ok(notes.every(m=>m.content.length<=120&&m.timestamp===123));assert.ok(notes.some(m=>m.content.includes('小雪：哥哥今天绘画得奖')));assert.ok(notes.some(m=>m.content.includes('小雨：哥哥承诺冬天带我穷游')));
 assert.deepEqual(e.chatNotes('如果我得奖就好了。你明天出差吗？','比如明年去旅行。'),[]);
});
test('正常聊天一次模型请求即可自动记住双方事件；日记不再次提取，删除当前会话一起丢弃',async t=>{
 const{store,slot,session}=setup(t);let requests=0;const agent=new Agent(store,()=>'',async()=>{requests++;return reply('我承诺冬天带你穷游。<记忆>[{"speaker":"小雪","text":"哥哥明天要出差。"},{"speaker":"小雪","text":"我承诺冬天带哥哥穷游。"}]</记忆>');});
 await agent.run(session.id,'明天要出差。');assert.equal(requests,1);assert.equal(store.list('memory').length,2);assert.ok(store.list('memory').every(m=>m.sessionId===session.id));
 await agent.remove(session.id,true);assert.equal(store.list('memory').length,0);assert.equal(store.get('slot',slot.id).save.data.diary.length,0);
});
test('迁移清除日记派生索引，只从保留的聊天回填；一兆存档不会进入模型完整上下文',t=>{
 const{store,slot,session,profile}=setup(t),s=structuredClone(slot);s.save.data.diary=[{content:'日'.repeat(1000000)}];store.put('slot',s);store.put('memory',{id:'derived',slotId:slot.id,sourceKey:'diary:old:note:x',content:'旧日记派生',kind:'event'});store.append(session.id,{role:'user',content:'今天绘画得奖了！'});store.append(session.id,{role:'assistant',content:'我答应冬天陪你旅行。'});
 const original=structuredClone(store.get('slot',slot.id).save),prefix=structuredClone(session.system);migrateMemories(store);migrateMemories(store);assert.equal(store.list('memory').length,1);assert.ok(store.list('memory').every(m=>m.sourceKey.startsWith('chat:')));assert.deepEqual(store.get('slot',slot.id).save,original);assert.deepEqual(store.get('session',session.id).system,prefix);
 const next=createSession(store,slot.id,profile,TOOLS),chars=contextChars(requestMessages(store,next));assert.ok(chars<11000);assert.ok(next.system.find(m=>m.content.startsWith('参考日记')).content.includes('日'.repeat(6000)));assert.match(next.system[0].content,/低权重背景/);
});
test('文件预览默认3000字，支持定位，重复内容不反复注入，日记工具总预算6000',async t=>{
 const{root,store,slot,session}=setup(t);writeFileSync(join(root,'files','big.txt'),'甲'.repeat(1000000));
 const a=await executeTool(store,session,call('files_read',{path:'big.txt'}));assert.equal(a.content.length,3000);assert.equal(a.totalChars,1000000);store.append(session.id,{role:'tool',tool_call_id:'first',content:JSON.stringify(a)});
 const b=await executeTool(store,session,call('files_read',{path:'big.txt'}));assert.equal(b.alreadyRead,true);assert.equal(b.content,undefined);const c=await executeTool(store,session,call('files_read',{path:'big.txt',offset:999900,length:100}));assert.equal(c.content.length,100);
 await assert.rejects(executeTool(store,session,call('files_read',{path:'big.txt',length:9000})),/8000/);
 const s=store.get('slot',slot.id);s.save.data.diary=[{content:'日'.repeat(10000)},{content:'记'.repeat(10000)}];store.put('slot',s);const diaries=await executeTool(store,session,call('diary_read',{}));assert.ok(diaries.reduce((n,d)=>n+d.content.length,0)<=6000);
});
test('上传与文件图片都以多模态image_url发送；工具结果顺序合法，重试/重启可恢复图片',async t=>{
 const{root,store,session}=setup(t);writeFileSync(join(root,'files','test.png'),Buffer.from(png.split(',')[1],'base64'));let n=0;
 const agent=new Agent(store,()=>'',async(p,k,m)=>{n++;if(n===1){assert.equal(m.at(-1).content[1].type,'image_url');assert.equal(m.at(-1).content[1].image_url.url,png);return{...reply(null),message:{content:null,tool_calls:[call('files_view_image',{path:'test.png'})]}};}assert.equal(m.at(-2).role,'tool');assert.equal(m.at(-1).content[1].image_url.url,png);return reply('我看到了图片。');});
 await agent.run(session.id,'看看图片',{call:0}?.emit||(()=>{}),{images:[png]});assert.equal(n,2);const messages=store.messages(session.id);assert.equal(messages[0].content[1].image_url.url,png);assert.equal(store.usages(session.id)[1].images,2);assert.ok(contextChars([{role:'user',content:[{type:'image_url',image_url:{url:png.repeat(100)}}]}])<200);
 assert.throws(()=>validateImage('data:image/svg+xml;base64,PHN2Zz4='));await assert.rejects(agent.run(session.id,'坏图片',()=>{},{images:['https://localhost/image.png']}),/图片/);
});
test('每轮汇总工具多次请求，区分缓存/未缓存/输出，未上报不作0',()=>{
 const a={...normalizeUsage({prompt_tokens:1000,prompt_cache_hit_tokens:800,completion_tokens:20}),turnId:'a'},b={...normalizeUsage({prompt_tokens:1100,prompt_cache_hit_tokens:1000,completion_tokens:30}),turnId:'a'};const s=usageSummary([a,b]);assert.equal(s.turn.requests,2);assert.equal(s.turn.input,2100);assert.equal(s.turn.uncached,300);assert.equal(s.turn.output,50);assert.equal(s.totalInput,2100);assert.equal(usageSummary([normalizeUsage({prompt_tokens:1200})]).turn.uncached,null);
});
