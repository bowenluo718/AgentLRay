# ADR-0005：平台来源统一与全表面等价（package / project / user）

- **状态**：accepted（2026-11-07）
- **取代**：ADR-0001 Q11「不做 per-platform 启停开关，文件存在=启用」
- **关联**：
  - [design-platform-equivalence.zh-CN.md](design-platform-equivalence.zh-CN.md)（完整设计）
  - [plan-platform-equivalence.zh-CN.md](plan-platform-equivalence.zh-CN.md)（实施计划）
  - [adr-0001-custom-platform-adapter.zh-CN.md](adr-0001-custom-platform-adapter.zh-CN.md)（自定义适配器模型）
  - [adr-0002-co-mind-platform.zh-CN.md](adr-0002-co-mind-platform.zh-CN.md)（薄适配器可行性历史结论）
  - [design-custom-platforms.zh-CN.md](design-custom-platforms.zh-CN.md)、[design-new-session-create.zh-CN.md](design-new-session-create.zh-CN.md)

## 背景

已有能力：7 个内置平台（openclaw/codex/claude-code/omp/dsh/gemini/hermes）+ 用户目录运行时适配器（`~/.agentlray/platforms/*.js`）。但内置平台 id 与专属能力散布在 `lib/routes/sessions.js`、`lib/session-list.js`、`lib/search.js`、`lib/prompts.js`、`lib/insights.js`、`lib/inspect.js`、`lib/backup.js`、`lib/resume.js`、`lib/new.js`、`lib/cli-bins.js` 与前端多处，导致：

1. 内置与自定义只在“能列会话”层面等价，children/spawn/agents/watch/search/insights/prompts/tool-audit/OTLP/backup/inspect 不等价；
2. 自定义平台不能放进项目内随包分发，内置平台不能迁到用户目录由用户维护；
3. 没有平台级启停，内置平台无法被禁用，也无法被用户版本替代。

旧设计 `design-platform-mount`（v1）只做 mount/unmount，未解决上述缺口，评审不通过。本 ADR 记录 v2 的架构决策。

## 决策

### D1 三类平台来源

| 来源 | 位置 | 分发方式 | 信任级别 |
| --- | --- | --- | --- |
| `package` | `lib/platforms/builtin/*.js` | 随 npm 包 | 与 AgentLRay 本体相同 |
| `project` | `<repo>/platforms/*.js` | 随仓库分发（`package.json files` 含 `platforms`） | 与仓库代码相同 |
| `user` | `~/.agentlray/platforms/*.js` | 用户手工放置 | 用户自行信任 |

环境变量覆盖：`AGENTLRAY_PROJECT_PLATFORMS_DIR`、`AGENTLRAY_PLATFORMS_DIR`；`AGENTLRAY_NO_PLUGINS=1` 只保留 `package`。测试必须隔离三类目录。

### D2 加载顺序与同 id 规则

加载顺序固定为 `package → project → user`，后者覆盖前者仅在同 id 被显式声明“替代”时允许：

- 新 id：直接加入 catalog；
- 同一来源内重复 id：后加载者为 broken，不覆盖；
- `project`/`user` 同 id 覆盖 `package`：仅当 settings `platforms.replaced` 或项目 `platforms/manifest.json` 的 `replaces` 包含该 id；
- `user` 同 id 覆盖 `project`：允许（用户优先）；
- 未声明替代的同 id 覆盖：broken，错误文案提示 `platform export` / `platform replace`。

### D3 `disabled` 与 `replaced` 分离

- `platforms.disabled: string[]`：**id 级完全停用**，优先级最高；被禁用的 id 不进入 `PLATFORMS`，但保留在 catalog 供设置面板重新启用。
- `platforms.replaced: string[]`：**仅表示包内置来源被同 id 的外部文件替代**；不改变挂载状态。
- 替代文件缺失/损坏：回退包内置适配器并标记 `replacementPending: true`，同时生成 broken 条目，平台不消失。
- `platform export <id>` 默认写用户目录、加入 `replaced`（不加入 `disabled`）、并把 id 移出 `disabled`（迁移语义），因此“导出后原内置仍可用、导出文件坏了回退内置”。

### D4 catalog / PLATFORMS / listPlatformInfo

- `ALL_PLATFORMS`（catalog）：全部已知平台（package + project + user + broken），**不过滤 disabled**。
- `PLATFORMS`：当前进程实际已挂载（catalog 中未 disabled 且未 broken）。
- `listPlatformInfo()` **必须遍历 catalog**，每项输出 `mounted` / `configuredMounted` / `restartRequired` / `origin` / `overrides` / `replacementPending`；从 `PLATFORMS` 派生会让 disabled 平台在设置面板消失，无法重新启用。

### D5 守卫与默认平台

- 停用守卫：`catalog − (disabled ∪ {目标 id})` 中至少存在 1 个“可查询”平台；可查询谓词为 `list || listForAgent || listAllAgents`。不得使用进程内 `PLATFORMS` 快照做守卫，否则连续停用可把平台全部禁掉。
- `defaultPlatformId()`：首个已挂载可查询平台（保持现有插入序，openclaw 优先）；所有“缺省平台”入口统一使用它，禁止再写死 `'openclaw'`。

### D6 全表面 hook 契约（Adapter v2）

等价范围定义为**全表面**，adapter 契约从“能列会话”扩展到：

- 数据面：`list`、`listForAgent`、`listAllAgents`、`listAgents`、`find`、`parse`、`getSession`、`getSessionAcrossAgents`、`collectFiles`、`watch`、`watchParse`、`listChildren`、`getChild`、`spawnMap`、`spawnTree`；
- 分析面：`search`、`searchFile`、`searchSupplement`、`computeInsights`、`insightsScanFile`、`extractPrompts`、`extractPromptsFromFile`、`computeToolAudit`、`scanToolAuditFile`；
- 导出面：`otlpSession`、`backupFiles`、`inspect`、`export`（复用 `getSession`）；
- 动作面：`resume`、`create`、`resumeHooks`、`bin`、`dirSettingKey`、`dirSettingLabel`、`dirSettingHint`、`dirParam`、`color`。

编排模块只按 hook 选择路径，不再出现内置 id 分支。内置平台与自定义平台走同一代码路径。

### D7 模块边界（防 require 环）

- `lib/platform-config.js` 不 require registry；catalog 由调用方传入。
- `lib/platforms/*-impl.js`（search/prompts/insights/tool-audit/backup/inspect）不 require 编排模块。
- builtin adapter 不 require `lib/resume.js`、`lib/new.js`、`lib/cli-bins.js`、`lib/platforms/index.js`；命令 args 内联。
- `lib/platforms/index.js` 不 require `lib/cli-bins.js`。

### D8 设置写路径单一

`settings.platforms` 只由 `PUT/DELETE /api/platforms/:id/mount`、`PUT/DELETE /api/platforms/:id/replace` 与 CLI `platform mount/unmount/replace/unreplace` 写入。`PUT /api/settings` 忽略 `platforms`，避免设置面板统一 draft 与平台开关即时写冲突。`GET /api/settings` 只读透出 `platforms` 供面板展示。

### D9 生效语义

- 服务进程：`disabled`/`replaced` 在 require 期读取，**重启后生效**；同进程内控制端点只落盘并返回 `restart: true`。
- CLI：每次执行是新进程，**即时生效**。
- 前端以 `mounted`（当前进程）与 `configuredMounted`（已落盘）区分，显示“重启后生效”。

### D10 迁移采用薄适配器 + 包根解析

`platform export <id>` 生成薄适配器：

```js
const path = require('path');
module.exports = require(path.join(process.env.AGENTLRAY_PKG_ROOT, 'lib/platforms/builtin', '<id>.js'));
```

`AGENTLRAY_PKG_ROOT` 由 loader 在加载自定义平台前注入。这样迁移文件不复制实现、不随包内版本漂移；包根缺失时该平台 broken 并给出明确错误。此决策**修订** ADR-0002 的“薄适配器不可行”结论——不可行的根因是当时没有稳定的包根注入契约，现已补上。

## 后果

正面：

- 内置/项目/自定义平台在全表面同一路径，新增能力只需扩 hook；
- 项目内可携带平台并随包分发；
- 内置平台可导出为用户目录版本并由 `replaced` 管理，坏了自动回退；
- 平台级停用可逆，且设置面板能看到未挂载平台。

负面/成本：

- Adapter v2 契约显著变大，自定义平台实现成本上升（可选 hook 可按能力缺位）；
- 需一次性重构 12+ 个服务端模块与前端多处硬编码，回归面大；
- 项目/用户目录平台仍是可执行 JS，信任边界不变（`AGENTLRAY_NO_PLUGINS=1` 可关闭）；
- 导入导出、脚本生成等仓库外工具若硬编码平台 id，需同步排查。

## 备选方案

1. **只做 mount/unmount（v1 设计）**：不满足全表面等价与双向迁移，否决。
2. **JSON 声明式平台**：无法表达 find/parse/children/spawn 等逻辑，否决（ADR-0001 已论证）。
3. **迁移文件复制完整实现**：与包内版本漂移，升级后行为不一致，否决。
4. **`replaced` 并入 `disabled`**：导出后原内置消失，替代文件损坏时平台整体不可用，否决。

## 与旧决策的关系

- ADR-0001 的加载器、信任边界、能力位缺位语义继续有效；其 **Q11「不做 per-platform 启停开关」被本 ADR 取代**。
- ADR-0002 的“薄适配器 require AgentLRay 内部模块不可行”被 D10 修订；co-mind 仍保留自包含实现，不强制迁移。
- ADR-0004 的 create 契约保留，但内置 `NEW_BINS` 将迁入 adapter 声明（P1）。
