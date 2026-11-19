# 多主机模式实现方案（plan-multi-host）

> 本文档是 [design-multi-host.zh-CN.md](design-multi-host.zh-CN.md)（grill 设计定稿）的**实现级落地设计**：数据模型、文件改动清单、网关代理中间件、transport 层、前端改动、验证方式与 P0/P1 实施切分。设计决策（R1–R4）以 design 文档为准，此处不再重述，只落到可执行层面。
> 状态：**P0 已实现**（只读 + 实时 + 主机管理闭环）；**P1 已实现前两项**（resume/create 透传、prompts analyze/rewrite 透传，见 §10 P1 ① ②）；P1 其余（CLI `--host`、多隧道并行、dsh）未实现。

## 1. 现状与目标

- 现状：本地跑一个 AgentLRay（`server.js` 监听 `127.0.0.1:3800`），前端 SPA 单一 base URL 直连本地 `/api/*`，平台适配器/解析全在本机。
- 目标：**多主机模式**——连接其他主机上运行的 AgentLRay，查看其会话/详情/状态/分析等（**设置除外**）；本机作**网关**，按 `X-Host-Id` 请求头把请求路由到对应主机。
- 关键语义（来自 design）：
  - **远端解析**：本地网关纯 HTTP 转发 + 主机管理，不实现任何平台解析；远端跑完整 AgentLRay 实例。
  - **transport**：`local`=直连 / `ssh`=`ssh -L` 隧道；复用系统 ssh（零存密，信任边界在系统 ssh 层）。
  - **统一 host 上下文**：`local` 与远端共用「选主机 → 请求该主机 `/api/*`」语义，transport 层是唯一区分点。
  - **只维护当前选中主机的隧道**（切换重连）；进程退出兜底清理所有隧道子进程。

## 2. 数据模型（hosts.json）

独立文件 `~/.agentlray/hosts.json`（非 settings.json 聚合——它是「连接目标列表」而非「本机设置」，且含运行时不入库的字段；沿用 `lib/settings.js` 的原子写模式）。

```jsonc
// ~/.agentlray/hosts.json
{
  "hosts": [
    {
      "id": "devbox",                 // 唯一 id（slug，字母数字+连字符）
      "label": "开发机 A",            // 展示名，可中文
      "type": "ssh",                  // 预留 dsh
      "ssh": {
        "host": "devbox",             // 直接透传 ~/.ssh/config 别名或 hostname
        "user": "luobo",              // 可空（走 config 默认用户）
        "port": 22,                   // 可空（走 config）
        "remoteAgentLrayPort": 3800,  // 远端 AgentLRay 监听端口
        "identityFile": "",           // 可空（走 ssh-agent/默认私钥）
        "useAgent": true              // 可空（-o ForwardAgent 或 ssh-add 语义，默认 false）
      }
    }
  ],
  "updatedAt": "2026-11-12T…"
}
```

约定：

- **本地转发端口运行时自动分配、不落盘**（见 §4 transport）。
- `local` **不落盘**，恒内建在主机列表首位。
- 校验：`id` 必填且 `^[A-Za-z0-9][A-Za-z0-9-]*$`、`label` 必填、`type` ∈ {`ssh`}、`ssh.host` 必填；`ssh.port` 1–65535。
- 增删改走服务端路由（§5），原子写（tmp + rename，复用 `lib/settings.js` 的 `writeSettings` 模式，抽一个 `lib/hosts.js`）。

### 2.1 内存态（host 状态机）

`lib/hosts.js` 维护运行时状态（不落盘）：

```ts
type HostStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface HostRuntime {
  // 隧道连接信息（仅 ssh 类型有值）
  localPort: number | null;   // 运行时分配的本地转发端口
  child: ChildProcess | null; // ssh 子进程
  status: HostStatus;
  error: string | null;       // error 状态时的文案
  version: { bootId: string } | null; // 最近一次 /api/version 探测结果
}
```

- `local` 恒 `connected`（`localPort`=null，直连 `process.env.PORT || 3800`）。
- 状态机：`disconnected → connecting → connected`；失败 `connecting → error`（保留错误文案，可重试回 `connecting`）。
- **切换失败停留原主机**：store 层在探测失败时不提交 `selectedHostId`。

## 3. 文件改动清单

### 服务端（新增）

| 文件 | 职责 |
| --- | --- |
| `lib/hosts.js` | `hosts.json` 读写（CRUD）+ 运行时状态机 + 隧道生命周期管理（建/拆/兜底清理） |
| `lib/transport.js` | transport 层：`local` 直连 / `ssh` spawn `ssh -L`；导出 `openHost(host) → runtime`、`closeHost(id)`、`resolveTarget(id) → { baseUrl } \| null` |
| `lib/routes/hosts.js` | `GET/POST/PUT/DELETE /api/hosts`（CRUD）+ `POST /api/hosts/:id/test`（测试连接） |
| `lib/routes/proxy.js` | 网关 host 路由中间件：按 `X-Host-Id` 头路由到本地或远端，含透传白名单边界 |

### 服务端（改动）

| 文件 | 改动 |
| --- | --- |
| `server.js` | 初始化 `lib/hosts.js`（载入 hosts.json + 内建 `local`）；`mountProxyRoutes(app)` 插在 csrfGuard 之后、业务路由挂载之前；`boot()` 里注册 `process.on('exit'/'SIGTERM'/'SIGINT')` 兜底关闭所有隧道 |
| `lib/settings.js`（可选） | 复用原子写抽公共 `atomicWrite`（或 hosts.js 自实现，二者取一，避免过度抽象） |

### 前端

| 文件 | 改动 |
| --- | --- |
| `frontend/src/store.ts` | `AppState` 加 `selectedHostId: string`（默认 `local`）、`hosts: HostInfo[]`、`hostStatus: Record<id, HostStatus>`、`hostError: Record<id, string>`；`setSelectedHostId`/`setHosts`/`setHostStatus`；切换时先探测成功再提交 |
| `frontend/src/api/client.ts` | `fetchJson`/`requestJson` 读 store 的 `selectedHostId` 注入 `X-Host-Id` 头；新增 hosts CRUD + `testHost` + `fetchVersion` 透传 |
| `frontend/src/api/types.ts` | `HostInfo`/`HostStatus`/`HostsResponse` 类型 |
| `frontend/src/components/SettingsDialog.tsx` | 新增「主机」tab（`SectionKey` 加 `'hosts'`，`MENU` 加项）：列表/添加/编辑/删除/「测试连接」 |
| 新增 `frontend/src/components/HostSelector.tsx` | 顶栏/侧栏主机选择器（下拉/chip + 状态徽标，`local` 恒在） |
| `frontend/src/App.tsx` | 挂载 `HostSelector`；首次拉取 hosts |

### 测试

| 文件 | 改动 |
| --- | --- |
| `test/hosts.test.js`（新） | hosts.json CRUD + 校验 + 状态机 |
| `test/transport.test.js`（新） | transport 层：local 解析、ssh 命令串构造（`ssh -L` 参数拼装）、隧道生命周期 |
| `test/proxy.test.js`（新） | 网关中间件：`X-Host-Id=local` 走本地、远端走 http、写设置面不透传（403） |

## 4. transport 层（lib/transport.js）

### 4.1 命令串构造（单一真源，参照 `lib/resume.js` 的 `shell: win32` 语义）

```
local：baseUrl = http://127.0.0.1:${process.env.PORT || 3800}
ssh：  baseUrl = http://127.0.0.1:${runtime.localPort}
       spawn('ssh', args, { shell: process.platform === 'win32' })
       args = [ '-N', '-L', `${localPort}:127.0.0.1:${remoteAgentLrayPort}`,
                '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
                ...(port? ['-p', String(port)] : []),
                ...(identityFile? ['-i', identityFile] : []),
                ...(useAgent? ['-o', 'ForwardAgent=yes'] : []),
                `${user ? user+'@' : ''}${host}` ]
```

- **本地转发端口**：`net.createServer().listen(0)` 拿到空闲端口后关闭，再交给 ssh（避免硬编码端口冲突）。绑定 `127.0.0.1`，不暴露局域网。
- **connectivity 判定**：spawn 后轮询 `GET ${baseUrl}/api/version`（带超时，如 5s×多次），成功 → `connected` + 记录 bootId；失败/超时 → kill 子进程、`error`。
- **ServerAliveInterval=30** 保活防长空闲隧道被掐（design R4-Q2）。

### 4.2 隧道生命周期（design R4-Q1）

- **绑定当前选中主机**：store `selectedHostId` 变化 → 旧主机 `closeHost`，新主机 `openHost`（若未连）。
- **删除主机** → `closeHost` + 从 hosts.json 移除。
- **进程退出兜底**：`lib/hosts.js` 维护 `activeChildren: Set<ChildProcess>`；`server.js` 注册 `process.on('exit')`（同步 `child.kill()`）与 `SIGTERM/SIGINT`（关隧道后 exit）。防孤儿 ssh。
- 无后台常驻隧道池（design R2-Q6）。

## 5. 网关代理中间件（lib/routes/proxy.js）

### 5.1 挂载位置（server.js）

```js
app.use('/api', csrfGuard);
app.use(express.json({ limit: '256kb' }));
app.use(proxyHost);          // ← 新增：X-Host-Id 路由
// ……原有 mountInsightsRoutes/mountSessionRoutes/… 保持挂载
```

`proxyHost(req, res, next)`：

1. 读 `X-Host-Id` 头（缺省 `'local'`）。
2. **透传边界校验**（§5.3）：命中写设置面黑名单 → 403（不透传）。
3. `id === 'local'` → **`next()`** 走本地原有路由（零改动，性能无损）。
4. 远端 → 查 `lib/hosts.js` 运行时，取 `baseUrl`；未连接 → 503（提示先连接）。
5. 用 `node:http`/`undici` 转发（保留 method/query/body/headers，删除 `X-Host-Id`），把远端响应流式 pipe 回 `res`；SSE（`/api/watch`）按流透传（design R4-Q2：透传远端 `retry:`，网关不干预）。

### 5.2 端点全清单（透传边界基准）

数据面（**全透传**）：

| 端点 | 方法 |
| --- | --- |
| `/api/version` | GET |
| `/api/platforms` | GET |
| `/api/status-labels` | GET |
| `/api/sessions`、`/api/:platform/sessions`、`/api/:platform/sessions/:sessionId` | GET |
| `/api/:platform/agents*`、`/api/agents*`（openclaw） | GET |
| `/api/:platform/sessions/:id/children*`、`/api/:platform/spawn-map`、`/api/:platform/spawn-tree*`、`/api/spawn-map`、`/api/spawn-tree*` | GET |
| `/api/insights`、`/api/tools/audit`、`/api/search`、`/api/prompts`、`/api/prompts/hidden*` | GET |
| `/api/:platform/sessions/:id/export`、`/api/otlp/:platform/:sessionId` | GET |
| `/api/watch` | GET（SSE 流式） |
| `/api/:platform/sessions/:id/resume-command` | GET |

写设置面（**不透传 → 403**）：`/api/settings`（PUT）、`/api/platforms/:id/mount|replace`（PUT/DELETE）、`/api/settings/cli-bins`（GET 也属设置面，不透传）。

P1 合意写透传（design R2-Q5 / R3-Q6）：`POST /api/:platform/sessions/new`（create）、`POST /api/prompts/rewrite`（LLM 改写）、`GET /api/prompts/analyze`（LLM 分析，远端用**远端** LLM 配置）。这些在 P1 放行时加入白名单，并在网关加「将在 \<host\> 上执行」提示位（前端）。

> 实现要点：透传判定用**前缀 + 精确匹配**双表。数据面为默认（`X-Host-Id` 存在即透传），写设置面为显式黑名单（`/api/settings`、`/api/platforms/:id/mount`、`/api/platforms/:id/replace`、`/api/settings/cli-bins`）。P1 合意写操作另开白名单。这样新增数据端点默认自动透传，避免漏配。

### 5.3 边界校验

- `local` 恒放行（本地自己的 CSRF 已由 csrfGuard 处理）。
- 远端仅放行数据面（默认透传 + 黑名单）；写设置面一律 403，错误体说明「远端设置请到该主机自身实例修改」。

## 6. 主机管理路由（lib/routes/hosts.js）

```
GET    /api/hosts            → 列表（含内建 local + 各 host 状态）
POST   /api/hosts            → 新建（body: { id, label, type, ssh }）
PUT    /api/hosts/:id        → 编辑（全量替换该 host 字段；id 不可改）
DELETE /api/hosts/:id        → 删除（关隧道 + 移除；local 不可删）
POST   /api/hosts/:id/test   → 测试连接（建隧道 → GET /api/version → 返回 { ok, bootId, error? }）
```

- 响应形状含 `status`（来自运行时状态机，`local` 恒 `connected`）。
- CSRF：这些是写操作，走 `/api` 前缀，已被 `csrfGuard` 覆盖。
- `test` 与「切换」复用同一 `openHost` 探测路径（§4.1），测试连接不影响当前选中主机（独立临时隧道，测完即关）。

## 7. 前端改动细节

### 7.1 store（frontend/src/store.ts）

```ts
interface AppState {
  selectedHostId: string;              // 默认 'local'
  hosts: HostInfo[];                   // 含内建 local
  hostStatus: Record<string, HostStatus>;
  hostError: Record<string, string>;
  setHosts: (hosts: HostInfo[], status: Record<string, HostStatus>) => void;
  setSelectedHostId: (id: string) => void;   // 仅探测成功后提交
  setHostStatus: (id: string, s: HostStatus, err?: string) => void;
}
```

- `setSelectedHostId`：非 `local` 时先 `POST /api/hosts/:id/test`，成功才 `set({ selectedHostId })`；失败 → 保持原 `selectedHostId`，`hostError` 写入、toast 显示（design R3-Q3「切换失败停留原主机」）。
- **host 上下文与平台/会话上下文解耦**：切换主机时清空 `selectedSessionId`/`detailPlatform` 等会话上下文（各主机平台列表不同，复用 `setPlatforms` 收敛逻辑——`setPlatforms` 已在切换时收敛到新主机平台列表）。

### 7.2 client（frontend/src/api/client.ts）

```ts
let activeHostId = 'local';   // 由 store 订阅同步，或 client 内部维护
function hostHeader(): Record<string, string> { return { 'X-Host-Id': activeHostId }; }
// fetchJson / requestJson 统一附加 hostHeader()
```

- `fetchJson`/`requestJson` 统一注入 `X-Host-Id` 头。
- **SSE `/api/watch`**：`watchUrl` 保持单一 base URL，`new EventSource(url)` 无法带头 → 改为 `?host=<id>` query 参数（网关同时支持 `X-Host-Id` 头与 `?host=` query，SSE 走 query）。这是 SSE 的一个实现要点（EventSource 只能带 query 不能带自定义头）。

### 7.3 主机选择器（HostSelector.tsx）

- 顶栏下拉/chip：列出 `local` + 各 host，`local` 恒在首位，显示状态徽标（`connected` 绿 / `connecting` 黄 / `error` 红 / `disconnected` 灰）。
- 点击非当前 host → `setSelectedHostId`（触发探测→切换）。
- `error` 状态 hover 显示错误文案。

### 7.4 设置面板「主机」tab（SettingsDialog.tsx）

- `SectionKey` 加 `'hosts'`，`MENU` 数组加 `{ key: 'hosts', label: '主机' }`。
- 面板：已保存主机列表（label/id/状态）、添加/编辑表单（label/id/type/ssh.host/user/port/remoteAgentLrayPort/identityFile/useAgent）、删除、「测试连接」按钮。
- 表单字段校验与服务端一致（§2）。
- 保存走 `POST/PUT /api/hosts`（独立于 settings draft——主机 CRUD 是独立资源，不进 `saveSettings` draft，避免与单一 draft 耦合）。

## 8. 版本探测（design R3-Q3）

- `openHost` 探测时 `GET ${baseUrl}/api/version` 取 `bootId`。
- `GET /api/hosts` 响应中透出各 host 的 `version.bootId`。
- 前端 `useVersionPoller` 已有本地轮询；远端版本在切换/测试连接时一次性获取即可。若远端 `bootId` 与服务端当前不一致（前端轮询到的本地 bootId）无法直接比较语义版本——当前 `bootId` 只是进程标识，不含版本号。**实现缺口**：需在 `GET /api/version` 增加 `version` 字段（如 `pkg.version`），前端才能提示「远端版本过低」。P0 建议 `GET /api/version` 加 `{ bootId, version }`（本地与远端同源同格式），前端对比最低兼容版本号。

## 9. 验证方式

### 服务端单测（新 test 文件）

- `test/hosts.test.js`：CRUD + id 校验（非法 id 拒绝）+ 状态机（`disconnected→connecting→connected/error`）+ local 恒 connected。
- `test/transport.test.js`：命令串构造（`ssh -L <port>:127.0.0.1:3800 …` 参数顺序、`-p`/`-i`/`ForwardAgent` 条件拼装、Windows `shell`）、local baseUrl 解析。
- `test/proxy.test.js`：`X-Host-Id=local` → next 走本地；远端 → 请求打到隧道端口（mock http server）；写设置面（PUT /api/settings）→ 403；SSE 透传（mock）。

### 集成验证（真实环境）

1. 本机跑一个 AgentLRay（`local`），再加一台（或本机第二个端口）当「远端」，`hosts.json` 指向它。
2. `curl -H 'X-Host-Id: local' /api/version` 与 `curl -H 'X-Host-Id: <id>' /api/version` 返回对应 bootId。
3. `curl -X PUT -H 'X-Host-Id: <id>' /api/settings` → 403（设置不透传）。
4. `curl -H 'X-Host-Id: <id>' /api/sessions` → 远端会话列表（数据面透传）。
5. 前端切主机 → 状态徽标、列表/详情/分析跟随远端；切回 local → 恢复。
6. `npm test` + `frontend npm run build`。

## 10. P0 / P1 实施切分

### P0（第 1 版交付——只读+实时+主机管理闭环）

1. `lib/hosts.js`：hosts.json CRUD + 运行时状态机 + 隧道生命周期兜底。
2. `lib/transport.js`：local 直连 / ssh 隧道建拆 + 命令串构造 + 连通性探测。
3. `lib/routes/proxy.js`：X-Host-Id 路由中间件 + 数据面透传 + 写设置面 403 + SSE query 透传。
4. `lib/routes/hosts.js`：CRUD + test。
5. `server.js`：挂载 proxy/hosts 路由 + 进程退出兜底清理。
6. `GET /api/version` 加 `version` 字段（版本探测前提）。
7. 前端：store `selectedHostId` + hosts 状态、HostSelector、设置「主机」tab、client 注入 `X-Host-Id` 头 + SSE `?host=`。

**P0 验收**：web 能选远端主机并查看其会话/详情/状态/分析/搜索/insights/export；设置面不透传；切换失败停留原主机；进程退出无孤儿 ssh；`npm test` 全绿。

### P1（后续增量）

1. ✅ resume/create 透传（`POST /api/:platform/sessions/new`，design R2-Q5）+ 前端「将在 \<host\> 上执行」提示。——**已实现**：`lib/routes/proxy.js` 的 `CONSENTED_WRITES` 审计登记（prompts analyze/rewrite + `POST /api/:platform/sessions/new`；resume-command 本就是 GET 数据面透传）；`NewTaskDialog`（新建，含「在 \<host\> 新建」按钮文案与提示条）与 `SessionSummary` ResumeButton（复制恢复命令标注远端主机）在非 local 时展示远端提示。
2. ✅ prompts analyze/rewrite 透传（design R3-Q6，远端 LLM 后端）。——**已实现**：代理默认透传（远端跑自己的 LLM 配置；`GET/PUT /api/settings` 不透传故密钥安全），并显式登记进 `CONSENTED_WRITES` 审计清单。
3. ⏳ CLI `--host`（design R3-Q5，需先改 CLI 走网关 HTTP）。
4. ⏳ 多隧道并行/后台常驻（design R2-Q6）。
5. ⏳ dsh remote 传输（`type:"dsh"` 预留，Q2 先不做）。

## 11. 风险与边界（实现层补充）

- **SSE 头限制**：`EventSource` 不能带自定义头，必须用 `?host=` query 路由 `/api/watch`；网关需同时支持头与 query 两种携带方式。
- **远端 baseUrl 与本地冲突**：`local` 直连用 `process.env.PORT || 3800`；若本机网关与远端同端口，靠 `localPort` 分配避开——ssh 隧道本地端口用 `listen(0)` 拿空闲端口，永不冲突。
- **写设置面黑名单为「前缀精确」双表**：`/api/settings`、`/api/platforms/:id/mount`、`/api/platforms/:id/replace`、`/api/settings/cli-bins` 精确匹配；其余默认透传。P1 合意写另开白名单。
- **`GET /api/version` 需要 `version` 字段**（当前只有 bootId）才能做跨主机版本提示，P0 一并加。
- **CLI 与 web 解析口径**：CLI 现直读本地文件、不经网关；P0 只影响 web。两者在 `local` 上仍共享同一解析逻辑（同一份规则单源），无漂移（design §5）。
- **远端数据目录/平台列表**：各主机显示自己的平台清单（`GET /api/platforms` 透传），前端 `setPlatforms` 收敛逻辑已按运行时列表收敛，切换主机时复用即可。

## 12. 实现备注（与设计文档的落地差异）

- **`connect` vs `test` 双端点**：设计只说「测试连接」；实现拆为 `POST /api/hosts/:id/test`（测完即关，供设置面板）与 `POST /api/hosts/:id/connect`（建立并保持隧道，供顶栏切换后 proxy 立即复用）。切换语义靠 `connect`，避免 test 关隧道导致后续请求 503。
- **SSE `?host=` 在网关层实现**：`watchUrl` 对非 local 加 `?host=<id>` query；网关 `hostIdFrom` 优先 `X-Host-Id` 头、回退 `?host=`。这样 `EventSource`（不能带自定义头）也能命中同一路由。
- **proxy 必须是第一个 `/api` 处理器**：曾把 `mountProxyRoutes` 放在 `/api/version` 路由之后，导致带 `X-Host-Id` 的 `/api/version` 被本地路由抢答（返回网关自身 bootId）。已挪到所有 `/api` 路由、`express.json` 之前（远端转发需原始 body 流）。实测 `X-Host-Id=nope` 的 `/api/version` 现返回 503。
- **改写设置面黑名单用「完整路径 + 正则」双表**：`WRITE_SETTINGS_BLOCKED`（精确：settings / settings/cli-bins）+ `WRITE_RESOURCE_RE`（`/api/platforms/:id/mount|replace`）。因挂载在 `/api` 下 `req.path` 已去前缀，用 `req.baseUrl + req.path` 还原完整路径判断。
- **`local` 不落运行时**：`openHost('local')` 返回直连 runtime（`baseUrl = 127.0.0.1:<PORT>`）不入 `runtime` Map；proxy 对 `local` 直接 `next()` 走本地路由，不经过转发。
- **测试隔离**：`test/proxy.test.js` 用 `setRuntimeForTest(id, baseUrl)` 注入 connected 运行时（指向本机 mock http server），避免真实 ssh spawn 依赖；该 setter 仅测试用，生产路径不调用。
- **`GET /api/version` 已加 `version` 字段**（`pkg.version`），前端 `VersionInfo` 类型同步；跨主机版本提示留待前端消费（P0 已具备探测数据）。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：部分实现：P0 完成；P1 ①② 完成，③ CLI `--host`、④ 多隧道池未实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| P0 网关/隧道/主机管理 | ✅ 已实现 | `lib/routes/proxy.js`、`lib/hosts.js`、`lib/transport.js` |
| P1 ① resume/create 透传 | ✅ 已实现 | `lib/routes/proxy.js` |
| P1 ② prompts 透传 | ✅ 已实现 | `lib/routes/proxy.js`、`lib/routes/prompts.js` |
| P1 ③ CLI `--host` | ❌ 未实现 | `bin/sessions.js` |
| P1 ④ 多隧道池 | ❌ 未实现 | `lib/routes/hosts.js:149` |

