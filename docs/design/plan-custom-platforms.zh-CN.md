# 实施计划：自定义平台扩展（plan-custom-platforms）

> 设计依据：`design-custom-platforms.zh-CN.md`（决策 Q1–Q12 全定稿）+ `adr-0001-custom-platform-adapter.zh-CN.md`。
> 基线：当前工作区（含未提交的会话状态 / openclaw 全 agent 改动）。
> 原则：每阶段跑覆盖该改动的**最小测试集** + 一次冒烟，通过才进下一阶段；不改 `src/generated/`。

## P0 — 契约与加载器（后端地基）

- 新增 `lib/platforms/loader.js`：`loadPlatformAdapters(registry)`
  - 读 `~/.agentlray/platforms/*.js`（按字母序），逐文件 `require`
  - 校验：导出对象、`id` 匹配 `^[a-z0-9][a-z0-9-]*$`、`label` 字符串、必需函数存在
  - id 冲突（内置/先前自定义）→ broken；单文件 try/catch 隔离
  - `AGENTLRAY_NO_PLUGINS=1` 跳过加载
  - 返回 `{ customAdapters, brokenAdapters }`
- `lib/platforms/index.js` 模块末尾接入 loader，并入 `PLATFORMS`
- **验证**：单测（id 正则/冲突/broken/逃生）；放一个抛错 + 一个正常适配器冒烟 `agentlray sessions list` 不中断、broken 可见

## P1 — 服务端表面

- 新增 `lib/routes/platforms.js`：`GET /api/platforms`（`id/label/builtin/capabilities/broken/error`），`server.js` 挂载
- `lib/routes/watch.js`：补 `platform.watchParse` 缺位守卫 → 400
- **验证**：测试 + 冒烟——自定义平台走通 `GET /api/:platform/sessions`、详情、export、OTLP；无 `collectFiles` 时 search/audit 缺位不报错；`PUT /api/settings/ui` 白名单含自定义 id；`/api/watch` 对无 watchParse 适配器 400

## P2 — CLI platform 子命令

- 新增 `bin/platform.js`：`list`（输出内置+自定义+broken，与 `/api/platforms` 同源）、`validate <file>`（共用 loader 校验 → 调 `list(defaultDir())` 报计数/首条 id/错误）
- `bin/agentlray.js` 增加 `platform` 分发；`docs/.local/cli-usage.md` 补章节
- **验证**：`--json` 输出约定对齐 CLI 既有（`{schemaVersion:1,…}`）；对样例适配器 validate 通过/对坏文件报错

## P3 — resume opt-in

- `bin/sessions.js`：`RESUME_BINS` 保留为内置回退；未命中查 `platform.resume`（`bin` 默认名 + `args(id,opts)`），可执行名经 `resolveCliBin()` 解析（`cli-bins.json` 的 `<id>` 键可覆盖）
- **验证**：声明 `resume` 的自定义平台 `sessions resume` 生成命令、`--run` spawn 正确 bin；未声明报「无原生续跑」；内置三平合行为不变（回归 `test/session-cli.test.js`）

## P4 — React 前端（服务端驱动）

- `frontend/src/api/types.ts`：`Platform` 枚举 → 服务端 `PlatformInfo`（`id/label/builtin/capabilities/broken/error`），运行时拉 `GET /api/platforms`
- `client.ts` / `queries.ts` / `store.ts`：平台列表与路径拼写改运行时
- `Sidebar.tsx`（选择/多选）、`SettingsDialog.tsx`（数据目录 tab / CLI 命令 tab）消费运行时列表；broken 徽标 + 错误，不参与查询，不做启停
- **验证**：起 frontend dev server，自定义平台出现在平台栏，可查列表/详情；无残留 `PLATFORMS` 常量依赖

## P5 — legacy 前端（最小侵入）

- `public/js/app.js`：`platforms` 数组保留内置表，启动 `GET /api/platforms` 追加 `builtin:false` 且未 broken 的自定义平台
- 9 处硬编码分发（列表/详情/探活/首启候选）补「非内置 → 通用 `/api/:platform/...`」兜底；broken 徽标；watch 仅在含 `watchParse` 时发 `/api/watch`
- **验证**：起 server，自定义平台在 legacy 看板可查列表/详情，broken 徽标可见

## P6 — 收尾

- 适配器样例模板文档（如 `docs/.local/custom-platform-example.zh-CN.md` 或并入 usage）
- `docs/usage*.md` 增补「自定义平台」章节
- 核对 `docs/.local/README.md` 索引（词表/设计/ADR/本计划）+ glossary 一致性

## 依赖与并行

`P0 → P1 → P2` 串行（后端闭环）；`P3` 依赖 P0；`P4`/`P5` 各自依赖 P1（`/api/platforms`），互相独立可并行。P6 收全部。

## 完成判据

`platform validate` 对样例适配器通过即后端闭环可用；`sessions list/show/resume` 对自定义平台可用；React+legacy 均可展示自定义平台与 broken 徽标；全部新增单测 + 受影响既有测试绿。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（P0–P6）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| P0 加载器 / P1 服务端表面 | ✅ 已实现 | `lib/platforms/`、`lib/routes/platforms.js` |
| P2 CLI / P3 resume opt-in | ✅ 已实现 | `bin/platform.js`、`lib/resume.js` |
| P4–P6 前端与收尾 | ✅ 已实现 | `frontend/src/components/Sidebar.tsx`、`SettingsDialog.tsx` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
