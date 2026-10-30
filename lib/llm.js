const fs = require('fs');
const path = require('path');
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
// 的 llm.analysisTimeoutMs（毫秒）。缺省 600s：原先 240s 对 235B 级模型出完整
// 聚类 JSON 偏紧，容易触发超时中止。钳制下限留 2s 供集成测试快速触达中止路径，
// 上限 1h 防止误填把一次损坏请求挂死整天。
const ANALYSIS_TIMEOUT_DEFAULT_MS = 600_000;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: input }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`LLM 端点返回 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) {
      throw new Error('LLM 端点响应缺少 choices[0].message.content');
    }
    return text;
  } catch (err) {
    // 超时定时器触发 abort() 时，undici 报原生文案 "This operation was aborted"，
    // 无超时语义；重抛带时长的可读错误，让 UI 一眼可诊断。
    if (err && err.name === 'AbortError') {
      const timeoutErr = new Error(`LLM 请求超过 ${Math.round(timeoutMs / 1000)}s 未完成，已中止`);
      timeoutErr.code = 'LLM_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
