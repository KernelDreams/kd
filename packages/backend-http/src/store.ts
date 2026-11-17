/**
 * `@kerneldreams/backend-http/store` — бэкенд над SessionStore без транспорта
 *: то, что работает в браузере и Worker'е (`createStoreBackend`,
 * состояние ранов над `KvStore`, файлы пространства в памяти, HTTP-клиент).
 * `serveBackend` (`node:http`) — только в корне пакета и `./serve`.
 */

export { createHttpBackend, BackendError } from './client.js'
export type { HttpBackendOpts } from './client.js'

export {
  createStoreBackend,
  StoreBadRequestError,
  StoreBusyError,
  StoreProfileConflictError,
  StoreProfileNotFoundError,
  StorePromptNotFoundError,
  StoreUnknownModelError,
  StoreUnknownProfileError,
} from './store-backend.js'
export type { StoreBackendOpts, GenerateFn, GenerateRequest, GenChunk, SessionChoices } from './store-backend.js'

export { aliveKeyOf, createAliveRegistry, createMemoryKv, createRunRegistry, RUN_TTL_MS, SESSION_TOOLS_HEARTBEAT_MS, SESSION_TOOLS_TTL_MS, type AliveRegistry, type RunRegistry } from './run-state.js'

export { createMemoryFiles } from './memory-files.js'
export type { MemoryFiles, MemoryFilesOpts } from './memory-files.js'

// Ядро провода на Web Fetch (board-edge-spec §5.2) — для Worker-хоста
export { createFetchHandler } from './fetch-handler.js'
export type { FetchHandlerOpts } from './fetch-handler.js'

// Подхват идущего рана (run-resume-spec §1): без Node — годится агенту в процессе и бэкенду в странице.
export { withRunAttach, hasRunAttach } from './run-attach.js'
export type { RunAttachOpts } from './run-attach.js'
