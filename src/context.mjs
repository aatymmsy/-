import { contentText, contextChars } from './images.mjs';
import '../public/sync-engine.js';
const memoryEngine=globalThis.MeijuSyncEngine;

import { STYLE } from './prompt-rules.mjs';
export { STYLE } from './prompt-rules.mjs';
export const isTurn = m => m.role === 'user' && !/^上条回复因输出长度|^这是文件工具/.test(contentText(m.content));
const clip = (text, n) => text.length > n ? text.slice(0, n) + '…[摘录，可回查]' : text;
function imageText(content) {
  return typeof content === 'string' ? content : (content || []).map(p => p.type === 'text' ? p.text : p.type === 'image_url' ? '[历史图片已保存，可通过history_read查看]' : '').join('\n');
}
// Completed operations keep receipts, not large generated file bodies or private reasoning.
function oldView(messages) {
  return messages.map(m => {
    if (m.role === 'tool') {
      let value; try { value = JSON.parse(m.content); } catch {}
      const receipt = value && !Array.isArray(value) ? Object.fromEntries(['path','offset','length','nextOffset','totalChars','modified','truncated','alreadyRead','bytes','artifactId','backup','code','error','imageAttached'].filter(k => value[k] !== undefined).map(k => [k,value[k]])) : {};
      receipt.excerpt = clip(m.content || '', 600);
      return { role:'tool', tool_call_id:m.tool_call_id, content:JSON.stringify(receipt) };
    }
    const row = { role:m.role, content:m.role==='assistant'?memoryEngine.stripMemory(imageText(m.content)):imageText(m.content) };
    if (m.tool_calls?.length) row.tool_calls = m.tool_calls.map(c => {
      let args;try { args = JSON.parse(c.function.arguments); } catch {}
      // Preserve the exact API tool-call structure, and explicitly mark omitted file payloads.
      if (args && typeof args.content === 'string' && args.content.length > 240) args = {...args,content:'[历史写入正文已保存在原文件及聊天记录，按需回查]'};
      return {...c,function:{...c.function,arguments:args?JSON.stringify(args):c.function.arguments}};
    });
    if (m.refusal) row.refusal = m.refusal;
    return row;
  });
}
export function prepareContext(store, session, { diary = false, permissions } = {}) {
  const raw = store.messages(session.id), boundary = raw.findLastIndex(isTurn), active = boundary < 0 ? raw : raw.slice(boundary);
  const earlier = boundary < 0 ? [] : raw.slice(0,boundary), groups = [];
  for (let i=0;i<earlier.length;i++) { if (!groups.length || isTurn(earlier[i])) groups.push({start:i,raw:[]}); groups.at(-1).raw.push(earlier[i]); }
  const budget = session.profile.historyChars || 12000;
  let omitted = Math.min(session.contextCut || 0, earlier.length);
  const pending = groups.filter(g=>g.start>=omitted).map(g=>({...g,view:oldView(g.raw)}));
  let used = contextChars(active)+pending.reduce((n,g)=>n+contextChars(g.view),0);
  // Compact in blocks, leaving headroom so the prefix stays stable for subsequent turns.
  if(used>budget)while(pending.length&&used>budget*.65){const group=pending.shift();used-=contextChars(group.view);omitted=group.start+group.raw.length;}
  const kept=pending.flatMap(g=>g.view);
  const excerpts=[];
  if (omitted) {
    const old=raw.slice(0,omitted);
    // Diary generation gets broader, bounded chronological excerpts of the whole session.
    const selected=old.map((m,i)=>({m,i})).filter(({m})=>m.role==='user'||m.role==='assistant'&&!m.tool_calls?.length);
    const limit=diary?6000:1800, per=Math.max(16,Math.min(320,Math.floor(limit/Math.max(1,selected.length))-30));
    let remaining=limit;
    for(const {m,i} of selected){const line=`#${i} ${m.role}: ${clip(imageText(m.content),per)}`;if(line.length>remaining)break;excerpts.push(line);remaining-=line.length;}
  }
  // New snapshots put reusable instructions before changing reference material.
  // Legacy snapshots retain their exact ordering until the user starts a new session.
  const system=session.promptVersion === 2 ? [...session.system] : [...session.system,{role:'system',content:STYLE}];
  if (permissions && permissions !== session.profile.permissions) system.push({role:'system',content:`当前工具权限已由用户切换为：${{ask:'操作前询问；写入文件、读取工作目录外文件、执行任何命令均需等待用户逐次批准',full:'完全访问；可在当前Windows账户权限内使用文件和命令工具',workspace:'仅工作目录内读写；禁止目录外访问及命令工具'}[permissions]}。旧快照中的权限说明以此为准；以工具实际返回为准，不得绕过用户拒绝的操作。`});
  if(!diary && session.promptVersion !== 2)system.push({role:'system',content:memoryEngine.MEMORY_INSTRUCTION});
  if (omitted) system.push({role:'system',content:`较早聊天的原文摘录（消息0–${omitted-1}，并非完整总结；原始记录可用history_read回查）：\n${excerpts.join('\n')}`});
  const messages=[...system,...kept,...active];
  return {messages,stats:{sourceChars:contextChars([...session.system,...raw]),sentChars:contextChars(messages),historyBudget:budget,omittedMessages:omitted,rawMessages:raw.length,historyReasoningChars:earlier.reduce((n,m)=>n+(typeof m.reasoning_content==='string'?m.reasoning_content.length:0)+(typeof m.reasoning==='string'?m.reasoning.length:0),0)}};
}
