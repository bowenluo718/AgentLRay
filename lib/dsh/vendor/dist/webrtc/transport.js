// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/webrtc/src/transport.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md
export class BaseTransport {
    handlers = new Set();
    closeHandlers = new Set();
    onMessage(cb) {
        this.handlers.add(cb);
        return () => this.handlers.delete(cb);
    }
    onClose(cb) {
        this.closeHandlers.add(cb);
        return () => this.closeHandlers.delete(cb);
    }
    emit(data) {
        for (const handler of this.handlers)
            handler(data);
    }
    emitClose(error) {
        for (const handler of this.closeHandlers)
            handler(error);
    }
}
