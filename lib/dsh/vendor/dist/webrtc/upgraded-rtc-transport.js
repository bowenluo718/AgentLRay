// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/webrtc/src/upgraded-rtc-transport.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md
import { unwrapUpgradedTransportFrame, wrapUpgradedTransportFrame, } from '../protocol/index.js';
export function isSequencedOutboundTransport(value) {
    return 'isSequencedUpgradeLeg' in value && value.isSequencedUpgradeLeg === true;
}
export class UpgradedRtcDataChannelTransport {
    rtc;
    isSequencedUpgradeLeg = true;
    sequencedHandlers = new Set();
    plainHandlers = new Set();
    closeHandlers = new Set();
    unsubscribeMessage;
    unsubscribeClose;
    unsubscribeError;
    closed = false;
    currentModeValue;
    currentSelectedValue;
    constructor(rtc, mode, selectedTransport) {
        this.rtc = rtc;
        this.currentModeValue = mode;
        this.currentSelectedValue = selectedTransport;
        this.unsubscribeMessage = rtc.onMessage(frame => {
            try {
                const parsed = unwrapUpgradedTransportFrame(frame);
                for (const handler of this.sequencedHandlers)
                    handler(parsed.counter, parsed.ciphertext);
                for (const handler of this.plainHandlers)
                    handler(parsed.ciphertext);
            }
            catch (error) {
                const failure = error instanceof Error ? error : new Error('Invalid upgraded WebRTC frame.');
                void this.close(failure);
            }
        });
        this.unsubscribeClose = rtc.onClose(() => this.emitClose(new Error('Upgraded WebRTC DataChannel closed.')));
        this.unsubscribeError = rtc.onError(err => this.emitClose(err));
    }
    async connect() {
        await this.rtc.connect();
    }
    async send(_data) {
        throw new Error('UpgradedRtcDataChannelTransport requires sendSequenced(counter, ciphertext).');
    }
    async sendSequenced(counter, ciphertext) {
        if (this.closed)
            throw new Error('Upgraded WebRTC transport is closed.');
        await this.rtc.send(wrapUpgradedTransportFrame(counter, ciphertext));
    }
    onSequencedMessage(cb) {
        this.sequencedHandlers.add(cb);
        return () => this.sequencedHandlers.delete(cb);
    }
    onMessage(cb) {
        this.plainHandlers.add(cb);
        return () => this.plainHandlers.delete(cb);
    }
    onClose(cb) {
        this.closeHandlers.add(cb);
        return () => this.closeHandlers.delete(cb);
    }
    async close(reason) {
        if (this.closed)
            return;
        this.closed = true;
        this.unsubscribeMessage?.();
        this.unsubscribeClose?.();
        this.unsubscribeError?.();
        await this.rtc.close();
        if (reason !== undefined) {
            for (const cb of this.closeHandlers)
                cb(reason);
        }
    }
    get mode() { return this.currentModeValue; }
    get selectedTransport() { return this.currentSelectedValue; }
    updateMode(mode, selectedTransport) {
        this.currentModeValue = mode;
        this.currentSelectedValue = selectedTransport;
    }
    getStats() {
        const base = this.rtc.getStats();
        return { ...base, mode: base.connected ? this.currentModeValue : 'Disconnected' };
    }
    connectionDetails() {
        return this.rtc.connectionDetails();
    }
    emitClose(error) {
        if (this.closed)
            return;
        this.closed = true;
        this.unsubscribeMessage?.();
        this.unsubscribeClose?.();
        this.unsubscribeError?.();
        for (const cb of this.closeHandlers)
            cb(error);
    }
}
