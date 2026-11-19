# AgentLRay dsh 多登录方式（扫码 + 账号密码）

> 状态：**已实现**（2026-11-18 grill 收敛 → 实现；**2026-11-19 评审修复 P1/P2/P4/P5**，见 `docs/.local/review-dsh-login-methods.zh-CN.md`（未迁移）；**2026-11-19 评审 Q1–Q4：发现/扫码 serverUrl 参数化**，见下方「serverUrl 参数化」）。关联：[design-dsh-host-connection.zh-CN.md](design-dsh-host-connection.zh-CN.md)（dsh 传输基础）、[adr-0006-dsh-host-connection.zh-CN.md](adr-0006-dsh-host-connection.zh-CN.md)（决策）。

## 背景与目标

`design-dsh-host-connection` 已把 dsh 远程主机连接的**加密传输 + loopback 端口转发**落地，但认证仅支持**账号密码**一种方式：`DshConfigDialog` 填 email+password 落盘 `hosts.json` 顶层 dsh section（`passwordEnc` 加密），连接时 `ensureCredentials`/`startDshHostService` 用账号密码注册设备。

参考 dsh 插件 `packages/plugin/package.json` 与官方服务器，官方中继服务器 `https://dsh.r2049.cn` 支持**多种登录方式**：DSH Go 扫码、知乎扫码、GitHub 扫码、Google 扫码、账号密码。本次目标：

- 官方服务器（及任何实现了 OAuth provider 发现的服务器）**动态发现**登录方式，页面支持对应方式。
- 中继服务器地址配置为官方默认时自动获取多种登录方式；**自定义服务器默认只支持账号密码**（除非它自己也实现了 OAuth 发现）。
- 扫码登录与账号密码登录都产出**设备 token**（落 `ServerCredentialStore`），连接隧道复用之。

## 官方真实服务器探查（2026-11-18，已实测）

| 端点 | 方法 | 成功响应 | 失败响应 |
| --- | --- | --- | --- |
| `/api/v1/auth/oauth/providers` | GET | `{capabilities:{devicePairing:"dsh-pairing-v1",devicePairingQr:"fragment-ticket-v1"},items:[{id,displayName,startUrl,qrStartUrl}]}`（官方 3 个：zhihu/github/google） | —（404 时 vendor 回退 legacy status 探测） |
| `/api/v1/auth/oauth/qr/start?provider={p}` | POST `{}` | `{qrId(≥20),scanUrl(以 baseUrl 开头),expiresIn:600,provider}` | 方法错/缺参 → **HTTP 200 + `{"status":"expired"}`**（不报 405） |
| `/api/v1/auth/oauth/qr/{qrId}` | GET | `{"status":"pending"}` / `{"status":"complete","token"}` | 不存在/过期 → **HTTP 200 + `{"status":"expired"}`**（不 404） |
| `/api/v1/auth/login` | POST | `{token,expiresAt,account,profile,isAdmin}` | 401 `{error:{code,message,retryable}}`（`AUTH_INVALID`，不创建账号） |
| `/api/v1/auth/me` | GET | `{account,isAdmin,...}` | 401 信封 |
| `/api/v1/devices/register` | POST+Bearer | `{accessToken,refreshToken,...}`(TokenPair) | 401 信封（无 token） |

- **统一错误信封**：所有非 2xx 都是 `{error:{code,message,retryable}}`，三字段必填。
- **token 生命周期**（`apps/server/src/server.ts`/`store.ts`）：登录 Web token 默认 8 小时；设备 refresh token 默认 **30 天**（`issue(deviceId, nExpiresAt = Date.now() + 30*86400_000)`）。`ServerCredentialStore` 持 refresh token，`refreshCredentials` 用 refresh 自动续期；refresh 也失效/设备撤销才需重新登录。

## 设计决策（grill 收敛）

### 登录方式与角色约束

- **D1 登录方式**：本轮实现 zhihu/github/google 三种网页 OAuth **扫码** + **账号密码**。**不做 DSH-Go device-pairing**（独立双端协议，需 8 位验证码人工确认 + 手机端，AgentLRay 无手机端，另立范围）。
- **D2 动态发现**：不硬编码「官方=多方式、自托管=单方式」。每次需要时对**当前目标 `serverUrl`** 调 `GET /api/v1/auth/oauth/providers` 动态发现。官方返回 3 provider → 多方式；自托管 404/空 → 只账号密码。未来自托管若实现 OAuth 也自动出现。**（2026-11-19 Q2：目标 serverUrl 可取前端 draft 值，见 D28。）**
- **D3 角色约束**：官方 device-pairing 协议（DSH-Go）**五层强制配对设备只能是 `host`（inbound_only），角色枚举仅 host/client 无 both**（协议文档、`pairingDeviceSchema`、`HostPairing.assertHost`/`accept`、`ServerApi.adoptPairing`、`control-runtime` 的 `pairingHostOnly` 禁 client 模式）。因此：
  - **both 角色只允许账号密码登录**（禁止扫码）。
  - host/client 角色可选扫码或账号密码，都按该角色授权。

### 账号密码不落盘、token 为唯一登录态

- **D4 账号密码不落盘**：账号密码只在**本次登录操作**临时使用（`authorizeWithAccount` 注册生成 token），**不再写入** `hosts.json` 的 `email`/`passwordEnc`。~~旧的已存密文**保留但不用**（不自动清理，由用户自行处理，`logout` 也不清旧密文）。~~ **2026-11-19 修订（评审 P4）**：改为**彻底清理**——`loadDshSettings` 不再返回/读取 `email`/`passwordEnc`/`hasPassword`；`saveDshSettings` 重写 dsh section 只写配置字段（旧字段下次保存即清除）；删除 `loadDshCredentials`；`migrateDshSectionOnce` 只搬配置字段、不迁移旧账号密码。
- **D5 登录态唯一判据 = token**：`任一 scope 的 `ServerCredentialStore` 有有效 token` 即视为已登录。账号密码不落盘后不再是登录态判据。
- **D6 token 持久、跨重启保持**：token 落 store（`~/.agentlray/dsh/<scope>/server-credentials.json`，0600），登录态跨重启保持，**主动退出才清**。
- **D7 退出清理范围**：logout 清**所有 scope**（host+client）的 token，回未登录态。不清旧 email/passwordEnc（2026-11-19 起这些字段已不再承载，无处可清）。

### 配置字段仍落盘

- **D8 配置字段仍落盘**：`serverUrl`/`role`/`deviceName`/`allowedPorts` 继续存 `hosts.json` 顶层 dsh section。只是账号密码不再落盘。
- **D9 退出保留配置字段**：logout 只清 token，**保留** serverUrl/role/端口等配置字段，用户退出后仍可看到并编辑。
- **D10 登录落盘配置字段**：账号密码登录、扫码登录都**落盘配置字段**（当前 draft 值）。账号密码登录时**不写 email/passwordEnc**。

### 交互状态机

- **D11 未登录态**：显示配置字段（可编辑）+ 登录方式。both → 账号密码（无扫码）；host/client → provider 扫码 tab + 账号密码 tab。
- **D12 已登录态**：显示**只读配置字段摘要 + 当前登录角色 + 退出**。不显示登录 tab、不显示账号密码输入、不可编辑配置。
- **D13 登录方式页签**：可用登录方式（账号密码 + 发现的 provider）总数 **>1 用页签**，否则**直显账号密码表单**。页签顺序：账号密码排第一、随后 provider。**默认选中账号密码**。
- **D14 配置字段与登录一体**：**无单独「保存配置」按钮**。账号密码 tab 的按钮为「**登录**」；点登录 = 落配置字段 + 账号密码登录。扫码成功 = **先以传入 serverUrl 完成扫码登录（token 落该服务器 scope），随后 PUT 持久化配置字段**。
- **D15 已登录禁止改配置**：已登录时不允许修改配置字段（只读摘要），退出后才恢复可编辑。

### 保存/登录的原子性与校验

- **D16 账号密码「登录」流程**：前端校验配置字段合法 + email/password 非空 → `PUT /api/dsh/config`（带配置字段 + email/password）→ 后端校验 + 落配置字段（不写账号密码）→ `authorizeWithAccount` 生成 token。**先落配置再注册 token**；注册失败（密码错/连不上）**配置已落但报登录失败、保持未登录**（不回滚配置）。
- **D17 配置字段校验**：serverUrl 必填非空 http(s)、deviceName 非空、allowedPorts 合法（复用 `normalizeServerUrl`/`normalizePorts`）。前端即时校验 + 后端防御。
- **D18 注册 scope**：账号密码登录按**配置 role** 决定注册 scope（both=host+client 两个、host=host、client=client）。both 登录时发**两次注册请求**。
- **D19 登录失败保留输入**：登录失败（401 密码错 / 服务器不可达）保留用户已填 email/password，显示错误提示（「账号或密码错误」「无法连接中继服务器」），停留未登录态。

### 扫码实现

- **D20 二维码渲染**：前端引入 `qrcode`（`toDataURL`，上游同款）渲染二维码；**同时提供登录跳转链接**（`<a href=scanUrl target=_blank>`，新标签打开完成登录，回来自动轮询捕获）。
- **D21 QR 会话无状态**：后端**无状态转发**上游——`POST /api/dsh/auth/qr/start`（body `{role,provider,serverUrl?}`）转发返回 `{qrId,scanUrl,expiresIn,provider}`；`POST /api/dsh/auth/qr/poll`（body `{role,qrId,serverUrl?}`）转发上游 poll，成功则 token 落该 role scope store。qrId 由前端持有（仅内存，不持久化/不进日志）。**（2026-11-19 Q3：`serverUrl` 参数化为目标中继地址；start 与 poll 必须传同一地址，token 以该 baseUrl 为键落盘；完成后由前端 PUT 持久化 serverUrl，使 token 与连接所用服务器一致。）**
- **D22 轮询**：前端 1.5s 轮询，状态机 pending/complete/expired/failed。仅**当前激活登录 tab** 轮询；切 tab/关闭弹框/登录成功清理 timer 与 qrId。
- **D23 poll 方法错边界**：上游 GET qr/start 返回 `{"status":"expired"}` 而非 405，后端**原样转发**，前端把这种 expired 当「过期刷新二维码」处理（异常场景，可接受）。

### 登录态展示与退出

- **D24 当前登录角色**：显示**实际有 token 的 scope 集合**（both 登录后显示「host + client」）。
- **D25 退出切本地主机**：点「退出」→ `POST /api/dsh/auth/logout` → 若当前选中主机是 **dsh 类型**，`setSelectedHostId('local')` + 复用 `settleHostSwitch()`（清 URL → 回会话主页 → 整页刷新）→ 关闭弹框。ssh/local 主机不受影响。

### 连接时的 token 复用与过期提示

- **D26 token 复用**：扫码/账号密码产出的 token 在 store 中同构（都是该 scope 设备凭据），现有 `openDshTunnel`/`startDshHostService` 直接复用，无需账号密码。
- **D27 过期语义**：连接时 `refreshCredentials` 用 refresh token 自动续期（refresh 有效则无提示、正常）；**refresh 失效/设备撤销**时连接报错并提示「dsh 登录已失效，请重新登录」，且若当前连接的是 dsh 主机则**自动切换本地主机**。

### serverUrl 参数化（2026-11-19 评审 Q1–Q4）

> 背景缺陷：`discoverProviders`/`startQrLogin`/`pollQrLogin` 一律读 `loadDshSettings().serverUrl`（**已保存值**）。用户未登录时把 serverUrl 改为新地址（draft，尚未保存）就直接发现/扫码 → 实际打到**旧服务器** → token 落旧服务器、配置却存新服务器，造成「登录态与配置分属两台服务器」。账号密码登录不受影响（PUT 先落配置再登录）。

- **D28 参数化目标地址**：`discoverProviders(role, serverUrl?)`、`startQrLogin(role, provider, serverUrl?)`、`pollQrLogin(role, qrId, serverUrl?)` 接受可选 `serverUrl` 覆盖已保存值（未传则回退 `loadDshSettings().serverUrl`，兼容既有调用）。前端发现与扫码均传 **draft.serverUrl**，使「发现的 provider / 扫码授权的服务器」与用户当前编辑的地址一致。
- **D29 扫码后持久化**：`qr/start` 与 `qr/poll` 必须传**同一** serverUrl；poll complete 时 token 以该 baseUrl 为键落入 role scope store。前端在扫码完成后（`onComplete`）再 `PUT /api/dsh/config` 持久化配置字段（含 serverUrl），使 token 与连接所用服务器一致。**不在扫码前 PUT**——因 host/both 角色无 token 时 `applyDshRuntime`→`startDshHostService` 会抛 `DSH_AUTH_REQUIRED`（见 D30）。
- **D30 serverUrl 校验**：后端对传入 `serverUrl` 仅做 http(s) 前缀校验（复用 `normalizeServerUrl` 语义，非法→400）。不额外封内网/回环：AgentLRay 绑 127.0.0.1 的单用户本地工具，用户本就要连内网自托管中继；更深一层的传输校验由 vendor `ClientServerApi` 构造时执行（HTTPS，或私有网段/localhost 允许 HTTP、禁止带凭证/路径/query/fragment）。
- **D31 both 部分登录失败**：`loginWithAccount('both')` 逐 scope 注册，任一失败即抛错；**已成功 scope 的 token 保留**（`authStatus.loggedIn` 可能仍为 true），重试时按已有 token 幂等跳过。接受半登录态、不做全量回滚（原 P3 留作已知边界）。

## 后端契约

### 数据模型（hosts.json 顶层 dsh section）

```json
{
  "role": "host|client|both",
  "serverUrl": "https://dsh.r2049.cn",
  "deviceName": "...",
  "allowedPorts": [3800]
}
```

> 账号密码不落盘（D4）：`email`/`passwordEnc` **不再读写**（2026-11-19 评审 P4 彻底清理，旧字段下次保存即从 `hosts.json` 消失）。

### 端点

| 端点 | 方法 | 请求 | 响应 | 说明 |
| --- | --- | --- | --- | --- |
| `/api/dsh/config` | GET | — | 配置字段 + `authStatus:{loggedIn:bool, roles:['host','client']}` | `authStatus.loggedIn`=任一 scope 有有效 token；`roles`=有 token 的 scope 集合（2026-11-19 清理：不含 email/hasPassword/accountPassword） |
| `/api/dsh/config` | PUT | 配置字段 + 可选 `email`/`password` | 同上 | 落配置字段（不写账号密码）；带 email+password → 同时 `authorizeWithAccount` 登录生成 token；登录失败认证类→400 带 code、网络类→502 |
| `/api/dsh/auth/providers` | GET | 可选 `?role=`、`?serverUrl=` | `{providers:[{id,displayName,qrStartUrl}], devicePairing:bool}` | 无状态转发 `oauthProviders()`；`role` 覆盖配置 role（P1）；`serverUrl` 覆盖目标服务器（Q2，非法→400） |
| `/api/dsh/auth/qr/start` | POST | `{role, provider, serverUrl?}` | `{qrId,scanUrl,expiresIn,provider}` | 无状态转发，返回官方形状；`serverUrl` 为本次授权的目标服务器（Q3，非法→400） |
| `/api/dsh/auth/qr/poll` | POST | `{role, qrId, serverUrl?}` | `{status:'pending'|'complete'|'expired'}` | 无状态转发；start/poll 须传同一 serverUrl；complete 时 token 以该 baseUrl 为键落该 role scope store |
| `/api/dsh/auth/logout` | POST | — | `{ok:true}` | 清**所有 scope** token，回未登录态 |

### 模块划分

- **新增 `lib/dsh/auth.js`**：聚合认证操作——`discoverProviders(role?, serverUrl?)`、`startQrLogin(role, provider, serverUrl?)`、`pollQrLogin(role, qrId, serverUrl?)`、`loginWithAccount(role, email, password)`、`logout()`、`scopeLoginStatus()`（判定各 scope 有无 token）、`scopesForRole(role)`。`openAuthSession(scope, serverUrl?)` 支持目标地址覆盖（Q1–Q3）。
- **`lib/dsh/settings.js`**：2026-11-19 评审 P4 后**彻底清理账号密码**——`saveDshSettings` 忽略 email/password 且重写 dsh section 只写配置字段；`loadDshSettings` 不读 email/passwordEnc/hasPassword；删除 `loadDshCredentials`；`migrateDshSectionOnce` 只搬配置字段。
- **`lib/routes/dsh.js`**：新增 `/api/dsh/auth/*` 端点 + `GET /api/dsh/config` 返回 `authStatus`；`PUT /api/dsh/config` 带 email/password 时调 auth 登录。
- **`lib/dsh/client.js`/`lib/dsh/host.js`**：连接逻辑改为**纯 token 驱动**——`ensureCredentials`/`startDshHostService` 不再要求 `loadDshCredentials`（账号密码），改为读 scope store 的 token，无有效 token 则抛「dsh 登录已失效，请重新登录」。

## 前端契约

### 依赖与类型

- `frontend/package.json` 新增 `qrcode` + `@types/qrcode`。
- `frontend/src/api/client.ts`：扩展 `DshConfig`（加 `authStatus`），新增 `discoverDshAuthProviders(role?, serverUrl?)`/`startDshQrLogin({role,provider,serverUrl?})`/`pollDshQrLogin({role,qrId,serverUrl?})`/`logoutDsh` 函数。

### DshConfigDialog 重构

- `DshConfigDialog`：状态机（未登录/已登录）+ 配置字段 + 布局。登录方式页签**内联**在 `DshConfigDialog`（不再单列 `DshLoginTabs` 子组件，与实际实现对齐）。
- 子组件：`PasswordLoginPanel`（email/password + 登录按钮）、`QrLoginPanel`（provider 子 tab + 二维码 + 跳转链接 + 轮询，接收 `role`/`provider`/**`serverUrl`**）、`DshLoggedInView`（只读摘要 + 角色 + 退出）。
- provider 发现触发时机：**已登录不调用**；未登录时 serverUrl 非空 → 打开即发现；serverUrl 为空 → 填完**失焦后**发现；失焦重发现在 serverUrl **变化**时；退出登录后重新发现。both 不发现。发现请求带 **draft.serverUrl**（Q2）。
- 发现失败/无 provider → 只显示账号密码 tab（单方式直显）。

## 测试

新增 `test/dsh-auth.test.js`，用**注入 fake vendor api**（`ClientServerApi`/`HostServerApi` 模拟官方真实形状：providers 3 provider、qr/start 返回 `{qrId,scanUrl,expiresIn,provider}`、qr/poll 返回 pending/complete/expired、login 401/成功、统一错误信封）测 auth.js 与路由端点逻辑，**不依赖真实 dsh.r2049.cn**。保留现有 dsh-transport 集成测试。

2026-11-19 Q1–Q4 追加测试：
- `discoverProviders`/`startQrLogin`/`pollQrLogin` 传 `serverUrl` 时以该地址为 baseUrl（覆盖已保存值），token 落该地址 scope store。
- 路由层：`GET /api/dsh/auth/providers?serverUrl=`、`POST qr/start|poll` body 的 `serverUrl` 透传；非法 serverUrl（非 http(s)）→ 400。
- `discoverProviders` 发现失败回退分支（`oauthProviders` 抛错 → `{providers:[], error}`）。

验证：`npm test`（含新增 dsh-auth）+ `frontend npm run build`。

## 已知边界

- 本轮**不做 DSH-Go device-pairing**（另立范围）。
- token 过期（refresh 也失效/设备撤销）后需重新登录；连接时给「请重新登录」提示并自动切本地。**启动时记忆的 dsh 主机 token 失效 → 静默回落本机（无 toast）**，用户可在主机弹框重连时看到错误提示。
- 旧已落盘的 `email`/`passwordEnc` 在 2026-11-19（评审 P4）起**彻底清理**：`loadDshSettings` 不读、`saveDshSettings` 重写时清除、迁移不搬运。已有用户下次保存 dsh 配置后旧字段即从 `hosts.json` 消失。
- **both 部分登录失败**（D31）：host/client 两 scope 部分成功时保留已成功 token（`loggedIn` 可能为 true），重试幂等跳过已有 token 的 scope；不做全量回滚。
- **切 provider tab 会新开 QR 会话**：每次挂载即 `qr/start`，反复切 tab 会在服务器留下废弃会话（600s 后过期）。可接受。
- **扫码完成但 PUT 持久化失败**：token 已落（按 draft serverUrl），配置未存 → `authStatus` 仍按已保存 serverUrl 判定为未登录；前端提示「配置保存失败」，用户可重试或重新扫码。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（2026-11-19 评审修复 + serverUrl 参数化）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 官方服务器 provider 动态发现 | ✅ 已实现 | `lib/dsh/auth.js`、`lib/routes/dsh.js` |
| 扫码登录 / 账号密码登录 | ✅ 已实现 | `lib/dsh/auth.js`、`frontend/src/components/dsh/{QrLoginPanel,PasswordLoginPanel}.tsx` |
| 账号密码不落盘、token 为登录态 | ✅ 已实现 | `lib/dsh/settings.js`、`lib/dsh/auth.js` |
| `serverUrl` 参数化（发现/扫码） | ✅ 已实现 | `lib/routes/dsh.js` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
