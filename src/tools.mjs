import { readFile, writeFile, mkdir, realpath, stat, copyFile, rename } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { id } from './store.mjs';
import { saveMemory, searchMemories, indexDiaries } from './memory.mjs';
import { validateImage } from './images.mjs';
import { isTurn } from './context.mjs';

const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const str = description => ({ type: 'string', description });
export const TOOLS = Object.freeze([
  tool('history_read', '按序号回查本会话完整原始记录。start从0开始，count默认4最多8；includeImage为true时可重看第一张历史图片。', {start:{type:'integer'},count:{type:'integer'},includeImage:{type:'boolean'}}, []),
  tool('files_read', '分段读取UTF-8文本。默认3000字符，单次最多8000；大文件请用offset/length定位，勿反复读取全文。', { path: str('文件路径'), offset:{type:'integer',description:'起始字符位置，默认0'}, length:{type:'integer',description:'读取字符数，默认3000，上限8000'} }, ['path']),
  tool('files_view_image', '查看本机PNG/JPEG/WebP图片，将真实图片传给视觉模型。', {path:str('图片文件路径')}, ['path']),
  tool('files_list', '列出目录中的文件和子目录。', { path: str('目录，默认工作目录') }, []),
  tool('files_write', '创建或替换 UTF-8 文件。覆盖前自动备份；返回产出文件。', { path: str('文件路径'), content: str('完整文件内容') }, ['path', 'content']),
  tool('command_run', '在工作目录执行 PowerShell 命令（Windows）或系统 shell 命令。询问模式需用户批准，完全访问直接执行，仅工作目录模式禁用。限时60秒。', { command: str('命令') }, ['command']),
  tool('memory_search', '搜索当前槽位的长期记忆。', { query: str('关键词') }, ['query']),
  tool('memory_save', '保存一条独立短记忆：一个长期事实、关键经历或约定，最多120字，多项分别调用。不要存日记全文。注明真实来源。', { content: str('一个事实或事件，最多120字的短字符串'), source: str('来源说明'), kind: str('fact 为稳定事实，event 为关键经历；省略为 fact') }, ['content', 'source']),
  tool('diary_read', '读取当前槽位最近的日记，最多 8 篇。', {}, [])
]);

async function checkedPath(profile, input = '.') {
  const workspace = resolve(profile.workspace), target = resolve(workspace, input);
  if (profile.permissions === 'full') return target;
  const within = (root, p) => { const rel = relative(root, p); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (!within(workspace, target)) throw new Error('路径超出工作目录');
  const canonicalRoot = await realpath(workspace);
  let parent = target;
  for (;;) {
    try { const canonical = await realpath(parent); if (!within(canonicalRoot, canonical)) throw new Error('路径链接指向工作目录之外'); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; const next = dirname(parent); if (next === parent) throw e; parent = next; }
  }
  return target;
}
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel)); };
const networkPath = path => /^[/\\]{2}/.test(path);
async function canonicalPath(path) {
  let parent = path;
  for (;;) {
    try { return resolve(await realpath(parent), relative(parent, path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const next = dirname(parent); if (next === parent) throw error; parent = next; }
  }
}
async function authorizeOperation(profile, name, args, signal, policy) {
  const mode = () => policy.getPermissions?.() ?? profile.permissions ?? 'workspace';
  const current = mode();
  if (!['ask', 'full', 'workspace'].includes(current)) throw new Error('权限模式无效，未执行');
  const command = name === 'command_run', workspace = resolve(profile.workspace);
  const target = command ? workspace : resolve(workspace, args.path ?? '.');
  if (current === 'workspace') {
    if (command) throw new Error('执行命令需要完全权限或逐次批准；当前仅工作目录模式已关闭命令');
    return checkedPath({ ...profile, permissions: 'workspace' }, args.path);
  }
  if (current === 'full') return target;
  // Never probe a UNC/network target before the user approves network access.
  const network = networkPath(target);
  const canonical = network ? null : await canonicalPath(target);
  const localRead = !command && name !== 'files_write' && !network && !networkPath(workspace)
    && within(workspace, target) && within(await canonicalPath(workspace), canonical);
  if (localRead) return canonical;
  if (!policy.authorize) throw new Error('此操作需要用户批准，当前没有可用的确认入口，未执行');
  const operation = {
    name, workspace, target, canonicalTarget: canonical,
    reason: command ? '命令可能修改或删除文件、下载内容或访问网络，需要确认完整命令。' : name === 'files_write' ? '创建或覆盖文件需要确认；已有文件将先备份。' : '读取工作目录以外的文件或网络目录需要确认。',
    arguments: structuredClone(args)
  };
  const approved = await policy.authorize(operation);
  if (approved !== true) throw new Error('操作未获批准，未执行');
  if (signal?.aborted) throw new Error('任务已停止');
  if (mode() === 'workspace') throw new Error('权限已切换为仅工作目录，此操作已取消，请按当前权限重新提出');
  if (canonical !== null && await canonicalPath(target) !== canonical) throw new Error('等待确认期间路径或链接发生变化，未执行，请重新提出操作');
  return canonical ?? await canonicalPath(target);
}
export async function runCommand(command, cwd, signal, timeoutMs = 60000) {
  if (signal?.aborted) throw new Error('任务已停止');
  return new Promise((resolveRun, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ' + command] : ['-c', command], { cwd, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', truncated = false, timedOut = false, stopped = false;
    const capture = bytes => { const text = bytes.toString('utf8'), remaining = 6000-output.length; if(text.length>remaining)truncated=true; if(remaining>0)output+=text.slice(0,remaining); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const kill = () => {
      if (windows) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { stopped = true; kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.on('error', error => { clean(); reject(error); });
    child.on('close', code => { clean(); resolveRun({ code, output, truncated, timedOut, stopped }); });
  });
}
export async function executeTool(store, session, call, signal, diaryMode = false, policy = {}) {
  const name = call.function?.name;
  if (!TOOLS.some(t => t.function.name === name)) throw new Error('未知工具');
  const args = JSON.parse(call.function.arguments || '{}');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数应为对象');
  const spec = TOOLS.find(t => t.function.name === name).function.parameters;
  for (const key of spec.required) if (typeof args[key] !== 'string') throw new Error(`工具参数 ${key} 应为字符串`);
  if (diaryMode && !['history_read', 'files_read', 'files_view_image', 'files_list', 'memory_search', 'diary_read'].includes(name)) throw new Error('日记生成阶段只允许读取资料');
  if (signal?.aborted) throw new Error('任务已停止');
  const profile = session.profile;
  if (args.path !== undefined && typeof args.path !== 'string') throw new Error('文件路径应为文本');
  if (name === 'files_write' && args.content.length > 4 * 1024 * 1024) throw new Error('单次产出超过 4 MiB');
  if (name === 'command_run' && (!args.command.trim() || args.command.length > 100000)) throw new Error('命令不能为空或超过100000字符');
  const path = ['files_read', 'files_view_image', 'files_list', 'files_write', 'command_run'].includes(name)
    ? await authorizeOperation(profile, name, args, signal, policy) : null;
  if (signal?.aborted) throw new Error('任务已停止');
  if(name==='history_read'){
    const start=args.start??0,count=args.count??4;
    if(!Number.isInteger(start)||start<0||!Number.isInteger(count)||count<1||count>8||args.includeImage!==undefined&&typeof args.includeImage!=='boolean')throw new Error('start为非负整数，count为1–8，includeImage为布尔值');
    const all=store.messages(session.id), selected=all.slice(start,start+count);let image,budget=6000;
    const messages=selected.map((m,i)=>{let content=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'):'';
      if(args.includeImage&&!image&&Array.isArray(m.content))image=m.content.find(p=>p.type==='image_url')?.image_url.url;
      const available=Math.min(2000,budget),text=content.slice(0,available);budget-=text.length;
      return{index:start+i,role:m.role,content:text,truncated:text.length<content.length,toolCalls:m.tool_calls?.map(c=>({name:c.function.name,arguments:c.function.arguments.slice(0,300)}))};});
    return{total:all.length,nextOffset:Math.min(all.length,start+count),messages,...(image?{image}:{}),note:'仅返回聊天可见内容与工具记录，不返回模型内部推理。'};
  }
  if(name==='files_view_image'){
    const info=await stat(path); if(info.size>4*1024*1024)throw new Error('图片超过4 MiB，请先缩小或通过图片按钮上传');
    const ext=path.split('.').at(-1).toLowerCase(),mime={png:'png',jpg:'jpeg',jpeg:'jpeg',webp:'webp'}[ext];if(!mime)throw new Error('仅支持PNG/JPEG/WebP图片');
    const image=validateImage(`data:image/${mime};base64,${(await readFile(path)).toString('base64')}`);return{path,image};
  }
  if (name === 'files_read') {
    const info = await stat(path); if (info.size > 4 * 1024 * 1024) throw new Error('文件超过 4 MiB，请先分段处理');
    if(/\.(png|jpe?g|webp|gif|bmp)$/i.test(path))throw new Error('这是图片，请使用 files_view_image 查看');
    const offset=args.offset??0,length=args.length??3000;if(!Number.isInteger(offset)||offset<0||!Number.isInteger(length)||length<1||length>8000)throw new Error('offset应为非负整数，length为1–8000');
    const all=store.messages(session.id),current=all.slice(Math.max(0,all.findLastIndex(isTurn)));
    for(const message of current.filter(m=>m.role==='tool').reverse()){
      try{const prior=JSON.parse(message.content);if(prior.path===path&&prior.offset===offset&&prior.length===length&&prior.modified===info.mtimeMs&&typeof prior.content==='string')return{path,alreadyRead:true,previousToolCall:message.tool_call_id,note:'相同文件片段已在历史工具结果中，不重复展开；需要其他段落可修改offset。'};}catch{}
    }
    const content = await readFile(path, 'utf8');
    return { path, offset, length, modified:info.mtimeMs, totalChars:content.length, content: content.slice(offset,offset+length), nextOffset:Math.min(content.length,offset+length), truncated: content.length > offset+length };
  }
  if (name === 'files_list') {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path, { withFileTypes: true });
    return { path, entries: entries.slice(0, 500).map(e => ({ name: e.name, directory: e.isDirectory() })), truncated: entries.length > 500 };
  }
  if (name === 'files_write') {
    if (args.content.length > 4 * 1024 * 1024) throw new Error('单次产出超过 4 MiB');
    await mkdir(dirname(path), { recursive: true });
    let backup = null;
    try { await stat(path); backup = join(store.root, 'backups', `file-${Date.now()}-${id()}.bak`); await copyFile(path, backup); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const temp = `${path}.${id()}.tmp`;
    await writeFile(temp, args.content, 'utf8');
    await rename(temp, path);
    const artifact = store.put('artifact', { id: id(), slotId: session.slotId, sessionId: session.id, path, backup, timestamp: Date.now() });
    return { artifactId: artifact.id, path, backup, bytes: Buffer.byteLength(args.content) };
  }
  if (name === 'command_run') {
    return runCommand(args.command, path, signal);
  }
  if (name === 'memory_save') return saveMemory(store, { slotId: session.slotId, sessionId: session.id, content: args.content, source: args.source, kind: args.kind || 'fact' });
  if (name === 'memory_search') {
    indexDiaries(store, session.slotId);
    return searchMemories(store, session.slotId, args.query,3);
  }
  let budget=6000;return (store.get('slot', session.slotId)?.save.data.diary || []).slice(-8).reverse().flatMap(d=>{if(budget<=0)return[];const content=(d.content||'').slice(-budget);budget-=content.length;return[{...d,content,truncated:content.length<(d.content||'').length}];}).reverse();
}
