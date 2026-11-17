/**
 * @kerneldreams/backend-fs — файлы пространства на диске (workspace-files-spec §2).
 *
 * ```ts
 * const files = createFsWorkspace('/srv/project')
 * caps.workspace = { files: files.capability }
 * backend.workspace.files = files
 * ```
 *
 * Не бэкенд, а его файловая часть: backend-pi и backend-local (exz v2) собирают
 * её в свой `ProtocolBackend`. Зависимости — node builtins и nr-ui-protocol.
 */

export { createFsWorkspace } from './workspace.js'
export type { FsWorkspace, FsWorkspaceOpts } from './workspace.js'
export { mountWorkspaces } from './mounts.js'
export { findRg } from './search.js'
