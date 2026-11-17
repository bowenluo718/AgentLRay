// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/webrtc/src/transport.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md

import type { TransportStats } from '../protocol/index.js'

export interface RemoteTransport {
  connect(): Promise<void>
  send(data: Uint8Array): Promise<void>
  onMessage(cb: (data: Uint8Array) => void): () => void
  onClose?(cb: (error?: Error) => void): () => void
  close(): Promise<void>
  getStats(): TransportStats
}

export interface SecureHandshakeTransport extends RemoteTransport {
  markSecureReady?(): void
  connectionInfo(): { connectionId: string; localDeviceId: string; remoteDeviceId: string }
  sendHandshake(step: number, data: Uint8Array): Promise<void>
  onHandshake(cb: (step: number, data: Uint8Array) => void): () => void
  onSequencedMessage?(cb: (counter: number | undefined, data: Uint8Array) => void): () => void
}

type MessageHandler = (data: Uint8Array) => void

export abstract class BaseTransport implements RemoteTransport {
  protected handlers = new Set<MessageHandler>()
  protected closeHandlers = new Set<(error?: Error) => void>()

  onMessage(cb: MessageHandler): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  onClose(cb: (error?: Error) => void): () => void {
    this.closeHandlers.add(cb)
    return () => this.closeHandlers.delete(cb)
  }

  protected emit(data: Uint8Array): void {
    for (const handler of this.handlers) handler(data)
  }

  protected emitClose(error?: Error): void {
    for (const handler of this.closeHandlers) handler(error)
  }

  abstract connect(): Promise<void>
  abstract send(data: Uint8Array): Promise<void>
  abstract close(): Promise<void>
  abstract getStats(): TransportStats
}
