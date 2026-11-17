// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/webrtc/src/websocket-backpressure.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md
/** Bound Relay buffering without changing the encrypted frame order. Call from serialized data sends. */
export async function waitForRelayCapacity(socket) {
    const started = Date.now();
    while ((socket.bufferedAmount ?? 0) > 512 * 1024) {
        if (socket.readyState !== 1 || Date.now() - started > 10_000)
            throw new Error('Relay consumer is too slow or disconnected');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (socket.readyState !== 1)
        throw new Error('Relay transport closed');
}
