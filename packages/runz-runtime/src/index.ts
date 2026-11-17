/**
 * @kerneldreams/runz-runtime — public API
 *
 * Загрузка скриптов, registry, environment.
 */

export type {
  ScriptMeta,
  ScriptResult,
  ServiceResult,
  ScriptOutput,
  ScriptArtifact,
  ScriptFn,
  DocumentHandlerFn,
  ProgramHelpers,
  LoadedScript,
  Runner,
} from './types.ts'
export { isServiceResult } from './types.ts'

export { parseArgv, coerceValue } from './cli.ts'
export type { ParsedArgs, RunzFlags } from './cli.ts'

export {
  findScript,
  listScripts,
  findProjectDir,
  isDirectPath,
  builtinScriptsDir,
  globalRunzDir,
} from './registry.ts'
export type { RegistryOptions, ResolvedScript } from './registry.ts'
export { describeScript } from './describe.ts'
export { helpText, parseFlags, unknownFlags, unknownFlagsError, wantsHelp, RUNTIME_ARGS, type FlagSpec } from './flags.ts'
export { importScriptModule } from './loader.ts'

export { buildChain, buildScopes, flattenChain, loadConfigFile } from './chain.ts'
export type { ChainLayers, Scopes, BuildScopesOptions } from './chain.ts'

export { importScriptFn, parseDocFile } from './loader.ts'

export { registerResolveHook, resolveHookURL, workspaceRoot } from './hook.ts'
export { runzHome } from './home.ts'

export { runTests, collectTestFiles, findTestTarget, isTestFile, registerHookPath } from './test-runner.ts'
export type { RunTestsOptions, RunTestsResult } from './test-runner.ts'

export { collectEnvNodeModules, nearestEnvDir, userEnvDir } from './envs.ts'

export { expandHome, resolvePath, parsePathList } from './paths.ts'

export { selectRunner, nodeRunner } from './runners/index.ts'

export { execute } from './execute.ts'

export { runDocument, documentHelpers, traceOf } from './documents.ts'
// След прогона (pipeline-run-spec §2.1): run.trace.jsonl.
export { RunTrace, TRACE_FILE, traceStream } from './trace.ts'
export type { TraceEvent, TraceEventName, StepOptions, StepEnd } from './trace.ts'
export type { RunzHelpers } from './documents.ts'

// Расширения файлами: слоты `agent`, `acp` — реализация вне открытого ядра.
export { EXTENSION_SLOTS, ExtensionMissingError, extensionDirs, findExtensionFile, loadExtension, registerExtension, requireExtension } from './extensions.ts'
// helpers.agent: агент в `$action` — слот расширения `agent`.
export { agentHelper, loadBackendNr, profileDocOf, resolveProfile, withAgentScope } from './agent.ts'
export type { HelperAgent, HelperAgentOptions } from './agent.ts'

// Провайдер хоста — низкоуровневый слой под helpers.llm/embed. appz через `$type`
// получает готовые helpers третьим аргументом; экспорт — для хостов,
// которые собирают helpers сами (exz sidecar, тесты).
export {
  resolveProvider,
  resolveImageProvider,
  listImageProviders,
  IMAGE_PROVIDER_TYPES,
  COMFY_TEMPLATES,
  mockProvider,
  mockImageProvider,
  MOCK_PROVIDER,
  findGcloud,
  gcloudDirs,
  gcloudToken,
} from './provider.ts'
// Провайдеры файлами: `providers/<type>.ts` — новый `$type` без правки runz.
export {
  providerDirs,
  findProviderFile,
  listProviderFiles,
  loadProviderFile,
  providerFileKinds,
  PROVIDER_FILE_EXTS,
  MEDIA_KINDS,
  LLM_KIND,
} from './provider-files.ts'
export type { ProviderFile, ProviderFileConfig, ProviderFactory } from './provider-files.ts'
export type { ExecuteOptions, ExecuteResult } from './execute.ts'

// Ответ «занято» от провайдера: пауза и повтор до потолка, дальше — код 4 (kd-cli-spec §7).
export { busyRetry, isBusy, parseWait, InterruptedError, DEFAULT_WAIT_MAX_MS } from './busy.ts'
export type { BusyOptions } from './busy.ts'

// Состояние прогона документа с шагами (kd-cli-spec §8): .runz/state/<имя>.mds.
export { stateFileOf, loadState, saveState, clearState, beforeStep, afterStep, runHash, stateEnabled } from './run-state.ts'
export type { RunState, StepRecord, StepPolicy } from './run-state.ts'
