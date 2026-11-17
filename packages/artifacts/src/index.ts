/**
 * `@kerneldreams/artifacts` — логика уровня «артефакт» (artifacts-spec): её зовут и
 * сервис плагина `artifacts` nrchat, и pi-расширение `pi-ext-artifact`.
 * Хост моста (HTTP статики, процессы сервисов) — отдельный вход `./host`.
 */

export { CAPABILITIES, parseManifest, quoteScopeLines, setManifestVersion } from './manifest.js'
export type { ArtifactManifest, ArtifactWidget, Capability, ManifestResult } from './manifest.js'
export {
  COLLECTION_MANIFEST,
  MANIFEST,
  WORKSPACE_COLLECTION,
  entryOf,
  expandHome,
  listArtifacts,
  listCollection,
  listCollections,
  readArtifact,
  registryPaths,
  resolveArtifact,
} from './collections.js'
export type { ArtifactInfo, Collection, CollectionKind, PluginCollection, RegistryOpts } from './collections.js'
export {
  DEFAULT_FS_READ,
  DEFAULT_FS_WRITE,
  FREE_METHODS,
  KNOWN_METHODS,
  METHOD_CAPABILITY,
  checkAccess,
  isTemplateTarget,
  pathAllowed,
  resolveGuestPath,
  runAllowed,
  scopeRoots,
} from './permissions.js'
export type { AccessEnv, AccessResult } from './permissions.js'
export { checkArtifact } from './check.js'
export {
  DEFAULT_SESSION_READ,
  DEFAULT_SESSION_WRITE,
  META_HASH_SKIP,
  SESSION_METHODS,
  SESSION_READ_SCOPES,
  SESSION_WRITE_SCOPES,
  checkSession,
  metaHash,
  metaPath,
  sessionManifestErrors,
  sessionScopes,
  stableHash,
  toolDecl,
  validatePersonasArg,
} from './session.js'
export type { SessionCheck, SessionManifest, SessionScope } from './session.js'
export { ICON_MAX_BYTES, checkIcon, parseIcon, resolveIcon } from './icon.js'
export type { ArtifactIcon } from './icon.js'
export { LUCIDE_NAMES, LUCIDE_VERSION } from './lucide-names.js'
export type { CheckResult } from './check.js'
export { CompileError, KIT_FILES, KIT_IMPORT, VENDORED, clearCompileCache, compileJsx, isHostImport, transformJsx } from './compile.js'
export {
  HISTORY_DIR,
  HISTORY_KEEP,
  artifactDataDir,
  contentHash,
  finalizeArtifact,
  historyVersions,
  initArtifact,
  listForAgent,
  openQueueFile,
  pluginDataRoot,
  requestOpen,
  revertArtifact,
  slugify,
  smokeBuild,
  targetCollection,
} from './lifecycle.js'
export type { FinalizeOpts, FinalizeResult, InitOpts, InitResult, ListedArtifact } from './lifecycle.js'
export { TEMPLATES, templateFiles } from './templates.js'
export type { TemplateName } from './templates.js'
export {
  RUNTIME_WINDOW_MS,
  STACK_LINES,
  ackCheck,
  appendRuntimeErrors,
  awaitRuntimeCheck,
  checkFile,
  newCheckId,
  normalizeRuntimeError,
  readRuntimeErrors,
  runtimeLogFile,
  writeCheckResult,
} from './runtime.js'
export type { AwaitCheckOpts, RuntimeCheck, RuntimeError, RuntimeLog } from './runtime.js'
export { VIEWER_MAX_IMAGES, viewerRequest } from './viewer.js'
export type { ViewerImage, ViewerRequest } from './viewer.js'
export { checkRuntime } from './verify.js'
export type { CheckTimings, CheckedFinalize } from './verify.js'
export { AGENT_TOOLS, agentCatalog, ARTIFACT_CATALOG_BUDGET_CHARS, formatFinalize, readAgentProfile, runAgentTool } from './agent.js'
export type { AgentToolDecl, AgentToolOpts, AgentToolResult } from './agent.js'
export { SKINS_METHODS, SKINS_DELEGATED, checkSkinsArgs, runSkins, skinsContract } from './skins.js'
