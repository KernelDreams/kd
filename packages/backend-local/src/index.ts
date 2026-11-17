/**
 * @kerneldreams/backend-local — ProtocolBackend над каталогом: `.mds`-сессии и
 * файлы на диске, без сети и без модели (exz-v2-spec §2).
 *
 * ```ts
 * const backend = createLocalBackend({ root: '/path/to/project' })
 * ```
 *
 * В exz живёт в sidecar за транспортом Tauri (@kerneldreams/backend-local/tauri),
 * но транспорта не знает: это обычный ProtocolBackend.
 */

export { createLocalBackend, LOCAL_ATTACHMENTS_DIR } from './local.js'
export type { LocalBackendOpts } from './local.js'
export type { GenerateFn, GenerateRequest, GenChunk } from '@kerneldreams/backend-http'
