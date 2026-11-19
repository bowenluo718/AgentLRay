# 内置平台代码内聚到 `lib/platforms/builtin/`

> 方案设计 · 2026-11-08
> 目标：把"内置平台自身的相关代码"全部内聚到 `lib/platforms/builtin/<id>/` 对应的文件/文件夹内，使每个内置平台自包含、可整体审视，并具备迁移到项目/用户自定义平台目录的路径。

## 1. 背景与目标

此前平台代码分散在 `lib/platforms/` 顶层单文件（`claude.js`、`omp.js`、`openclaw.js`、`codex.js`、`dsh.js`、`gemini.js`、`hermes.js`、`omp-outcome.js`、`lib/watch.js`）与 `lib/platforms/*-impl.js` 若干 hook 实现里。平台自身的解析/元数据逻辑与共享工具、hook 骨架混杂，难以整体迁移。

本次把平台自身逻辑按平台内聚：

- 每个内置平台一个文件夹 `lib/platforms/builtin/<id>/`，内部 `index.js` + `parse.js` + 各能力文件（`inspect.js`/`tool-audit.js`/`search.js`/`prompts.js`/`backup.js`/`resume.js`/`outcome.js` 等）。
- 平台之间共享的纯工具下沉到 `lib/platforms/shared/` barrel（`helpers`/`tail-state`/`contracts`/`search`/`insights`/`backup`/`inspect`/`tool-audit`/`watch`/`gemini-format`/`zstd`）。
- `lib/platforms/` 顶层只保留注册表（`index.js`）、加载器（`loader.js`）、`builtin/`、`shared/`、`shared-alias.js`。

## 2. 新目录结构

```
lib/platforms/
├── index.js          # 注册表：require 期合并三来源 + 注册 @agentlray/shared 别名
├── loader.js         # 三来源（package/project/user）加载；支持 <id>/index.js 子目录平台
├── shared-alias.js   # @agentlray/shared 裸名 require 别名钩子
├── builtin/
│   ├── openclaw/   ├── codex/   ├── claude-code/   ├── omp/   ├── dsh/   ├── gemini/   ├── hermes/
│   │   # 每平台：index.js + parse.js + 能力文件（inspect/tool-audit/search/prompts/backup/resume/outcome）
└── shared/           # 平台间共享纯工具 barrel（helpers/tail-state/contracts/…）
```

每平台文件夹内聚该平台全部逻辑；共享工具只依赖 `lib/config` 等全局配置，不依赖任何平台。

## 3. 共享引用策略

平台内代码引用共享工具，仓库内**内置平台与自定义/项目平台统一采用裸名别名** `@agentlray/shared/<sub>`（自 `shared-alias.js` 解析到 `lib/platforms/shared/<sub>`），保证内外一致：

```js
const { withMetadataCache, topToolsOf } = require('@agentlray/shared/helpers');
const { CODEX_DIR } = require('@agentlray/shared/config');
const { sortSessionsByStatusGroups } = require('@agentlray/shared/status');
```

`@agentlray/shared/<sub>` 裸名别名由 `lib/platforms/index.js` 在 require 任何 builtin 前注册（`installSharedAlias()`），测试环境经 `test/setup-env.cjs` 全局注入（`node --require ./test/setup-env.cjs`），因此直接 `require('builtin/<id>/parse')` 的单元测试同样可解析。

共享层对框架配置的访问统一走 `@agentlray/shared/config` 别名窗口（`shared/config.js` 从 `lib/config` 导出平台所需片段），平台不直接依赖 `lib/config` / `lib/status` 的仓库位置（开箱即用）。

内置平台迁移到自定义目录时无需改写共享引用——目录内聚即开箱即用。

## 4. 关键改动点

### 4.1 删除的顶层文件
- `lib/watch.js` → 下沉 `lib/platforms/shared/watch.js`（`readNewLines`/`parseWatchLines` 等）；消费方 `lib/routes/watch.js`、原 `watch-impl.js` 改引共享。
- `lib/platforms/{claude,omp,openclaw,codex,dsh,gemini,hermes}.js`、`omp-outcome.js` → 迁入各自 `builtin/<id>/parse.js`（及 `outcome.js`）。
- `lib/platforms/shared.js`/`tail-state.js`/`contracts.js` → `lib/platforms/shared/{helpers,tail-state,contracts}.js`。
- `lib/platforms/{search,insights,prompts,tool-audit,backup,inspect,watch,omp-resume}-impl.js` → 能力骨架下沉 `shared/{search,insights,…}.js`，平台具体解析留在 `builtin/<id>/`。

### 4.2 loader 支持子目录平台（`<id>/index.js`）
`loadDirIntoCatalog` 现支持双形态：单文件 `<id>.js` 与子目录 `<id>/index.js`（辅助文件 `parse.js` 等随目录内聚，不单独成平台）。同名冲突时子目录优先于单文件。新增单测覆盖。

### 4.3 离线 inspect 的 adapterFiles 指纹
`lib/inspect.js` 把各平台 `adapterFiles` 拼为 `lib/platforms/<file>` 读入并哈希进 `adapterSha256`。原先指向已删顶层文件（`codex.js`/`claude.js`/`omp.js`/`omp-outcome.js`）导致 inspect 全挂；现改为指向 builtin 源文件：

- codex：`['builtin/codex/index.js', 'builtin/codex/parse.js', 'builtin/codex/inspect.js']`
- claude-code：`['builtin/claude-code/index.js', …]`
- omp：`['builtin/omp/index.js', 'builtin/omp/parse.js', 'builtin/omp/inspect.js', 'builtin/omp/outcome.js']`

同时 `builtin/<id>/parse.js` 重导出已下沉的格式工具（dsh `scanZstdFrames`/`decompressDshLog`、gemini `foldGeminiRecords`/`stringifyToolResult`），保持 parse 模块既有公开面不被破坏。

### 4.4 `platform export` 薄适配器路径
`bin/platform.js` 的 `internalRelativePathFor` 对 package 内置从 `lib/platforms/builtin/<id>.js` 改为 `lib/platforms/builtin/<id>/index.js`；测试夹具同步。

### 4.5 测试路径更新
`test/{claude,dsh,gemini,omp,openclaw}.test.js` 直引 `builtin/<id>/parse.js`；`test/search-watch.test.js` 直引 `shared/watch.js`；`test/{platform-export,platform-project}.test.js` 薄适配器路径指向 `builtin/<id>/index.js`。

## 5. 验证

- `npm test`：**597/597 通过**。
- 前端 `npm run build`：通过（React 前端为唯一功能开发面，未涉及）。
- 新增单测：`test/platform-loader.test.js` 增加「子目录平台 `<id>/index.js` 由 loader 加载、辅助文件不产生独立平台」与「`@agentlray/shared` 别名解析到外层共享目录（同引用）」。
- 残留引用扫描：`lib/bin/test` 全层无对已删顶层平台/impl/`lib/watch` 的 dangling require。

## 6. 迁移路径（内置 → 自定义）

1. 拷贝 `lib/platforms/builtin/<id>/` 到 `~/.agentlray/platforms/<id>/`（或项目 `<repo>/platforms/<id>/`）。
2. 共享依赖已使用 `@agentlray/shared/<sub>` 裸名别名（加载器经 `index.js` 与测试环境注入注册），目录内聚即开箱即用，无需改写引用。
3. `agentlray platform list` / `validate` 验证。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 内置平台内聚 `lib/platforms/builtin/<id>/` | ✅ 已实现 | `lib/platforms/builtin/{claude-code,codex,omp,openclaw}/` |
| 共享工具 `lib/platforms/shared/` barrel | ✅ 已实现 | `lib/platforms/shared/index.js` |
| `@agentlray/shared` 裸名别名 | ✅ 已实现 | `lib/platforms/shared-alias.js` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
