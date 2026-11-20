# ADR-0007：独立薄服务（thin service）—— 仅用于远程连接的轻量网关

> 类型：决策记录（ADR）　｜　日期：2026-11-20　｜　状态：**accepted（已实现，2026-11-20）**
> 需求来源：`todo.md` #16「开发薄服务和页面，只用于远程连接」、#17「开发移动端 APP，用于远程连接」
> 前置文档：`design-multi-host`（多主机网关，P0+P1①② 已实现）、`design-remote-settings-tunnel`（设置透传远端，已实现）、`design-host-settings-redesign`（主机设置布局，已实现）
> 方案设计：见 [design-thin-service.zh-CN.md](design-thin-service.zh-CN.md)

## 1. 背景与问题

AgentLRay 现有**多主机模式**（`design-multi-host`，P0+P1①② 已实现）：本地跑**完整 AgentLRay** 作网关，按 `X-Host-Id` 头把 `/api/*` 代理到**远端完整 AgentLRay**（ssh `-L` 隧道 / dsh 通道），解析全在远端。设置面已按 `design-remote-settings-tunnel` 改为**透传远端**（远端下可改远端系统配置）。

`todo.md` #16/#17 提出新的独立需求：开发一个**独立的薄服务**，只用于远程连接，去除系统配置，为后续移动端 APP 远程连接桌面端查看和操控做准备。

现状的完整网关**不是**这个薄服务：它跑在本地、携带完整平台注册/状态机/insights/搜索全栈，并暴露全部系统配置面（settings / platforms mount|replace / LLM / CLI）。薄服务需要的是一个**独立进程**，只做远程连接转发，从数据模型上就排除系统配置。

## 2. 决策（grill R1–R4 收敛，Q1–Q27）

### 2.1 定位与形态

| 决策点 | 结论 |
| --- | --- |
| **Q1 定位** | 薄服务跑在**连接方**（移动端代理/连接方侧），去连**完整 AgentLRay**（远端桌面数据源）。移动端永不跑完整解析栈；解析全在远端。 |
| **Q3 复用** | 同一代码库、**独立入口**（`agentlray thin` 子命令），最大复用 `lib/hosts` / `lib/transport` / `lib/routes/proxy`，独立进程装配薄 Express app。 |
| **Q4 连接对象** | 连**完整 AgentLRay 实例**；连接方不区分对端是薄是厚（都暴露 `/api/version` + 会话数据面），与现有 `proxy.js` 完全同构，零新逻辑。 |
| **Q11 进程隔离** | **独立 `bin/thin-server.js`**（或 `bin/agentlray.js thin`）组装薄 app，共享 `lib/*`；不在 `server.js` 里塞 flag。 |
| **Q20 隧道池** | 薄服务**沿用单隧道**（`connect` 仍 `closeAllExcept`），切主机重建；隧道池另立需求，不并入本设计。 |

### 2.2 配置边界（「去除系统配置」）

| 决策点 | 结论 |
| --- | --- |
| **Q2 配置最小集** | 薄服务只持有**连接所需最小配置**：主机列表（`hosts.json`）+ dsh 传输配置；**不持有**会话/平台/LLM/状态等系统配置。 |
| **Q7 本地路由子集** | 薄服务本地只挂 `hosts` + `version`（Q17 例外见下）；其余全走 `proxy.js` 透传远端。 |
| **Q9 远端设置不透传** | 薄服务连上远端也**不透传 settings**——远端设置只读，薄服务不能改任何系统配置。 |
| **Q15 接口边界** | **堵系统配置面**：`/api/settings*`（含 cli-bins）一律 403；`/api/platforms/:id/(mount|replace)` 写面 403；**保留 `GET /api/platforms` 列表与 `GET /api/ui-selection` 只读**（恢复远端平台选择）。 |
| **Q17 dsh 作为连接配置例外** | 薄服务本地挂 `/api/dsh/*`（配置/登录/设备列表）——dsh 配置属于「连接所需最小配置」，是移动端穿透 NAT 连桌面的关键通道，非系统配置。 |
| **Q22 前端裁剪** | 薄模式前端一次性禁用：`SettingsDialog` 与设置按钮、`useInboundPoller`、`KanbanView` 的 `getKanbanConfig` 查询、`syncSelectedPlatforms`（写远端）。`getSelectedPlatforms` 只读保留。 |
| **Q24 dsh 只 client** | 薄服务 dsh **强制 client**（只出站连远端），不启 `startDshHostService`，不恢复 `/api/inbound` 本地路由。 |
| **Q26 看板配置** | 薄服务下看板跳过 `getKanbanConfig` 查询，直接用后端默认 `maxPerStatus=20`，不落盘。 |

### 2.3 模式信号与前端

| 决策点 | 结论 |
| --- | --- |
| **Q13 模式信号** | 新增 **`GET /api/mode`**：完整实例返回 `{mode:'full'}`，薄服务返回 `{mode:'thin',version}`；前端启动先取 mode，`thin` 时隐藏设置入口、跳过系统配置调用。**单一 dist**（无 `VITE_THIN` 构建分叉）。`/api/mode` 与 `/api/hosts`、`/api/version` 同列**本地资源**，绝不被 `proxy.js` 透传。 |
| **Q14 local 宿主语义** | 薄服务**无 `local`**：`GET /api/hosts` 只返回远端；前端 thin 自动连接记忆/首台主机；无主机时显示空态。 |
| **Q23 启动自动连接** | 服务端取 **`AGENTLRAY_THIN_HOST=<id>`**；缺省取 `hosts.json` 第一台；都没有则不连、前端空态引导添加。boot 即 `openHost`（失败仅记状态），前端首帧直接落在该主机。 |
| **Q22 首帧门控** | store 加 `mode`，boot 先 `GET /api/mode`，未解析前渲染轻量占位；`thin` 下一次性禁用上述裁剪。 |
| **Q25 inbound 响应** | 薄服务 `/api/inbound` 与完整网关一致走 `proxy.js` 403（本地资源、薄服务不提供）；前端 thin 已禁用轮询，不可达无影响。 |
| **Q26 空态** | `hosts.json` 空且无 `AGENTLRAY_THIN_HOST` 时，主区渲染「尚未添加远程主机」+「添加主机」按钮，打开现有 `HostFormDialog`。 |

### 2.4 远端操控与安全

| 决策点 | 结论 |
| --- | --- |
| **Q16 远端写操作** | **全部放行**（`resume-command`、`sessions new`、`prompts rewrite/hidden/analyze`）：它们不是系统配置，属「操控远端会话」；继续走 `proxy.js` 默认透传。 |
| **Q18 鉴权** | **无鉴权**（沿用现状 CSRF 语义）：薄服务默认 `HOST=127.0.0.1`，LAN 需显式 `HOST=0.0.0.0`；`csrf.js` 对无 `Origin` 的非浏览器客户端放行。**主动接受的风险**：绑 LAN 即任何人可看全部会话，文档需显著提示。 |
| **Q21 启动与端口** | `agentlray thin` 子命令 + `npm run thin`；默认 `PORT=3801`、`HOST=127.0.0.1`；配置仍用 `~/.agentlray/hosts.json`（与完整实例共享主机列表），可用 `AGENTLRAY_HOME` 隔离。 |

### 2.5 移动端 APP（#17）关系

| 决策点 | 结论 |
| --- | --- |
| **Q5 薄服务是 APP 后端** | 薄服务是移动端 APP 的 HTTP 后端；APP 只调薄服务 API，薄服务经隧道转发到真实桌面数据源。 |
| **Q6 APP 起步形态** | **移动端 Web 起步**（复用现有 React 前端，已有 767 断点 + 看板移动端适配）；后续演进到原生壳 + web 内核。 |

## 3. 决策理由

- **独立进程而非 `server.js` flag**：进程边界干净，薄服务不携带完整网关的全栈启动成本；`lib/*` 全部复用，不重复实现。
- **「去除系统配置」= 数据面边界排除**：从数据模型（无本地系统配置端点）+ 代理面（不透传 settings）双重排除，而非仅隐藏 UI。
- **`GET /api/mode` 单 dist**：避免第二套前端构建；运行时探测与现有 `DEMO` 短路同构，前端裁剪集中在一个 `mode === 'thin'` 判定点。
- **无 `local` 宿主**：薄服务自身不读平台日志，保留 `local` 会出现「切到本机看到 404」的伪能力；从数据模型上就没有本地数据源。
- **dsh 强制 client**：薄服务定位是连接方；再当被连接方会把它变回「迷你完整实例」，违背「薄」。
- **无鉴权**：与现有 AgentLRay 架构一致（无 cookie、无 token 体系），改动最小；默认只绑 127.0.0.1 是现有安全默认。为移动端暴露 LAN 的安全风险已明示，属用户拍板接受。

## 4. 影响与兼容

- **不改变**现有完整网关行为：`/api/mode` 是新增只读端点，完整实例返回 `{mode:'full'}`，前端据此维持现状；薄服务是新增入口，不影响 `server.js`。
- **新增**：`GET /api/mode`（`lib/routes/mode.js`）、`bin/thin-server.js`、`agentlray thin` + `npm run thin`、前端 `mode` 状态 + thin 裁剪。
- **复用**：`lib/hosts.js`、`lib/transport.js`、`lib/routes/proxy.js`、`lib/routes/hosts.js`、`lib/routes/dsh.js`、前端 `HostsDialog`/`HostFormDialog`/`HostConnectingView`/`Sidebar`。
- **与 `design-remote-settings-tunnel` 的关系**：完整网关仍透传远端 settings（可改）；薄服务不透传——二者是**不同形态**，不是回归。

## 5. 已实现清单

1. ✅ 后端：`GET /api/mode`（完整 → full / 薄 → thin+version），`/api/mode` 列为本地资源。
2. ✅ 后端：`bin/thin-server.js`（只挂 proxy + hosts + dsh + version + mode + SPA）；proxy 对 `/api/settings*` 与 platforms mount/replace 写面 403，保留 `GET /api/platforms` / `GET /api/ui-selection` 只读透传。
3. ✅ 后端：`autoConnectThinHost`（`AGENTLRAY_THIN_HOST` 或首台）+ dsh 强制 client。
4. ✅ 前端：store 加 `mode`，boot 先 `GET /api/mode`；thin 禁用 `SettingsDialog`/`useInboundPoller`/`getKanbanConfig`/`syncSelectedPlatforms`。
5. ✅ 前端：薄模式无 `local` 语义 + 空态引导添加主机；`/api/ui-selection` GET 保留恢复远端平台选择。
6. ✅ CLI：`agentlray thin` 子命令 + `npm run thin`（PORT=3801）。

## 实现进度（代码核对）

**状态：accepted（已实现，2026-11-20）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 薄服务后端（`/api/mode`、`bin/thin-server.js`、proxy 系统配置面拦截） | ✅ 已实现 | `lib/routes/mode.js`、`bin/thin-server.js`、`lib/routes/proxy.js` |
| 薄服务启动自动连接（`AGENTLRAY_THIN_HOST`） | ✅ 已实现 | `lib/hosts.js:autoConnectThinHost`、`bin/thin-server.js` |
| 前端 thin 模式裁剪 + `mode` 状态 | ✅ 已实现 | `frontend/src/{main.tsx,store.ts,App.tsx}` 等 |
| CLI `agentlray thin` | ✅ 已实现 | `bin/agentlray.js`、`package.json` |
| 契约测试 | ✅ 已实现 | `test/thin-service.test.js`（11 例）；全量 `738/738` + `build:ui` 通过 |
