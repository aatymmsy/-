/* Shared by Node and the Android WebView. No network, model calls or storage writes. */
(function (root) {
  'use strict';
  const clone = value => structuredClone(value);
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v;
  const stable = v => JSON.stringify(canonical(v));
  const time = value => {
    if (value == null || value === '') return 0;
    const n = typeof value === 'number' || /^\d{10,16}$/.test(value) ? Number(value) : Date.parse(value);
    return Number.isFinite(n) && n > 0 && n <= 8640000000000000 ? n : 0;
  };
  const diaryTime = d => time(d.timestamp) || time(d.generatedAt) || time(d.createdAt) || time(d.date);
  const fingerprint = text => {
    // Four independent 32-bit hashes for portable stable IDs; equality uses the full key.
    return [2166136261, 2246822519, 3266489917, 668265263].map(seed => {
      let h = seed; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
      return (h >>> 0).toString(16).padStart(8, '0');
    }).join('');
  };
  function cleanDiary(d) { const { id, slotId, ...rest } = clone(d); return rest; }
  function diaryKey(d) {
    return stable(d.content ? [diaryTime(d), d.content] : ['empty', cleanDiary(d)]);
  }
  const ordered = list => list.slice().sort((a, b) => diaryTime(a) - diaryTime(b) || diaryKey(a).localeCompare(diaryKey(b)));
  function mergeDiaries(a = [], b = []) {
    const groups = new Map();
    for (const raw of [...a, ...b]) {
      const d = cleanDiary(raw), key = diaryKey(d), prior = groups.get(key);
      // Keep complementary metadata, resolve conflicting metadata deterministically.
      if (!prior) groups.set(key, d);
      else groups.set(key, stable(prior) < stable(d) ? { ...prior, ...d } : { ...d, ...prior });
    }
    const result = ordered([...groups.values()]), identities = new Map();
    for (const d of result) if (d.diaryId != null) {
      const identity = String(d.diaryId), key = diaryKey(d);
      if (identities.has(identity) && identities.get(identity) !== key) d.diaryId = `${identity}:lan:${fingerprint(key)}`;
      identities.set(String(d.diaryId), key);
    }
    return result;
  }
  const MEMORY_LIMIT = 120;
  // One short statement per node. Splitting is lossless; no model calls or invented facts.
  function shortStatements(content) {
    const clauses = String(content).trim().match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
    const result = [];
    for (const clause of clauses) {
      let rest = clause.trim();
      while (rest.length > MEMORY_LIMIT) {
        const head = rest.slice(0, MEMORY_LIMIT);
        const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf('、'), head.lastIndexOf(' '));
        const end = cut >= MEMORY_LIMIT / 2 ? cut + 1 : MEMORY_LIMIT;
        result.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
      }
      if (rest) result.push(rest);
    }
    return result;
  }
  function atomicRecord(record) {
    if (record.content.trim().length <= MEMORY_LIMIT && !/[\r\n]/.test(record.content.trim())) return [{ ...record, content: record.content.trim() }];
    return shortStatements(record.content).map((content, i) => ({ ...record, key: `${record.key}:part:${String(i).padStart(4, '0')}:${fingerprint(content)}`, parentKey: record.parentKey || record.key, content }));
  }
  function memoryBundle(value) {
    const records = Array.isArray(value?.records) ? value.records : [], forgotten = Array.isArray(value?.forgotten) ? value.forgotten : [];
    if (records.some(m => !m || typeof m.key !== 'string' || !m.key || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 20000 || !['fact', 'event'].includes(m.kind))) throw new Error('本地记忆格式无效，未同步');
    if (forgotten.some(m => !m || typeof m.key !== 'string' || !m.key)) throw new Error('记忆删除标记无效，未同步');
    return { version: 3, records: records.filter(m => !m.key.startsWith('diary:')).map(normalizeChatRecord).filter(Boolean).flatMap(atomicRecord), forgotten };
  }
  function mergeMemories(a, b) {
    a = memoryBundle(a); b = memoryBundle(b);
    const dead = new Map(), rows = new Map();
    for (const m of [...a.forgotten, ...b.forgotten]) if (!dead.has(m.key) || time(m.timestamp) > time(dead.get(m.key).timestamp)) dead.set(m.key, clone(m));
    for (const m of [...a.records, ...b.records]) {
      if (dead.has(m.key) || m.parentKey && dead.has(m.parentKey)) continue;
      const old = rows.get(m.key);
      if (!old || time(m.timestamp) > time(old.timestamp) || time(m.timestamp) === time(old.timestamp) && stable(m) > stable(old)) rows.set(m.key, clone(m));
    }
    return { version: 3, records: [...rows.values()].sort((a, b) => time(a.timestamp) - time(b.timestamp) || a.key.localeCompare(b.key)), forgotten: [...dead.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  }
  const latestFive = save => ordered(save?.data?.diary || []).slice(-5).map(d => [diaryTime(d), d.content || '']);
  const count = save => (save?.data?.diary || []).filter(d => d.content?.trim()).length;
  const gameTime = save => time(save?.data?.gameData?.timestamp);
  function meaningful(save) {
    if (!save) return null;
    const v = clone(save); delete v.timestamp; delete v.exportDate;
    if (v.data) { v.data.diary = mergeDiaries(v.data.diary || []); v.data.localMemory = mergeMemories(v.data.localMemory); }
    return v;
  }
  function compare(a, b) {
    return count(a) - count(b) || (Math.max(0, ...(a.data.diary || []).map(diaryTime)) - Math.max(0, ...(b.data.diary || []).map(diaryTime)))
      || gameTime(a) - gameTime(b) || stable(meaningful(a)).localeCompare(stable(meaningful(b)));
  }
  function mergeSaves(pc, phone, slot) {
    if (!pc && !phone) return { save: null, base: null, recentDifferent: false, addedToPC: 0, addedToPhone: 0 };
    for (const save of [pc, phone]) if (save && (save.slotId !== slot || !save.data?.gameData || !Array.isArray(save.data.diary || []))) throw new Error('同步槽位号或存档结构不匹配');
    const base = !pc ? 'phone' : !phone ? 'pc' : compare(pc, phone) >= 0 ? 'pc' : 'phone';
    const save = clone(base === 'pc' ? pc : phone);
    save.slotId = slot;
    save.data.diary = mergeDiaries(pc?.data.diary, phone?.data.diary);
    save.data.localMemory = mergeMemories(pc?.data.localMemory, phone?.data.localMemory);
    return { save, base, recentDifferent: stable(latestFive(pc)) !== stable(latestFive(phone)),
      addedToPC: save.data.diary.length - mergeDiaries(pc?.data.diary).length,
      addedToPhone: save.data.diary.length - mergeDiaries(phone?.data.diary).length };
  }
  const terms = text => [...new Set((String(text).normalize('NFKC').toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]+/g) || []).flatMap(s => /^[\u3400-\u9fff]+$/.test(s) ? s.length === 1 ? [s] : Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)) : [s]))];
  function search(entries, query, limit = 8) {
    const words = terms(query); if (!words.length) return [];
    const docs = entries.map(m => ({ m, terms: terms(m.content) })), frequency = new Map();
    for (const doc of docs) for (const t of doc.terms) frequency.set(t, (frequency.get(t) || 0) + 1);
    return docs.map(({ m, terms: ts }) => {
      let score = 0, matched = 0;
      for (const t of words) if (ts.includes(t)) { const df = frequency.get(t); score += Math.log(1 + (docs.length - df + .5) / (df + .5)); matched++; }
      if (m.content.toLowerCase().includes(String(query).toLowerCase())) score += 3;
      return { ...m, score: score * matched / words.length / (1 + Math.log(1 + ts.length) / 12) };
    }).filter(m => m.score > 0).sort((a, b) => b.score - a.score || time(b.timestamp) - time(a.timestamp)).slice(0, limit);
  }
  const chatText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
  const MEMORY_INSTRUCTION = '只在本轮出现值得长期记住、已经明确的事件、承诺、偏好或重要关系变化时，在正常回复末尾附加<记忆>[{"speaker":"实际角色名","text":"角色用自己的口吻写的一条记忆","kind":"event"}]</记忆>，最多2条，每条最多100字。没有重要事实就不要附加。记忆以角色自己的感受和措辞表达，但必须明确谁、做了什么、时间及必要对象；避免指代不明的“我/她/那件/去寻”，不要把未完成计划当成事实。双人人设分别写真实角色名，不能写“角色”“助手”，无法确定归属则不要记。可用角色名开头的中立叙述表达不适合第一人称的事实。不记录临时取物、肢体动作、随口应答、片段台词或工作步骤。不得编造、补全未说明的对象。日记生成时只写日记正文，不附加标签。这些条目随正常回复一次生成，无需额外调用工具。';
  const stripMemory = value => String(value||'').split(/(```[\s\S]*?```)/g).map((part,i)=>i%2?part:part.replace(/<记忆>[\s\S]*?<\/记忆>/g,'').replace(/<记忆>[\s\S]*$/g,'')).join('');
  function personaNotes(value,timestamp){
    const text=chatText(value).replace(/```[\s\S]*?```/g,'');const result=[];
    for(const match of text.matchAll(/<记忆>([\s\S]*?)<\/记忆>/g))try{const rows=JSON.parse(match[1]);if(!Array.isArray(rows))continue;for(const row of rows.slice(0,2)){
      if(typeof row.speaker!=='string'||typeof row.text!=='string')continue;const name=row.speaker.trim(),body=row.text.trim();
      if(!name||name.length>20||/^(?:角色|助手|assistant|AI|模型|未知)$/i.test(name)||!body||body.length>100||/[<>\r\n]/.test(name+body))continue;
      result.push({content:name+'：'+body,kind:row.kind==='fact'?'fact':'event',source:'角色记忆 · '+name,timestamp});
    }}catch{}return result.slice(0,2);
  }
  function importantUser(text){
    if(text.length<4||text.length>96||/[？?]$|吗[。！!]?$/.test(text)||/(?:如果|假如|假设|例如|比如|示例|要是)/.test(text))return false;
    return /出差|搬家|搬到|入职|离职|升职|毕业|录取|考上|考试通过|生日|结婚|订婚|获奖|得奖|拿[到下了].{0,8}奖|画.{0,8}奖|住院|生病|手术/.test(text)
      || /(?:承诺|约定|答应|说好|约好).{0,30}(?:冬天|夏天|明年|周末|下周|旅行|旅游|穷游|结婚|出差|搬家|毕业)|(?:明天|下周|下个月|冬天|夏天|明年|周末).{0,30}(?:旅行|旅游|穷游|出发|见面|出差)/.test(text)
      || /(?:最喜欢|最讨厌|不喜欢|爱好|过敏)|我喜欢.{1,30}|我的名字(?:是|叫)|我叫(?!你|您|她|他|人|一声)[\u3400-\u9fffA-Za-z]{1,12}/.test(text)
      || /我.{0,8}爱你|最爱你|喜欢你|喜欢我|在一起.{0,8}(?:天|年|月)|纪念日/.test(text);
  }
  function normalizeChatRecord(record){
    if(!record.key?.startsWith('chat:'))return record;
    if(/^角色说[：:]/.test(record.content))return null;
    const old=record.content.match(/^(用户|[^：:\n]{1,30}（用户）)说[：:]([\s\S]*)$/);if(!old)return record;
    const text=old[2].trim();if(!importantUser(text))return null;
    return {...record,content:old[1].replace(/（用户）$/,'')+'：'+text,source:record.source?.replace('聊天原话','聊天事实')};
  }
  function chatNotes(user,assistant,{userName='用户',timestamp=Date.now()}={}){
    const voiced=personaNotes(assistant,timestamp);if(voiced.length)return voiced;
    const raw=chatText(user).replace(/```[\s\S]*?```/g,'').replace(/【可能相关的记忆[\s\S]*/g,'');
    return [...new Set(shortStatements(raw).filter(importantUser))].slice(0,2).map(text=>({content:(userName+'：'+text).slice(0,MEMORY_LIMIT),kind:/喜欢|讨厌|爱好|过敏|名字|我叫/.test(text)&&!/今天|明天|这次/.test(text)?'fact':'event',source:'用户明确事实 · '+userName,timestamp}));
  }
  root.MeijuSyncEngine = { MEMORY_INSTRUCTION, stripMemory, personaNotes, normalizeChatRecord, MEMORY_LIMIT, chatText, chatNotes, shortStatements, atomicRecord, canonical, stable, time, diaryTime, diaryKey, fingerprint, mergeDiaries, mergeMemories, latestFive, count, meaningful, mergeSaves, search };
})(globalThis);
