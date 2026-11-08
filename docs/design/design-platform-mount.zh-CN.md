# 设计：内置平台 mount/unmount（design-platform-mount）

> ⚠️ **已被取代（2026-11-07）**：本设计未覆盖“项目内平台目录”“内置迁移到用户目录”“全表面严格等价”，评审不通过。请以 [design-platform-equivalence.zh-CN.md](design-platform-equivalence.zh-CN.md) 与 [plan-platform-equivalence.zh-CN.md](plan-platform-equivalence.zh-CN.md) 为准；本文仅保留历史。
>
> 状态：方案定稿（待评审）。基线：当前工作区（含自定义平台扩展 P0–P5、会话状态、openclaw 全 agent 等已合入改动）。
> 关联：`adr-0001-custom-platform-adapter.zh-CN.md`（自定义平台加载器）、`design-custom-platforms.zh-CN.md`、`design-new-session-create.zh-CN.md`、`plan-custom-platforms.zh-CN.md`。
> 目标：**内置平台（openclaw/codex/claude-code/omp/dsh/gemini/hermes）与自定义平台统一到同一注册模型 + 同一 mount/unmount 生命周期，不再把内置平台 id 硬编码散布到其它代码**。

---

## 1. 问题与动机

AgentLRay 的平台注册表 `lib/platforms/index.js` 里，内置平台是**内联硬编码**的：

- 想停用一个内置平台没有入口，只能接受它永远存在；自定义平台（`~/.agentlray/platforms/*.js`）天然有"文件在=挂载、文件删=移除"的插拔语义。**两者行为不对称**。
- 内置平台的 id 与专属逻辑**散布耦合**在大量下游模块里，新增/移除内置平台都要动这些地方：
  - `lib/routes/sessions.js`：openclaw 特判（`req.params.platform === 'openclaw'`，且跑在 `PLATFORMS[...]` 查找**之前**）、目录参数映射 `PER_PLATFORM_DIR_PARAM`、omp/claude-code 的 children 专属路由。
  - `lib/resume.js` / `lib/new.js`：`RESUME_BINS` / `NEW_BINS` 能力表（内置六/五平台）。
  - `lib/cli-bins.js`：`CLI_BIN_DEFAULTS` / `CLI_BIN_ENV`（内置六平台）。
  - `lib/export.js` / `lib/otlp.js` / `lib/tool-audit.js`：require 期 `Object.values(PLATFORMS)` 快照派生。
  - `lib/session-list.js`：`id === 'openclaw'` 分支。
  - `server.js`：boot 日志硬编码打印七个平台目录。
  - 前端 `store.ts`（`dirForPlatform` switch + `FALLBACK_PLATFORM_INFOS`）、`client.ts`（`ALL_DIR_PARAMS`）、`SettingsDialog.tsx`（平台→设置字段映射）、`usePlatformProbe.ts`、legacy `app.js`。
- 同一份"平台 → 目录设置键 / query 参数名"映射在多处重复（`dirForPlatform`、`ALL_DIR_PARAMS`、`PER_PLATFORM_DIR_PARAM`、`SettingsDialog`），漂移风险高。

**本次改造成果**：内置平台可从黑名单停用/启用，与该平台相关的一切表面（会话路由、聚合、探活、设置面板、导出/OTLP/审计快照、CLI）随 mount 状态**自动一致收敛**；平台能力与目录参数改为 **adapter 声明式**，内置与自定义走完全同一模型。

## 2. 关键决策（已确认）

| # | 决策点 | 结论 | 理由 |
| --- | --- | --- | --- |
| D1 | 生效时机 | **重启生效**（`bin/*` CLI 每次新进程天然即时；仅常驻 `server.js` 重启生效） | 与自定义平台"加删文件后重启"语义一致；require 期快照零改动，改动面最小最稳 |
| D2 | 控制入口 | **CLI 命令 + Web 设置面板** | 体验完整（`agentlray platform mount/unmount` + 设置面板平台启停开关） |
| D3 | 挂载状态存储 | settings 新增 `platforms: { disabled: string[] }` **黑名单** | 升级语义干净：缺省空→全部内置默认挂载；未来新增内置平台默认可见。白名单需逐用户改，会让新平台静默消失。自定义平台同样可被禁用（保留文件但停用） |
| D4 | openclaw 特判 | **不做**；统一受一条通用守卫：**不能 unmount 最后一个可查询平台** | 保证聚合视图 `platform=all`、CLI 默认平台、前端回退总有落点；同时体现"内置与自定义统一生命周期" |
| D5 | openclaw 能否被禁用 | 能（只要不是最后一个可查询平台） | 前端回退链（`setPlatforms` openclaw 优先→首项）、`bin/sessions.js` 运行时 `PLATFORMS[ui.platform]`、`routes/settings.js` 的 `PLATFORMS[ui.platform]` 校验都能处理 openclaw 缺席 |
| D6 | 能力/参数硬编码表 | 删除 `RESUME_BINS`/`NEW_BINS`/`CLI_BIN_DEFAULTS`/`CLI_BIN_ENV`/`PER_PLATFORM_DIR_PARAM`/`ALL_DIR_PARAMS`，收敛为 adapter 声明字段 | 内置与自定义同一模型；单一真源防漂移 |
| D7 | legacy 前端 | **不改**（AGENTS.md 冻结快照，只受安全修复） | 既定降级：unmount 平台在 legacy 页签仍显示但探活 0/err（其 `/api/<id>/sessions` 404） |
| D8 | 离线降级表 | `FALLBACK_PLATFORM_INFOS` 恒列 7 内置全挂载 | 服务器不可达本就读不到挂载态，降级为全量展示是合理退化；正常链路以 `/api/platforms` 的 `mounted` 为准 |

## 3. 架构核心

### 3.1 统一注册模型

内置平台与自定义平台都产出**同一形状的 adapter 对象**，合并进同一 `PLATFORMS` 注册表：

```text
lib/platforms/
├── index.js              # 组装层：require builtin → loader 合并自定义 → 剔除 disabled → 导出
├── loader.js             # （既有）自定义平台加载器
├── shared.js             # 共享 helper（含上移的 fileBasedGetSession）
└── builtin/
    ├── openclaw.js       # 每个内置平台一个 adapter 文件
    ├── codex.js
    ├── claude-code.js
    ├── omp.js
    ├── dsh.js
    ├── gemini.js
    └── hermes.js
```

- 每个 builtin adapter 文件独立 `require` 其纯函数实现库（`../codex.js` 等）与 `lib/config` 目录常量，导出完整 adapter。
- `index.js` 退化为纯组装层，`PLATFORMS` 按**现实际插入序**（openclaw, codex, claude-code, omp, dsh, gemini, hermes）显式列出——该序即 `listPlatformInfo` 输出序，也即前端页签序，不能抖。
- 唯一共享点：`fileBasedGetSession(find, parse)`（现 index.js 私有，5 个内置共用）上移到 `shared.js`。

### 3.2 registry = 已挂载平台集合（重启生效的根）

`PLATFORMS` 在**模块求值期**完成 disabled 过滤（**过滤在导出前**）：

- 所有 require 期快照（`export.js` 的 `EXPORT_PLATFORMS`、`otlp.js` 的 `OTLP_PLATFORMS`、`tool-audit.js` 的 `TOOL_AUDIT_PLATFORMS`）自然不含被禁平台 → **零改动**。
- 所有请求期活引用（`session-list.js`、`routes/watch.js`、`routes/settings.js` 读同一个单例对象）自动一致。
- 前提：过滤在模块求值期完成，且 `PLATFORMS` 是进程内唯一最终单例（require 缓存保证 index.js 只跑一次）。

**关键坑（假卸载）**：`routes/sessions.js` 里通用平台路由的 openclaw 特判分支在 `PLATFORMS[...]` 查找**之前**就命中返回。若 openclaw 从 `PLATFORMS` 移除，`/api/openclaw/sessions` 依然可查——**unmount 根本没生效**。所以硬编码 `=== 'openclaw'` 分支**必须**泛化为 `p.needsAgent`（同为 P1 解耦点，非可选）。`lib/session-list.js::listPlatformSessions` 的 `id === 'openclaw'` 同理。

### 3.3 能力与目录参数声明化

内置 adapter 新增声明字段，拟语义与自定义平台一致：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `resume` | `{ bin, args(id, opts?) }` | 原生续跑契约。从 `RESUME_BINS` 逐条平移；openclaw 不声明 |
| `create` | `{ bin, args(opts) }` | 原生新建契约。从 `NEW_BINS` 逐条平移；dsh 不声明（本就不支持新建） |
| `bin` | `string\|null` | CLI 默认可执行名。**claude-code 的默认是 `claude`（≠ id），务必照搬** |
| `dirSettingKey` | `string\|null` | 前端/聚合请求的目录设置键（如 `codexDir`）。query 参数名由规则 `'dir'+首字母大写` 派生，与现 `ALL_DIR_PARAMS`/`PER_PLATFORM_DIR_PARAM` 逐字一致 |

约束（防环）：builtin adapter 文件**禁止** require `resume.js`/`new.js`/`cli-bins.js`/`index.js` 取表或取函数，args 一律内联在 adapter 文件里。

删表后 `hasResumeContract`/`hasCreateContract`/`buildResumeCommand`/`buildNewCommand`/`resolveCliBin` 统一走 adapter 声明，内置与自定义同一路径。

### 3.4 平台专属路由按 adapter 挂载

omp/claude-code 的 children 路由（4 个）、openclaw 的 agent/spawn 管理端点，迁入 `lib/routes/platform-extra.js`：`id → [{ method, path, handler }]` 映射 + `mountPlatformExtraRoutes(app)` 按 `PLATFORMS[id]` 存在性挂载——**挂载即路由，卸载即 404**。

## 4. 数据 / 接口契约

### 4.1 settings 新 section：`platforms`

```jsonc
{
  "platforms": {
    "disabled": ["codex"]      // 黑名单；缺省 [] = 全部内置挂载
  }
}
```

- 白名单/校验归属 `lib/platform-config.js`（仿 `status-config.js` 组织）。
- **同步读入口（关键坑）**：`lib/settings.js::readSettings` 是 async（`fsp.readFile`），模块求值期调不到。必须用 `fs.readFileSync` + `JSON.parse` 写独立 `readDisabledSync()`（容错缺失/损坏→`[]`，按 `ID_RE` 过滤非法 id），这是整个 registry 唯一受控的 require 期同步读。路径与 `lib/settings.js` 同一 `HOME/.agentlray/settings.json` 推导（`HOME = AGENTLRAY_HOME || os.homedir()`）。

### 4.2 GET /api/platforms 扩展

`listPlatformInfo()` 每条增：
- `mounted: boolean` —— 当前是否挂载（可查询）
- `dirSettingKey?: string` —— 目录设置键
- `source: 'builtin' | 'custom'`

## 5. 发布影响与兼容

- **空黑名单零回归**：存量用户无 `platforms` section → `disabled: []` → 全部内置挂载（现状不变，`registry.test.js` 断言 7 平台全在手仍通过）。
- **向后兼容**：`RESUME_BINS`/`NEW_BINS` 内容平移进 adapter 后命令串**逐字不变**（`test/new.test.js` 命令串断言仍通过）；`GET /api/settings/cli-bins` 兼容端点保留，仅数据源改 adapter。
- **无数据库/元数据变更**（纯设置 + 代码重构）。
- **无组件/插件/配置兼容性风险**（非运行态，无插件扩展点改动）。

## 6. 双前端降级说明

| 前端 | 行为 | 说明 |
| --- | --- | --- |
| React（功能开发面） | 以 `/api/platforms` 的 `mounted` 为准：页签/聚合/探活/新建/设置面板只列已挂载；设置面板提供平台启停开关 | 正常链路 |
| legacy（冻结快照，不改） | unmount 平台页签仍显示但探活 0/err | 既定降级，仅接受安全修复 |
| 离线降级表 | `FALLBACK_PLATFORM_INFOS` 恒列全挂载 | 服务器不可达读不到挂载态，合理退化 |

## 7. 待办 / 后续（不计入本方案）

- **运行时热生效**（写入后无需重启）：需把 export/otlp/tool-audit 的 require 期快照改为惰性派生、处理运行时 registry 可变，改动面大。可作为后续独立版本。
- openclaw 的 `/api/agents*`/`/api/spawn-*` 管理端点是否随 openclaw 卸载一并消失：建议随 P1 纳入 platform-extra，与"卸载即消失"一致观感。

---

*注：本文件为**设计定稿**，实现步骤见 `plan-platform-mount.zh-CN.md`。*
