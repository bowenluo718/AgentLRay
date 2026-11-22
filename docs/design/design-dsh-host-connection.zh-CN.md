# AgentLRay 基于 ds-harness-remote 的远程主机连接（dsh 传输）

> 状态：**已实现**（2026-11-17 设计定稿 → 同日实现落地）。交付物 A = 设计文档 + ADR + 术语表；
> 实现补记见文末「实现落地补记（2026-11-17）」，其中记录了与初版设计的偏差及其实测依据。
> 关联：[adr-0006-dsh-host-connection.zh-CN.md](adr-0006-dsh-host-connection.zh-CN.md)（决策记录）、[glossary.zh-CN.md](glossary.zh-CN.md)（术语）。

## 背景与目标

AgentLRay 现有「多主机」能力用 **ssh 隧道**连接远端另一台 AgentLRay（`ssh -L` 本地端口转发 → 本地网关按 `X-Host-Id` 透传其 `/api/*` 数据面）。`lib/hosts.js` 的 `normalizeHost` 早已**预留 `type: 'dsh'`**，命中即抛「dsh 传输尚未支持（type 预留）」。

本次目标：在 ssh 之外，**新增一种基于 ds-harness-remote 的远程主机连接方式**——通过代理/中继服务器连接远端 AgentLRay，且 AgentLRay **既能作为连接方（去连别的 AgentLRay）也能作为被连接方（被别的 AgentLRay 连）**，参考 `ds-harness-remote` 插件 `packages/plugin/package.json` 的接入方式。

**核心定位**：ds-harness-remote 在 AgentLRay 里只承担「**加密传输通道 + loopback 端口转发**」；AgentLRay 自己的 HTTP 数据面仍是唯一数据源（与 ssh 连到的其实是同一套 AgentLRay 会话/界面）。远端就是另一台 AgentLRay，**不需要装 DeepSeek Harness/dsh**。

## 外源调研结论（已实测，2026-11-17）

ds-harness-remote 是一个 pnpm workspace 单仓（GitHub `liguobao/ds-harness-remote`），Client ↔ Relay Server ↔ Host 三角模型，连接路径 LAN → P2P(WebRTC) → TURN → Relay。查询公开源（npmjs / npmmirror / GitHub releases）确认：

| 包 | 公开源状态 | 结论 |
| --- | --- | --- |
| `@dsh-remote/client-core` / `webrtc` / `crypto` | 公开 registry **全部 404**，仅存于 monorepo 内部 workspace | **未发布**，无法 `npm install` |
| `@dsh-remote/protocol`（npm 上有） | **同名第三方项目**（`providcc` 的 DSH Remote Control，repo `dsh-remote/*`） | 非 liguobao 的，**不可信任/不可用** |
| `ds-harness-remote@0.6.5`（插件本体，已发布） | `dist/index.js` 顶层 import `@deepseek-ai/dsh-client-connection`（dsh 宿主 peer）→ **纯净 Node 无法 require**（实测 `ERR_MODULE_NOT_FOUND`）；`./client` 的 `dist/client.js` 是**浏览器 bundle**（引用 `window`）→ Node 无法用 | 为「在 DeepSeek Harness Cordis 容器里跑」设计，**不向第三方 Node 进程暴露可独立 require 的连接骨架** |
| GitHub releases | 只有 Android/客户端二进制，无 Node 插件 tarball | 插件走 npm，非独立构建产物 |

**结论**：没有任何公开、可直接 `npm install` 的「Node 客户端库」形态现成模块。AgentLRay 作为纯 Node 连接方/被连接方集成，**只能从 `liguobao/ds-harness-remote` 源码引入连接骨架**（借码方式见 D10）。

## 可行性核验：ds-harness-remote 连接骨架自足（可脱离 dsh 宿主）

逐文件核验（`packages/plugin/src/`）：

- **连接编排层零 dsh 宿主依赖**：`client-server-api.ts`（只依赖 node 标准库 + `@dsh-remote/crypto|protocol|webrtc` + `config.js`/`identity-store.js`/`server-credentials.js`）、`client-connection.ts`、`identity-store.ts`、`client-secure-transport.ts`、`server-credentials.ts`、`loopback-preview.ts`、`client-runtime-contract.ts`、`connection-controller.ts`、`server-connection.ts`、`host-pairing.ts`、`loopback-host.ts` **均不 import 任何 dsh 宿主包**。
- **host 侧连接骨架同样自足**：只有 `harness-remote-bridge`/`codex`/`acp`/`terminal` 这些「workspace 枚举面」依赖 `LocalTypertGateway`（dsh 宿主注入）；AgentLRay 不需要那部分，`rpc-router.ts` 对 harness/codex/acp 是 `import type`，运行时可只路由 `loopback.call`。
- **loopback 镜像对称**：连接方用 `LoopbackPreview`（本地开随机端口 → 经 `loopback.call` 转发到远端 loopback 端口），被连接方用 `LoopbackHost`（收到 `loopback.call` → 转发到本机 loopback 端口）。二者共用同一套加密传输，方向相反。

因此 **ds-harness-remote 的连接骨架（client 侧 + host 侧）可脱离 dsh 宿主、整体集成进 AgentLRay**；AgentLRay 只复用「连接骨架 + loopback」，丢弃 Harness/Codex/ACP workspace 面。

## grill-with-docs 决策收敛

### R1（数据面/接入/范围）

| 决策点 | 拍板 |
| --- | --- |
| 数据面形态 | **ds-harness-remote 当传输层，连「远程 AgentLRay」的 HTTP 数据面**（复用现有代理/会话模型，仅替换 ssh 隧道）。否决「直接查远程 Harness/Codex 会话」 |
| 接入形态 | **作为 Node 客户端库嵌入**（自建 `ClientServerApi`+`IdentityStore`+`AdaptiveTransport`+`ClientSecureTransport`+`RemoteClientCore`）。否决「AgentLRay 做成 dsh 插件」「仅参考打包形态」 |
| 交付物 | **先出设计文档 + ADR + 术语表**，实现另开轮次 |

### R2（角色/中继/账号/远端部署）

| 决策点 | 拍板 |
| --- | --- |
| 角色模型 | 每实例可选 **`host` / `client` / `both`**，`both` 为默认（复用 ds-harness-remote 原生三态） |
| 中继服务器 | **官方公开 `https://dsh.r2049.cn` 为默认 + 可配置自定义服务器**（如自托管 `apps/server`）；**项目内不内置、不托管中继服务器** |
| 账号/凭据 | **共享一套账号**：serverUrl / email / password（密码走现有 `lib/secret.js` AES-256-GCM 加密）存 `hosts.json` 顶层 `dsh` section；设备身份（25519 密钥对）文件放 `~/.agentlray/` |
| 远端部署 | **远端就是另一台 AgentLRay（无 dsh）**；ds-harness-remote 只承担传输 + loopback |

### R3（传输抽象/生命周期/inbound/连接目标）

| 决策点 | 拍板 |
| --- | --- |
| 传输抽象 | **新增独立 `lib/dsh/` 模块**（`dsh-client.js` 连接方 + `lib/dsh/host.js` 被连接方），`lib/hosts.js` 的 `openHost`/`tunnelAndProbe` 按 `type` 分支；**不重构现有 ssh 路径** |
| 被连接方生命周期 | **随 server 常驻**：角色含 `host` 时 server 启动即拉起 host 服务并连中继服务器，独立于「当前选中主机」 |
| inbound 展示 | **并入现有 inbound peer 注册表**，加 `via: 'ssh' | 'dsh'` 区分来源，`被 N 连` 徽标统一反映两种来源 |
| 连接目标选择 | **从中继服务器设备列表选**（`server.listDevices()`），不手填网络地址 |

### R4（端口/借码）

| 决策点 | 拍板 |
| --- | --- |
| 被连接方放行端口 | **放行列表 + 每目标端口字段**：被连接方 host 侧默认放行 `3800`、可在 dsh 设置追加；连接方 dsh 目标带「远端 AgentLRay 端口」字段（默认 3800，对齐 ssh `remoteAgentLrayPort`） |
| 借码方式 | **B 本地拷贝进 `lib/dsh/vendor/`**（标注来源 commit，上游同步文档化为手动步骤）；**并记录方案 A（git submodule）的后续实现说明**（见「方案 A（submodule）后续实现说明」节） |

## 架构设计

### 角色模型

每台 AgentLRay 实例有一个 `role ∈ { host, client, both }`（默认 `both`）：

- `host`：启动被连接方 host 服务（连中继服务器、接受加密连接、loopback 转发），供别的 AgentLRay 连进来。
- `client`：不启动 host 服务，只作为连接方去连别的 AgentLRay（不对外开放被连）。
- `both`：两者皆可。

角色只控制「是否开放被连」，**不影响** AgentLRay 作为连接方的能力（任何角色都能连别的 AgentLRay）。

### 中继服务器（Relay Server）

- 每个实例配置一个 `serverUrl`（默认官方 `https://dsh.r2049.cn`），也可填自托管 `apps/server` 地址（配 `DSH_SERVER_ACCOUNT`/`DSH_SERVER_PASSWORD`）。
- AgentLRay **不内置、不托管**中继服务器；只作为其客户端接入。
- 账号体系归中继服务器：官方服务器用其公开账号体系，自托管用自配账号。

### 账号与设备身份

- `hosts.json` 顶层新增 `dsh` section（见「数据模型」），共享一套账号（email/password），password 加密存 `passwordEnc`。
- 设备身份：首次连接生成 25519 密钥对，落 `~/.agentlray/dsh/dsh-device.json` + `~/.agentlray/dsh/dsh-device.key`（沿用 ds-harness-remote 命名），作为该 AgentLRay 实例在中继服务器上的设备身份。
- 被连接方固定身份：Host 侧在服务器上注册/固定自己的 identityKey，连接方连接时做「账号成员 + 设备身份 + Host 固定身份」三重校验（ds-harness-remote 原生语义）。

### 双向连接

```
              ┌───────────── 中继服务器（账号认证 + WebRTC/TURN/Relay 转发）─────────────┐
              │                                                                        │
   连接方 AgentLRay                                                   被连接方 AgentLRay
   (client/both)                                                       (host/both)
   IdentityStore ─┐                                                     IdentityStore ─┐
   ClientServerApi│ 连中继服务器                                          HostServerConn │ 连中继服务器
   AdaptiveTransport┐  加密传输                                              ConnectionController ┐ 接受连接
   ClientSecureTransport│ (Noise_IK_25519_ChaChaPoly_SHA256)                RpcRouter + LoopbackHost │ loopback 转发
   RemoteClientCore ┘                                                        └→ 本机 127.0.0.1:<port> AgentLRay
   LoopbackPreview ── 本地开随机端口 ── 转发 loopback.call ──────────────────────────►
        │
        ▼
   本地 HTTP → http://127.0.0.1:<localPort>  →  代理到远端 AgentLRay 的 /api/*
```

- **连接方**：`LoopbackPreview` 在本地开一个随机端口，`loopback.call` 经加密通道把 HTTP/WS 请求转发到远端 AgentLRay 的 loopback 端口（目标端口 = 该 dsh 主机的「远端 AgentLRay 端口」字段，默认 3800）。本地 HTTP 入口等价于 ssh `-L` 后的本地端口，喂给现有 proxy 数据面。
- **被连接方**：`LoopbackHost` 收到连接方的 `loopback.call` 请求，转发到本机 loopback 端口（放行列表内的端口），即本机 AgentLRay 的 HTTP 数据面。

### 传输抽象与 `type` 分支

`lib/hosts.js` 的 `openHost`/`tunnelAndProbe` 按 `type` 分支：

- `type: 'ssh'` → 走现有 `lib/transport.js`（`spawnSsh` + `buildSshArgs` + `probeVersion`），**零改动**。
- `type: 'dsh'` → 走新增 `lib/dsh/client.js`（`openDshTunnel` 建 LoopbackPreview 隧道 + `probeVersion`），产出与 ssh 相同的契约：`{ status, baseUrl, version }`。

`tunnelAndProbe` 的「探测 `/api/version` + 收尾」逻辑复用；「建隧道」按 type 分派。状态机（disconnected/connecting/connected/error）、CRUD、proxy 透传、前端 host 选择均**复用**。

### 被连接方生命周期

- 服务启动时按 `role` 决定是否拉起 `lib/dsh/host.js`（host 服务）：`role ∈ { host, both }` 即启动。
- host 服务独立于「当前选中主机」，不进入 `runtime` Map（不占连接槽），生命周期绑定 server 进程（进程退出即关）。
- 连接方与被连接方同机自连需防护（见「边界」）。

### inbound 展示统一

- 现有 `lib/inbound.js` peer 注册表（`registerPeer({ peerId, label, ... })`）服务 ssh 连接方上报 + 心跳。
- ds-harness-remote 被连接方在**账号/设备体系里天然知道谁在连**（`ConnectionController` 持有每连接的 `peerDeviceId`），无需连接方上报。把其设备身份转成同构 peer（`peerId = 设备 ID`、`label = 设备名`、`via: 'dsh'`）并入注册表。
- `GET /api/inbound` 的 peer 快照每项加 `via` 字段；前端 `被 N 连` 徽标与明细统一展示两种来源。

### 连接目标选择

- 连接方添加 dsh 主机：前端拉 `GET /api/dsh/devices`（经 `ClientServerApi.listDevices()` 取中继服务器上的已知/在线设备），用户点选（`deviceId` + 显示名 label）生成一个 `type: 'dsh'` 连接目标。
- 设备未上线也能保存（label 可编辑）；本机设备从候选列表排除。

## 数据模型

### `hosts.json` 顶层新增 `dsh` section

```jsonc
{
  "hosts": [],
  "dsh": {
    "role": "both",                 // host | client | both，默认 both
    "serverUrl": "https://dsh.r2049.cn",  // 默认官方，可改自托管
    "email": "user@example.com",    // 中继服务器账号
    "passwordEnc": "<AES-256-GCM 密文>",  // 密码，经 lib/secret.js 加密，GET 不回明文
    "deviceName": "<短主机名>",      // 设备名，默认 os.hostname() 短名
    "allowedPorts": [3800]          // 被连接方放行端口（默认 [3800]）
  }
}
```

- 与主机列表同文件（`hosts.json`，0600 权限），经 `lib/hosts-file.js` 共享层读写；`lib/hosts.js` 写盘时合并保留顶层 dsh。
- 密码沿用 `lib/secret.js` AES-256-GCM 加密（复用 ssh 私钥/llm.apiKey 方案），GET 只回 `hasPassword` 不明文。
- **旧版本迁移**：曾存于 `settings.json` 的 `dsh` section，首次读取时经 `migrateDshSectionOnce` 状态驱动幂等迁移到 hosts.json。

### 设备身份文件（`~/.agentlray/dsh/`）

- `dsh-device.json`：设备公开信息（deviceId、公钥）。
- `dsh-device.key`：25519 私钥，0600。
- 按用途拆分 `host`/`client`/`probe` 三套（`dsh-{client,probe}.json` + `.key`），与各 scope 凭据目录 `~/.agentlray/dsh/<scope>/` 同处 `~/.agentlray/dsh/` 下，不散落 `~/.agentlray` 根目录。
- **退出即清空**：`POST /api/dsh/auth/logout` 先停被连接方服务（常驻服务持有凭据存储、会重连写盘），再关闭 `hosts.js` 运行时持有的全部 dsh 隧道（client/probe 会话的令牌刷新同样会把凭据写回；ssh 隧道不依赖 dsh 凭据，保持不动），最后递归删除整个 `~/.agentlray/dsh/`（凭据 + 身份/密钥 + 信任库），下次登录重新生成设备身份；dsh 配置（`role`/`serverUrl`/`deviceName`/`allowedPorts`）在 `hosts.json`，不受影响。
- **设备身份只在登录时生成**：登录态判定（`scopeLoginStatus`）、列设备（`listDshDevices`）、发现登录方式（`discoverProviders`）、发起扫码（`startQrLogin`）、建隧道、被连接方启动等路径一律只读既有身份（`loadExisting` + `loadPeers`），无身份时按「登录已失效」处理。否则退出后 UI 一刷新（`GET /api/dsh/config`）、打开登录表单或主机弹框就会把 `dsh-device.*`/`dsh-client.*` 写回目录。
- 键对生成/编码沿用 ds-harness-remote `identity-store.ts` 的语义（base64url 无填充、公钥指纹同算法）；持久化位置与生成时机由 AgentLRay 决定（登录时生成、退出时清除）。

### `hosts.json` 新增 `type: 'dsh'` 目标

```jsonc
{
  "id": "main-agentlray",
  "label": "主控 AgentLRay",
  "type": "dsh",
  "dsh": {
    "deviceId": "<中继服务器上的设备 ID>",
    "remoteAgentLrayPort": 3800   // 远端 AgentLRay 端口，默认 3800
  }
}
```

- `normalizeHost` 放开 `type: 'dsh'` 分支（原「dsh 传输尚未支持」占位改为真实现），校验 `dsh.deviceId` 必填、`dsh.remoteAgentLrayPort` 默认 3800。
- `type: 'ssh'` 目标结构不变。

### 前后端契约（新增/变更）

| 端点 | 说明 |
| --- | --- |
| `GET /api/dsh/config` | 本机 dsh 配置（角色/服务器/账号/设备名/放行端口，只回 `hasPassword`） |
| `PUT /api/dsh/config` | 保存 dsh 配置 + 热切换被连接方服务（`applyDshRuntime`） |
| `GET /api/dsh/status` | 本机 dsh 状态：`role`、`serverUrl`、`connected`（host 服务是否在线）、被连 peers（或并入 inbound） |
| `GET /api/dsh/devices` | 中继服务器设备列表（供连接方选目标；本机排除） |
| `POST /api/dsh/test` | 测试未保存的 dsh 连接目标（等价 ssh 的 `POST /api/hosts/test`） |
| `GET /api/inbound` | peer 快照每项加 `via: 'ssh'|'dsh'` |
| 复用 `/api/hosts` CRUD | body 带 `type: 'dsh'` + `dsh` 字段 |

前端：`HostFormDialog` 新增 dsh 表单分支（选设备 + 端口）、`HostsDialog` 底部「dsh 配置」按钮打开 `DshConfigDialog`（角色/服务器/账号，本机资源弹框）、`HostsDialog`/侧栏 inbound 徽标展示 `via`。设置面板（`SettingsDialog`）已移除 dsh 页签，`GET/PUT /api/settings` 不再含 dsh section。

## 边界与取舍

- **循环连接**：A 连 B、B 连 A 同时存在——各自把对方视为一个 peer 显示，无状态冲突（连接方向相反、互不依赖）。
- **自连**：连接方从设备列表排除本机设备；若强行配置本机 deviceId，`openDshTunnel` 报错拒绝（防 loopback 自环）。
- **角色切换**：`role` 从含 `host` 切到 `client` 时，需要重启 host 服务；`role` 变更按「重启后生效」语义（对齐 settings 生效约定）或即时热切换（实现时二选一，倾向即时热切换，host 服务可启停）。
- **非 3800 端口**：目标 AgentLRay 跑非默认端口时，被连接方需在 dsh 设置放行该端口、连接方目标填该端口。
- **账号为共享**：同一内网/团队多台 AgentLRay 用一套账号互连，靠设备身份 + Host 固定身份区分；账号泄露则所有设备可被该账号成员枚举（信任边界同 ds-harness-remote）。
- **官方服务器账号**：用官方 `dsh.r2049.cn` 需有该体系账号；内网强控场景建议自托管 `apps/server`。

## 验证路径（设计定稿，实现时执行）

- 单元：`lib/dsh/client.js` / `lib/dsh/host.js` 的隧道建立/关闭/探测（mock 中继服务器 + mock loopback，对齐 `test/fixtures/ssh-mock.cjs` 思路）；`normalizeHost` 的 `type: 'dsh'` 分支校验；`via` 字段 inbound 合并；`hosts.json` 顶层 dsh section 加密读写 + 旧 settings.json 迁移（`test/dsh-transport.test.js`）。
- 端到端冒烟：自托管 `apps/server`（`DSH_SERVER_ACCOUNT`/`DSH_SERVER_PASSWORD`）+ 两台 AgentLRay 实例（一台 `both`、一台 `client`），连接方选设备 → 建 dsh 隧道 → 探测远端 `/api/version` → proxy 透传远端会话列表 → 被连接方 inbound 显示 `via: 'dsh'` 的 peer。
- 回归：现有 ssh 多主机测试全部保留（`test/hosts.test.js`、`test/transport.test.js`、`test/proxy.test.js`），确认 dsh 分支不触碰 ssh 路径。

## 方案 A（git submodule）后续实现说明

> 当前采用 **D10-B（本地拷贝进 `lib/dsh/vendor/`）**。本节约定「何时/如何切换到方案 A（git submodule）」，作为未来可选升级路径，仅在确有「随上游自动同步」需求时启用。

**切换触发条件**（满足其一再考虑）：
- 需要频繁跟随 ds-harness-remote 上游修复/特性（如协议升级、WebRTC 栈更新）；
- 有多个项目复用同一份 ds-harness-remote 连接骨架，希望单一真源；
- 上游把 `@dsh-remote/*` 正式发布到公开 npm（届时可直接 `npm install`，无需 submodule）。

**切换步骤**：
1. 在 AgentLRay 仓库根挂 submodule：`git submodule add https://github.com/liguobao/ds-harness-remote vendor/ds-harness-remote`（锁定 tag，如 `v0.6.5`）。
2. 把 `lib/dsh/vendor/` 下已拷贝的源码**替换为对 submodule 的引用**：`lib/dsh/vendor/index.js` 改为 `module.exports = require('../../vendor/ds-harness-remote/packages/plugin/src/...')`（或直接 import submodule 内源码），删除重复拷贝。
3. `lib/dsh/vendor/README.md` 记录「真源在 submodule」；`.gitignore` 不再忽略 vendor（改为 submodule 管理）。
4. 构建/分发：npm 包需在 `files` 含 `vendor/ds-harness-remote`，或预构建后仅带所需 dist；CI/安装脚本补 `git submodule update --init`（或发布前预打包）。
5. 升级流程：`git -C vendor/ds-harness-remote fetch && git -C vendor/ds-harness-remote checkout <new-tag>` → 跑 dsh 相关测试 → 提交 submodule 指针。

**风险与回退**：
- submodule 引入 clone/init/update 流程，离线/内网 clone 需要上游可达；
- 若上游目录结构/导出变化，`lib/dsh/vendor` 引用需同步调整；
- 回退：删 submodule 指针、恢复 `lib/dsh/vendor/` 拷贝（保留 git 历史中的拷贝版本）。

**当前建议**：维持 B（拷贝），把「同步上游」固化为文档化手动步骤（升级时 diff 拷贝文件 + 更新顶部来源 commit 注释）。只有当出现上表任一触发条件时才切换 A。

---

## 实现落地补记（2026-11-17）

实现按本设计落地，代码分布：`lib/dsh/`（模块本体 + 借码层 `lib/dsh/vendor/`）、`lib/hosts.js`（`type` 分支）、`lib/inbound.js`（`via`）、`lib/routes/dsh.js` + `lib/routes/settings.js` + `lib/routes/hosts.js` + `lib/routes/proxy.js`、`server.js`（挂载 + 被连接方常驻）、前端 `HostFormDialog` / `SettingsDialog` / `HostsDialog` / `api/client` / `api/types`，测试 `test/dsh.test.js`。

### 落地时的偏差（均带实测依据）

| # | 初版设计 | 实际实现 | 依据 |
| --- | --- | --- | --- |
| 1 | 借码「连接骨架 + loopback」 | **借码连接骨架，loopback 两端自研**（`lib/dsh/loopback*.js`），沿用上游同一套线协议（`describe`/`http.open`/`http.read`/`close`） | 上游 `LoopbackPreview` 是浏览器预览模型（要求 `Host` 等于随机 `*.localhost` 授权域，否则 403），与 AgentLRay「服务器到服务器网关转发、`Host` 须原样透传（远端 csrf 依赖 `Host == Origin`）」不兼容；上游 `LoopbackHost` 的 `http.read` 空闲 20 秒即断链，会切断 AgentLRay 的 SSE 会话尾随 |
| 2 | 出站/被连共用一套设备身份 | **按用途拆分三套身份**：`host`（`~/.agentlray/dsh/dsh-device.json`，本机被连）、`client`（`dsh-client.json`，出站隧道）、`probe`（`dsh-probe.json`，连接测试） | 中继服务器对**同一设备只保留一条控制连接**（实测：`gateway.ts` 新连接时 `disconnect(device.deviceId, 'CONNECTION_REPLACED')`）。共用身份会让「连接测试」顶替正在使用的出站隧道 |
| 3 | 传输链路 LAN → P2P → TURN → Relay | **仅 Relay**（`forceRelay: true`） | AgentLRay 不内置 WebRTC/TURN 后端（上游依赖 `werift` 纯 JS WebRTC 栈 + ICE 服务）；Relay 通道由中继服务器承载，天然穿 NAT。预留 `forceRelay` 开关，后续可加 WebRTC |
| 4 | —（初版未涉及） | 借码层补丁：`ConnectionController` **不再按 `peerDeviceId` 顶替**并发连接（只按 `connectionId` 顶替） | 同上：上游「同一对端设备只保留一条逻辑连接」会顶替同设备的另一条隧道（实测：探测隧道顶替常驻隧道，常驻隧道随即 502）。补丁说明见 `lib/dsh/vendor/README.md` §4.8 |
| 5 | 放行端口「默认 3800、可在 dsh 设置追加」 | 落到 `hosts.json` 顶层 `dsh.allowedPorts`（默认 `[3800]`），被连接方**每条连接一个独立 loopback 宿主** | 共享 loopback 宿主时，一条连接断开会把**所有**连接的在途请求一起断掉（实测 502） |

### 实测结论（本地自托管中继服务器 + 两个 AgentLRay 实例）

- 中继服务器：上游 `apps/server`（自托管，`DSH_SERVER_ACCOUNT`/`DSH_SERVER_PASSWORD`），AgentLRay 不内置、不托管（设计 D4 保持）。
- 连接方（`role=client`）选设备 → 建隧道 → 探测远端 `/api/version` 成功（bootId 与被连接方一致）→ 经网关取远端 `/api/platforms` 成功 → `PUT /api/settings`（csrf 路径）经隧道 200 → SSE `/api/watch` 经隧道收到 `event: connected` 并保持长连接。
- 被连接方 `GET /api/inbound` 出现 `via: 'dsh'` 的 peer（peerId = 连接方设备 id，label = 设备名）。
- 「连接测试」与常驻隧道并存互不干扰（独立探测身份 + 借码层补丁共同保证）。

### 已知边界

- **同一 AgentLRay 实例同时只能保持一条 dsh 出站隧道**：中继服务器对同一设备只保留一条控制连接。与既有「同一时刻只保留当前选中主机一条隧道」（`closeAllExcept`）的模型一致；切换主机时旧隧道随之关闭。
- dsh 目标只能选**在线**设备（离线设备可保存配置，但连接时会被拒）。
- WebSocket 不经 dsh 隧道（AgentLRay 前端只用 SSE，无 WS 通道）。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（含 2026-11-17 dsh 配置迁入 hosts.json 增量）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| dsh 传输 `type: dsh` | ✅ 已实现 | `lib/dsh/`、`lib/transport.js`、`lib/hosts.js` |
| dsh 配置独立端点 | ✅ 已实现 | `lib/routes/dsh.js`、`frontend/src/components/DshConfigDialog.tsx` |
| 配置落 `hosts.json` 顶层 `dsh` | ✅ 已实现 | `lib/hosts-file.js`、`lib/dsh/settings.js` |
| inbound `via` / loopback | ✅ 已实现 | `lib/inbound.js`、`lib/dsh/loopback*.js` |

