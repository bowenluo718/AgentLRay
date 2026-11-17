// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/{crypto,protocol,webrtc,client-core,plugin}/src/*（聚合入口，本项目手写）
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md
//
// 本文件是 vendor 产物的唯一入口。统一以「命名空间」方式导出，避免上游各包之间的同名导出
// （例如 crypto/protocol 各自的常量）在 CommonJS 调用方侧互相覆盖。
// 调用方（CommonJS）：require('<abs>/lib/dsh/vendor/dist/index.js') → { crypto, protocol, webrtc, ... }

export * as crypto from './crypto/index.js'
export * as protocol from './protocol/index.js'
export * as webrtc from './webrtc/index.js'
export * as clientCore from './client-core/index.js'
export * as serverApi from './plugin/server-api.js'
export * as serverCredentials from './plugin/server-credentials.js'
export * as serverConnection from './plugin/server-connection.js'
export * as connectionController from './plugin/connection-controller.js'
export * as clientSecureTransport from './plugin/client-secure-transport.js'
export * as safeError from './plugin/safe-error.js'
export * as nodeWebSocket from './plugin/node-websocket.js'
export * as logging from './plugin/logging.js'
export * as config from './plugin/config.js'
export * as transportUpgrade from './plugin/transport-upgrade.js'
export * as ids from './plugin/ids.js'
export * as identityStore from './plugin/identity-store.js'
