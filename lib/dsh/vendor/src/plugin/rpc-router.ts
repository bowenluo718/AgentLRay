// 说明：本文件是本项目手写的类型契约，替代上游 packages/plugin/src/rpc-router.ts。
// 上游 rpc-router 依赖 codex / acp / harness workspace 桥接（CodexPeerBridge、AcpPeerBridge、
// HarnessRemoteBridge、WorkspaceUploadHost 等），本项目不需要；调用方自行实现最小 host 路由。
// 这里只保留上游 connection-controller.ts 以 type-only 方式引用的最小契约。
// Upstream reference: packages/plugin/src/rpc-router.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md

import type { RemoteMessage } from '../protocol/index.js'

export interface RpcRouter {
  handle(message: RemoteMessage): Promise<RemoteMessage>
  closePeerStreams(): Promise<void>
}
