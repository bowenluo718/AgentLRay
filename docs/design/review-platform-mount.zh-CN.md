# 评审意见：内置平台 mount/unmount 设计与实施计划

> 评审对象：
> - [design-platform-mount.zh-CN.md](design-platform-mount.zh-CN.md)（下称“设计”）
> - [plan-platform-mount.zh-CN.md](plan-platform-mount.zh-CN.md)（下称“计划”）
>
> 评审基线：当前工作区（含自定义平台 P0–P5、会话状态、openclaw 全 agent、新建会话等已合入改动）。
> 评审要求（用户原话）：**内置平台与自定义平台等价；自定义平台可放在项目内作为内置平台；内置平台也能迁移到用户目录内作为自定义平台；现有全部能力保持完全兼容。**

---

## 0. 结论

**不通过（需修订后再评审）。**

设计的主体方向正确：把内置平台 adapter 文件化、统一注册表、`platforms.disabled` 黑名单、能力/目录参数声明化、重启生效，这些都能显著降低硬编码漂移。但当前版本：

1. **没有实现用户要求的“双向等价”**：既没有“项目内平台目录”，也没有“内置 → 用户目录”的迁移/覆盖机制；内置 adapter 文件本身也无法直接拷到 `~/.agentlray/platforms/` 运行。
2. **“所有表面自动收敛”的承诺与代码事实不符**：search / insights / backup / inspect / children / spawn / hermes watch 等仍是平台 id 硬编码，部分禁用后仍会工作。
3. **存在若干会导致功能失效的实现级缺陷**：`listPlatformInfo` 数据源、卸载守卫的数据源、require 循环、目录参数派生规则、`needsAgent` 假泛化、禁用 openclaw 后的缺省平台回退、测试隔离等。
4. **与既有决策冲突未记录**：ADR-0001 明确“不做 per-platform 启停开关”，本设计反转该决策但未新增/修订 ADR。

建议先补齐下述 3 个决策，再修订设计与计划：

- **决策 A：项目级平台目录**（路径、加载顺序、id 冲突优先级、是否随包分发）。
- **决策 B：内置 → 自定义的迁移/覆盖语义**（导出命令、同 id 覆盖条件、自包含/包根解析方式、迁移后的能力边界）。
- **决策 C：等价范围**（哪些表面必须等价、哪些明确为内置专属并由 capability 隐藏）。

---

## 1. 需求对齐检查

### R1（未覆盖）自定义平台放在项目内作为内置平台

设计与计划中不存在“项目级平台目录”这一概念。当前只有两个来源：

- 包内内置：`lib/platforms/index.js` 内联对象（计划 P0 拆为 `lib/platforms/builtin/*.js`）；
- 用户目录：`~/.agentlray/platforms/*.js`（`lib/platforms/loader.js:14`）。

把文件放进 `lib/platforms/builtin/` 属于**改源码**，不是“自定义平台放在项目内”。要实现 R1，需要新增第三个来源，例如：

```text
<repo>/platforms/*.js        # 随项目分发，按“内置”视角展示与默认挂载
```

并在设计中明确：

- 目录路径与 `package.json` 的 `files` 是否包含（决定它是否随 npm 包分发）；
- 加载顺序与 id 冲突优先级（建议：包内置 → 项目 → 用户，后者覆盖前者；同目录内重复仍 broken）；
- `listPlatformInfo()` 的 `source` 取值（应至少为 `package | project | user`，而不是当前的 `builtin | custom` 二值）；
- `AGENTLRAY_NO_PLUGINS` 是否同时跳过项目目录（建议只跳过用户/项目目录，内置仍加载）；
- 测试隔离与安全信任边界（项目目录同样执行任意 JS）。

### R2（未覆盖）内置平台迁移到用户目录作为自定义平台

设计只有“禁用内置平台”，没有“把内置平台搬到用户目录继续用”的路径。当前有 **4 个硬阻碍**：

1. **相对 require 失效**：计划 P0 要求每个 builtin adapter `require('../codex.js')`、`require('../../config')`、`require('./shared')`（`plan-platform-mount.zh-CN.md:11`）。文件复制到 `~/.agentlray/platforms/` 后这些相对路径全部解析失败。ADR-0002 已经记录过同类问题：“薄适配器 require AgentLRay 内部模块不可行”（`adr-0002-co-mind-platform.zh-CN.md:20-25`）。
2. **同 id 必 broken**：`loader.js:43-45` 对 id 冲突一律记 broken；设计还明确“disabled 内置仍占 id、防自定义同名顶包”（`design-platform-mount.zh-CN.md:68`）。因此“导出 codex 到用户目录”后，用户文件与内置 codex 同 id，**必然加载失败**。
3. **没有导出/迁移入口**：设计与计划均无 `platform export <id>`（或 `platform migrate`）命令，也没有“迁移后自动禁用内置”的原子操作。
4. **平台专属能力没有适配器契约**：openclaw 的 agent 维度列表/跨 agent 详情（`lib/routes/sessions.js:194-269`、`lib/session-list.js:104-126`）、hermes 的 SQLite watch 专用分支（`lib/routes/watch.js:240`）、omp/claude-code 的 children 路由（`lib/routes/sessions.js:342-441`）、inspect（`lib/inspect.js:12`）都不是 adapter 可声明/可复用的能力。把这些内置迁到用户目录后会**丢失这些能力**，与“等价”直接矛盾。

**建议方案（需拍板）**：

- 新增 `agentlray platform export <id> [--out <dir>] [--force] [--no-disable]`：
  - 默认写入 `~/.agentlray/platforms/<id>.js`，并**自动把该 id 加入 `platforms.disabled`**（迁移语义），提示“重启后生效”；
  - 生成文件用**包根解析**而不是相对路径：由 loader 在 require 前注入 `AGENTLRAY_PKG_ROOT`，生成文件写 `require(path.join(process.env.AGENTLRAY_PKG_ROOT, 'lib/platforms/builtin/<id>.js'))`；或直接生成**自包含单文件**（复用 co-mind 的内联方式）。前者实现小、随包升级自动同步；后者真正自包含但维护成本高、需逐平台处理。建议 P0 用包根解析，自包含作为后续增强。
- 允许“用户/项目适配器覆盖**已禁用**的同 id 包内置”；否则导出后必须改名，无法做到“迁移”。
- 迁移能力清单必须在文档中逐平台说明：openclaw/hermes/omp/claude-code 迁移后哪些表面降级（agent 列表、SQLite watch、children、inspect）。若要求“迁移后完全等价”，则必须先补齐对应 adapter hook（见 R3）。

### R3（未定义）等价的边界

设计 §1 声称“与该平台相关的一切表面随 mount 状态自动一致收敛”（`design-platform-mount.zh-CN.md:24`），但代码事实是：

| 表面 | 现状 | 与“等价/收敛”的关系 |
| --- | --- | --- |
| search | `lib/search.js:226-233` 的 `DIR_PARAMS` 只含 6 个内置；`249`、`293`、`304-313` 直接调用 hermes/claude 专用实现 | 自定义平台在单平台与 `all` 模式都不被搜索；内置 hermes 禁用后仍可被搜索 |
| insights | `lib/insights.js:431` 直接按 `platform === 'hermes'` 走 SQLite 分支 | 同上 |
| prompts | `lib/prompts.js:363-382` 按 7 个 id 选择提取器 | 自定义平台落到 `extractGenericJsonlPrompts`（可工作），但禁用内置仍可能被调用（前端不选则不可达） |
| backup | `lib/backup.js:127-142` 固定备份 5 个内置目录 | 禁用后仍备份；自定义平台不被备份 |
| watch | `lib/routes/watch.js:240` hermes 专用分支 | 自定义 hermes 迁移后走通用文件尾随，能力丢失 |
| children/spawn | `lib/routes/sessions.js:79-185`、`342-441`；`frontend/src/views/trace/childAgents.ts:11-15` | 仅 omp/claude-code/openclaw；自定义平台无等价能力 |
| inspect | `lib/inspect.js:12` 固定 `['omp','codex','claude-code']` | 内置专属，禁用后 CLI 仍可用 |

**建议**：把“等价”拆成两层写进设计：

- **核心数据面等价**：注册/挂载生命周期、列表、详情、聚合、watch、export、OTLP、prompts、tool-audit、resume/create、目录参数。这些必须做到 builtin/custom/project 同一路径。
- **平台专属面（builtin-only capability）**：children、spawn-tree、agent/spawn 管理端点、inspect/evidence、backup。自定义平台通过 `capabilities` 声明缺失，前端按能力隐藏；不要宣称“一切表面收敛”。
- 如果用户要求严格等价，则必须为 children/spawn/inspect/backup 设计通用 adapter hook；这是明显更大的工作量，应在设计里单列。

---

## 2. 设计缺陷（实现前必须修）

### D-1（Blocker）`listPlatformInfo` 不能继续从 `PLATFORMS` 派生内置条目

`lib/platforms/index.js:370-407` 当前从 `Object.values(PLATFORMS)` 生成 builtin 条目。按设计，`disabled` 过滤在导出前完成（`design-platform-mount.zh-CN.md:66-70`），被禁用的内置会从 `PLATFORMS` 消失——于是：

- `GET /api/platforms` 不再返回该平台 → 设置面板无法重新启用；
- `agentlray platform list` 看不到它 → `mount` 命令无对象；
- `plan-platform-mount.zh-CN.md:16` 只写了“新增 `ALL_PLATFORMS` catalog”，**没有写 `listPlatformInfo` 改为遍历 catalog**。

**修正**：`listPlatformInfo` 必须遍历 `ALL_PLATFORMS`（全部内置 + 项目 + 用户 + broken），每条按 `PLATFORMS[id] === adapter`（或 disabled 集合）计算 `mounted`。禁用自定义平台同理（`CUSTOM` 数组不会被过滤，必须单独标注 `mounted:false`）。

### D-2（Blocker）卸载守卫若用进程内 `PLATFORMS` 计数会失效

计划 P0 的守卫描述为“unmount 后剩余可查询挂载平台数 ≥ 1”（`plan-platform-mount.zh-CN.md:15`），但没有规定数据源。若实现时读 `PLATFORMS`（进程启动时的快照）：

- 服务器启动时有 7 个平台，用户连续调用 6 次 unmount，**每次守卫都看到 7**；
- 第 7 次仍会通过 → 可以把全部平台禁用，聚合/前端回退失去落点。

**修正**：守卫必须基于“**catalog − (当前 disabled ∪ {目标 id})**”计算，而不是基于 `PLATFORMS`；并明确“可查询平台”的谓词（建议：`capabilities.list === true` 或 `needsAgent && listAllAgents`）。同时处理 `saveSections` 的读-改-写并发（两个 CLI 同时 mount 可能丢更新），至少串行化或加锁/重读校验。

### D-3（Blocker）`platform-config` 与 `index.js` 的 require 循环

计划要求 `setPlatformMounted` 校验 `id ∈ ALL_PLATFORMS`（`plan-platform-mount.zh-CN.md:15`）。如果 `lib/platform-config.js` 顶层 `require('../platforms')` 取 catalog，而 `index.js` 在模块求值期 `require('./platform-config')` 调 `readDisabledSync()`，就形成环：`index → platform-config → index`。Node 会返回半初始化 exports，`ALL_PLATFORMS` 为 `undefined`，守卫静默失效或启动报错。

**修正**：`platform-config.js` 不 require `platforms`；`setPlatformMounted(id, mounted, catalog)` 由路由/CLI 传入 catalog；`readDisabledSync()` 只依赖 `lib/settings` 的 `SETTINGS_FILE`（或同源路径推导），不碰注册表。

### D-4（Major）目录参数派生规则不成立

设计写“query 参数名由规则 `'dir'+首字母大写` 派生，与现 `ALL_DIR_PARAMS`/`PER_PLATFORM_DIR_PARAM` 逐字一致”（`design-platform-mount.zh-CN.md:83`）。事实是：

- `claudeCodeDir` 按该规则会得到 `dirClaudeCode`，而现网参数是 `dirClaude`（`lib/routes/sessions.js:48`、`frontend/src/api/client.ts:116`）；
- `lib/search.js:226-233` 还有第三份 `DIR_PARAMS`，`lib/routes/insights.js:61-68` 是第四份，计划只覆盖了 `routes/sessions.js` 与前端。

**修正**：adapter 显式声明 `dirParam: 'dirClaude'`（或 `dirParam: null`），作为单一真源；四处消费点全部改读声明。若坚持派生，必须给出能处理 `claude-code → dirClaude` 的明确算法并加单测。

### D-5（Blocker）`needsAgent` 泛化是“假泛化”

计划 P1 写“`req.params.platform === 'openclaw'` 分支 → `p.needsAgent`”（`plan-platform-mount.zh-CN.md:37-40`），但分支体仍然调用 `listOpenclawSessionsFlat`、`resolveSessionFile`、`getSessionAcrossAgents`、`readAgents`（`lib/routes/sessions.js:194-211`、`228-251`；`lib/session-list.js:104-126`）。把条件换成 `p.needsAgent` 只解决“假卸载”（禁用 openclaw 后 `/api/openclaw/sessions` 仍命中），**不能让自定义 `needsAgent` 平台工作**；`design-custom-platforms.zh-CN.md` 的契约里也没有 agent 维度列表/跨 agent 详情 hook。

**修正**（二选一）：

- 新增 adapter 可选能力：`listAllAgents(dir)`、`getSessionAcrossAgents(dir, id)`（或统一 `list(dir, { agent })`），openclaw adapter 实现之，通用路由只调这些 hook；
- 或在契约中明确 `needsAgent` 仅 openclaw 可用，自定义平台声明即 broken/忽略，并在“等价范围”中排除。

### D-6（Blocker）openclaw 可禁用后，缺省平台回退未处理

D5 允许禁用 openclaw（`design-platform-mount.zh-CN.md:34`），但以下缺省值仍是硬编码 `'openclaw'`：

- `lib/routes/sessions.js:56`：`GET /api/sessions` 缺省 → `parsePlatformSelection('openclaw')` → 400；
- `lib/routes/prompts.js:24,49`、`lib/routes/insights.js:17`、`lib/routes/watch.js:232`：缺省 openclaw → 空数据或 400；
- `frontend/src/store.ts:526` 有回退，但服务端/CLI/legacy 调用方不一定带平台。

**修正**：定义“缺省平台 = 第一个已挂载且可查询的平台（顺序取 catalog）”；`GET /api/sessions` 缺省可回退为 `all`；所有路由共用同一个 `defaultPlatformId()` helper，并加禁用 openclaw 的测试。

### D-7（Major）平台开关与统一设置 draft 的写路径冲突

`design-settings-merge.zh-CN.md` 已定“设置面板单 draft + 底部统一 Save/Reset”；本计划同时：

- 新增 `PUT/DELETE /api/platforms/:id/mount` 即时写（`plan-platform-mount.zh-CN.md:17`）；
- `PUT /api/settings` 接受 `body.platforms`（`plan-platform-mount.zh-CN.md:19`）；
- 前端开关直接 `setPlatformMounted` + toast「重启后生效」（`plan-platform-mount.zh-CN.md:51`）。

这会产生：同一 section 两条写路径；开关点击即写、其他设置要 Save；Reset 不会回退已点开关；刷新后 `/api/platforms.mounted` 仍是旧值，开关可能“弹回”。

**修正**：二选一并在设计中写明——

- 开关纳入设置 draft，统一 Save（保存后提示重启）；或
- 开关保持即时写入，但 UI 以 `settings.platforms.disabled` 作为开关真源、`/api/platforms.mounted` 只作为“当前生效态”展示，并显示“重启后生效”角标；Reset 明确只重置 draft，不撤销已生效的开关。

### D-8（Blocker）测试隔离：require 期同步读会污染单测

`readDisabledSync()` 在 require 期读 `HOME/.agentlray/settings.json`（`lib/config.js:5`）。但多数单测没有设置 `AGENTLRAY_HOME`：

- `test/registry.test.js:8` 只设了 `AGENTLRAY_NO_PLUGINS`；
- `test/new.test.js`、`test/platform-cli.test.js` 等直接 require lib。

后果：

- 开发者一旦真实禁用过某平台，本地 `npm test` 会随机失败；
- 更危险的是：若测试调用 `setPlatformMounted`，会直接改写开发者真实 `~/.agentlray/settings.json`。

**修正**：在计划中加入强制项——`npm test` 通过 `--require ./test/setup-env.cjs` 统一设置临时 `AGENTLRAY_HOME`（或每个 require `lib/platforms` 的测试文件入口设置）；所有写测试必须使用 `makeTmpHome()`；`setPlatformMounted` 的测试只允许在临时 HOME 下运行。

### D-9（Major）loader 校验契约与内置 adapter 不一致，阻塞 hermes 迁移

`loader.js:19` 的 `REQUIRED_FUNCS = ['defaultDir','parse','getSession']` 强制 `parse` 是函数；而内置 hermes 的 `parse: null`、`find/collectFiles/watchParse` 均为 null（`lib/platforms/index.js:318-330`）。若按 R2 把 hermes 导出到用户目录，`validateAdapter` 会判 broken。

**修正**：loader 改为能力位校验（`parse` 可为 null；至少要求 `defaultDir` + `getSession`），或在设计中明确 hermes 不支持导出/迁移。

### D-10（Minor）`source` 与 `builtin` 双字段冗余

设计新增 `source: 'builtin' | 'custom'`（`design-platform-mount.zh-CN.md:111-113`），但 `PlatformInfo` 已有 `builtin: boolean`（`frontend/src/api/types.ts:22-34`）。两套真源会漂移，且 `source` 二值无法容纳“项目内平台”。

**修正**：单一定义 `origin: 'package' | 'project' | 'user'`，`builtin` 保留为兼容派生（`origin !== 'user'`），或直接升级字段并在前端一次性迁移。

### D-11（Major）openclaw 的 agent/spawn 端点未纳入“卸载即消失”

设计把 openclaw 的 `/api/agents*`、`/api/spawn-*` 列为“后续/建议”（`design-platform-mount.zh-CN.md:133`），但这些路由在 `lib/routes/sessions.js:79-185` 是独立挂载、直接使用 `DATA_DIR`，**不经过 `PLATFORMS` 查找**。禁用 openclaw 后它们仍然可用，形成“半卸载”。

**修正**：本轮把 openclaw 的 agent/spawn 路由一并迁入 `platform-extra`（按 `PLATFORMS.openclaw` 存在性挂载），或明确这些端点属于“数据目录工具”不受 mount 影响，并在设计的“收敛范围”中说明。

### D-12（Major）“require 期快照零改动”只对三个模块成立

设计 §3.2 说所有 require 期快照自然不含被禁平台（`design-platform-mount.zh-CN.md:66-70`）。实际 `lib/export.js:12`、`lib/otlp.js:12`、`lib/tool-audit.js:17` 成立；但 `lib/search.js` 的 `DIR_PARAMS`、`lib/backup.js:127-142`、`lib/routes/watch.js:240`、`lib/insights.js:431`、`lib/routes/insights.js:61-68` 是运行期/硬编码分支，禁用后仍会工作。需要逐项处理，或在设计中明确“以下表面不随 mount 收敛”。

### D-13（Major）与 ADR-0001 的决策冲突未记录

ADR-0001 的 Q11 明确“**不做 per-platform 启停开关**：文件存在 = 启用，卸载 = 删/移走文件”（`adr-0001-custom-platform-adapter.zh-CN.md` 决策摘要；`design-custom-platforms.zh-CN.md:31`）。本设计引入 `platforms.disabled` 黑名单，是对该决策的反转。需要新增 ADR-0005（或 amend ADR-0001）记录新决策、理由与兼容语义，否则后续读者会拿到互相矛盾的文档。

### D-14（Minor）`routes/settings.js` 的 ui 白名单会拒绝已禁用平台

`lib/routes/settings.js:67-80` 用 `PLATFORMS[ui.platform]` 校验；禁用某平台后，历史 `ui.platform`/`selectedPlatforms` 仍可能包含它，前端 `persistState` 的 `PUT /api/settings {ui}` 会 400（前端 catch 后静默）。这不是崩溃，但会让“平台选择”持久化静默失败。建议在 `setPlatforms` 收敛后再写，且服务端对已禁用 id 采用“过滤而非 400”的兼容策略（或在响应中返回 `platforms.mounted` 供前端收敛）。

---

## 3. 实施计划缺陷

| 编号 | 计划位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| P-1 | P0（`plan:16`） | 未写 `listPlatformInfo` 改为遍历 catalog、`mounted` 计算、禁用自定义平台处理 | 补为独立任务并加单测 |
| P-2 | P0（`plan:15`） | 守卫数据源未定义（见 D-2）；未处理并发写 | 明确“catalog − disabled”计算 + 重读校验 |
| P-3 | P0（`plan:19`） | 未列 `routes/settings.js` ui 白名单的禁用平台兼容（D-14） | 补兼容策略与测试 |
| P-4 | P1（`plan:37-40`） | `needsAgent` 泛化只改条件不改实现（D-5） | 补 adapter hook 或缩窄声明 |
| P-5 | P1（`plan:28-35`） | 未列 `lib/search.js`、`lib/routes/insights.js` 目录参数/禁用分支；未列 `lib/backup.js`、`watch hermes` | 补文件清单或明确不收敛 |
| P-6 | P2（`plan:51`） | 未列 `SettingsDialog.tsx:37-44` 的 `RESUME_BUILTIN_IDS`（第四份硬编码）；未说明开关与 draft 的 UX（D-7）；未说明 `usePlatforms` 失效/重取与 demo stub 字段 | 补前端任务与交互定义 |
| P-7 | 验证（`plan:20-24`、`42-43`、`54`） | 缺少“双向等价”用例：项目目录加载、内置导出→用户目录→禁用内置→仍可查、自定义迁入项目目录、openclaw 禁用后缺省请求、连续 mount/unmount 守卫、settings draft 与开关一致 | 新增对应测试矩阵 |
| P-8 | 文档 | 未列 `docs/usage*.md`、`cli-usage.md`、glossary 的更新（`bin/platform.js` 新增命令） | 补文档任务 |

另外，`plan:22` 的 API 测试建议补一条“**同一进程内 PUT mount 后仍 404**”，把 D1「重启生效」语义锁死；否则实现者可能顺手做了热生效，导致与设计不一致。

---

## 4. 兼容性核对

| 项 | 结论 | 说明 |
| --- | --- | --- |
| 空 `platforms.disabled` | 兼容 | 全部内置默认挂载；`registry.test.js` 的 7 平台断言应保持 |
| `RESUME_BINS`/`NEW_BINS` 命令串 | 兼容（需逐字断言） | 平移进 adapter 时 args 必须逐字不变；`test/new.test.js` 需改 import 但断言保留 |
| `GET /api/settings/cli-bins` | 兼容 | 只读端点保留，数据源改 adapter |
| `GET /api/platforms` 新增字段 | 兼容 | 只增不改；但 `source` 与 `builtin` 需去重（D-10） |
| 现有自定义平台 | 兼容（默认） | 用户目录加载顺序、冲突规则不变；但若允许覆盖 disabled 内置，需明确优先级 |
| legacy 前端 | 兼容（降级） | 冻结快照；禁用平台在 legacy 仍显示，探活 0/err，属已知退化 |
| 测试 | **有风险** | require 期同步读会读取真实 HOME（D-8） |
| ADR/文档 | **有冲突** | ADR-0001 Q11 与本设计相反（D-13） |

---

## 5. 建议的最小修订清单

以下按“先决策、再设计、再计划”的顺序给出，可直接并入现有文档：

### 5.1 设计补章

1. **新增 §2.x 三来源模型**：`package` / `project` / `user`，含目录、加载顺序、id 冲突与覆盖规则、`AGENTLRAY_NO_PLUGINS` 语义、打包与测试隔离。
2. **新增 §3.x 迁移语义**：`platform export` 命令、包根解析（`AGENTLRAY_PKG_ROOT`）或自包含方案、自动禁用内置、逐平台能力降级表。
3. **修订 §3.2**：`PLATFORMS`/`ALL_PLATFORMS` 的职责与计算时机；明确 `listPlatformInfo` 遍历 catalog；明确守卫数据源。
4. **修订 §3.3**：用 `dirParam` 取代不成立的派生规则；列出四个目录参数消费点。
5. **修订 §3.4 / §7**：把 openclaw 的 agent/spawn 路由纳入本轮或明确排除；把 children/inspect/backup 列为 builtin-only capability。
6. **新增 §“等价边界”表**：核心数据面 vs 平台专属面，避免“一切表面收敛”的过度承诺。
7. **新增 ADR-0005**（或 amend ADR-0001）：per-platform 启停/黑名单决策。

### 5.2 计划补任务

1. `P0`：`listPlatformInfo` 改 catalog；守卫用 catalog 计算；`platform-config` 去 require 环；测试 `setup-env` 隔离；openclaw 禁用后的默认平台 helper。
2. `P0.5`（新）：项目目录 loader + 优先级 + 测试；`platform export` + 覆盖语义 + 测试。
3. `P1`：`needsAgent` hook 或缩窄；`dirParam` 四处收敛；search/insights/backup/watch-hermes 的禁用语义；`SettingsDialog::RESUME_BUILTIN_IDS`。
4. `P2`：开关与 settings draft 的 UX 定稿；`usePlatforms` 失效策略；demo stub；文档更新（usage/cli-usage/glossary）。
5. 测试矩阵：见 P-7。

### 5.3 建议新增的测试用例（摘要）

- `project adapter`：`<repo>/platforms/foo.js` 被加载为 `origin:'project'`、默认挂载、可查列表/详情；删除后重启消失。
- `migrate builtin → user`：`platform export codex` → 用户目录文件加载成功 → `platforms.disabled` 含 codex → 重启后 `codex` 仍可查且 `origin:'user'`；再次 export 不重复写/可 `--force`。
- `same-id override`：用户文件同 id 覆盖**已禁用**内置成功；覆盖**未禁用**内置时按既定策略（broken 并提示先 disable）。
- `guard`：同一进程连续 unmount 6 次后，第 7 次仍被拒（即使 registry 快照有 7 个）。
- `openclaw disabled`：`GET /api/sessions`（无 platform）、`/api/prompts`、`/api/watch` 缺省走首个挂载平台；legacy 不崩。
- `settings draft`：开关点击后 Save 前不落盘（若选 draft 方案）；或即时落盘后刷新开关状态不弹回（若选即时方案）。
- `test isolation`：真实 HOME 下禁用 codex，单测仍全绿且不改真实 settings。

---

## 6. 附：关键证据索引

- 注册表/加载：`lib/platforms/index.js:66-71,73-331,346-350,365-407`；`lib/platforms/loader.js:14,19,43-45,54-98`
- 硬编码表：`lib/resume.js:16-41`；`lib/new.js:42-70`；`lib/cli-bins.js:17-34,54-93`
- 会话路由/聚合：`lib/routes/sessions.js:45-77,194-269,342-441`；`lib/session-list.js:99-142`
- 其他表面：`lib/search.js:226-313`；`lib/routes/insights.js:17,53-68`；`lib/insights.js:431,500`；`lib/prompts.js:363-382`；`lib/backup.js:127-142`；`lib/routes/watch.js:232-246`；`lib/inspect.js:12`
- 设置：`lib/routes/settings.js:12,31,67-80`；`lib/settings.js:29-58`；`lib/config.js:5`
- 前端：`frontend/src/store.ts:22-30,146-166,520-545`；`frontend/src/api/client.ts:96-121,140-152`；`frontend/src/components/SettingsDialog.tsx:26-44`；`frontend/src/hooks/usePlatformProbe.ts:27`
- 既有决策：`docs/.local/adr-0001-custom-platform-adapter.zh-CN.md`（Q11）；`docs/.local/adr-0002-co-mind-platform.zh-CN.md:20-25`；`docs/.local/design-custom-platforms.zh-CN.md:31,40,87-90`
- 测试隔离：`test/registry.test.js:8`；`test/helpers.js:28-46`；`package.json` 的 `test` 脚本
