// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/plugin/src/version.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md

/**
 * Version of the `ds-harness-remote` distribution.
 *
 * This is reported to the Server during device registration (`clientVersion`
 * in the Device Descriptor) and again in the WebSocket `hello` frame. The
 * Harness version is read separately from `host.describe` at runtime.
 * Keep it in sync with `packages/plugin/package.json` (`version`).
 * If they diverge, `npm scripts` checks in `scripts/verify-version-sync.mjs`
 * will fail fast during build/check/test.
 */
export const PLUGIN_VERSION = '0.6.5'
