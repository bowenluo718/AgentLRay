'use strict';
// 内置平台 omp 适配器（P1 从 lib/platforms/index.js 逐字搬迁 + 声明字段）。
// 不 require resume.js / new.js / cli-bins.js / index.js —— 声明内联。
const fsp = require('fs/promises');
const path = require('path');
const { OMP_DIR } = require('../../../config');
const {
  ompSessionIdFromFile,
  findOmpSessionFile,
  listOmpSessions,
  normalizeOmpRecord,
  parseOmpSessionFile,
  parseOmpSessionMetadata,
  findOmpSpawnDir,
} = require('./parse');
const { fileBasedGetSession } = require('../../shared/helpers');
const { createOmpResumeHooks } = require('./resume');
const { extractOmpPrompts } = require('./prompts');
const { enumerateOmpFiles } = require('./backup');
const { ompRawToolEntries } = require('./inspect');

module.exports = {
  id: 'omp',
  label: 'OMP',
  // 目录设置：数据目录 tab（settings.json ui section 的 ompDir）。
  dirSettingKey: 'ompDir',
  dirSettingLabel: 'OMP 会话目录',
  dirSettingHint: 'OMP（oh-my-pi）会话目录',
  dirParam: 'dirOmp',
  color: '#ffd33d',
  // resume / create / bin 声明（与旧 RESUME_BINS / NEW_BINS / CLI_BIN_DEFAULTS 逐字对齐）。
  resume: { bin: 'omp', args: (id) => ['--auto-approve', `--resume=${id}`] },
  create: { bin: 'omp', args: () => ['--auto-approve'] },
  bin: 'omp',
  defaultDir: () => OMP_DIR,
  list: listOmpSessions,
  find: findOmpSessionFile,
  parse: parseOmpSessionFile,
  getSession: fileBasedGetSession(findOmpSessionFile, parseOmpSessionFile),
  // 续跑治理（P2）：同 id 续跑、不接受派生。omp 专属实现对 CLI 不可见，bin 只认
  // 通用的 resumeHooks 契约（prepare/after）。
  resumeHooks: createOmpResumeHooks(),
  // OMP subagents: children live as <slug>/<timestamp>_<sessionId>/<AgentName>.jsonl。
  listChildren: async (dir, sessionId) => {
    const spawnDir = await findOmpSpawnDir(dir, sessionId);
    if (!spawnDir) return [];
    const entries = await fsp.readdir(spawnDir, { withFileTypes: true });
    const children = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const meta = await parseOmpSessionMetadata(path.join(spawnDir, e.name), e.name).catch(() => null);
      children.push({
        name: e.name.replace(/\.jsonl$/, ''),
        file: e.name,
        title: meta?.title || null,
        timestamp: meta?.timestamp || null,
        lastActivity: meta?.lastActivity || null,
        messageCount: meta?.messageCount || 0,
        toolCallCount: meta?.toolCallCount || 0,
      });
    }
    children.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    return children;
  },
  // 无 spawn 目录返回 null（路由 → 'No subagents for this session'）；子文件缺失抛 ENOENT。
  getChild: async (dir, sessionId, name) => {
    const spawnDir = await findOmpSpawnDir(dir, sessionId);
    if (!spawnDir) return null;
    return parseOmpSessionFile(path.join(spawnDir, name + '.jsonl'));
  },
  collectFiles: async (dir) => {
    const files = [];
    const slugs = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const slugDir = path.join(dir, s.name);
      const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          files.push({ path: path.join(slugDir, f.name), file: f.name, sessionId: ompSessionIdFromFile(f.name) });
        }
      }
    }
    return files;
  },
  watchParse: (rec) => {
    if (rec.type === 'session') return { session: { id: rec.id, cwd: rec.cwd, timestamp: rec.timestamp } };
    const normalized = normalizeOmpRecord(rec);
    return normalized && normalized.length ? { messages: normalized } : null;
  },
  // Prompts 面：OMP 记录格式专用提取器。
  extractPromptsFromFile: (filePath) => extractOmpPrompts(filePath),
  // 离线 inspect 面：记录规范化 + 原始工具 id 提取 + 参与 adapter 指纹的源文件。
  inspect: {
    normalize: normalizeOmpRecord,
    rawToolEntries: ompRawToolEntries,
    adapterFiles: ['builtin/omp/index.js', 'builtin/omp/parse.js', 'builtin/omp/inspect.js', 'builtin/omp/outcome.js'],
  },
  // 备份面：归档到 <ARCHIVE_DIR>/omp/<rel>。
  backupFiles: (dir) => enumerateOmpFiles(dir),
};
