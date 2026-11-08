'use strict';
// platform-disabled-route.test.js 的夹具：在独立进程内按需把 gemini 视为「catalog 有、
// 未挂载」并请求会话端点，stdout 输出一行 JSON 结果。argv 不参与决策，由环境变量
// AGENTLRAY_NO_PLUGINS 决定：=1 时全部内置挂载（对照组），否则强制 gemini 未挂载。
const assert = require('node:assert/strict');
const lib = require('../lib/platforms');

const mountPlatformsRoutes = require('../lib/routes/platforms');

// 构造未挂载态：gemini 在 catalog，但不在 PLATFORMS。
if (process.env.AGENTLRAY_FORCE_DISABLED_GEMINI === '1') {
  const gemini = lib.ALL_PLATFORMS.get('gemini')?.adapter ?? require('../lib/platforms/builtin/gemini');
  // 条目（含损坏的遗留条目）都在 ALL_PLATFORMS 里；测试不依赖 settings，直接覆盖为有效条目。
  lib.ALL_PLATFORMS.set('gemini', { adapter: gemini, origin: 'package', overrides: null, replacementPending: false });
  delete lib.PLATFORMS.gemini;
}

const express = require('express');
const app = express();
// 对照组若本机已停用 gemini，则把适配器补回 PLATFORMS（无该 adapter 时无从构造）。
if (process.env.AGENTLRAY_FORCE_DISABLED_GEMINI !== '1' && !lib.PLATFORMS.gemini) {
  lib.PLATFORMS.gemini = lib.ALL_PLATFORMS.get('gemini')?.adapter ?? require('../lib/platforms/builtin/gemini');
}
const mountSessionRoutes = require('../lib/routes/sessions');
mountPlatformsRoutes(app);
mountSessionRoutes(app);
app.use((_req, res) => res.status(200).json({ spa: true })); // SPA 兜底（与 server.js 类似）

const server = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  };
  const out = {
    geminiSessions: await get('/api/gemini/sessions'),
    geminiSession: await get('/api/gemini/sessions/x'),
    unknownSessions: await get('/api/nosuchplatform/sessions'),
  };
  server.close(() => {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  });
});
