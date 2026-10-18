'use strict';
const $ = selector => document.querySelector(selector);
const token = $('meta[name="agent-token"]').content;
const deletingSessions = new Set();
let activeRun = null, startingRun = false;
const starter = MeijuConversationStarter;
let pendingImages = [], preparingImages = 0;
let pendingApprovals = [], permissionSaving = false;
const plainText = content => typeof content==='string'?content:Array.isArray(content)?content.filter(p=>p.type==='text').map(p=>p.text).join('\n'):'';
let state, slotId = localStorage.getItem('meiju-slot'), sessionId = null, session = null, busy = false, streaming = false, toastTimer;
const api = async (path, body, options = {}) => {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' }, signal: options.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
};
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
const safe = fn => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message); } };
function element(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
function currentSlot() { return state.slots.find(s => s.id === slotId); }
async function refresh() {
  state = await api('/state');
  showPermission();
  if (!state.slots.some(s => s.id === slotId)) slotId = state.slots[0]?.id;
  localStorage.setItem('meiju-slot', slotId);
  $('#slot-select').replaceChildren(...state.slots.map(s => { const opt = element('option', s.name); opt.value = s.id; return opt; }));
  $('#slot-select').value = slotId;
  const sessions = state.sessions.filter(s => s.slotId === slotId).reverse();
  $('#sessions').replaceChildren(...sessions.map(s => {
    const row = element('div', undefined, 'session-row' + (s.id === sessionId ? ' active' : ''));
    const b = element('button', s.title, 'session-open'); b.append(element('small', `${new Date(s.createdAt).toLocaleDateString()} · ${s.closed ? '已写日记' : s.status === 'running' ? '进行中' : '可继续'}`)); b.onclick = safe(() => selectSession(s.id));
    const remove = element('button', '删除', 'session-delete'); remove.title = s.id === sessionId && !s.closed ? '删除并脱离：丢弃当前聊天和本次新增记忆' : '仅删除此条聊天历史，保留日记和记忆'; remove.setAttribute('aria-label', `删除会话：${s.title}`); remove.onclick = safe(() => removeSession(s));
    row.append(b, remove); return row;
  }));
  $('#session-count').textContent = sessions.length;
  $('#diary-count').textContent = currentSlot()?.diaryCount || 0;
  $('#sync-dot').textContent = state.sync.enabled ? '●' : '○';
}
async function selectSession(key) {
  if (streaming && key !== sessionId) { toast('当前任务完成后再切换会话'); return; }
  sessionId = key; session = await api(`/sessions/${key}`);
  busy = session.status === 'running';
  $('#messages').replaceChildren(...session.messages.map(renderMessage));
  $('#session-title').textContent = session.title;
  $('#session-subtitle').textContent = `${session.profile.model || '尚未配置模型'} · ${session.personaVersion === 2 ? `${session.personaKey || session.personaReason} · ` : '旧人设快照，需新建会话使用修正 · '}${session.closed ? '会话已结束，日记已保存' : '历史按原顺序保留'}`;
  $('#prefix-status').textContent = `当前前缀 ${(session.requestPrefixHash||session.prefixHash).slice(0, 10)}`;
  pendingApprovals = session.approvals || []; showApprovals();
  $('#status').textContent = session.error || (busy ? '任务仍在运行…' : session.closed ? '日记已保存，可以新建会话' : '准备就绪');
  $('#retry').hidden = !['error', 'interrupted'].includes(session.status);
  $('#artifacts').replaceChildren(...session.artifacts.map(a => { const b = element('button', `↓ ${a.path.split(/[\\/]/).pop()}`); b.title = a.path; b.onclick = safe(async () => { const r = await fetch(`/api/artifacts/${a.id}`, { headers: { 'X-Agent-Token': token } }); if (!r.ok) throw new Error((await r.json()).error); download(await r.blob(), a.path.split(/[\\/]/).pop()); }); return b; }));
  showUsage(session.usage); controls(); await refresh(); scrollBottom();
}
function controls() { $('#first-speak').disabled = busy || startingRun || Boolean(session?.closed); $('#send').disabled = busy || startingRun || preparingImages>0 || Boolean(session?.closed); $('#attach-image').disabled=busy||Boolean(session?.closed); $('#stop').hidden = !busy; $('#finish-session').disabled = busy || !session || session.closed || !session.messages.length; $('#chat-input').disabled = Boolean(session?.closed); for (const key of ['#new-session', '#slot-select', '#add-slot', '#import-save', '#persona-button']) $(key).disabled = busy || startingRun; }
function showPermission() {
  if (permissionSaving) return;
  $('#permission-select').value = state.config.permissions;
  $('#permission-label').textContent = {ask:'写入文件、读取目录外文件和执行命令前，逐次确认',full:'可直接读写、删除文件和联网 · 受 Windows 账户权限限制',workspace:'仅工作目录内读写 · 命令工具关闭'}[state.config.permissions] || '权限状态未知';
}
$('#permission-select').onchange = async () => {
  if (permissionSaving) return;
  permissionSaving = true; $('#permission-select').disabled = true;
  try {
    state.config = await api('/config', { permissions: $('#permission-select').value });
    $('#settings-form').elements.permissions.value = state.config.permissions;
    toast('权限已保存，对下一次工具操作生效' + (pendingApprovals.length ? '；待确认操作仍需单独批准' : ''));
  } catch (e) { toast(e.message); }
  finally { permissionSaving = false; $('#permission-select').disabled = false; showPermission(); }
};
function showApprovals() {
  const panel = $('#approval-panel');
  panel.hidden = !pendingApprovals.length; panel.replaceChildren();
  for (const approval of pendingApprovals) {
    const card = element('div', undefined, 'approval-card');
    card.append(element('strong', '需要你确认 · ' + ({files_write:'写入文件',command_run:'执行命令',files_read:'读取文件',files_list:'读取目录',files_view_image:'查看图片'}[approval.name] || approval.name)), element('p', approval.reason));
    card.append(element('pre', approval.name === 'command_run' ? `执行目录：${approval.target}\n\n${approval.arguments.command}` : `路径：${approval.target}${approval.canonicalTarget && approval.canonicalTarget !== approval.target ? '\n实际路径：' + approval.canonicalTarget : ''}`));
    if (approval.name === 'files_write') {
      const preview = element('details'); preview.append(element('summary', `查看完整写入内容（${approval.arguments.content.length.toLocaleString()} 字符）`), element('pre', approval.arguments.content)); card.append(preview);
    }
    const actions = element('div', undefined, 'approval-actions');
    for (const [decision, label] of [['deny','拒绝'],['approve','允许这一次']]) {
      const button = element('button', label, decision === 'approve' ? 'primary' : ''); button.type = 'button'; button.dataset.decision = decision;
      button.onclick = async () => {
        actions.querySelectorAll('button').forEach(b => b.disabled = true);
        try { await api(`/approvals/${approval.id}/decision`, {decision}); pendingApprovals = pendingApprovals.filter(a => a.id !== approval.id); showApprovals(); }
        catch (e) { toast(e.message); if (!streaming && sessionId) await selectSession(sessionId); }
        finally { actions.querySelectorAll('button').forEach(b => b.disabled = false); }
      };
      actions.append(button);
    }
    card.append(actions); panel.append(card);
  }
}
function renderMessage(m) {
  if (m.role === 'user' && m.content === starter.request) return element('article', starter.label, 'message conversation-cue');
  const box = element('article', undefined, `message ${m.role}`);
  if (m.role === 'tool') {
    const details = element('details'); details.append(element('summary', '工具结果 · 点击展开'), element('pre', m.content)); box.append(details); return box;
  }
  box.append(element('div', m.role === 'user' ? 'YOU / 你' : 'AGENT / 回复', 'message-label'));
  if (m.role==='assistant'){
    for(const part of MeijuDisplay.parts(plainText(m.content))){
      if(part.kind==='heart'){const fold=element('details',undefined,'character-heart');fold.append(element('summary','角色心声'),element('div',part.text,'message-content'));box.append(fold);}
      else box.append(element(part.kind==='code'?'pre':'div',part.text,part.kind==='code'?'chat-code':'message-content'));
    }
  }else if (plainText(m.content)) box.append(element('div', plainText(m.content), 'message-content'));
  if(Array.isArray(m.content))for(const part of m.content.filter(p=>p.type==='image_url')){const img=element('img',undefined,'chat-image');img.src=part.image_url.url;img.alt='本次对话图片';box.append(img);}
  for (const call of m.tool_calls || []) { const details = element('details'); details.append(element('summary', `调用 ${call.function.name}`), element('pre', call.function.arguments)); box.append(details); }
  return box;
}
function showUsage(summary) {
  const percent = r => r === null || r === undefined ? '未上报' : `${(r * 100).toFixed(1)}%`;
  $('#cache-last').textContent = summary.requests ? percent(summary.last?.ratio) : '待请求';
  $('#cache-last').title = !summary.requests ? '发送消息后显示接口返回的缓存用量' : summary.last?.ratio === 0 ? '接口实际返回缓存命中为 0。新会话快照改变或服务端缓存尚未建立时，首条可能未命中；这不是显示错误。' : summary.last?.ratio == null ? '本次接口没有提供可核验的缓存用量，不按 0% 计算。' : '根据接口返回的缓存 token / 输入 token 计算；不代表本地记忆检索命中率。';
  $('#cache-total').textContent = percent(summary.ratio);
  $('#cache-tokens').textContent = summary.measured ? `${summary.cached.toLocaleString()} / ${summary.input.toLocaleString()}` : '—';
  $('#cache-coverage').textContent = `${summary.measured} / ${summary.requests} 次`;
  const n=v=>Number.isFinite(v)?v.toLocaleString():'未上报',t=summary.turn;
  $('#token-usage').textContent=t?.requests?`本轮 ${t.requests} 次请求 · 输入 ${n(t.input)}（未缓存 ${n(t.uncached)}）· 输出 ${n(t.output)}${t.reasoning?'（含推理 '+n(t.reasoning)+'）':''}　｜　本会话累计输入 ${n(summary.totalInput)}（含缓存），未缓存 ${n(summary.uncached)}，输出 ${n(summary.output)}`:'';
  $('#cache-note').textContent = !summary.requests ? '固定内容优先复用；首次请求的缓存由服务商建立。' : summary.last?.ratio == null ? '服务商未上报缓存明细，无法判断命中率。' : summary.requests === 1 ? '会话首轮 · 已命中 ' + percent(summary.last.ratio) + '。新内容需要建立缓存，继续相同上下文更利于复用。' : '按服务商实际用量统计；人设、模型、历史压缩或缓存过期都可能影响复用。';
  const context=summary.last?.context;
  $('#context-info').textContent=context?`本次发送 ${n(context.sentChars)} 字符 · 原始上下文 ${n(context.sourceChars)} 字符 · 较早 ${n(context.omittedMessages)} 条按需回查（完整历史保留；图片成本以接口用量为准）`:'';
}
function scrollBottom() { $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight; }
async function newSession() { if (busy) return; const s = await api('/sessions', { slotId }); await selectSession(s.id); $('#chat-input').focus(); }
async function run({ text, diary = false, retry = false, firstSpeak = false }) {
  if (busy || startingRun || session?.closed) return;
  startingRun = true; controls();
  try { if (!sessionId) await newSession(); }
  finally { startingRun = false; controls(); }
  const runningId = sessionId, runKey = Symbol(); activeRun = runKey;
  busy = true; streaming = true; controls(); $('#retry').hidden = true;
  const images=diary||retry||firstSpeak?[]:pendingImages.map(m=>m.url);
  if (!retry) { $('#messages').append(renderMessage({ role: 'user', content: firstSpeak ? starter.request : diary ? '结束本次会话并生成日记。' : images.length?[{type:'text',text:text||'请看看这些图片。'},...images.map(url=>({type:'image_url',image_url:{url}}))]:text })); if (!diary && !firstSpeak) $('#chat-input').value = ''; scrollBottom(); }
  $('#status').textContent = '已提交，正在处理…';
  let failed = false;
  try {
    const response = await fetch(`/api/sessions/${sessionId}/run`, { method: 'POST', headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, diary, retry, firstSpeak, images }) });
    if (!response.ok) throw new Error((await response.json()).error);
    if(!diary&&!retry&&!firstSpeak){pendingImages=[];renderPendingImages();}
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const event = e => {
      if (activeRun !== runKey || sessionId !== runningId || deletingSessions.has(runningId)) return;
      if (e.type === 'status') $('#status').textContent = e.text;
      if (e.type === 'tool') $('#status').textContent = `正在执行 ${e.name}…`;
      if (e.type === 'approval') { pendingApprovals = [e.approval]; showApprovals(); $('#status').textContent = '等待你确认操作，暂未执行'; }
      if (e.type === 'approval_result') { pendingApprovals = pendingApprovals.filter(a => a.id !== e.id); showApprovals(); $('#status').textContent = e.status === 'approved' ? '已批准，正在处理…' : '操作未执行'; }
      if (e.type === 'message') { $('#messages').append(renderMessage(e.message)); scrollBottom(); }
      if (e.type === 'usage') $('#cache-last').textContent = e.usage.ratio === null ? '未上报' : `${(e.usage.ratio * 100).toFixed(1)}%`;
      if (e.type === 'diary') toast('日记已保存，会话已结束');
      if (e.type === 'error') { failed = true; toast(e.error); }
    };
    for (;;) { const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) event(JSON.parse(line)); } if (done) break; }
    if (buffer.trim()) event(JSON.parse(buffer));
  } finally { if (activeRun === runKey) { activeRun = null; busy = false; streaming = false; if (sessionId === runningId && !deletingSessions.has(runningId)) { await selectSession(runningId); if (!failed) $('#chat-input').focus(); } } }
}
async function removeSession(item) {
  if (deletingSessions.has(item.id)) return;
  const discard = item.id === sessionId && !item.closed;
  if (!confirm(discard ? '删除并脱离当前会话？会停止正在生成的回复，删除聊天和本次新增记忆，不生成日记；已有文件保留。' : '只删除这条聊天历史？已经写入的日记、记忆和产出文件保留。')) return;
  deletingSessions.add(item.id);
  try {
    await api(`/sessions/${item.id}/delete`, { mode: discard ? 'discard' : 'history' });
    if (sessionId === item.id) {
      sessionId = null; session = null; activeRun = null; busy = false; streaming = false;
      pendingApprovals = []; showApprovals();
      $('#messages').replaceChildren(); $('#artifacts').replaceChildren(); $('#session-title').textContent = '已离开会话'; $('#session-subtitle').textContent = '可以开始新的交流'; $('#status').textContent = '会话已删除'; $('#retry').hidden = true;
      showUsage({ measured: 0, requests: 0, ratio: null }); controls();
      await refresh(); if (discard) await newSession();
    } else await refresh();
    toast(discard ? '已丢弃本次聊天和新增记忆，已进入全新会话' : '聊天历史已删除，日记和记忆保留');
  } finally { deletingSessions.delete(item.id); }
}
function download(blob, name) { const url = URL.createObjectURL(blob), a = element('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
let providers = [], availableModels = [], modelsController = null, modelsVersion = 0;
const endpointIdentity = value => { try { return new URL(value.trim()).href.replace(/\/+$/, ''); } catch { return value.trim(); } };
function showPicker(open) { $('#model-picker').hidden = !open; $('#model-picker-toggle').setAttribute('aria-expanded', String(open)); }
function invalidateModels(message = '地址或 Key 已变更，请重新同步模型。') {
  modelsVersion++; modelsController?.abort(); modelsController = null;
  availableModels = []; showPicker(false); $('#model-options').replaceChildren();
  $('#model-search').value = ''; $('#model-sync-status').textContent = message;
  $('#model-sync-status').classList.remove('error-text'); $('#sync-models').disabled = false; $('#sync-models').textContent = '↓ 同步模型';
}
function providerNote() {
  const form = $('#settings-form'), preset = providers.find(p => p.id === form.elements.provider.value);
  $('#provider-note').textContent = preset?.note || '使用 Chat Completions 兼容协议，模型从当前接口实时获取。';
  const canReuse = state.config.hasKey && endpointIdentity(form.elements.baseURL.value) === endpointIdentity(state.config.baseURL) && !form.elements.clearKey.checked;
  form.elements.apiKey.placeholder = canReuse ? '已保存此地址的 Key；留空保留' : '填写当前地址的 Key；本机服务可留空';
}
function renderModels() {
  const query = $('#model-search').value.trim().toLowerCase();
  const matches = availableModels.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(query));
  $('#model-options').replaceChildren(...matches.map(m => { const opt = element('option', m.name === m.id ? m.id : `${m.name} · ${m.id}`); opt.value = m.id; return opt; }));
  $('#model-options').value = $('#model-input').value;
  $('#model-match-count').textContent = matches.length ? `${matches.length} / ${availableModels.length} 个模型` : '没有匹配模型，可换个关键词或手动填写 ID。';
}
async function settings() {
  if (!providers.length) providers = await api('/providers');
  const f = $('#settings-form');
  $('#provider-select').replaceChildren(...providers.map(p => { const opt = element('option', p.name); opt.value = p.id; return opt; }));
  for (const [key, value] of Object.entries(state.config)) if (f.elements[key] && !['apiKey', 'hasKey'].includes(key)) f.elements[key].value = key === 'extraBody' ? JSON.stringify(value, null, 2) : value ?? '';
  f.elements.apiKey.value = ''; f.elements.clearKey.checked = false;
  providerNote(); invalidateModels('点击同步，获取当前接口可用的模型。');
  f.querySelector('.form-error').textContent = ''; $('#settings-dialog').showModal();
}
$('#provider-select').onchange = () => {
  const f = $('#settings-form'), preset = providers.find(p => p.id === f.elements.provider.value);
  if (preset?.baseURL) f.elements.baseURL.value = preset.baseURL;
  f.elements.apiKey.value = ''; f.elements.model.value = ''; f.elements.clearKey.checked = false;
  providerNote(); invalidateModels('已切换厂商，填写 Key 后点击同步模型。');
};
$('#settings-form').elements.baseURL.oninput = () => {
  const f = $('#settings-form'), matching = providers.find(p => p.baseURL && endpointIdentity(p.baseURL) === endpointIdentity(f.elements.baseURL.value));
  f.elements.provider.value = matching?.id || 'custom'; providerNote(); invalidateModels();
};
$('#settings-form').elements.apiKey.oninput = () => invalidateModels();
$('#settings-form').elements.clearKey.onchange = () => { providerNote(); invalidateModels(); };
$('#model-search').oninput = renderModels;
$('#model-options').onchange = () => { $('#model-input').value = $('#model-options').value; showPicker(false); $('#model-input').focus(); };
$('#model-search').onkeydown = e => {
  if (e.key === 'Enter') { e.preventDefault(); const option = $('#model-options').selectedOptions[0] || $('#model-options').options[0]; if (option) { $('#model-input').value = option.value; showPicker(false); $('#model-input').focus(); } }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showPicker(false); $('#model-input').focus(); }
};
$('#model-picker-toggle').onclick = () => {
  if (!availableModels.length) { $('#model-sync-status').textContent = '请先点击“同步模型”，也可以直接填写模型 ID。'; return; }
  showPicker($('#model-picker').hidden); if (!$('#model-picker').hidden) { renderModels(); $('#model-search').focus(); }
};
$('#sync-models').onclick = async () => {
  const f = $('#settings-form'), baseURL = f.elements.baseURL.value.trim();
  if (!baseURL) { f.elements.baseURL.reportValidity(); return; }
  invalidateModels('正在获取模型列表…');
  const version = modelsVersion, controller = new AbortController(); modelsController = controller;
  $('#sync-models').disabled = true; $('#sync-models').textContent = '同步中…';
  try {
    const body = { baseURL };
    if (f.elements.apiKey.value.trim() || f.elements.clearKey.checked) body.apiKey = f.elements.clearKey.checked ? '' : f.elements.apiKey.value.trim();
    const result = await api('/models', body, { signal: controller.signal });
    if (version !== modelsVersion || !$('#settings-dialog').open) return;
    availableModels = result.models; renderModels();
    $('#model-sync-status').textContent = availableModels.length ? `已同步 ${availableModels.length} 个模型，展开列表选择。` : '接口返回空列表，可稍后重试或手动填写模型 ID。';
    if (availableModels.length) { showPicker(true); $('#model-search').focus(); }
  } catch (e) {
    if (version === modelsVersion && e.name !== 'AbortError') { $('#model-sync-status').textContent = e.message; $('#model-sync-status').classList.add('error-text'); }
  } finally {
    if (version === modelsVersion) { modelsController = null; $('#sync-models').disabled = false; $('#sync-models').textContent = '↓ 同步模型'; }
  }
};
$('#settings-dialog').addEventListener('close', () => invalidateModels());
$('#settings-form').onsubmit = async e => {
  e.preventDefault(); const f = e.currentTarget;
  try {
    const b = Object.fromEntries(new FormData(f));
    for (const k of ['maxTokens', 'maxContextChars', 'historyChars', 'timeoutMs']) b[k] = Number(b[k]);
    b.temperature = b.temperature.trim() ? Number(b.temperature) : null; b.extraBody = JSON.parse(b.extraBody || '{}');
    b.baseURL = b.baseURL.trim(); b.model = b.model.trim(); b.apiKey = b.apiKey.trim();
    if (f.elements.clearKey.checked) b.apiKey = '';
    else if (!b.apiKey) delete b.apiKey;
    delete b.clearKey;
    await api('/config', b); await refresh(); $('#settings-dialog').close();
    if (session && !session.messages.length && !busy) { await newSession(); toast('配置已保存，已创建使用新配置的会话'); }
    else toast('配置已保存；权限立即用于下一次操作，其他配置新会话生效');
  } catch (err) { f.querySelector('.form-error').textContent = err.message; }
};
function showPersonaPreview(card) {
  $('#persona-card-info').textContent = card.error || `${card.key || '无卡片'} · ${card.reason}`;
  $('#persona-card-preview').textContent = card.text || '请手动选择卡片，或填写下方人设覆盖。';
}
$('#persona-form').onsubmit = async e => {
  e.preventDefault(); const f = e.currentTarget;
  if (busy) return;
  try { await api(`/slots/${slotId}/persona`, Object.fromEntries(new FormData(f))); await refresh(); await newSession(); $('#persona-dialog').close(); toast('已使用当前人设新开会话，旧聊天记录保留'); }
  catch (err) { f.querySelector('.form-error').textContent = err.message; }
};
$('#persona-button').onclick = safe(async () => {
  const s = currentSlot(), f = $('#persona-form'), data = await api(`/slots/${slotId}/persona`);
  f.elements.name.value = s.name; f.elements.persona.value = s.persona || '';
  const auto = element('option', '自动：依照存档状态'); auto.value = '';
  f.elements.personaKey.replaceChildren(auto, ...data.choices.map(c => { const opt = element('option', `${c.key}${c.name ? ` · ${c.name}（卡片元数据）` : ''}`); opt.value = c.key; return opt; }));
  f.elements.personaKey.value = s.personaKey || '';
  $('#persona-current').textContent = `当前生效：${data.current.key || data.current.reason} · ${data.current.reason}${data.current.error ? ` · ${data.current.error}` : ''}`;
  showPersonaPreview(data.card); f.querySelector('.form-error').textContent = ''; $('#persona-dialog').showModal();
});
$('#persona-form').elements.personaKey.onchange = safe(async e => {
  const data = await api(`/slots/${slotId}/persona?key=${encodeURIComponent(e.target.value)}`); showPersonaPreview(data.card);
});
$('#settings-button').onclick = safe(settings);
$('#welcome-settings').onclick = safe(settings);
for (const button of document.querySelectorAll('.close')) button.onclick = () => button.closest('dialog').close();
$('#new-session').onclick = safe(newSession);
$('#slot-select').onchange = safe(async e => { slotId = e.target.value; sessionId = null; session = null; await refresh(); const latest = state.sessions.filter(s => s.slotId === slotId).at(-1); if (latest) await selectSession(latest.id); else await newSession(); });
$('#add-slot').onclick = safe(async () => { const s = await api('/slots', { name: `存档 ${state.slots.length + 1}` }); slotId = s.id; sessionId = null; await refresh(); await newSession(); });
$('#import-save').onclick = () => $('#import-file').click();
$('#import-file').onchange = safe(async e => { const file = e.target.files[0]; if (!file) return; try { const save = JSON.parse(await file.text()); const s = await api('/import', { save }); slotId = s.id; sessionId = null; await refresh(); await newSession(); toast('已导入为独立空间，原有槽位保留'); } finally { e.target.value = ''; } });
$('#export-save').onclick = safe(async () => { const save = await api(`/slots/${slotId}/export`); download(new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' }), `妹居物语_槽位${save.slotId ?? '桌面'}_桌面导出.json`); });
function renderPendingImages(){ $('#image-preview').replaceChildren(...pendingImages.map((item,i)=>{const box=element('div'),img=element('img');img.src=item.url;img.alt=item.name;const remove=element('button','×');remove.type='button';remove.setAttribute('aria-label','移除图片 '+item.name);remove.onclick=()=>{pendingImages.splice(i,1);renderPendingImages();};box.append(img,remove);return box;})); }
async function addImages(files){
  if(busy||session?.closed)return; preparingImages++;controls();
  try{for(const file of files){if(pendingImages.length>=4)throw new Error('每次最多4张图片');if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type))throw new Error('请选择PNG/JPEG/WebP/GIF图片');if(file.size>20*1024*1024)throw new Error('原图超过20 MiB');const bitmap=await createImageBitmap(file);try{const scale=Math.min(1,1536/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);pendingImages.push({name:file.name||'粘贴图片',url:canvas.toDataURL('image/jpeg',.85)});}finally{bitmap.close();}renderPendingImages();}}
  finally{preparingImages--;controls();}
}
$('#attach-image').onclick=()=>$('#image-file').click();
$('#image-file').onchange=safe(async e=>{try{await addImages([...e.target.files]);}finally{e.target.value='';}});
$('#chat-input').addEventListener('paste',safe(async e=>{const images=[...e.clipboardData.items].filter(m=>m.type.startsWith('image/')).map(m=>m.getAsFile()).filter(Boolean);if(images.length){e.preventDefault();await addImages(images);}}));
$('#chat-form').addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
$('#chat-form').addEventListener('drop',safe(async e=>{if(e.dataTransfer.files.length){e.preventDefault();await addImages([...e.dataTransfer.files]);}}));
$('#chat-form').onsubmit = safe(async e => { e.preventDefault(); if(preparingImages)return;const text = $('#chat-input').value.trim(); if (text||pendingImages.length) await run({ text }); });
$('#chat-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); } };
$('#first-speak').onclick = safe(() => run({ firstSpeak: true }));
$('#retry').onclick = safe(() => run({ retry: true }));
$('#stop').onclick = safe(() => api(`/sessions/${sessionId}/stop`, {}));
$('#finish-session').onclick = safe(() => run({ diary: true }));
async function entries(kind, title) {
  const data = await api(`/slots/${slotId}/${kind}`); $('#content-title').textContent = `${title} · ${data.length}`;
  $('#content-list').replaceChildren(...(data.length ? data.slice().reverse().map(d => { const box = element('div', undefined, 'entry'); box.append(element('small', d.date || (d.timestamp ? new Date(d.timestamp).toLocaleString() : '历史记录')), element('p', d.content || '（原始存档中的空记录）')); if (d.source) box.append(element('small', `来源：${d.source}`)); if (kind === 'memories') { box.prepend(element('small', d.kind === 'event' ? '事件记忆 · ' : '长期事实 · ')); if (d.previousId) box.append(element('small', ' · 已关联前一条经历')); const remove = element('button', '忘记这条记忆', 'memory-delete'); remove.onclick = safe(async () => { if (confirm('忘记这条记忆？原日记和聊天保持原样。已打开的会话仍使用原背景，新会话生效。')) { await api(`/memories/${d.id}/delete`, {}); await entries(kind, title); } }); box.append(remove); } return box; }) : [element('p', `暂时没有${title}。`, 'muted')])); $('#content-dialog').showModal();
}
$('#diary-list').onclick = safe(() => entries('diaries', '日记'));
$('#memory-list').onclick = safe(() => entries('memories', '记忆'));
function showSync(s) {
  const info = $('#sync-info'); info.replaceChildren(element('p', s.enabled ? '同步入口已开启' : '同步入口已关闭', 'muted'));
  if (s.enabled && (!s.devices.length || $('#sync-advanced').open)) { for (const address of s.addresses) info.append(element('p', address, 'sync-address')); info.append(element('div', s.pairingCode || '点击刷新配对码', 'pair-code')); }
  const pending = s.request && Date.now() - s.request.timestamp < 300000 && s.lastResult?.id !== s.request.id;
  $('#sync-status').textContent = pending ? '等待手机主菜单响应…（手机打开游戏即可，5 分钟内有效）' : s.lastResult ? (s.lastResult.result?.errors?.length ? '部分完成：' + s.lastResult.result.errors.join('；') : '同步完成 · ' + new Date(s.lastResult.timestamp).toLocaleTimeString()) : s.devices.length ? '已配对，点击“同步”。也可以在手机点击同步。' : '首次使用请展开下方配对设置。';
  $('#sync-start').disabled = s.enabled; $('#sync-stop').disabled = !s.enabled; $('#sync-renew').disabled = !s.enabled;
  $('#sync-devices').replaceChildren(...s.devices.map(d => { const row = element('div', undefined, 'entry'); row.append(element('p', d.name)); const b = element('button', '解除配对'); b.onclick = safe(async () => showSync(await api('/sync', { action: 'revoke', deviceId: d.id }))); row.append(b); return row; }));
  $('#sync-conflicts').replaceChildren(...s.conflicts.map(c => { const row = element('div', undefined, 'entry'); row.append(element('p', `保留的冲突副本 · ${new Date(c.timestamp).toLocaleString()}`)); const b = element('button', '导出冲突副本'); b.onclick = safe(async () => { const conflict = await api(`/conflicts/${c.id}`); download(new Blob([JSON.stringify(conflict, null, 2)], { type: 'application/json' }), `同步冲突-${c.id}.json`); }); row.append(b); return row; }));
}
$('#sync-now').onclick = safe(async () => { showSync(await api('/sync', { action: 'sync' })); if (!state.sync.devices.length) { $('#sync-advanced').open = true; await refresh(); showSync(state.sync); } });
$('#sync-advanced').addEventListener('toggle', () => { if (state) showSync(state.sync); });
setInterval(() => { if ($('#sync-dialog').open) safe(async () => { await refresh(); showSync(state.sync); })(); }, 3000);
$('#sync-button').onclick = safe(async () => { await refresh(); showSync(state.sync); $('#sync-dialog').showModal(); });
for (const [selector, action] of [['#sync-start', 'start'], ['#sync-stop', 'stop'], ['#sync-renew', 'pair']]) $(selector).onclick = safe(async () => { showSync(await api('/sync', { action })); await refresh(); });
safe(async () => { await refresh(); const latest = state.sessions.filter(s => s.slotId === slotId).at(-1); if (latest) await selectSession(latest.id); else controls(); })();
setInterval(() => { if (!streaming && session?.status === 'running') safe(() => selectSession(sessionId))(); }, 2500);
