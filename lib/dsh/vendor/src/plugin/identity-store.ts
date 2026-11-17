// 说明：本文件是本项目手写的类型契约，替代上游 packages/plugin/src/identity-store.ts 的实现部分。
// 上游实现包含文件锁 / 目录迁移 / 凭据轮转等本项目不需要的运行时逻辑（AgentLRay 侧自己实现
// lib/dsh/identity.js，落在 ~/.agentlray/dsh-device.json）。此处仅保留上游 server-api.ts /
// server-connection.ts / connection-controller.ts / client-secure-transport.ts 以 type-only
// 方式引用的类型，字段与上游定义逐字一致。
// Upstream reference: packages/plugin/src/identity-store.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md

export interface HostIdentity {
  schemaVersion: 1
  deviceId: string
  name: string
  publicKey: string
  privateKey: string
  fingerprint: string
}

export interface TrustedPeer {
  deviceId: string
  name: string
  platform: string
  publicKey: string
  fingerprint: string
  trustedAt: number
  membershipId?: string
}

export interface IdentityStore {
  loadOrCreate(deviceName: string): Promise<HostIdentity>
  loadExisting(): Promise<HostIdentity | undefined>
  current(): HostIdentity
  listTrustedPeers(): TrustedPeer[]
  trustedPeer(deviceId: string): TrustedPeer | undefined
  isTrusted(deviceId: string, publicKey: string): boolean
  trustPeer(input: Omit<TrustedPeer, 'fingerprint' | 'trustedAt'>): Promise<TrustedPeer>
  revokePeer(deviceId: string): Promise<boolean>
}

export type RemoteDeviceRole = 'host' | 'client'
