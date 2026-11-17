/**
 * @kerneldreams/backend-http — транспортный шов nr-ui-protocol, обе стороны.
 *
 * serveBackend(backend) → HTTP+SSE → createHttpBackend(url) → ProtocolBackend.
 * Стороны живут в одном пакете намеренно: они обязаны эволюционировать
 * синхронно и тестируются друг об друга (backends-spec §3).
 *
 * Зависимости: node builtins + @kerneldreams/ui-protocol. Ничего про
 * pi/engine/opencode здесь нет и быть не должно — это провод, не бэкенд.
 */

export { serveBackend } from './serve.js'
export { createDevices, peerAddress, stripGuess, PEER_HEADER, type DeviceSpec, type StandDevices } from './devices.js'
export type { ServeBackendOpts, ServeHandle } from './serve.js'

// board-edge-spec §5.2: ядро провода на Web Fetch — Worker, Deno, Bun; serveBackend зовёт его же
export { createFetchHandler, createWireCore } from './fetch-handler.js'
export type { FetchHandlerOpts, WireCore } from './fetch-handler.js'

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

export { createFsPlugins, pluginIdOf } from './fs-plugins.js'
export type { FsPlugin, FsPluginDir, FsPlugins, FsPluginsOpts } from './fs-plugins.js'

export {
  createMemoryProjects,
  checkProject,
  expandProject,
  newProjectId,
  patchProject,
  projectInfo,
  ProjectBadRequestError,
  ProjectConflictError,
  ProjectNotFoundError,
} from './projects.js'
export type { ProjectEntry, ProjectsRegistry } from './projects.js'
export { createRepos, expandMask, listRepos, readProjectOverride, repoInfo } from './repos.js'
export { aliasIds, repoPrefix, spaceOfSession } from './repos-core.js'
export { sessionObjectBlocks, sessionObjectsOf } from './session-objects.js'
export type { RepoPrefixBlock, ReposSource } from './repos-core.js'
export { createProjectFilesRouter } from './project-files.js'
export type { ProjectFiles, ProjectFilesFactory, ProjectFilesRouter } from './project-files.js'

export { createMemoryFiles } from './memory-files.js'
export type { MemoryFiles, MemoryFilesOpts } from './memory-files.js'

export {
  CODE_BAD_REQUEST,
  CODE_BUSY,
  CODE_CONNECTION_LOST,
  CODE_NOT_FOUND,
  CODE_NOT_SUPPORTED,
  CODE_UNAUTHORIZED,
  CODE_FORBIDDEN,
  normalizeBasePath,
} from './wire.js'
export type { WireEnvelope } from './wire.js'

export { createHub, createHubPlugins, capsDiff, HubError, ENGINE_UNAVAILABLE_CODE } from './hub.js'
export { createAutoArchive, autoArchiveCandidate, AUTOARCHIVE_STATUSES } from './autoarchive.js'
export type { AutoArchive, AutoArchiveOptions } from './autoarchive.js'
export { createQuestions, withQuestionsService, QUESTIONS_SERVICE_ID, type HubQuestion, type Questions } from './questions.js'
export { createWake, withWakeService, parseAt, parseDuration, parseCron, nextCron, describeWhen, shortTime, zonedTime, WAKE_SERVICE_ID, WAKE_TOOLS, WAKE_STATUSES, WAKE_LIVE, WAKE_DEFAULT_TZ, JOB_FINAL } from './wake.js'
export type { Wake, WakeOptions, WakeRecord, WakeWhen, WakeStatus, WakeJobs, WakeJobView, WakeCreateInput, WakeTaskEvent, WakeTaskOn } from './wake.js'
export { createRemoteServices, ServiceUnavailableError, SERVICE_UNAVAILABLE_CODE } from './remote-services.js'
export type { RemoteServices, RemoteServicesOpts } from './remote-services.js'
export { withRunAttach, hasRunAttach } from './run-attach.js'
export type { RunAttachOpts } from './run-attach.js'
export type { HubEngine, HubOpts, HubPluginsEngine } from './hub.js'

export { createUsersGate, ForbiddenError, UsersBadRequestError, DEVICE_COOKIE } from './gate.js'
export type { AuthResult, Identity, UsersGate, UsersGateOpts } from './gate.js'
export { createFileSigner, type FileSigner, type FileSignOpts, type FileSignCheck } from './file-sign.js'
export { createMemoryUsers, createCredentials, enginesOf, homeProjectOf, userInfo, USER_ID, JOIN_TTL_MS, LOGIN_TTL_MS, DEVICE_TTL_MS } from './users.js'
export type { Credentials, UserRecord, UsersRegistry } from './users.js'
export { ID_COOKIE, idBaseOf, defaultLoginUrl, defaultTokenOf } from './access.js'
export type { AccessIdentity, AccessOpts, AccessVerifier, IdUser, IdTier, IdVerifier, IdentityKit } from './access.js'

// file-links-spec §3 (v1.41): файл вне пространств, действия хоста
export { DEFAULT_EXTERNAL_DENY, DEFAULT_HOST_APPS, DEFAULT_THUMB_CONCURRENCY, createExternalHost, hostThumbnail, parseWinDrives, readExternalRaw, thumbKind, thumbMime, winFromWire, winToWire } from './external.js'
export { createLocalExec, externalDenied } from './host-exec.js'
export type { HostExec, HostExecOpts, HostExecResult } from './host-exec.js'
export type { ExternalHost, ExternalHostOptions, HostCommand } from './external.js'
export { ptyOriginAllowed, type PtyOps } from './pty.js'
// v1.45: удалённые хосты реестра поверх ssh — агент nr-host-agent, роутинг по host=
export { agentDenyRules, createHostsRouter, createLocalAgentHost, createRemoteHost, transferAcross } from './remote-host.js'
export type { ByteChunk, ByteHost, HostsRouter, RemoteHost, RemoteHostOptions, RemoteHostSpec, TransferItem, TransferProgress, WalkEntry } from './remote-host.js'

// settings-spec (v1.40): хост слоёв настроек на файлах стенда
export { SettingsError, createFsSettings, parseSettingsText, removeSettingsText, settingsOfCard, settingsOfMeta, writeSettingsText } from './settings.js'
export type { FsSettingsOpts } from './settings.js'
