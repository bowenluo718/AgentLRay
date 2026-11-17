// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/plugin/src/types.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md

import type { RemoteMessage } from '../protocol/index.js'

export interface AuthenticatedPeerChannel {
  /**
   * Attestation supplied by the Noise/control-plane integration. Implementors
   * must expose this channel only after both the Noise IK transcript and the
   * Server membership for this exact connection have been verified.
   */
  readonly security: {
    protocol: 'Noise_IK_25519_ChaChaPoly_SHA256'
    connectionId: string
    membershipId: string
  }
  readonly peerDeviceId: string
  readonly peerIdentityKey: string
  readonly mode?: 'LAN' | 'P2P' | 'TURN' | 'Relay'
  readonly createTransportUpgradeHost?: (publishEvent: (message: RemoteMessage) => Promise<void>) => import('./transport-upgrade.js').TransportUpgradeHost | undefined
  send(message: RemoteMessage): Promise<void>
  onMessage(handler: (message: RemoteMessage) => void): () => void
  close(code?: string): Promise<void>
}
