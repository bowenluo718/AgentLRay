// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/webrtc/src/serial-send.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md

/** Serialize encryption with transmission, bounded even when the transport stalls. */
export class SerialSend {
  private tail: Promise<void> = Promise.resolve()
  private bytes = 0
  private count = 0
  async run(bytes: number, send: () => Promise<void>): Promise<void> {
    if (this.bytes + bytes > 8 * 1024 * 1024 || this.count >= 256) throw new Error('Encrypted send queue exceeds its limit')
    this.bytes += bytes; this.count += 1
    const task = this.tail.then(send)
    this.tail = task.catch(() => undefined)
    try { await task } finally { this.bytes -= bytes; this.count -= 1 }
  }
}
