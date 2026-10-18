import { normalizeBaseURL } from './providers.mjs';

export async function listModels(baseURL, apiKey = '', { timeoutMs = 20000, signal } = {}) {
  const base = normalizeBaseURL(baseURL);
  let response;
  try {
    response = await fetch(`${base}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean)) });
  } catch (e) {
    if (signal?.aborted) throw new Error('已取消模型同步');
    if (e.name === 'TimeoutError') throw new Error('同步模型超时，请检查网络或接口地址');
    throw new Error('无法连接模型列表接口，请检查网络及地址；不支持重定向地址');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const reasons = { 401: 'Key 无效或未填写', 403: 'Key 没有访问权限', 404: '该地址不提供模型列表，可手动填写模型', 429: '请求过于频繁，请稍后重试' };
    throw new Error(`同步模型失败（HTTP ${response.status}）：${reasons[response.status] || '服务商返回错误，请稍后重试'}`);
  }
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error('模型列表过大，请手动填写模型'); chunks.push(chunk); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('模型接口返回的不是有效 JSON，请检查地址'); }
  if (!Array.isArray(data?.data)) throw new Error('模型接口未返回兼容的 data 列表，可手动填写模型');
  const models = new Map();
  for (const row of data.data) {
    if (typeof row?.id !== 'string' || !row.id.trim() || row.id.length > 500 || /[\u0000-\u001f]/.test(row.id)) continue;
    const modelId = row.id.trim();
    if (!models.has(modelId)) models.set(modelId, { id: modelId, name: typeof row.name === 'string' ? row.name.slice(0, 200) : modelId });
  }
  return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), fetchedAt: Date.now() };
}

export function normalizeUsage(usage = {}) {
  const number = n => Number.isFinite(n) && n >= 0 ? n : null;
  const input = number(usage.prompt_tokens ?? usage.input_tokens);
  const cached = number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens);
  const output = number(usage.completion_tokens ?? usage.output_tokens);
  const valid = input !== null && cached !== null && cached <= input;
  return { input, cached: valid ? cached : null, output, reasoning:number(usage.completion_tokens_details?.reasoning_tokens??usage.output_tokens_details?.reasoning_tokens), ratio: valid && input > 0 ? cached / input : null, cacheWrite: number(usage.prompt_tokens_details?.cache_write_tokens ?? usage.input_tokens_details?.cache_write_tokens), reported: valid, timestamp: Date.now() };
}
export function usageSummary(rows) {
  const measured = rows.filter(r => r.reported);
  const input = measured.reduce((s, r) => s + r.input, 0), cached = measured.reduce((s, r) => s + r.cached, 0);
  const last=rows.at(-1),turn=last?.turnId?rows.filter(r=>r.turnId===last.turnId):last?[last]:[];
  const totalInput=rows.some(r=>r.input!=null)?rows.reduce((n,r)=>n+(r.input||0),0):null;
  return { requests: rows.length, measured: measured.length, input, totalInput, cached, uncached:measured.length?input-cached:null, ratio: input > 0 ? cached / input : null, output: rows.reduce((s, r) => s + (r.output || 0), 0), last: last || null, turn:{requests:turn.length,input:turn.some(r=>r.input!=null)?turn.reduce((n,r)=>n+(r.input||0),0):null,uncached:turn.every(r=>r.reported)?turn.reduce((n,r)=>n+r.input-r.cached,0):null,output:turn.reduce((n,r)=>n+(r.output||0),0),reasoning:turn.reduce((n,r)=>n+(r.reasoning||0),0)} };
}
export async function completion(profile, apiKey, messages, tools, signal) {
  if (!profile.model?.trim()) throw new Error('请先配置模型名称，并创建新会话');
  const base = profile.baseURL.replace(/\/+$/, '');
  const url = new URL(`${base}/chat/completions`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('接口地址必须是 HTTP 或 HTTPS');
  const body = { ...(profile.extraBody || {}), model: profile.model, messages, tools, stream: false };
  body[profile.tokenParameter || 'max_tokens'] = profile.maxTokens;
  if (profile.temperature !== null && profile.temperature !== undefined) body.temperature = profile.temperature;
  const combined = AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutMs || 180000)].filter(Boolean));
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal: combined });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`模型接口 HTTP ${response.status}，请检查接口、模型、密钥或额度`); }
  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error('接口没有返回 choices[0].message；当前支持 Chat Completions 兼容协议');
  return { message: choice.message, finish: choice.finish_reason, usage: normalizeUsage(data.usage) };
}
