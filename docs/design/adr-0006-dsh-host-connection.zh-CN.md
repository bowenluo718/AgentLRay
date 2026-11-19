# ADR-0006：基于 ds-harness-remote 的 dsh 远程主机连接

- **状态**：accepted（2026-11-17）
- **取代**：无（新增能力；`lib/hosts.js` 中 `type: 'dsh'` 的「dsh 传输尚未支持」占位由本 ADR 落地为真实现）
- **关联**：
  - [design-dsh-host-connection.zh-CN.md](design-dsh-host-connection.zh-CN.md)（完整设计，含方案 A 后续实现说明）
  - [design-multi-host.zh-CN.md](design-multi-host.zh-CN.md)（现有 ssh 多主机模型）
  - [design-inbound-peers.zh-CN.md](design-inbound-peers.zh-CN.md)（被连接方 peer 展示）
  - `design-ssh-password.zh-CN.md`（未随仓库分发）（复用的 AES-256-GCM 加密方案 `lib/secret.js`）

## 背景

AgentLRay 多主机能力目前只支持 ssh 隧道（`ssh -L`）连接远端 AgentLRay。需新增第二种远程主机连接方式——用 `ds-harness-remote` 通过中继服务器连接远端 AgentLRay，且 AgentLRay **既作连接方也作被连接方**（双向）。`lib/hosts.js` 早已预留 `type: 'dsh'` 占位。

外源调研（2026-11-17 实测）确认：`@dsh-remote/*` 底层包未发布到任何公开 registry，`ds-harness-remote` 插件本体虽发布（`0.6.5`）但绑定 dsh 宿主 peer、其 `dist/client.js` 是浏览器 bundle，**无任何公开可 `npm install` 的 Node 客户端库**。但逐文件核验确认其**连接骨架（client + host 两侧）完全自足**（零 dsh 宿主依赖），loopback 提供镜像对称的 HTTP/WS 端口转发。

## 决策

### D1 数据面形态：ds-harness-remote 当传输层

ds-harness-remote 只承担「加密传输通道 + loopback 端口转发」，AgentLRay 自己的 HTTP 数据面是唯一数据源。连接方 `LoopbackPreview` 本地开随机端口 → 经加密通道转发到远端 AgentLRay loopback 端口 → 喂给现有 proxy 数据面；被连接方 `LoopbackHost` 收到请求转发到本机 AgentLRay 端口。否决「直接用 ds-harness-remote 查远端 Harness/Codex 会话」（数据面不同，与「ssh 之外新增连接方式」语义不符）。

### D2 接入形态：作为 Node 客户端库嵌入

AgentLRay 自建连接（`ClientServerApi` + `IdentityStore` + `AdaptiveTransport` + `ClientSecureTransport` + `RemoteClientCore`），远端就是另一台 AgentLRay、无需 dsh 宿主。否决「AgentLRay 做成 dsh 插件」（方向反向）与「仅参考打包形态」（无连接能力）。

### D3 角色模型：host / client / both

每实例 `role ∈ { host, client, both }`，默认 `both`。`host` 启动被连接方 host 服务（连中继服务器、接受连接、loopback 转发）；`client` 不开放被连；`both` 皆可。角色只控制「是否开放被连」，不影响作为连接方。

### D4 中继服务器：官方默认 + 可配自定义，不内置不托管

每个实例配置 `serverUrl`（默认官方 `https://dsh.r2049.cn`，可填自托管 `apps/server`）。AgentLRay 不内置、不托管中继服务器，只作为客户端接入。账号体系归中继服务器。

### D5 账号/凭据：共享一套 + secret 加密

`settings.json` 新增 `dsh` section（`role`/`serverUrl`/`email`/`passwordEnc`/`deviceName`），password 经现有 `lib/secret.js` AES-256-GCM 加密（复用 ssh 私钥/llm.apiKey 方案），GET 不回明文。设备身份（25519 密钥对）落 `~/.agentlray/dsh-device.json` + `.key`（0600）。共享账号 + 设备身份 + Host 固定身份三重校验（ds-harness-remote 原生语义）。

### D6 传输抽象：独立 `lib/dsh/` 模块，`type` 分支

`lib/hosts.js` 的 `openHost`/`tunnelAndProbe` 按 `type` 分支：`ssh` 走现有 `lib/transport.js`（零改动），`dsh` 走新增 `lib/dsh/client.js`（建 LoopbackPreview 隧道 + `probeVersion`），产出与 ssh 相同的契约 `{ status, baseUrl, version }`。「探测 `/api/version` + 收尾」复用；「建隧道」按 type 分派。状态机/CRUD/proxy/前端 host 选择均复用。

### D7 被连接方生命周期：随 server 常驻

`role ∈ { host, both }` 时 server 启动即拉起 `lib/dsh/host.js`（host 服务），独立于「当前选中主机」、不占 runtime 连接槽、进程退出即关。

### D8 inbound 展示统一：并入现有 peer 注册表 + `via` 字段

ds-harness-remote 被连接方天然知道谁在连（`ConnectionController` 持有 `peerDeviceId`），把设备身份转成同构 peer（`peerId`/`label`/`via: 'dsh'`）并入 `lib/inbound.js` 注册表。`GET /api/inbound` 每项加 `via: 'ssh'|'dsh'`，前端 `被 N 连` 徽标统一展示两种来源。

### D9 连接目标：从中继服务器设备列表选

连接方添加 dsh 主机时，前端拉 `GET /api/dsh/devices`（`ClientServerApi.listDevices()`）点选设备（`deviceId` + label），生成 `type: 'dsh'` 目标。设备未上线可保存；本机设备排除。不手填网络地址（ds-harness-remote 目标是设备 ID 而非地址）。

### D10 借码方式：本地拷贝进 `lib/dsh/vendor/`（+ 方案 A 后续说明）

无公开可安装的 Node 库，只能从 `liguobao/ds-harness-remote` 源码引入连接骨架。**当前采用本地拷贝**进 `lib/dsh/vendor/`（四个自足包 `client-core`/`webrtc`/`crypto`/`protocol` + 连接编排文件），顶部注释标注来源 commit，上游同步文档化为手动步骤。**方案 A（git submodule）的切换条件、步骤、风险与回退**完整记录在 [design-dsh-host-connection.zh-CN.md](design-dsh-host-connection.zh-CN.md) 的「方案 A 后续实现说明」节——仅在确需随上游自动同步时启用。

### D11 被连接方放行端口

被连接方 host 侧默认放行 `3800`（AgentLRay 默认端口）、可在 dsh 设置追加放行端口；连接方 dsh 目标带「远端 AgentLRay 端口」字段（默认 3800，对齐 ssh `remoteAgentLrayPort`）。

## 后果

正面：

- 新增一种**穿 NAT / 免开公网端口 / 免 ssh** 的远程主机连接方式；
- 双向（连接方 + 被连接方），远端无需 dsh/Harness；
- 复用现有 proxy 数据面、状态机、CRUD、inbound 展示，ssh 路径零改动；
- 复用 `lib/secret.js` 加密、`lib/settings.js` 聚合读写、`lib/inbound.js` 展示。

负面/成本：

- 需引入并维护 ds-harness-remote 连接骨架的本地拷贝（`lib/dsh/vendor/`），上游更新手动同步；
- 引入中继服务器依赖（默认官方，内网强控需自托管）；
- 共享账号 + 设备身份体系，账号泄露则同账号设备可被枚举（信任边界同 ds-harness-remote）；
- 需实现 host 侧连接骨架 + loopback 放行，涉及一定量的新代码与测试。

## 备选方案

1. **`npm install ds-harness-remote` 直接用**：发布版 `dist/index.js` 顶层 import `@deepseek-ai/dsh-client-connection`（dsh 宿主 peer），纯净 Node 无法 require（实测 `ERR_MODULE_NOT_FOUND`）；`./client` 是浏览器 bundle。否决。
2. **`npm install @dsh-remote/*`**：底层包未发布（npmjs/npmmirror 均 404）。否决。
3. **AgentLRay 做成 dsh 插件（Cordis）**：方向反向（把 AgentLRay 当被连对象挂进 Harness），且需整套 dsh 宿主 peer。否决。
4. **直接用 ds-harness-remote 查远端 Harness/Codex 会话**：数据面与「ssh 之外新增连接方式」不符，且需 dsh 宿主。否决。

## 与旧决策的关系

- **扩展现有多主机模型**（[design-multi-host.zh-CN.md](design-multi-host.zh-CN.md)）：`type: 'dsh'` 作为第二种传输，与 ssh 并存；proxy 数据面/状态机/CRUD 复用不变。
- **inbound 展示**（[design-inbound-peers.zh-CN.md](design-inbound-peers.zh-CN.md)）：peer 结构加 `via` 字段，向后兼容（旧 peer 无 `via` 视为 `ssh`）。
- **加密方案**（`design-ssh-password.zh-CN.md`（未随仓库分发））：复用 `lib/secret.js` AES-256-GCM，`dsh.passwordEnc` 与 `ssh.identityKeyEnc`/`llm.apiKeyEnc` 同机制。
- 本 ADR 落地 `lib/hosts.js` 中 `type: 'dsh'` 的预留占位，不改变 ssh 路径。

## 实现落地补记（2026-11-17）

本 ADR 的决策已全部落地，实现细节与偏差见 [design-dsh-host-connection.zh-CN.md](design-dsh-host-connection.zh-CN.md) 的「实现落地补记」一节。落地过程中实测得出三条初版未覆盖的硬约束，直接影响了实现形态：

1. **中继服务器对同一设备只保留一条控制连接**（新连接顶替旧连接）——本地设备身份按用途拆为 `host`/`client`/`probe` 三套；借码层 `ConnectionController` 打补丁，使同设备的并发连接不再互相顶替。
2. **上游 loopback 两端不可直接复用**——`LoopbackPreview` 的预览源校验与 AgentLRay 的服务器到服务器网关转发不兼容；`LoopbackHost` 的 20 秒空闲读超时会切断 SSE 会话尾随。故 loopback 两端由 AgentLRay 自研（沿用上游同一套线协议）。
3. **传输只走 Relay**——不引入上游的 `werift` WebRTC/TURN 栈（`forceRelay: true`），后续可按需追加。

借码层（`lib/dsh/vendor/`）的裁剪与补丁清单见 [lib/dsh/vendor/README.md](../../lib/dsh/vendor/README.md)。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：Accepted，已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| `type: dsh` 连接与 `lib/dsh/` 模块 | ✅ 已实现 | `lib/dsh/{client,host,identity,settings}.js` |
| 共享账号/中继配置与加密 secret | ✅ 已实现 | `lib/dsh/settings.js`、`lib/secret.js`、`lib/hosts-file.js` |
| 被连接方 inbound `via` | ✅ 已实现 | `lib/inbound.js`、`lib/routes/inbound.js` |
| loopback 端口映射 | ✅ 已实现 | `lib/dsh/loopback.js`、`loopback-client.js`、`loopback-host.js` |

