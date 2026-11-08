'use strict';
// 单一设置端点 GET/PUT /api/settings —— web 设置面板唯一读写的服务端设置入口。
// 所有设置聚合存 ~/.agentlray/settings.json（各 section 白名单/校验在对应 lib
// 模块）。GET 全量返回（LLM 密钥永不明文回传，只回 hasApiKey）；PUT 仅保存请求
// 体提供的 section（ui / cliBins / status / kanban / llm），原子写入。
const { loadUiSettings, saveUiSettings } = require('../ui-settings');
const { loadCliBins, saveCliBins, resolveCliBin, cliBinDefaults } = require('../cli-bins');
const { loadStatusConfig, saveStatusConfig, STATUS_DEFAULTS } = require('../status-config');
const { loadKanbanConfig, saveKanbanConfig, KANBAN_DEFAULTS } = require('../kanban-config');
const { loadLlmConfig, saveLlmConfig, llmBackend, ANALYSIS_TIMEOUT_DEFAULT_MS } = require('../llm');
const { settingsResult } = require('../settings');
const { ALL_PLATFORMS, defaultPlatformId } = require('../platforms');

module.exports = function mountSettingsRoutes(app, { status } = {}) {
  // 读取各 section 的干净存储（白名单 + 校验后）。
  async function loadStored() {
    const [ui, cliBins, statusCfg, kanban, llm] = await Promise.all([
      loadUiSettings(),
      loadCliBins(),
      loadStatusConfig(),
      loadKanbanConfig(),
      loadLlmConfig(),
    ]);
    return { ui, cliBins, status: statusCfg, kanban, llm };
  }

  // 组装 GET/PUT 响应：cliBins 的 bin 反映「实际生效命令」= 环境变量 → 配置 → 默认，
  // 与 bin/sessions.js resume 的 resolveCliBin() 完全一致。
  async function buildResponse(stored) {
    const cliBins = {};
    for (const [id, def] of Object.entries(cliBinDefaults())) {
      cliBins[id] = {
        bin: await resolveCliBin(id),
        configured: Boolean(stored.cliBins[id]),
        default: def,
      };
    }
    return {
      ui: stored.ui || { platform: null, selectedPlatforms: [] },
      cliBins,
      status: settingsResult(stored.status, STATUS_DEFAULTS),
      kanban: settingsResult(stored.kanban, KANBAN_DEFAULTS),
      llm: {
        baseUrl: stored.llm.baseUrl,
        model: stored.llm.model,
        // 实际生效的分析超时：未配置时回默认，便于前端回显。
        analysisTimeoutMs: stored.llm.analysisTimeoutMs ?? ANALYSIS_TIMEOUT_DEFAULT_MS,
        // 密钥只写不读：回传是否已配置，绝不明文。
        hasApiKey: Boolean(stored.llm.apiKey),
        backend: await llmBackend(),
      },
      // platforms：只读镜像（listPlatformInfo({configured:true}) 的简洁形态）——
      // 前端设置面板据此展示启停/替代控制，写经 /api/platforms/:id/mount|replace。
      platforms: {
        default: defaultPlatformId(),
        ids: [...ALL_PLATFORMS.keys()],
      },
    };
  }

  app.get('/api/settings', async (_req, res) => {
    try {
      res.json(await buildResponse(await loadStored()));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/settings', async (req, res) => {
    try {
      const body = req.body || {};
      // ui：平台白名单校验（沿用原 /api/settings/ui 语义）。
      if (body.ui !== undefined) {
        const ui = body.ui || {};
        // 平台白名单校验：catalog（含 disabled）——UI 可展示/持久化已停用平台。
        const platform =
          typeof ui.platform === 'string' && ALL_PLATFORMS.has(ui.platform) ? ui.platform : null;
        if (ui.platform !== undefined && platform === null) {
          return res.status(400).json({ error: 'platform must be one of: ' + [...ALL_PLATFORMS.keys()].join(', ') });
        }
        let selectedPlatforms = [];
        if (Array.isArray(ui.selectedPlatforms)) {
          selectedPlatforms = ui.selectedPlatforms.filter((p) => ALL_PLATFORMS.has(p));
        } else if (ui.selectedPlatforms !== undefined) {
          return res.status(400).json({ error: 'selectedPlatforms must be an array' });
        }
        await saveUiSettings({ platform, selectedPlatforms });
      }
      // cliBins：白名单过滤 + 空值清除，合并写 section。
      if (body.cliBins !== undefined) await saveCliBins(body.cliBins);
      // status：保存即注入运行时状态判定（与 server / CLI 启动注入一致）。
      if (body.status !== undefined) {
        const saved = await saveStatusConfig(body.status);
        if (status && typeof status.setStatusConfig === 'function') {
          status.setStatusConfig(saved);
        }
      }
      // kanban：纯配置，无运行时注入。
      if (body.kanban !== undefined) await saveKanbanConfig(body.kanban);
      // llm：apiKey 语义沿用原 /api/settings/llm——缺省=保留、'' = 清除、否则替换；
      // baseUrl 被清空时一并清 key。
      if (body.llm !== undefined) {
        const llm = body.llm || {};
        const baseUrl = typeof llm.baseUrl === 'string' ? llm.baseUrl.trim() : '';
        const model = typeof llm.model === 'string' ? llm.model.trim() : '';
        if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
          return res.status(400).json({ error: 'baseUrl must start with http:// or https://' });
        }
        if (baseUrl && !model) {
          return res.status(400).json({ error: 'model is required when baseUrl is set' });
        }
        const current = await loadLlmConfig();
        const apiKey = typeof llm.apiKey === 'string' ? llm.apiKey : current.apiKey;
        // 请求体带 analysisTimeoutMs（含 0/非法 → 清除回默认）则透传，否则保留现状。
        await saveLlmConfig(
          llm.analysisTimeoutMs !== undefined
            ? { baseUrl, apiKey: baseUrl ? apiKey : '', model, analysisTimeoutMs: llm.analysisTimeoutMs }
            : { baseUrl, apiKey: baseUrl ? apiKey : '', model }
        );
      }
      res.json(await buildResponse(await loadStored()));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
