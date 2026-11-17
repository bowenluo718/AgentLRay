// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/webrtc/src/util.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md
export async function socketText(data) {
    if (typeof data === 'string')
        return data;
    if (data instanceof ArrayBuffer)
        return new TextDecoder().decode(data);
    return new TextDecoder().decode(await data.arrayBuffer());
}
export function toBase64Url(bytes) {
    const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
    const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
    return base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function fromBase64Url(value) {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    if (typeof atob === 'function')
        return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    return new Uint8Array(Buffer.from(padded, 'base64'));
}
