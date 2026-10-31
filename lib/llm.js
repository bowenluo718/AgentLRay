const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { execFile } = require('child_process');
const { readSettings, saveSections } = require('./settings');

// --- LLM backend abstraction (#14) ---
// Every LLM-backed feature (prompt rewrites, cluster suggestions, name
// suggestions) goes through runLlm(). Backend priority:
//   1. Explicit OpenAI-compatible endpoint from ~/.agentlray/settings.json's
//      llm section (baseUrl + model required, apiKey optional for local servers).
//   2. A `claude` CLI on PATH (the original behavior).
// With neither available, runLlm throws err.code = 'NO_LLM_BACKEND' whose
// message carries setup guidance — routes surface it instead of a grey button.

// Test seam: point at a nonexistent binary to simulate a machine without claude.
const CLAUDE_BIN = process.env.AGENTLRAY_CLAUDE_BIN || 'claude';

const EMPTY_CONFIG = { baseUrl: '', apiKey: '', model: '' };

// 提示词画像分析（runClaudeAnalysis）的 LLM 单次请求上限，存在 settings.json
// 的 llm.analysisTimeoutMs（毫秒）。缺省 900s（15 分钟）：真实 MaaS 网关对 235B
// 级模型的非流式分析生成实测 >5 分钟才回响应头，10 分钟偏紧；该默认经直连路径
// （见 runOpenAiDirect）生效，超时给出明确「已中止」。钳制下限留 2s 供集成测试
// 快速触达中止路径，上限 1h 防止误填把一次损坏请求挂死整天。
const ANALYSIS_TIMEOUT_DEFAULT_MS = 900_000;
const ANALYSIS_TIMEOUT_MIN_MS = 2_000;
const ANALYSIS_TIMEOUT_MAX_MS = 3_600_000;

// 非正整数/缺失 → 默认；越界 → 钳制到 [MIN, MAX]。
function normalizeAnalysisTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return ANALYSIS_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(Math.round(n), ANALYSIS_TIMEOUT_MIN_MS), ANALYSIS_TIMEOUT_MAX_MS);
}

async function readLlmSection() {
  const data = await readSettings();
  const section = data.llm;
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

async function loadLlmConfig() {
  const section = await readLlmSection();
  return {
    baseUrl: typeof section.baseUrl === 'string' ? section.baseUrl.trim() : '',
    apiKey: typeof section.apiKey === 'string' ? section.apiKey : '',
    model: typeof section.model === 'string' ? section.model.trim() : '',
    analysisTimeoutMs: normalizeAnalysisTimeoutMs(section.analysisTimeoutMs),
  };
}

// 保存到 settings.json 的 llm section；缺失字段沿用现状（供 API 层做
// 「缺省=保留密钥」语义），原子写由 lib/settings.js 保证。
async function saveLlmConfig(config) {
  const section = await readLlmSection();
  if (config.baseUrl !== undefined) {
    section.baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  }
  if (config.apiKey !== undefined) {
    section.apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
  }
  if (config.model !== undefined) {
    section.model = typeof config.model === 'string' ? config.model.trim() : '';
  }
  if (config.analysisTimeoutMs !== undefined) {
    // 0/空/非法 → 清除该键，load 时回默认（与「空串=回默认」惯例一致）。
    const n = Number(config.analysisTimeoutMs);
    section.analysisTimeoutMs =
      Number.isFinite(n) && n > 0
        ? Math.min(Math.max(Math.round(n), ANALYSIS_TIMEOUT_MIN_MS), ANALYSIS_TIMEOUT_MAX_MS)
        : undefined;
  }
  await saveSections({ llm: section });
  return loadLlmConfig();
}

// Cheap PATH scan (no subprocess): is a claude CLI available?
function findClaudeCli() {
  if (path.isAbsolute(CLAUDE_BIN)) {
    try {
      fs.accessSync(CLAUDE_BIN, fs.constants.X_OK);
      return CLAUDE_BIN;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, CLAUDE_BIN);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

function runClaudeCli(input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(CLAUDE_BIN, ['-p'], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function runOpenAi(config, input, timeoutMs) {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`);
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const body = JSON.stringify({ model: config.model, messages: [{ role: 'user', content: input }] });

  // ⚠️ 不要直接给 fetch 传 undici 自定义 dispatcher 来抬高 headersTimeout：实测
  // 自定义 dispatcher 会绕过 Node 的 env-proxy 路由（NODE_USE_ENV_PROXY），导致
  // 需代理的外部端点直连失败。因此「需要代理」的请求保留默认 fetch（Node 自行
  // 裁决 NO_PROXY），仅直连走自有超时的 http(s) 实现。
  const res = proxyRequiredFor(url)
    ? await runOpenAiViaFetch(url, headers, body, timeoutMs)
    : await runOpenAiDirect(url, headers, body, timeoutMs);

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`LLM 端点返回 ${res.status}: ${(res.text || '').slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error(`LLM 端点响应非 JSON: ${(res.text || '').slice(0, 300)}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) {
    throw new Error('LLM 端点响应缺少 choices[0].message.content');
  }
  return text;
}

// fetch 路径（需要代理的外部端点）：node 的 env-proxy 由默认 dispatcher 处理。
// 注意 undici 默认 headersTimeout=300s：网关非流式生成若超过 5 分钟才回响应头，
// 会先于本请求自己的超时抛 "fetch failed (UND_ERR_HEADERS_TIMEOUT)"——外部端点
// 一般短响应，维持原行为；直连路径则完全绕开该上限（见 runOpenAiDirect）。
async function runOpenAiViaFetch(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    // 超时定时器触发 abort() 时，undici 报原生文案 "This operation was aborted"，
    // 无超时语义；重抛带时长的可读错误，让 UI 一眼可诊断。
    if (err && err.name === 'AbortError') {
      const timeoutErr = new Error(`LLM 请求超过 ${Math.round(timeoutMs / 1000)}s 未完成，已中止`);
      timeoutErr.code = 'LLM_TIMEOUT';
      throw timeoutErr;
    }
    // fetch 的网络层失败底部原因包在 err.cause（如 UND_ERR_HEADERS_TIMEOUT /
    // ECONNREFUSED），拼进消息，避免 UI 只看到裸 "fetch failed"。
    if (err && err.message === 'fetch failed') {
      const cause = err.cause;
      const hint = cause ? ` (${cause.name}: ${cause.message || ''})` : '';
      const wrapped = new Error(`LLM 请求网络失败${hint}`);
      wrapped.code = 'LLM_NETWORK';
      throw wrapped;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 直连路径（真实网关/内网/本地端点，NO_PROXY 覆盖）：用 node http(s) 自有墙钟
// 超时，绕开 undici 全局 fetch 默认 headersTimeout=300s 的隐藏上限——大模型非流
// 式生成超过 5 分钟才回响应头时，undici 会先掐断连接报 "fetch failed"，把真正
// 的慢生成误判成网络错误。这里永远由本请求的 timeoutMs 决定收口，超时给出明确
// 的「已中止」，网络错误给出底层 syscall/code（ECONNREFUSED / ENOTFOUND / 证书）。
function runOpenAiDirect(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    let timer;
    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = lib.request(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        finish(resolve)({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', finish(reject));
    });
    req.on('error', finish(reject));
    timer = setTimeout(() => {
      req.destroy();
      finish(reject)(
        Object.assign(new Error(`LLM 请求超过 ${Math.round(timeoutMs / 1000)}s 未完成，已中止`), {
          code: 'LLM_TIMEOUT',
        })
      );
    }, timeoutMs);
    req.write(body);
    req.end();
  });
}

// 目标主机是否需要走环境代理（Node env-proxy 语义的保守子集）：无代理配置 → 直连；
// 有代理且主机被 NO_PROXY 命中（精确 / 后缀 / * 通配）→ 直连；否则 → 走代理。
// 边界处一律偏向「走代理」：让 Node 的 fetch 用自己的 NO_PROXY 匹配兜底，安全。
function proxyRequiredFor(url) {
  const isHttps = url.protocol === 'https:';
  const env = process.env;
  const proxy = (isHttps ? env.https_proxy || env.HTTPS_PROXY : env.http_proxy || env.HTTP_PROXY) || env.all_proxy || env.ALL_PROXY;
  if (!proxy) return false;
  return !hostExcludedFromProxy(url.hostname);
}

function hostExcludedFromProxy(host) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!raw.trim()) return false;
  const h = host.toLowerCase();
  for (const entry of raw.split(',')) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (e === '*') return true;
    if (net.isIP(h)) {
      if (h === e) return true;
      continue; // IP 通配/CIDR 交给 fetch 路径由 Node 裁决，本节一律不算命中（安全）
    }
    const suffix = e.replace(/^[*.]*/, '');
    if (!suffix) return true;
    if (h === suffix || h.endsWith('.' + suffix)) return true;
  }
  return false;
}

// Which backend would runLlm use right now? 'openai' | 'claude-cli' | null.
async function llmBackend() {
  const config = await loadLlmConfig();
  if (config.baseUrl && config.model) return 'openai';
  return findClaudeCli() ? 'claude-cli' : null;
}

async function runLlm(input, timeoutMs) {
  const config = await loadLlmConfig();
  if (config.baseUrl && config.model) return runOpenAi(config, input, timeoutMs);
  if (findClaudeCli()) return runClaudeCli(input, timeoutMs);
  const err = new Error(
    '未配置 LLM 后端：在 设置 → LLM 接口 填入 OpenAI 兼容端点的 Base URL 与模型名（API Key 视端点可选），或安装并登录 claude CLI（npm i -g @anthropic-ai/claude-code）。'
  );
  err.code = 'NO_LLM_BACKEND';
  throw err;
}

module.exports = {
  loadLlmConfig,
  saveLlmConfig,
  findClaudeCli,
  llmBackend,
  runLlm,
  ANALYSIS_TIMEOUT_DEFAULT_MS,
};
