// Store driver resolution from EngineConfig (spec §4.3).
//
// The engine takes a ready SessionStore via RunInput.target; this helper is for
// the runz/chat3 mdz-cascade layer that reads `$store` (driver name) + `$path`
// (driver opts) out of the config and picks a registry driver. It also carries
// the legacy `$session` compatibility mapping for one release cycle.

import type { EngineConfig } from './types.js'

/**
 * Store driver name from config, default `'mds'`. Legacy `$session: file` maps
 * to `'mds'` (+ warn, one release cycle — then remove); `$session: memory` →
 * `'memory'`. Consumers register the nr-chat driver under `'mds'` in the
 * nr-chat-store registry and build a RunTarget from the resolved name.
 */
export function resolveStoreName(
  config: EngineConfig,
  warn: (m: string) => void = (m) => process.stderr.write(m + '\n'),
): string {
  if (typeof config.store === 'string' && config.store) return config.store

  const legacy = config['session']
  if (typeof legacy === 'string' && legacy) {
    const mapped = legacy === 'file' ? 'mds' : legacy
    warn(`nr-engine: legacy $session: ${legacy} → $store: ${mapped} — обнови конфиг, $session уходит`)
    return mapped
  }

  return 'mds'
}
