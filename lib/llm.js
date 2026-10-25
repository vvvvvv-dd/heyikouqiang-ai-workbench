/**
 * 大模型适配层（可选增强）
 * 协议：OpenAI 兼容 /chat/completions，支持 DeepSeek、混元、通义、OpenAI、本地 Ollama 等
 * 未配置或调用失败时，由调用方自动降级到本地引擎 —— 断网也能完整演示。
 */
const store = require('./store');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.resolve(__dirname, '..', 'config.json');
function defaults() {
  return { enabled: false, baseURL: '', apiKey: '', model: '', timeout: 25000, temperature: 0.7 };
}

function getSettings() {
  let cfg = defaults();
  try {
    if (fs.existsSync(CONFIG_FILE)) Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).llm || {});
  } catch (e) { /* ignore */ }
  const rt = store.read('llm', {});
  Object.assign(cfg, rt);
  if (process.env.LLM_API_KEY) { cfg.apiKey = process.env.LLM_API_KEY; cfg.enabled = cfg.enabled || !!cfg.baseURL; }
  return cfg;
}

function saveSettings(patch) {
  let file = {};
  try { if (fs.existsSync(CONFIG_FILE)) file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { }
  file.llm = { ...(file.llm || {}), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(file, null, 2), 'utf8');
  // 敏感项不落 store，运行时只保留非密钥字段
  const rt = { enabled: file.llm.enabled, baseURL: file.llm.baseURL, model: file.llm.model, temperature: file.llm.temperature };
  store.write('llm', rt);
  return file.llm;
}

function available() {
  const s = getSettings();
  return !!(s.enabled && s.baseURL && s.apiKey && s.model);
}

async function chat(messages, opts = {}) {
  const s = getSettings();
  if (!available()) return { ok: false, error: '未配置大模型', fallback: true };
  const url = s.baseURL.replace(/\/$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeout || 25000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
      body: JSON.stringify({
        model: s.model,
        messages,
        temperature: opts.temperature ?? s.temperature ?? 0.7,
        stream: false
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 200)}`, fallback: true };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content) return { ok: false, error: '返回为空', fallback: true };
    return { ok: true, content, raw: data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? '调用超时' : e.message, fallback: true };
  }
}

async function test() {
  const s = getSettings();
  if (!s.baseURL || !s.apiKey || !s.model) return { ok: false, error: '配置不完整（baseURL / apiKey / model 必填）' };
  const t0 = Date.now();
  const r = await chat([{ role: 'user', content: '回复两个字：正常' }]);
  return r.ok ? { ok: true, ms: Date.now() - t0, model: s.model, sample: r.content.slice(0, 40) } : r;
}

module.exports = { chat, test, getSettings, saveSettings, available };
