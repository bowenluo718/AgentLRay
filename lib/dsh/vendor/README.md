# lib/dsh/vendor — ds-harness-remote 连接骨架借码层

本目录把上游仓库 [`liguobao/ds-harness-remote`](https://github.com/liguobao/ds-harness-remote) 的**连接骨架**（加密传输 + loopback 端口转发）以 TypeScript 源码形式借码进 AgentLRay，并编译为 **ESM** 产物 `lib/dsh/vendor/dist/`。

## 1. 上游来源

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/liguobao/ds-harness-remote |
| 上游 commit | `4cd6b4351c2c4be84c889dd72f2c42622f1d4235` |
| commit 日期 | 2026-11-17（`fix(harmony): 包名对齐 Android 为 io.github.liguobao.dshremote`） |
| 许可证 | **MIT License**（上游 `LICENSE`，Copyright (c) 2026 DSH Remote contributors） |
| 借码范围 | `packages/{crypto,protocol,webrtc,client-core,plugin}/src/` 中的连接骨架文件 |

### 为什么必须借码

上游是 pnpm workspace 仓库，其内部包 `@dsh-remote/crypto`、`@dsh-remote/protocol`、`@dsh-remote/webrtc`、`@dsh-remote/client-core` **未发布到任何 npm registry**；插件本体 `ds-harness-remote` 绑定 DSH 宿主（`@deepseek-ai/cordis` 等），无法被第三方 Node 进程 `require`。因此只能把需要的那部分源码"借"进本仓库自行编译。

MIT 许可证允许在保留版权声明与许可证文本的前提下使用、复制、修改。本目录每个借码文件顶部都带有来源、commit 与许可证标注，本文件即为本目录的许可证声明入口。

## 2. 目录结构

```
lib/dsh/vendor/
├── README.md              本文件
├── tsconfig.json          编译配置（module: nodenext / target: es2022）
├── src/                   借码 + 裁剪后的 TypeScript 源码（唯一需要人工维护的部分）
│   ├── package.json       {"type":"module"} —— 让 .ts 源文件按 ESM 解析
│   ├── index.ts           命名空间 barrel（vendor 产物的唯一入口）
│   ├── crypto/            上游 packages/crypto/src
│   ├── protocol/          上游 packages/protocol/src
│   ├── webrtc/            上游 packages/webrtc/src
│   ├── client-core/       上游 packages/client-core/src（已裁剪）
│   └── plugin/            上游 packages/plugin/src（部分裁剪 + 两个类型桩）
└── dist/                  编译产物（提交入库，调用方直接 require）
    ├── package.json       {"type":"module"}
    ├── index.js
    └── {crypto,protocol,webrtc,client-core,plugin}/*.js
```

### `src/` 与 `dist/` 的关系

* `src/` 是**唯一需要人工维护**的部分：同步上游、复核裁剪点、修改补丁都只发生在 `src/`。
* `dist/` 是 `src/` 的**纯编译产物**，由 `tsc` 生成，**不手工编辑**。仓库中提交 `dist/`，是为了让 CommonJS 调用方无需在安装时依赖 TypeScript 工具链即可 `require()`，同时保证"入库的二进制/产物与入库的源码"版本一致，不会出现调用方编译出不同产物的情况。
* 重新生成 `dist/` 只需一条命令（见 §5）。

### 调用方式

调用方是 CommonJS 的 AgentLRay，用 Node ≥ 22.12 的 `require(esm)` 能力加载 ESM 产物：

```js
const dsh = require('/abs/path/to/AgentLRay/lib/dsh/vendor/dist/index.js')
// → { crypto, protocol, webrtc, clientCore, serverApi, serverCredentials, serverConnection,
//     connectionController, clientSecureTransport, safeError, nodeWebSocket, logging, config,
//     transportUpgrade, ids, identityStore }
```

入口一律以**命名空间**方式导出，避免上游不同包之间的同名导出（如 `crypto` / `protocol` 各自的常量）在 CommonJS 侧互相覆盖。

> `rpc-router` **不导出**：调用方自己实现最小 host 路由；本仓库只保留 `plugin/identity-store.ts` 与 `plugin/rpc-router.ts` 两个**类型桩**供类型检查使用。

## 3. 借码文件清单

### `src/crypto/`（上游 `packages/crypto/src/`）

| 文件 | 说明 |
| --- | --- |
| `index.ts` | X25519 密钥对、HKDF 派生、ChaCha20-Poly1305 帧加解密、base64url 工具、指纹 |
| `noise.ts` | `NoiseIkSession` 封装（基于 `@lukeburns/clatterjs`）、`createNoisePrologue` |

### `src/protocol/`（上游 `packages/protocol/src/`）

| 文件 | 说明 |
| --- | --- |
| `index.ts` | 线上消息编解码、RPC 请求/响应、握手与控制帧、Relay 数据帧、安全消息编解码 |
| `loopback.ts` | loopback 请求/响应 schema（http.open / ws.open / read / send / close） |
| `close-semantics.ts` | 关闭原因（close code）语义 |
| `wire-json.ts` | 线上 JSON 解析 |
| `transport-upgrade.ts` | 传输升级（relay → WebRTC）能力协商 schema |
| `binary-upload.ts` | 二进制分块上传编解码 |
| `lan-upload.ts` | 局域网上传能力与票据 schema |

### `src/webrtc/`（上游 `packages/webrtc/src/`）

| 文件 | 说明 |
| --- | --- |
| `index.ts` | 包入口：`RelayTransport` 及各子模块 re-export |
| `transport.ts` | `BaseTransport` / `RemoteTransport` 抽象 |
| `adaptive-transport.ts` | `AdaptiveTransport`（relay / WebRTC 自适应选择） |
| `upgraded-rtc-transport.ts` | 升级后的 RTC 传输实现 |
| `rtc-adapter.ts` | `RTCPeerConnection` 工厂适配（浏览器 / Node） |
| `rtc-data-channel.ts` | `RtcDataChannelTransport` 数据通道传输 |
| `rtc-chunking.ts` | 大消息分块编解码 |
| `control-lease.ts` | 控制通道租约 |
| `serial-send.ts` | `SerialSend` 串行发送队列 |
| `websocket-backpressure.ts` | `waitForRelayCapacity` 背压等待 |
| `util.ts` | base64url 等小工具 |

### `src/client-core/`（上游 `packages/client-core/src/`）

| 文件 | 说明 |
| --- | --- |
| `index.ts` | `RemoteClientCore`、`RemoteClientError`、`RemoteClientErrorCode`、`RemoteRpcOptions`（**已裁剪**，见 §4.3） |

### `src/plugin/`（上游 `packages/plugin/src/`）

| 文件 | 说明 |
| --- | --- |
| `server-api.ts` | `ClientServerApi` / `HostServerApi`：与远端服务器配对 / 授权 / 凭据签发 |
| `server-credentials.ts` | `ServerCredentialStore`：服务器凭据落盘与轮转 |
| `server-connection.ts` | `HostServerConnection`：宿主侧 WebSocket + Noise + Relay/WebRTC 隧道 |
| `connection-controller.ts` | `ConnectionController`：认证对端通道与 RPC 分发 |
| `client-secure-transport.ts` | `ClientSecureTransport`：客户端侧加密传输 |
| `transport-upgrade.ts` | `TransportUpgradeHost`：传输升级宿主侧实现 |
| `safe-error.ts` | `RpcError` / 错误码规范化 |
| `node-websocket.ts` | `createNodeWebSocket`：Node 端 WebSocket 工厂 |
| `logging.ts` | `SafeLogger` / 日志级别 |
| `types.ts` | 共享类型（如 `AuthenticatedPeerChannel`） |
| `ids.ts` | `uuidV7` 等 ID 生成 |
| `version.ts` | `PLUGIN_VERSION` |
| `pairing-contract.ts` | 配对相关的 zod schema 与类型 |
| `config.ts` | 配置解析（**已裁剪**，见 §4.4） |
| `identity-store.ts` | **本项目手写的类型桩**（见 §4.1） |
| `rpc-router.ts` | **本项目手写的类型桩**（见 §4.2） |

### `src/index.ts`

本项目手写的命名空间 barrel（vendor 产物的唯一入口）。

## 4. 裁剪 / 补丁清单

以下 5 项是本仓库对上游代码做的**全部**改动。除此之外，所有借码文件除"头部来源注释"与"跨包 import 路径重写"外均与上游逐字一致。

### 4.1 `src/plugin/identity-store.ts` —— 类型桩（手写，非借码）

* **上游**：`packages/plugin/src/identity-store.ts`（1141 行），包含设备身份生成、文件锁、目录迁移、凭据轮转、信任对端持久化等完整运行时实现。
* **为什么裁剪**：本项目不使用上游的身份存储实现。AgentLRay 侧自行实现 `lib/dsh/identity.js`，落在 `~/.agentlray/dsh-device.json`，与 AgentLRay 的配置目录约定保持一致。
* **裁剪后由谁补位**：本文件只保留上游 `server-api.ts` / `server-connection.ts` / `connection-controller.ts` / `client-secure-transport.ts` 以 **type-only** 方式引用的类型契约：`HostIdentity`、`TrustedPeer`、`IdentityStore`、`RemoteDeviceRole`。`HostIdentity` 与 `TrustedPeer` 的字段与上游定义**逐字一致**（含 `schemaVersion: 1`、`membershipId?: string`），`IdentityStore` 的方法签名与上游一致。
* **运行时影响**：无。该文件编译产物为空模块（仅类型），不产生任何运行时代码。

### 4.2 `src/plugin/rpc-router.ts` —— 类型桩（手写，非借码）

* **上游**：`packages/plugin/src/rpc-router.ts`，依赖 codex / acp / harness workspace 桥接（`CodexPeerBridge`、`AcpPeerBridge`、`HarnessRemoteBridge`、`WorkspaceUploadHost`、`RemoteFileViewerBridge` 等），是一个完整的 RPC 方法路由实现。
* **为什么裁剪**：这些桥接属于 DSH 宿主的 acp / codex / harness 能力，本项目既不引入这些 workspace，也不使用它们的实现。
* **裁剪后由谁补位**：调用方（AgentLRay）自己实现最小 host 路由；本文件只保留上游 `connection-controller.ts` 以 **type-only** 方式引用的最小契约 `RpcRouter { handle(message): Promise<RemoteMessage>; closePeerStreams(): Promise<void> }`。
* **运行时影响**：无。该文件编译产物为空模块（仅类型）。

### 4.3 `src/client-core/index.ts` —— 删除 5 行 re-export

* **改动**：删除文件末尾的
  `export * from './remote-gateway.js'` / `'./harness-alpha-client.js'` / `'./codex-client.js'` / `'./acp-client.js'` / `'./transport-upgrader.js'`。
* **为什么裁剪**：这 5 个 re-export 会把 acp / codex / harness 桥接代码（`remote-gateway.ts`、`harness-alpha-client.ts`、`codex-client.ts`、`acp-client.ts`、`transport-upgrader.ts`）拉进 vendor 产物，属于明确禁止带入的宿主桥接代码。
* **裁剪后由谁补位**：`RemoteClientError`、`RemoteClientErrorCode`、`RemoteRpcOptions`、`RemoteClientCore` 及内部 `PendingCall` **全部保留**；`export type { EventPayload, RemoteEventName, RemoteTransport }` 也保留。调用方需要 gateway / harness 能力时，由 AgentLRay 侧自行实现。

### 4.4 `src/plugin/config.ts` —— 移除 Schemastery / Cordis 依赖

* **改动**：
  1. 删除 `import type { Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'`；
  2. 删除 `import s from '@deepseek-ai/schemastery'`；
  3. 删除 Schemastery 导出块 `entryConfigSchema`、`withVolatileSchema`、`export const Config`；
  4. 在文件内以本地类型别名 `type Volatile<T> = T` / `type VolatileSnapshot<T> = T` 替代 Cordis 的 volatile 类型。
* **为什么裁剪**：`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 是 DSH 宿主的配置框架，本项目不引入；`Config`（接口）与 `Config`（Schemastery schema 常量）同名，删除常量后接口得以保留。
* **裁剪后由谁补位**：`DEFAULT_REMOTE_SERVER_URL`、`Config`、`ResolvedConfig`（及其 `ResolvedCodexConfig` / `ResolvedCursorConfig` / `ResolvedAcpConfig`）、`resolveConfig`、`normalizeServerUrl` 与全部私有辅助函数（`isPrivateNetworkHostname`、`parseIpAddress`、`parseIpv4`、`parseIpv6`、`normalizeHttpServerAllowlist`、`isAllowlistedHostname`、`matchesHttpServerAllowlist`、`isValidHttpServerAllowlistEntry`、`parseHttpServerAllowlistEnv` 等）以及基于 **zod** 的 `configSchema` 运行时校验**全部保留**。调用方若需要 Cordis volatile 配置语义，由 AgentLRay 侧自行适配。

### 4.5 跨包 import 重写

上游用 pnpm workspace 别名引用内部包，借码后必须改成相对路径。涉及文件：`src/webrtc/*`（5 个）、`src/client-core/index.ts`、`src/plugin/*`（9 个）。重写规则（所有被改文件都位于 `src/<pkg>/`，因此一律是 `../<pkg>/...`）：

| 上游写法 | 借码后写法 |
| --- | --- |
| `@dsh-remote/crypto` | `../crypto/index.js` |
| `@dsh-remote/protocol` | `../protocol/index.js` |
| `@dsh-remote/webrtc` | `../webrtc/index.js` |
| `@dsh-remote/client-core` | `../client-core/index.js` |

* **为什么必须改**：这些 workspace 别名在 npm 上不存在，`tsc` 与 Node 运行时都无法解析。
* **裁剪后由谁补位**：无需补位，纯路径改写，语义不变。注意 `src/crypto/`、`src/protocol/` 内部文件不含这类别名导入。

### 4.6 借码头部注释（非语义改动）

每个**从上游拷贝**的文件顶部都加了：

```ts
// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/<pkg>/src/<file>
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md
```

§4.3 / §4.4 两个裁剪文件的注释额外写明裁剪内容一句话；§4.1 / §4.2 两个类型桩自带头部说明。

### 4.7 不借码 loopback 两端实现（AgentLRay 自研）

上游 `packages/plugin/src/loopback-host.ts`（被连接方）与 `packages/plugin/src/loopback-preview.ts`（连接方）**未借码**，由 AgentLRay 侧自行实现（`lib/dsh/loopback-host.js`、`lib/dsh/loopback-client.js`、`lib/dsh/loopback.js`）。

* **为什么不借码**：
  1. 上游 `LoopbackPreview` 是「浏览器预览」模型——本地监听端口要求请求的 `Host` 头等于一个随机 `*.localhost` 授权域，否则 403。AgentLRay 是**服务器到服务器**的网关转发，`Host` 头必须原样透传给远端（远端的 csrf 校验依赖 `Host == Origin`），两者模型不兼容。
  2. 上游 `LoopbackHost` 的 `http.read` 空闲 **20 秒**即判定对端失联并断链。AgentLRay 的会话实时尾随是 SSE（长时间无事件），会被这条规则切断。
* **补位方式**：AgentLRay 侧按上游 `packages/protocol/src/loopback.ts` 的**同一套线协议**（`describe` / `http.open` / `http.read` / `close` 操作与响应形状）自行实现两端，因此与上游协议仍然兼容；将来若上游放宽上述两条限制，可直接换回上游实现。
* **同步上游时**：这两个文件不在借码清单内，上游改动它们**不影响**本仓库；只需确认 `protocol/src/loopback.ts` 的 schema 未发生不兼容变更。

### 4.8 `src/plugin/connection-controller.ts` —— 并发连接不再按设备顶替（AgentLRay 补丁）

* **上游**：接受一条新通道时，会把**同一 `peerDeviceId`** 的既有连接全部顶替（`CONNECTION_REPLACED`）——即「一对端设备只保留一条逻辑连接」。
* **为什么改**：AgentLRay 的 dsh 隧道语义与 ssh 隧道一致，同一远端可并存多条独立隧道（例如「连接测试」的探测隧道与常驻隧道、同一设备的多个端口目标）。上游的顶替规则会让后建立的隧道把先建立的顶掉。
* **改成**：只按 `connectionId` 顶替（同一连接 id 的旧通道仍被回收），不同连接 id 的并发连接共存；各自的存活由传输层关闭 / 租约心跳清理（`HostServerConnection` 的 `tunnels` 表本就按 `connectionId` 独立管理）。
* **同步上游时**：上游若调整该顶替规则，需重新评估本补丁是否仍需要（补丁以 `PATCH(AgentLRay)` 注释标注，便于 diff 定位）。

## 5. 编译

编译命令（在 `lib/dsh/vendor/` 目录下执行）：

```bash
cd lib/dsh/vendor
npx tsc -p tsconfig.json --noCheck
```

* `--noCheck`（TypeScript ≥ 5.6 支持）跳过类型检查直接产出 JS：上游代码的类型检查依赖 DSH 宿主的类型环境，在本仓库不可用；**类型错误不应阻塞产物产出**。
* 编译后需保证 `lib/dsh/vendor/dist/package.json` 存在且内容为 `{"type":"module"}`（`tsc` 不会拷贝 `src/package.json`，需手动放置）。
* `tsconfig.json` 关键项：`module` / `moduleResolution` 均为 `nodenext`，`rootDir: src`，`outDir: dist`，`strict: false`，`skipLibCheck: true`，`declaration: false`。

### 类型检查现状（供上游同步参考）

在 `strict: false`（本仓库 tsconfig 设定）下 **零类型错误**；用 `--strict`（与上游 tsconfig.base.json 一致）编译同样为零错误：

```bash
cd lib/dsh/vendor && npx tsc -p tsconfig.json --noEmit --strict   # 0 errors
```

（早期版本曾在上游 `loopback-host.ts` 报 2 处 `TS2345`——`strictNullChecks` 关闭时 zod v4 对 `z.tuple` 的输出类型推断退化。该文件已按 §4.7 不再借码，问题随之消失。）

## 6. 运行时依赖

vendor 产物是 ESM，运行期依赖如下（**均已在本仓库根 `package.json` 的 `dependencies` 中，无需改动**）：

| 依赖 | 版本 | 用途 | 备注 |
| --- | --- | --- | --- |
| `ws` | `^8.21.3` | Node 端 WebSocket（relay 传输、loopback 预览） | CJS + ESM 双格式 |
| `zod` | `^4.6.7` | 协议与配置 schema | |
| `@noble/ciphers` | `^1.1.3` | ChaCha20-Poly1305 | |
| `@noble/curves` | `^1.7.0` | X25519 | |
| `@noble/hashes` | `^1.6.1` | HKDF / SHA-256 | |
| `@lukeburns/clatterjs` | `1.0.0` | Noise IK 握手框架 | **ESM-only** |

* **`@lukeburns/clatterjs` 是 ESM-only**，因此 vendor 产物**必须**是 ESM（`dist/package.json` 含 `{"type":"module"}`）。
* CommonJS 调用方通过 Node **≥ 22.12** 的 `require(esm)` 能力加载 ESM 产物（本仓库 `package.json` 的 `engines.node` 为 `>=22.13`，满足该要求）。
* 开发期依赖：`typescript`（5.9.3，已装）、`@types/node`、`@types/ws`。

## 7. 同步上游步骤（手动、可复现）

1. 拉取上游并切到目标 commit：

   ```bash
   git clone https://github.com/liguobao/ds-harness-remote /tmp/dsh-upstream
   git -C /tmp/dsh-upstream checkout <new-commit>
   ```

2. 按 §3 的**借码文件清单**，把新 commit 的对应文件覆盖到 `lib/dsh/vendor/src/`（只覆盖清单内的文件，不要整目录复制——上游 `plugin/src/` 下还有 acp / codex / harness 桥接、客户端 UI 等本项目不需要的代码）。

3. 重做 §4.5 的跨包 import 重写（`@dsh-remote/crypto` → `../crypto/index.js`，`@dsh-remote/protocol` → `../protocol/index.js`，`@dsh-remote/webrtc` → `../webrtc/index.js`，`@dsh-remote/client-core` → `../client-core/index.js`）。

4. 重做 §4.1 / §4.2 / §4.3 / §4.4 四处裁剪。**裁剪点若在上游变化后失效，必须人工确认**：例如上游若给 `identity-store.ts` 的 `HostIdentity` / `TrustedPeer` 增删字段，本仓库的类型桩必须同步；若上游把 `client-core` 的 5 行 re-export 拆分或改名，裁剪位置需重新定位；若上游不再依赖 Cordis/Schemastery，可考虑撤销 §4.4 的裁剪。

5. 更新每个文件顶部的 `Upstream commit:` 注释，然后重新编译：

   ```bash
   cd lib/dsh/vendor && npx tsc -p tsconfig.json --noCheck
   ```

   并确认 `lib/dsh/vendor/dist/package.json` 仍是 `{"type":"module"}`。

6. 人工审阅 diff 后提交：

   ```bash
   git diff lib/dsh/vendor
   ```

   审阅要点：借码文件除头部注释与 import 路径外是否与上游一致；四个裁剪点是否仍然成立；`dist/` 是否与 `src/` 同步。

7. 更新本 README 中的 commit 号与 commit 日期，以及 §3 文件清单（若上游新增/删除/改名了文件）。

## 8. 后续路径：上游发布到公开 npm 时改回直接依赖

本借码层是**过渡方案**。若上游未来把 `@dsh-remote/crypto`、`@dsh-remote/protocol`、`@dsh-remote/webrtc`、`@dsh-remote/client-core` 发布到公开 npm registry，则应改为在根 `package.json` 直接依赖这些包，删除整个 `lib/dsh/vendor/`，并把调用方的 `require('<abs>/lib/dsh/vendor/dist/index.js')` 换成对上游包的直接引用（届时同样需要一层命名空间聚合，以规避包间同名导出冲突）。在此之前，本目录是唯一的连接骨架来源。
