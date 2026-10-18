import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Approvals } from '../src/approvals.mjs';
import { createSession } from '../src/prompts.mjs';
import { executeTool, TOOLS } from '../src/tools.mjs';
import { Agent } from '../src/agent.mjs';
import { startApp } from '../src/server.mjs';

const call = (name, args) => ({ id:'operation', type:'function', function:{name, arguments:JSON.stringify(args)} });
const reply = (content, calls) => ({ message:{content, ...(calls ? {tool_calls:calls} : {})}, finish:'stop', usage:{input:10,cached:0,output:2,reported:true} });
const waitFor = async predicate => { for(let n=0;n<300;n++){const value=await predicate();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw new Error('未等到待确认操作'); };
function setup(t, permissions='ask') {
  const root=mkdtempSync(join(tmpdir(),'meiju-permissions-')),store=new Store(root),slot=store.createSlot();
  const session=createSession(store,slot.id,{permissions,workspace:join(root,'files'),model:'mock',maxContextChars:400000},TOOLS);
  const approvals=new Approvals(store);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const policy={authorize:operation=>approvals.request(session.id,operation)};
  return{root,store,slot,session,approvals,policy};
}

test('询问写入先等待，完整内容不变；一次批准执行一次，覆盖前备份',async t=>{
  const {root,store,session,approvals,policy}=setup(t),target=join(root,'files','result.txt');writeFileSync(target,'旧内容');
  const pending=executeTool(store,session,call('files_write',{path:'result.txt',content:'完整新内容\n第二行'}),undefined,false,policy);
  const entry=await waitFor(()=>approvals.list(session.id)[0]);assert.equal(readFileSync(target,'utf8'),'旧内容');assert.equal(entry.arguments.content,'完整新内容\n第二行');
  approvals.decide(entry.id,'approve');const result=await pending;assert.equal(readFileSync(target,'utf8'),'完整新内容\n第二行');assert.equal(readFileSync(result.backup,'utf8'),'旧内容');
  assert.throws(()=>approvals.decide(entry.id,'approve'),/已处理/);assert.equal(approvals.list(session.id).length,0);
  const next=executeTool(store,session,call('files_write',{path:'next.txt',content:'不得执行'}),undefined,false,policy);const denied=assert.rejects(next,/用户拒绝/);
  approvals.decide((await waitFor(()=>approvals.list(session.id)[0])).id,'deny');await denied;assert.equal(existsSync(join(root,'files','next.txt')),false);
});

test('目录内读取免询问，目录外读取需批准，没有确认入口时禁止执行',async t=>{
  const {root,store,session,approvals,policy}=setup(t);writeFileSync(join(root,'files','inside.txt'),'内部');writeFileSync(join(root,'outside.txt'),'外部');
  assert.equal((await executeTool(store,session,call('files_read',{path:'inside.txt'}),undefined,false,policy)).content,'内部');
  assert.equal(approvals.list(session.id).length,0);
  await assert.rejects(executeTool(store,session,call('files_write',{path:'none.txt',content:'x'})),/需要用户批准/);
  const pending=executeTool(store,session,call('files_read',{path:'../outside.txt'}),undefined,false,policy);
  const entry=await waitFor(()=>approvals.list(session.id)[0]);approvals.decide(entry.id,'approve');assert.equal((await pending).content,'外部');
});

test('任意shell命令都需确认；拒绝不启动命令，完全访问无需确认',async t=>{
  const {root,store,session,approvals,policy}=setup(t);const command=process.platform==='win32'?"Set-Content -LiteralPath 'marker.txt' -Value 'done'":"printf done > marker.txt";
  const pending=executeTool(store,session,call('command_run',{command}),undefined,false,policy);const denied=assert.rejects(pending,/用户拒绝/);
  const entry=await waitFor(()=>approvals.list(session.id)[0]);assert.equal(entry.arguments.command,command);assert.equal(existsSync(join(root,'files','marker.txt')),false);
  approvals.decide(entry.id,'deny');await denied;assert.equal(existsSync(join(root,'files','marker.txt')),false);
  const allowed=executeTool(store,session,call('command_run',{command}),undefined,false,policy);approvals.decide((await waitFor(()=>approvals.list(session.id)[0])).id,'approve');assert.equal((await allowed).code,0);assert.match(readFileSync(join(root,'files','marker.txt'),'utf8'),/done/);
  session.profile.permissions='full';assert.equal((await executeTool(store,session,call('command_run',{command}),undefined,false,{authorize:()=>{throw Error('不应询问');}})).code,0);
});

test('路径链接不能伪装目录内读取；等待确认期间更换链接则取消',async t=>{
  const {root,store,session,approvals,policy}=setup(t);const outside=join(root,'outside'),other=join(root,'other'),link=join(root,'files','link');mkdirSync(outside);mkdirSync(other);
  writeFileSync(join(outside,'secret.txt'),'原文');writeFileSync(join(other,'secret.txt'),'不得读取');symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
  const pending=executeTool(store,session,call('files_read',{path:'link/secret.txt'}),undefined,false,policy);const rejected=assert.rejects(pending,/路径或链接发生变化/);
  const entry=await waitFor(()=>approvals.list(session.id)[0]);rmSync(link);symlinkSync(other,link,process.platform==='win32'?'junction':'dir');approvals.decide(entry.id,'approve');await rejected;
});

test('切为完全访问不自动批准等待项，切为工作目录可取消之前的外部授权',async t=>{
  const {root,store,session,approvals,policy}=setup(t);let mode='ask';policy.getPermissions=()=>mode;
  const pending=executeTool(store,session,call('files_write',{path:'a.txt',content:'x'}),undefined,false,policy);const entry=await waitFor(()=>approvals.list(session.id)[0]);
  mode='full';await new Promise(r=>setTimeout(r,25));assert.equal(approvals.list(session.id).length,1);assert.equal(existsSync(join(root,'files','a.txt')),false);approvals.decide(entry.id,'approve');await pending;
  mode='ask';const next=executeTool(store,session,call('files_write',{path:'../external.txt',content:'x'}),undefined,false,policy);const rejected=assert.rejects(next,/权限已切换/);
  const second=await waitFor(()=>approvals.list(session.id)[0]);mode='workspace';approvals.decide(second.id,'approve');await rejected;assert.equal(existsSync(join(root,'external.txt')),false);
});

test('停止和删除当前会话取消等待，不额外调用模型，不创建文件',async t=>{
  const {root,store,session,approvals}=setup(t);let requests=0;
  const agent=new Agent(store,()=>'',async()=>{requests++;return reply(null,[call('files_write',{path:'never.txt',content:'x'})]);},{getPermissions:()=> 'ask',approvals});
  const pending=agent.run(session.id,'生成文件');const rejected=assert.rejects(pending,/任务已停止/);
  await waitFor(()=>approvals.list(session.id)[0]);assert.equal(requests,1);agent.stop(session.id);await rejected;assert.equal(requests,1);assert.equal(existsSync(join(root,'files','never.txt')),false);assert.equal(approvals.list(session.id).length,0);
  const second=agent.run(session.id,'生成文件');const secondRejection=assert.rejects(second,/任务已停止/);await waitFor(()=>approvals.list(session.id)[0]);await agent.remove(session.id,true);await secondRejection;assert.equal(store.get('session',session.id),null);
});

test('旧的未决确认在重启后取消，不可重放',t=>{
  const {store}=setup(t);store.put('approval',{id:'old-pending',sessionId:'old-session',status:'pending',name:'command_run'});
  const next=new Approvals(store);assert.equal(store.get('approval','old-pending').status,'cancelled');assert.throws(()=>next.decide('old-pending','approve'),/已处理/);
});

test('未批准的确认15分钟后过期；不会隐式执行',async t=>{
  const {session,approvals}=setup(t);t.mock.timers.enable({apis:['setTimeout']});
  const pending=approvals.request(session.id,{name:'command_run',arguments:{command:'never run'}});const rejected=assert.rejects(pending,/已过期/);
  const entry=approvals.list(session.id)[0];t.mock.timers.tick(15*60*1000);await rejected;
  assert.equal(approvals.list(session.id).length,0);assert.throws(()=>approvals.decide(entry.id,'approve'),/已处理/);
});

test('升级保留已保存的完全访问选择，旧会话和原始存档无变化',async t=>{
  const root=mkdtempSync(join(tmpdir(),'meiju-permission-upgrade-'));let app;
  t.after(async()=>{await app?.close();rmSync(root,{recursive:true,force:true});});
  app=await startApp({root,port:0,syncPort:0});
  let token=(await(await fetch(app.url)).text()).match(/name="agent-token" content="([^"]+)"/)[1];
  const response=await fetch(app.url+'/api/config',{method:'POST',headers:{'X-Agent-Token':token},body:JSON.stringify({permissions:'full'})});assert.equal(response.status,200);
  const slots=JSON.stringify(app.store.list('slot'));await app.close();app=await startApp({root,port:0,syncPort:0});
  token=(await(await fetch(app.url)).text()).match(/name="agent-token" content="([^"]+)"/)[1];
  const state=await(await fetch(app.url+'/api/state',{headers:{'X-Agent-Token':token}})).json();assert.equal(state.config.permissions,'full');assert.equal(JSON.stringify(app.store.list('slot')),slots);
});

test('HTTP权限立即作用于旧会话；刷新恢复待确认项，鉴权及单次批准；关闭取消等待',async t=>{
  const root=mkdtempSync(join(tmpdir(),'meiju-permission-http-'));let requests=0;
  const app=await startApp({root,port:0,syncPort:0,callModel:async()=> ++requests%2===1?reply(null,[call('files_write',{path:'http.txt',content:'HTTP'} )]):reply('好了')});
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
  const token=(await(await fetch(app.url)).text()).match(/name="agent-token" content="([^"]+)"/)[1],headers={'X-Agent-Token':token};
  const get=async path=>(await fetch(app.url+'/api'+path,{headers})).json();
  const post=(path,body)=>fetch(app.url+'/api'+path,{method:'POST',headers,body:JSON.stringify(body)});
  const state=await get('/state');assert.equal(state.config.permissions,'ask');
  await post('/config',{permissions:'full'});const session=await(await post('/sessions',{slotId:state.slots[0].id})).json();assert.equal(session.profile.permissions,'full');
  await post('/config',{permissions:'ask'});const response=await post(`/sessions/${session.id}/run`,{text:'写文件'}),events=response.text();
  const waiting=await waitFor(async()=> (await get(`/sessions/${session.id}`)).approvals[0]);assert.equal(existsSync(join(root,'files','http.txt')),false);assert.equal(requests,1);
  assert.equal((await fetch(`${app.url}/api/approvals/${waiting.id}/decision`,{method:'POST',body:'{"decision":"approve"}'})).status,403);
  assert.equal((await post(`/approvals/${waiting.id}/decision`,{decision:'unknown'})).status,400);
  assert.equal((await post(`/approvals/${waiting.id}/decision`,{decision:'approve'})).status,200);assert.match(await events,/"type":"done"/);assert.equal(readFileSync(join(root,'files','http.txt'),'utf8'),'HTTP');
  assert.equal((await post(`/approvals/${waiting.id}/decision`,{decision:'approve'})).status,409);
  assert.equal((await get(`/sessions/${session.id}`)).profile.permissions,'full');
  const next=await post(`/sessions/${session.id}/run`,{text:'再写一次'}),nextEvents=next.text();await waitFor(async()=> (await get(`/sessions/${session.id}`)).approvals[0]);
  await app.close();assert.match(await nextEvents,/"status":"cancelled"/);assert.equal(requests,3);
});
