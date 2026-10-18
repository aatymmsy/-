import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';import {createSession} from '../src/prompts.mjs';import {Agent} from '../src/agent.mjs';
import {prepareContext} from '../src/context.mjs';import {TOOLS,executeTool} from '../src/tools.mjs';
import '../public/chat-display.js';
function setup(t){const root=mkdtempSync(join(tmpdir(),'meiju-context-')),store=new Store(root),slot=store.createSlot();t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const profile={workspace:join(root,'files'),permissions:'workspace',model:'mock',historyChars:4000,maxContextChars:400000};return{root,store,session:createSession(store,slot.id,profile,TOOLS)};}
const toolCall=(name,args,id='call')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
test('旧工具正文和推理只在请求视图精简，当前工具顺序/推理完整；旧图可回查',async t=>{
 const {store,session}=setup(t);const image='data:image/png;base64,placeholder';
 store.append(session.id,{role:'user',content:[{type:'text',text:'请生成文件'},{type:'image_url',image_url:{url:image}}]});
 store.append(session.id,{role:'assistant',content:null,reasoning_content:'内部推理'.repeat(9000),tool_calls:[toolCall('files_write',{path:'work.txt',content:'正文'.repeat(30000)})]});
 store.append(session.id,{role:'tool',tool_call_id:'call',content:JSON.stringify({path:'work.txt',bytes:60000})});store.append(session.id,{role:'assistant',content:'已经写好了。'});
 store.append(session.id,{role:'user',content:'继续看看其他文件'});store.append(session.id,{role:'assistant',content:null,reasoning_content:'当次协议字段',tool_calls:[toolCall('files_read',{path:'work.txt'},'active')]});
 store.append(session.id,{role:'tool',tool_call_id:'active',content:'本轮原始数据'.repeat(300)});
 const before=JSON.stringify(store.messages(session.id)),view=prepareContext(store,session);
 assert.ok(view.stats.sentChars<10000);assert.ok(view.stats.sourceChars>60000);assert.equal(JSON.stringify(store.messages(session.id)),before);
 assert.equal(view.messages.at(-2).reasoning_content,'当次协议字段');assert.equal(view.messages.at(-1).content,'本轮原始数据'.repeat(300));assert.ok(!JSON.stringify(view.messages).includes('内部推理'.repeat(10)));
 const history=await executeTool(store,session,toolCall('history_read',{start:0,count:3,includeImage:true}));assert.equal(history.image,image);assert.ok(!JSON.stringify(history).includes('内部推理'.repeat(10)));assert.equal(store.messages(session.id).length,7);
});
test('预算按整轮分块收缩，留下余量；后续短聊天前缀稳定，原记录可分段回查',async t=>{
 const {store,session}=setup(t);
 for(let i=0;i<18;i++){store.append(session.id,{role:'user',content:'用户'+i+'原话'.repeat(100)});store.append(session.id,{role:'assistant',content:'回复'+i+'回答'.repeat(100)});}
 store.append(session.id,{role:'user',content:'最后的问题'});const one=prepareContext(store,session);assert.ok(one.stats.omittedMessages>0);assert.ok(one.stats.sentChars<8000);session.contextCut=one.stats.omittedMessages;
 store.append(session.id,{role:'assistant',content:'自然的回复'});store.append(session.id,{role:'user',content:'接着呢'});const two=prepareContext(store,session);assert.equal(two.stats.omittedMessages,one.stats.omittedMessages);assert.deepEqual(two.messages.slice(0,one.messages.length),one.messages);
 const history=await executeTool(store,session,toolCall('history_read',{start:0,count:2}));assert.match(history.messages[0].content,/用户0/);assert.equal(history.messages[0].index,0);assert.equal(history.total,39);
});
test('跨轮重读能恢复已精简的文件片段，同轮重复读不重传',async t=>{
 const {store,session,root}=setup(t);writeFileSync(join(root,'files','a.txt'),'详细原文'.repeat(500));const call=toolCall('files_read',{path:'a.txt'});
 store.append(session.id,{role:'user',content:'读取'});const first=await executeTool(store,session,call);store.append(session.id,{role:'tool',tool_call_id:'read',content:JSON.stringify(first)});
 assert.equal((await executeTool(store,session,call)).alreadyRead,true);store.append(session.id,{role:'assistant',content:'看完了'});store.append(session.id,{role:'user',content:'请再看细节'});assert.equal((await executeTool(store,session,call)).content,first.content);
});
test('角色心声折叠数据与内部推理严格分开，代码符号/用户原文不被改写',()=>{
 const raw='<think>内部工作规划</think><角色心声>有点期待和你一起做完。</角色心声>\n**已经做好了**\n- 放在桌面。\n```js\nconst x = "**";\n```';
 const parts=globalThis.MeijuDisplay.parts(raw);assert.ok(!JSON.stringify(parts).includes('内部工作规划'));assert.equal(parts.find(p=>p.kind==='heart').text,'有点期待和你一起做完。');assert.match(parts.find(p=>p.kind==='text').text,/已经做好了/);assert.ok(!parts.find(p=>p.kind==='text').text.includes('**'));assert.match(parts.find(p=>p.kind==='code').text,/"\*\*"/);assert.equal(globalThis.MeijuDisplay.parts('<think>未闭合的推理').length,0);
});
test('已存在的旧会话无需重建即可精简，保留旧快照及聊天，工具仍可使用',async t=>{
 const {store,session}=setup(t);delete session.promptVersion;session.tools=session.tools.filter(t=>t.function.name!=='history_read');store.put('session',session);
 store.append(session.id,{role:'user',content:'原有工作'});store.append(session.id,{role:'assistant',content:'原有答复',reasoning_content:'旧推理'.repeat(10000)});
 const system=JSON.stringify(session.system);let calls=0;
 const agent=new Agent(store,()=>'',async(p,k,m,tools)=>{calls++;assert.ok(!JSON.stringify(m).includes('旧推理'));assert.ok(tools.some(t=>t.function.name==='history_read'));assert.match(m[session.system.length].content,/当前人设原有的口吻/);return{message:{content:'嗯，我们继续聊。',reasoning_content:'新推理'},finish:'stop',usage:{input:5000,cached:4000,output:20,reported:true}};});
 await agent.run(session.id,'聊点别的');assert.equal(calls,1);assert.equal(JSON.stringify(store.get('session',session.id).system),system);assert.equal(store.messages(session.id)[1].reasoning_content,'旧推理'.repeat(10000));assert.equal(store.usages(session.id).at(-1).context.historyReasoningChars,30000);
});
