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
const { loadDirsConfig, saveDirsConfig, dirEnvActive } = require('../dirs-config');
const { applyPlatformSection, readPlatformStateSync } = require('../platform-config');
const { settingsResult } = require('../settings');
const { ALL_PLATFORMS, PLATFORMS, defaultPlatformId } = require('../platforms');

module.exports = function mountSettingsRoutes(app, { status } = {}) {
  // 读取各 section 的干净存储（白名单 + 校验后）。
  async function loadStored() {
    const [ui, cliBins, statusCfg, kanban, llm, dirs] = await Promise.all([
      loadUiSettings(),
      loadCliBins(),
      loadStatusConfig(),
      loadKanbanConfig(),
      loadLlmConfig(),
      loadDirsConfig(),
    ]);
    return { ui, cliBins, status: statusCfg, kanban, llm, dirs };
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
    const dirs = {};
    // 目录配置只对已挂载且声明 dirSettingKey 的平台有意义（dirSettingKey 在挂载的
    // adapter 上，catalog 元数据不含）；未挂载/未声明 → 不展示目录行。
    for (const [id, p] of Object.entries(PLATFORMS)) {
      if (!p || typeof p.dirSettingKey !== 'string' || !p.dirSettingKey) continue;
      dirs[id] = {
        key: p.dirSettingKey,
        value: stored.dirs[p.dirSettingKey] || '',
        configured: Boolean(stored.dirs[p.dirSettingKey]),
        envActive: dirEnvActive(p),
        default: typeof p.defaultDir === 'function' ? p.defaultDir() : null,
      };
    }
    const platformState = readPlatformStateSync();
    return {
      ui: stored.ui || { platform: null, selectedPlatforms: [] },
      cliBins,
      dirs,
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
      // 前端设置面板据此展示启停/替代控制；写可经 /api/platforms/:id/mount|replace
      // 或随统一保存 PUT /api/settings 的 platforms section（disabled/replaced）。
      platforms: {
        default: defaultPlatformId(),
        ids: [...ALL_PLATFORMS.keys()],
        disabled: platformState.disabled,
        replaced: platformState.replaced,
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
      // dirs：白名单 + 绝对路径校验 + env 生效平台忽略（saveDirsConfig 内）。
      // 键为平台 dirSettingKey（codexDir/openclawDir/…）。
      if (body.dirs !== undefined) await saveDirsConfig(body.dirs);
      // platforms：启停/替代随统一保存提交。一次原子应用（applyPlatformSection）：
      // 读一次 → 内存算最终 disabled/replaced → last-queryable 守卫在最终态校验 →
      // 单次写盘。避免逐个 setPlatformMounted 在「停用多平台触发守卫」时前半部分已
      // 落盘的半提交（整体 422 必须零写盘）。{ disabled, replaced } 为全集，null 表示
      // 该列表不变。
      if (body.platforms !== undefined) {
        const plat = body.platforms || {};
        await applyPlatformSection(
          {
            disabled: Array.isArray(plat.disabled) ? plat.disabled : null,
            replaced: Array.isArray(plat.replaced) ? plat.replaced : null,
          },
          ALL_PLATFORMS
        );
      }
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
      // 平台启停守卫（复用 platform-config）：最后一个可查询平台不可停用 → 422，
      // 与独立 mount 端点（lib/routes/platforms.js）口径一致。
      if (error && error.code === 'last-platform') {
        return res.status(422).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });
};
