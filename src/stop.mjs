const url = `http://127.0.0.1:${Number(process.env.PERCH_PORT || process.env.MEIJU_AGENT_PORT || 39781)}`;
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  const page = await response.text();
  const token = page.match(/name="agent-token" content="([^"]+)"/)?.[1];
  if (!response.ok || !token) throw new Error('此端口不是桌面 Agent，未停止其他服务');
  const result = await fetch(`${url}/api/shutdown`, { method: 'POST', headers: { 'X-Agent-Token': token }, signal: AbortSignal.timeout(3000) });
  if (!result.ok) throw new Error('停止请求失败');
  console.log('已请求停止服务，运行进度会保留。');
} catch (e) {
  if (e.cause?.code === 'ECONNREFUSED') console.log('桌面 Agent 当前未运行。');
  else { console.error(e.message); process.exitCode = 1; }
}
