import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startApp } from './server.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) throw new Error('Node.js 24 or newer is required.');
const port = Number(process.env.PERCH_PORT || process.env.MEIJU_AGENT_PORT || 39781);
let url = `http://127.0.0.1:${port}`, alreadyRunning = false, app;
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  alreadyRunning = response.ok && (await response.text()).includes('name="agent-token"');
} catch {}
if (!alreadyRunning) {
  app = await startApp({ port }); url = app.url;
  console.log(`桌面 Agent 已启动：${url}\n本窗口是服务控制台。按 Ctrl+C 或运行“停止.cmd”可停止服务。`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} else console.log(`使用已运行的桌面 Agent：${url}`);
if ((process.env.PERCH_NO_WINDOW || process.env.MEIJU_AGENT_NO_WINDOW) !== '1') {
  const edge = join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  if (existsSync(edge)) {
    // Open an ordinary visible app window; the Node server remains in this console.
    const window = spawn(edge, [`--app=${url}`, '--window-size=1280,900'], { detached: true, stdio: 'ignore' });
    const launcher = new URL('../栖.exe', import.meta.url);
    if (process.platform === 'win32' && existsSync(launcher)) { const decorate = spawn(fileURLToPath(launcher), ['--decorate'], { detached: true, stdio: 'ignore' }); decorate.on('error', () => {}); decorate.unref(); }
    window.on('error', e => console.error(`请在浏览器打开 ${url}（${e.message}）`)); window.unref();
  } else console.log(`请在浏览器打开：${url}`);
}
