# 终端会话命令平台非必填：缺省使用页面持久化的平台数据

> 类型：方案设计 · 更新：2026-10-26 · 对应实现：已合入主干 `72dee90`（见项目根 `AGENTS.md`）

## 问题

`agentlray sessions list/show/resume` 的 `--platform` 目前必填。终端命令与 web 看板是两个入口，
看板把平台选择持久化在浏览器 `localStorage`（`agent-xray-settings`，键 `platform` /
`selectedPlatforms`），CLI（Node 进程）无法读取”——两处视角一旦不一致，命令用得别扭。

## 决策

`--platform` 转**非必填**；缺省使用**页面持久化的平台数据**。为让浏览器端数据能被 CLI 读取，
新增一条「前端 → 后端落盘 → CLI 读取」通道，与 `llm.json` / `hidden-prompts.json` 的既有持久化
模式一致：

```
web 看板 persistState() ──PUT /api/settings/ui──▶ ~/.agentlray/ui-settings.json ◀─读─ agentlray sessions
   localStorage(agent-xray-settings)                 { platform, selectedPlatforms, updatedAt }
```

## 改动清单

- **`lib/ui-settings.js`（新增）**：读写 `~/.agentlray/ui-settings.json`；`loadUiSettings()` 文件缺失/损坏 → `null`。
- **`lib/routes/ui-settings.js`（新增）**：`GET /api/settings/ui` 返回持久化值（缺省
  `{platform:null, selectedPlatforms:[]}`）；`PUT` 只收 `PLATFORMS` 注册表白名单内的平台，拒绝脏数据；挂载于 `server.js`。
- **前端 `store.ts`**：`persistState()` 内 fire-and-forget `PUT` 平台选择（DEMO 模式跳过）；
  `client.ts` 新增 `saveUiSettings()`（与 `saveLlmSettings` 同构的 API fetcher）。
- **`bin/sessions.js`**：`--platform` 转可选；`main` 里 `opts.platform == null` 时按子命令推导缺省：
  - `list`：持久化 `selectedPlatforms` 非空 → 按集合查询（全选 → `all`）；空（单平台模式）→ `platform`；
    无持久化 → `all`（与前端「无持久化默认全部平台聚合」一致）。
  - `show` / `resume`：用持久化单平台 `platform`；无数据 → usage 报错要求显式 `--platform`。

## 边界与取舍

- `show`/`resume` 本质单平台，无持久化数据时**报错**而非猜测默认（避免查错平台）。
- 多选（持久化 `selectedPlatforms` 非空）时 `--dir` 依旧报「仅支持单平台模式」，与显式多选一致。
- `resume` 持久化单平台若不支持续跑（如 openclaw），沿用既有「No native resume」报错路径。
- DEMO 构建（无真实后端）跳过 API 同步，仅本地 `localStorage` 持久化不受影响。

## 验证

- `test/api.test.js`：`ui settings persist` 组——GET 缺省、PUT 持久化 + 落盘文件、非法平台 400 / 过滤。
- `test/session-cli.test.js`：缺省无持久化=list all、多选集合、全选=all、单平台模式、`--dir` 报错、
  show/resume 无数据报错、show/resume 用持久化单平台、resume 不支持平台报错。
- 冒烟：真实环境看板选 `omp`+`hermes` → `~/.agentlray/ui-settings.json` 落盘 →
  `agentlray sessions list` 缺省返回 `omp,hermes`。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（后续由 `ui` section / `ui.platform` 默认平台语义承接）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 前端持久化 → 服务端设置 | ✅ 已实现 | `lib/ui-settings.js`、`lib/routes/settings.js` |
| CLI 缺省 `--platform` 读取页面持久化 | ✅ 已实现 | `bin/sessions.js` |

