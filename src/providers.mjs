// Endpoint presets only. Model IDs are discovered from the user's endpoint, never guessed.
export const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', docs: 'https://developers.openai.com/api/reference/resources/models/methods/list' },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', docs: 'https://api-docs.deepseek.com/' },
  { id: 'moonshot', name: 'Kimi / 月之暗面', baseURL: 'https://api.moonshot.cn/v1', docs: 'https://platform.moonshot.cn/docs' },
  { id: 'siliconflow', name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', docs: 'https://docs.siliconflow.cn/docs/userguide/quickstart' },
  { id: 'bailian', name: '阿里云百炼（北京）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', note: '北京地域公共地址；也可改填控制台提供的业务空间专属地址。', docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope' },
  { id: 'ollama', name: 'Ollama（本机）', baseURL: 'http://127.0.0.1:11434/v1', docs: 'https://docs.ollama.com/api/openai-compatibility' },
  { id: 'lmstudio', name: 'LM Studio（本机）', baseURL: 'http://127.0.0.1:1234/v1', docs: 'https://lmstudio.ai/docs/developer/openai-compat' },
  { id: 'custom', name: '自定义 / 中转站', baseURL: '', note: '填写服务商给出的 OpenAI 兼容地址。' }
];
export function normalizeBaseURL(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写接口地址');
  let url; try { url = new URL(value.trim()); } catch { throw new Error('接口地址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('接口地址应为 HTTP/HTTPS 基础地址，不含账号、查询参数或片段');
  return url.href.replace(/\/+$/, '');
}
export function inferProvider(baseURL) {
  const normalized = normalizeBaseURL(baseURL);
  return PROVIDERS.find(p => p.baseURL && normalizeBaseURL(p.baseURL) === normalized)?.id || 'custom';
}
