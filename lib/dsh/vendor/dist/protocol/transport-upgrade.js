// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/protocol/src/transport-upgrade.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md
import { z } from 'zod';
export const TRANSPORT_UPGRADE_CAPABILITY = 'remote.transport.upgrade.v1';
export const UPGRADE_SEQUENCE_HEADER_BYTES = 12;
export const MAX_REORDER_BUFFERED_FRAMES = 256;
export const MAX_REORDER_BUFFERED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REORDER_GAP_TIMEOUT_MS = 5_000;
export const DEFAULT_PREVIOUS_LEG_DRAIN_MS = 3_000;
const UPGRADE_SEQ_MAGIC = [0x44, 0x53, 0x48, 0x55]; // 'DSHU'
export const transportUpgradeCandidateSchema = z.object({
    candidate: z.string().max(4096).optional(),
    sdpMid: z.string().max(128).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
}).strict();
export const transportUpgradeOfferSchema = z.object({
    attemptId: z.string().min(1).max(64),
    sdp: z.string().min(1).max(128 * 1024),
}).strict();
export const transportUpgradeIceSchema = z.object({
    attemptId: z.string().min(1).max(64),
    candidate: transportUpgradeCandidateSchema,
}).strict();
export const transportUpgradeActivateSchema = z.object({
    attemptId: z.string().min(1).max(64),
    transport: z.enum(['lan', 'p2p', 'turn']).optional(),
    previousLegEndCounter: z.number().int().min(0).optional(),
}).strict();
export const transportUpgradeDrainSchema = z.object({
    attemptId: z.string().min(1).max(64),
    previousLegEndCounter: z.number().int().min(0),
}).strict();
export const transportUpgradeAbortSchema = z.object({
    attemptId: z.string().min(1).max(64).optional(),
}).strict();
export function transportTierRank(mode) {
    switch (mode) {
        case 'LAN': return 3;
        case 'P2P': return 2;
        case 'TURN': return 1;
        default: return 0;
    }
}
export function wireFromTransportTier(mode) {
    return mode === 'LAN' ? 'lan' : mode === 'P2P' ? 'p2p' : 'turn';
}
export function wrapUpgradedTransportFrame(counter, ciphertext) {
    if (!Number.isSafeInteger(counter) || counter < 0) {
        throw new Error('Upgraded transport counter must be a non-negative safe integer.');
    }
    const out = new Uint8Array(UPGRADE_SEQUENCE_HEADER_BYTES + ciphertext.byteLength);
    out.set(UPGRADE_SEQ_MAGIC, 0);
    const view = new DataView(out.buffer, out.byteOffset, UPGRADE_SEQUENCE_HEADER_BYTES);
    view.setBigUint64(4, BigInt(counter), false);
    out.set(ciphertext, UPGRADE_SEQUENCE_HEADER_BYTES);
    return out;
}
export function unwrapUpgradedTransportFrame(frame) {
    if (frame.byteLength < UPGRADE_SEQUENCE_HEADER_BYTES
        || frame[0] !== UPGRADE_SEQ_MAGIC[0]
        || frame[1] !== UPGRADE_SEQ_MAGIC[1]
        || frame[2] !== UPGRADE_SEQ_MAGIC[2]
        || frame[3] !== UPGRADE_SEQ_MAGIC[3]) {
        throw new Error('Invalid upgraded transport frame header.');
    }
    const view = new DataView(frame.buffer, frame.byteOffset, UPGRADE_SEQUENCE_HEADER_BYTES);
    const rawCounter = view.getBigUint64(4, false);
    if (rawCounter > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Upgraded transport frame counter overflowed.');
    }
    return {
        counter: Number(rawCounter),
        ciphertext: frame.subarray(UPGRADE_SEQUENCE_HEADER_BYTES),
    };
}
/**
 * Bounded out-of-order ciphertext reorder buffer for cross-leg Noise switchovers.
 * Enforces strict frame count, byte budget, and gap deadline limits.
 */
export class SequencedCiphertextReorderBuffer {
    options;
    pending = new Map();
    bufferedBytes = 0;
    gapTimer;
    gapCounter;
    constructor(options) {
        this.options = options;
    }
    get size() { return this.pending.size; }
    get bytes() { return this.bufferedBytes; }
    push(counter, expectedCounter, ciphertext) {
        if (!Number.isSafeInteger(counter) || counter <= expectedCounter) {
            throw new Error('Ciphertext counter is duplicated or out of order.');
        }
        if (this.pending.has(counter)) {
            throw new Error('Duplicate buffered ciphertext counter.');
        }
        const maxFrames = this.options.maxFrames ?? MAX_REORDER_BUFFERED_FRAMES;
        const maxBytes = this.options.maxBytes ?? MAX_REORDER_BUFFERED_BYTES;
        if (this.pending.size >= maxFrames || this.bufferedBytes + ciphertext.byteLength > maxBytes) {
            throw new Error('Cross-transport reorder buffer exceeded its limit.');
        }
        const copy = new Uint8Array(ciphertext);
        this.pending.set(counter, copy);
        this.bufferedBytes += copy.byteLength;
        this.armGapTimer(expectedCounter);
    }
    takeNext(expectedCounter) {
        const hit = this.pending.get(expectedCounter);
        if (hit === undefined) {
            if (this.pending.size === 0)
                this.clearGapTimer();
            else
                this.armGapTimer(expectedCounter);
            return undefined;
        }
        this.pending.delete(expectedCounter);
        this.bufferedBytes -= hit.byteLength;
        if (this.pending.size === 0)
            this.clearGapTimer();
        else
            this.armGapTimer(expectedCounter + 1);
        return hit;
    }
    onExpectedAdvanced(nextExpectedCounter) {
        if (this.pending.size === 0) {
            this.clearGapTimer();
            return;
        }
        this.armGapTimer(nextExpectedCounter);
    }
    clear() {
        this.clearGapTimer();
        this.pending.clear();
        this.bufferedBytes = 0;
    }
    armGapTimer(expectedCounter) {
        if (this.gapCounter === expectedCounter && this.gapTimer !== undefined)
            return;
        this.clearGapTimer();
        this.gapCounter = expectedCounter;
        const timeoutMs = this.options.gapTimeoutMs ?? DEFAULT_REORDER_GAP_TIMEOUT_MS;
        this.gapTimer = setTimeout(() => {
            this.gapTimer = undefined;
            if (this.pending.size > 0) {
                this.options.onGapTimeout(expectedCounter);
            }
        }, timeoutMs);
        this.gapTimer.unref?.();
    }
    clearGapTimer() {
        if (this.gapTimer !== undefined) {
            clearTimeout(this.gapTimer);
            this.gapTimer = undefined;
        }
        this.gapCounter = undefined;
    }
}
