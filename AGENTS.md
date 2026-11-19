# AGENTS.md

AgentLRay 是本地 Web 看板：读取各 AI 编码代理（OpenClaw、Codex、Claude Code、OMP、dsh、Gemini、Hermes）**已有的原生会话日志**，归一化为统一消息模型后渲染，支持离线 `inspect`。核心链路不调模型、不上传数据。Node ≥ 22.13（dsh 的 zstd 日志需 ≥ 22.15）。

栈：Express（`server.js` + `lib/routes/*` + `lib/*`）｜React 19 + Vite + TS（`frontend/`，唯一功能开发面）｜平台原始日志（JSONL/SQLite/zstd-JSONL）+ `~/.agentlray/*` 配置。

## 常用命令

```bash
npm start                # http://127.0.0.1:3800（无鉴权，勿随意外露）
npm run dev              # 先 build:ui 再启动
npm run build:ui         # 诊断规则打包 + vite build；首次用 build:ui:full
npm run build:demo       # VITE_DEMO=1 演示构建
npm test                 # 全部 test/*.test.js
node --require ./test/setup-env.cjs --test test/status.test.js   # 单个文件
npm run lint / format    # Biome
node bin/agentlray.js {inspect|evidence|sessions|platform} ...   # 离线 CLI，无需起服务
npm run pack:build
```

## 架构约束

- **路由挂载顺序有语义**：`lib/routes/proxy.js`（多主机网关）必须是第一个 `/api` 处理器且在任何 body parser 之前（远端转发要原始 body 流）；SPA fallback 用 `frontend/dist`；CSRF（`lib/csrf.js`）、JSON 256KB 上限、全程 `no-store` 统一在 `server.js` 处理。
- **分层**：`lib/routes/*` 只做参数校验与响应整形，业务逻辑一律放 `lib/*`；`bin/` 是 CLI；`frontend/` 是唯一开发面。
- **平台注册表**（`lib/platforms/index.js`）是单一真源，`PLATFORMS` 在 **require 期同步合并**——硬约束：`export`/`otlp`/`session-list`/routes/CLI 都在 require 期派生，改异步会让自定义平台消失。三来源：`package`（`builtin/{openclaw,codex,claude-code,omp}`）、`project`（`platforms/{dsh,gemini,hermes}`）、`user`（`~/.agentlray/platforms/*.js`）。共享层经裸名 `@agentlray/shared/*` 解析（`shared-alias.js` 注册钩子，测试由 `setup-env.cjs` 注入）。
- **适配器契约**以 `lib/platforms/builtin/omp/index.js` 为范例；归一化消息由 `makeMessage` 定义为 11 字段（`id,timestamp,role,content,usage,model,provider,toolCallId,toolName,details,isError`），只覆写原始记录真实携带的字段。新增平台 = 一个适配器 + 注册，优先「薄适配器」，不要内联镜像内置逻辑。
- **会话状态**（`lib/status.js`）四态 `awaiting-input`/`working`/`waiting`/`stopped`，**只依据记录证据推导，从不查进程**。`endedAt` 仅来自会话级结束、`endTurnAt` 仅来自回合级结束，混用会把正常结束误判成 stopped。`GET /api/status-labels` 是状态词表单一真源。
- **设置与密钥**：全部设置聚合 `~/.agentlray/settings.json`（`ui`/`cliBins`/`status`/`kanban`/`llm`），原子写 + 旧文件幂等迁移；唯一入口 `GET/PUT /api/settings`，GET 只回 `hasApiKey` 不回密钥。敏感值用 `lib/secret.js`（AES-256-GCM，密钥 `~/.agentlray/secret` 0600），落盘为 `xxxEnc` 密文。
- **多主机网关**：`proxy.js` 按 `X-Host-Id` 或 `?host=` 路由，远端转发保留原始 Host/Origin 供远端 CSRF 校验；仅 `/api/hosts`、`/api/inbound`、`/api/dsh` 的 403 不透传。传输方式 `ssh`（`transport.js`+`hosts.js`）与 `dsh`（`lib/dsh/`）；SSE（`/api/watch`）只能靠 `?host=` 选主机。
- **诊断规则单一真源**：`frontend/src/views/sessions/diagnostics.ts` → `scripts/build-diagnostics.mjs` 打包为 `lib/generated/diagnostics.cjs`（**生成文件，勿手改**），离线 CLI 与 UI 共用同一判定。

## 前端

`store.ts`（zustand）+ react-query（`views/sessions/queries.ts`）；`api/client.ts` 统一注入 `X-Host-Id`；基件在 `components/ui`（Radix+Tailwind）；视图在 `views/{sessions,trace,insights,kanban,prompts}`；`@` → `src`。Vite dev 把 `/api` 代理到 3800；`VITE_DEMO=1` 时走 `src/demo/router.ts`，不发真实请求。

## 约定

- **文档**：中间过程文档（设计/计划/进度/审查/测试举证）写 `docs/.local/`（被 `.gitignore` 忽略、不提交）并登记 `docs/.local/README.md`；正式文档在 `docs/`。未指定语言时**默认简体中文**；代码标识符、命令、配置键、错误信息保持原文。
- **设计文档进度与迁移（强制）**：`docs/.local/` 下的设计/计划文档必须记录**实施进度**（已实现 / 部分实现 / 待实现 + 代码证据），实现有变更则同步更新文档内进度小节、`docs/.local/README.md` 的「实施进度与迁移状态」索引。**已实现或部分实现的设计文档必须迁移到 `docs/design/` 并随代码提交**，同时更新 `docs/design/README.md` 与 `docs/.local/README.md` 的索引/进度；尚未实现的过程材料（评审、进度、交接、外部研究）留在 `docs/.local/`。迁移后在 `docs/design/` 的副本为准，`docs/.local/` 保留同名过程稿。
- **平台适配器是可信边界**：加载即按当前权限执行任意代码；`AGENTLRAY_NO_PLUGINS=1` 跳过 project/user 来源。
- **安全默认**：无鉴权，默认只绑 `127.0.0.1`；外露需显式 `HOST=0.0.0.0`。
- **测试隔离**：`test/setup-env.cjs` 注入空的用户平台目录并注册 `@agentlray/shared` 别名；它**不得**设置 `AGENTLRAY_HOME`/改 `HOME`（既有测试会自建隔离家目录）。`test/fixtures/home` 必须整体入库。
- **文档时效**：`docs/architecture.md`/`architecture.zh-CN.md` 已按当前实现重写（基线 `c7fdb8f`），与 `docs/usage*.md`、`docs/diagnostics*.md`、`docs/offline-inspect*.md`、`docs/session-forensics*.md`、`docs/ROADMAP*.md` 同批校对；`docs/.local/implementation.md` 是历史快照（仍提到已移除的 `public/` legacy UI、会话备份、资产库），仅供追溯。`claims.json` 中每个公开数字都配有 `scripts/claims-receipts.mjs` 复算命令，改动文档数字时需同步该命令的期望值。以仓库实际文件为准。
