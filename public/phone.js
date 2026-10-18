'use strict';
const $ = s => document.querySelector(s), storageKey = 'meiju-sync-device-v1';
let token = '', busy = false, slots = [], snapshot = null, uploadSave = null;
try { token = localStorage.getItem(storageKey) || ''; } catch {}
const status = (text, error = false) => { $('#status').textContent = text; $('#status').classList.toggle('error', error); };
function controls() {
  for (const s of ['#pair-button', '#pair-code', '#device-name', '#disconnect', '#slots', '#refresh', '#save-file']) $(s).disabled = busy;
  $('#download').disabled = busy || !snapshot; $('#upload').disabled = busy || !snapshot || !uploadSave;
}
function clearFile() { uploadSave = null; $('#save-file').value = ''; $('#file-info').textContent = '尚未选择文件'; }
function forget() {
  token = ''; snapshot = null; slots = []; clearFile();
  try { localStorage.removeItem(storageKey); } catch {}
  $('#transfer-panel').hidden = true; $('#pair-panel').hidden = false; controls();
}
async function request(path, body) {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401 && path !== '/v1/pair') forget();
    const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; e.conflict = data.conflict; throw e;
  }
  return data;
}
const action = fn => async e => {
  e?.preventDefault(); if (busy) return;
  busy = true; controls();
  try { await fn(e); } catch (e) {
    status(e.conflict ? '电脑存档在你选择后已有变化，本次未覆盖，上传内容已保留为冲突副本。请在电脑查看“局域网同步”中的冲突副本，再决定如何处理。' : e.name === 'TimeoutError' ? '连接超时，请检查电脑同步入口是否开启及网络连接。' : e.message, true);
    if (e.conflict) { snapshot = null; }
  } finally { busy = false; controls(); }
};
function showSnapshot(s) {
  snapshot = s;
  $('#slot-info').textContent = `当前：${s.name} · 手机槽位 ${s.save.slotId ?? '?'} · 日记 ${s.save.data.diary?.length || 0} 篇`;
}
async function selectSlot() {
  snapshot = null; clearFile();
  const id = $('#slots').value;
  if (!id) { $('#slot-info').textContent = '电脑上暂无存档空间，请先在电脑创建。'; return; }
  showSnapshot(await request(`/v1/slots/${encodeURIComponent(id)}`));
}
async function refresh() {
  const selected = $('#slots').value;
  slots = await request('/v1/slots');
  $('#slots').replaceChildren(...slots.map(s => {
    const opt = document.createElement('option'); opt.value = s.id; opt.textContent = `${s.name} · 手机槽位 ${s.phoneSlot ?? '?'}`; return opt;
  }));
  if (slots.some(s => s.id === selected)) $('#slots').value = selected;
  $('#pair-panel').hidden = true; $('#transfer-panel').hidden = false;
  await selectSlot();
}
$('#pair-form').onsubmit = action(async () => {
  const code = $('#pair-code').value.trim();
  if (!/^\d{6}$/.test(code)) throw new Error('请输入电脑当前显示的六位配对码');
  const result = await request('/v1/pair', { code, name: $('#device-name').value.trim() || '我的手机' });
  token = result.token; let saved = true;
  try { localStorage.setItem(storageKey, token); } catch { saved = false; }
  $('#pair-code').value = ''; await refresh();
  status(saved ? '配对成功，可选择存档空间进行传档。' : '配对成功。浏览器禁止保存配对信息，关闭页面后需要重新配对。');
});
$('#refresh').onclick = action(async () => { await refresh(); status('电脑存档列表已刷新，请核对后再传档。'); });
$('#slots').onchange = action(async () => { await selectSlot(); status('已切换电脑存档空间。'); });
$('#disconnect').onclick = action(async () => { forget(); status('已忘记本浏览器的配对信息。电脑中的设备记录可在“局域网同步”解除配对。'); });
$('#save-file').onchange = action(async e => {
  uploadSave = null;
  const file = e.target.files[0]; if (!file) { clearFile(); return; }
  $('#file-info').textContent = `正在读取 ${file.name}…`;
  if (file.size > 23 * 1024 * 1024) throw new Error('存档文件过大，请选择小于 23 MiB 的 JSON');
  let save; try { save = JSON.parse(await file.text()); } catch { throw new Error('不是有效的 JSON 存档'); }
  if (!save || typeof save !== 'object' || Array.isArray(save) || !save.data?.gameData || typeof save.data.gameData !== 'object' || Array.isArray(save.data.gameData)) throw new Error('不是可识别的妹居存档，尚未上传');
  if (save.data.diary !== undefined && !Array.isArray(save.data.diary)) throw new Error('存档日记格式无效，尚未上传');
  uploadSave = save;
  $('#file-info').textContent = `${file.name} · 手机槽位 ${save.slotId ?? '?'} · 日记 ${save.data.diary?.length || 0} 篇\n目标：${snapshot?.name || '尚未选择电脑存档'}`;
  status('文件已读取，尚未上传。核对目标空间后点击下方上传按钮。');
});
$('#upload').onclick = action(async () => {
  if (!snapshot || !uploadSave) return;
  const id = snapshot.slotId, result = await request(`/v1/slots/${encodeURIComponent(id)}`, { baseRevision: snapshot.revision, save: uploadSave });
  // Use the committed version, not a later fetch that could advance our conflict baseline.
  showSnapshot({ ...snapshot, save: uploadSave, revision: result.revision });
  clearFile(); status('上传成功。电脑旧存档已自动备份；新会话将读取更新后的存档。');
});
$('#download').onclick = action(async () => {
  if (!snapshot) return;
  const s = await request(`/v1/slots/${encodeURIComponent(snapshot.slotId)}`);
  // Keep a staged upload tied to its original revision, even when downloading a newer save.
  if (!uploadSave) showSnapshot(s);
  const blob = new Blob([JSON.stringify(s.save, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `妹居物语_槽位${s.save.slotId ?? '桌面'}_电脑同步_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  status('已发起存档下载，请在浏览器下载列表查看，再到手机游戏内手动导入。');
});
action(async () => {
  if (token) { await refresh(); status('已恢复配对，可选择存档空间进行传档。'); }
  else { forget(); status('已连接到同步服务，请先输入电脑显示的配对码。'); }
})();
