import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { readFileSync, existsSync, mkdirSync, createReadStream, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store, atomicJSON } from './store.mjs';
import { TOOLS } from './tools.mjs';
import { createSession } from './prompts.mjs';
import { resolvePersona, personaChoices, validatePersonaKey } from './persona.mjs';
import { Agent, DIARY_REQUEST } from './agent.mjs';
import { Approvals } from './approvals.mjs';
import { usageSummary, listModels } from './provider.mjs';
import { PROVIDERS, normalizeBaseURL, inferProvider } from './providers.mjs';
import { SyncService, readJSON, json } from './sync.mjs';
import { indexDiaries, forgetMemory, migrateMemories } from './memory.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function startApp({ root = process.env.PERCH_DATA || process.env.MEIJU_AGENT_DATA || join(project, 'data'), port = Number(process.env.PERCH_PORT || process.env.MEIJU_AGENT_PORT || 39781), syncPort = Number(process.env.PERCH_SYNC_PORT || process.env.MEIJU_AGENT_SYNC_PORT || 39782), callModel } = {}) {
  // Bind before opening storage: a duplicate start must never mark another process's runs interrupted.
  let dispatch = (req, res) => json(res, 503, { error: '服务正在初始化' });
  const server = http.createServer((req, res) => dispatch(req, res));
  server.requestTimeout = 0; server.headersTimeout = 15000;
  await new Promise((resolveStart, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveStart); });
  let store;
  try {
  store = new Store(root);
  migrateMemories(store);
  const configPath = join(root, 'config.json');
  const defaults = { provider: 'openai', baseURL: 'https://api.openai.com/v1', model: '', apiKey: '', maxTokens: 8192, tokenParameter: 'max_tokens', temperature: null, workspace: join(root, 'files'), permissions: 'ask', maxContextChars: 400000, historyChars:12000, timeoutMs: 180000, extraBody: {} };
  let config = { ...defaults, ...(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}) };
  config.baseURL = normalizeBaseURL(config.baseURL);
  config.provider = inferProvider(config.baseURL);
  const envKeyBase = config.baseURL;
  const savedKey = base => normalizeBaseURL(base) === config.baseURL ? ((config.baseURL === envKeyBase && (process.env.PERCH_API_KEY || process.env.MEIJU_API_KEY)) || config.apiKey) : '';
  mkdirSync(config.workspace, { recursive: true });
  if (!store.list('slot').length) store.createSlot('我的存档');
  const publicConfig = () => { const { apiKey, ...rest } = config; return { ...rest, hasKey: Boolean(savedKey(config.baseURL)) }; };
  const approvals = new Approvals(store);
  const agent = new Agent(store, profile => {
    // Do not send an existing secret to a changed endpoint during a running session.
    if (normalizeBaseURL(profile.baseURL) !== config.baseURL) throw new Error('接口地址已改变，请新建会话后再使用密钥');
    return savedKey(profile.baseURL);
  }, callModel, { getPermissions: () => config.permissions, approvals });
  const sync = new SyncService(store);
  const csrf = randomBytes(32).toString('hex');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const running = [...agent.running.values()]; for (const c of running) c.abort();
    await Promise.allSettled(running.map(c => c.finished));
    await sync.stop();
    await new Promise(r => server.close(r)); store.close();
  };
  const onRequest = async (req, res) => {
    try {
      const host = req.headers.host;
      const allowedHosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
      if (!allowedHosts.includes(host)) return json(res, 403, { error: '仅允许本机访问桌面管理接口' });
      const origin = req.headers.origin;
      if (origin && !allowedHosts.some(h => origin === `http://${h}`)) return json(res, 403, { error: '拒绝跨站请求' });
      const url = new URL(req.url, `http://${host}`), path = url.pathname;
      if (path.startsWith('/api/')) {
        if (req.headers['x-agent-token'] !== csrf) return json(res, 403, { error: '页面会话已过期，请刷新' });
        if (req.method === 'POST' && path === '/api/shutdown') { json(res, 200, { ok: true }); setImmediate(() => close().catch(() => {})); return; }
        if (closing) return json(res, 503, { error: '服务正在停止' });
        if (req.method === 'GET' && path === '/api/state') return json(res, 200, { config: publicConfig(), slots: store.list('slot').map(({ save, ...s }) => { const { text, ...personaInfo } = resolvePersona({ ...s, save }); return { ...s, personaInfo, diaryCount: save.data.diary?.length || 0 }; }), sessions: store.list('session').map(({ system, tools, profile, ...s }) => ({ ...s, model: profile.model, permissions: profile.permissions })), sync: sync.info() });
        if (req.method === 'GET' && path === '/api/providers') return json(res, 200, PROVIDERS);
        if (req.method === 'POST' && path === '/api/models') {
          const b = await readJSON(req, 20000);
          const base = normalizeBaseURL(b.baseURL);
          if (b.apiKey !== undefined && typeof b.apiKey !== 'string') throw new Error('Key 应为文本');
          const key = b.apiKey === undefined ? savedKey(base) : b.apiKey.trim();
          const controller = new AbortController();
          const disconnected = () => { if (!res.writableEnded) controller.abort(); };
          res.on('close', disconnected);
          try { return json(res, 200, await listModels(base, key, { signal: controller.signal })); }
          finally { res.off('close', disconnected); }
        }
        if (req.method === 'POST' && path === '/api/config') {
          const body = await readJSON(req, 50000);
          const next = { ...config };
          for (const k of Object.keys(defaults)) if (body[k] !== undefined) next[k] = body[k];
          next.baseURL = normalizeBaseURL(next.baseURL);
          if (next.baseURL !== config.baseURL && body.apiKey === undefined) next.apiKey = '';
          if (body.provider === undefined) next.provider = inferProvider(next.baseURL);
          if (!PROVIDERS.some(p => p.id === next.provider)) throw new Error('厂商选项无效');
          if (typeof next.model !== 'string' || typeof next.workspace !== 'string' || typeof next.apiKey !== 'string') throw new Error('配置字段类型错误');
          if (!['ask', 'full', 'workspace'].includes(next.permissions)) throw new Error('权限模式无效');
          for (const [key, min, max] of [['maxTokens', 256, 131072], ['maxContextChars', 10000, 4000000], ['historyChars',4000,100000], ['timeoutMs', 1000, 600000]]) if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw new Error(`${key} 超出有效范围`);
          if (!['max_tokens', 'max_completion_tokens'].includes(next.tokenParameter)) throw new Error('输出长度字段无效');
          if (next.temperature !== null && (!Number.isFinite(next.temperature) || next.temperature < 0 || next.temperature > 2)) throw new Error('temperature 应为空或 0–2');
          if (!next.extraBody || typeof next.extraBody !== 'object' || Array.isArray(next.extraBody)) throw new Error('扩展参数必须是 JSON 对象');
          for (const k of ['messages', 'tools', 'stream', 'model', 'max_tokens', 'max_completion_tokens']) if (k in next.extraBody) throw new Error(`扩展参数不允许覆盖 ${k}`);
          next.workspace = resolve(next.workspace); mkdirSync(next.workspace, { recursive: true });
          atomicJSON(configPath, next); config = next;
          return json(res, 200, publicConfig());
        }
        if (req.method === 'POST' && path === '/api/slots') { const body = await readJSON(req, 4096); return json(res, 200, store.createSlot(String(body.name || '新存档').slice(0, 100))); }
        if (req.method === 'POST' && path === '/api/import') { const body = await readJSON(req); return json(res, 200, { id: store.importSave(body.save, body.slotId).id }); }
        const slotMatch = path.match(/^\/api\/slots\/([^/]+)(?:\/(export|persona|diaries|memories))?$/);
        if (slotMatch) {
          const [, slotId, action] = slotMatch, slot = store.get('slot', slotId);
          if (!slot) return json(res, 404, { error: '槽位不存在' });
          if (req.method === 'GET' && action === 'export') return json(res, 200, slot.save);
          if (req.method === 'GET' && action === 'diaries') return json(res, 200, slot.save.data.diary || []);
          if (req.method === 'GET' && action === 'memories') { indexDiaries(store, slotId); return json(res, 200, store.list('memory').filter(m => m.slotId === slotId)); }
          if (req.method === 'GET' && action === 'persona') {
            const key = url.searchParams.has('key') ? url.searchParams.get('key') || null : slot.personaKey;
            validatePersonaKey(slot, key);
            return json(res, 200, { current: resolvePersona(slot), card: resolvePersona({ ...slot, persona: '', personaKey: key }), choices: personaChoices(slot) });
          }
          if (req.method === 'POST' && action === 'persona') { const b = await readJSON(req, 100000); if (typeof b.persona !== 'string') throw new Error('人设应为文本'); store.updatePersona(slotId, b.persona, String(b.name || slot.name), b.personaKey); return json(res, 200, { ok: true }); }
        }
        if (req.method === 'POST' && path === '/api/sessions') {
          const b = await readJSON(req, 4096); return json(res, 200, createSession(store, b.slotId, config, TOOLS));
        }
        const memoryMatch = path.match(/^\/api\/memories\/([^/]+)\/delete$/);
        if (req.method === 'POST' && memoryMatch) { store.transaction(() => forgetMemory(store, memoryMatch[1])); return json(res, 200, { ok: true }); }
        const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/decision$/);
        if (req.method === 'POST' && approvalMatch) { const b = await readJSON(req, 4096); return json(res, 200, approvals.decide(approvalMatch[1], b.decision)); }
        const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(run|stop|delete))?$/);
        if (sessionMatch) {
          const [, sessionId, action] = sessionMatch, session = store.get('session', sessionId);
          if (!session) return json(res, 404, { error: '会话不存在' });
          if (req.method === 'POST' && action === 'delete') { const b = await readJSON(req, 4096); return json(res, 200, await agent.remove(sessionId, b.mode === 'discard')); }
          if (req.method === 'GET' && !action) return json(res, 200, { ...session, effectivePermissions: config.permissions, approvals: approvals.list(sessionId), messages: store.messages(sessionId), usage: usageSummary(store.usages(sessionId)), artifacts: store.list('artifact').filter(a => a.sessionId === sessionId) });
          if (req.method === 'POST' && action === 'stop') { agent.stop(sessionId); return json(res, 200, { ok: true }); }
          if (req.method === 'POST' && action === 'run') {
            const b = await readJSON(req, 24 * 1024 * 1024);
            if (agent.running.has(sessionId)) return json(res, 409, { error: '会话正在运行' });
            if (session.closed) return json(res, 409, { error: '会话已结束，请新建会话' });
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            // Browser navigation must not cancel a running command or lose a diary.
            try { await agent.run(sessionId, b.diary ? DIARY_REQUEST : b.text, event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); }, { retry: Boolean(b.retry), diary: Boolean(b.diary), firstSpeak: b.firstSpeak === true, images:b.diary?[]:b.images }); }
            catch { /* Agent persists the failure and emits the recoverable error. */ }
            res.end(); return;
          }
        }
        const artifactMatch = path.match(/^\/api\/artifacts\/([^/]+)$/);
        if (req.method === 'GET' && artifactMatch) {
          const artifact = store.get('artifact', artifactMatch[1]); if (!artifact) return json(res, 404, { error: '文件记录不存在' });
          const info = statSync(artifact.path); if (!info.isFile()) throw new Error('产出路径已不是文件');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(artifact.path))}`, 'Content-Length': info.size });
          const stream = createReadStream(artifact.path); stream.on('error', () => res.destroy()); stream.pipe(res); return;
        }
        if (req.method === 'POST' && path === '/api/sync') {
          const b = await readJSON(req, 4096);
          if (b.action === 'sync') { await sync.start(syncPort); return json(res, 200, sync.requestSync()); }
          if (b.action === 'start') { await sync.start(syncPort); return json(res, 200, sync.info()); }
          if (b.action === 'stop') { await sync.stop(); return json(res, 200, sync.info()); }
          if (b.action === 'pair') return json(res, 200, sync.renewPin());
          if (b.action === 'revoke') { sync.revoke(b.deviceId); return json(res, 200, sync.info()); }
        }
        const conflictMatch = path.match(/^\/api\/conflicts\/([^/]+)$/);
        if (req.method === 'GET' && conflictMatch) {
          const conflict = store.get('conflict', conflictMatch[1]); if (!conflict) return json(res, 404, { error: '冲突记录不存在' });
          return json(res, 200, conflict);
        }
        return json(res, 404, { error: '接口不存在' });
      }
      const assets = { '/conversation-starter.js': ['conversation-starter.js', 'text/javascript'], '/': ['index.html', 'text/html'], '/chat-display.js':['chat-display.js','text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/icon.svg': ['icon.svg','image/svg+xml'], '/icon.ico': ['icon.ico','image/x-icon'], '/icon-256.png': ['icon-256.png','image/png'], '/manifest.webmanifest': ['manifest.webmanifest','application/manifest+json'] };
      if (req.method !== 'GET' || !assets[path]) return json(res, 404, { error: '页面不存在' });
      const [file, type] = assets[path];
      let content = readFileSync(join(project, 'public', file), ['icon.ico','icon-256.png'].includes(file) ? undefined : 'utf8');
      if (file === 'index.html') content = content.replace('__AGENT_TOKEN__', csrf);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'X-Content-Type-Options': 'nosniff' }); res.end(content);
    } catch (e) { if (!res.headersSent) json(res, e.status || 400, { error: e.message }); else res.end(); }
  };
  dispatch = onRequest;
  const actualPort = server.address().port;
  return { server, store, agent, sync, url: `http://127.0.0.1:${actualPort}`, close };
  } catch (e) { await new Promise(r => server.close(r)); store?.close(); throw e; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startApp().then(app => {
    console.log(`PERCH_READY ${app.url}`);
    const stop = async () => { await app.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch(e => { console.error(`启动失败：${e.message}`); process.exitCode = 1; });
}
