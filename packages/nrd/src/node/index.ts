// @kerneldreams/nrd/node — ступень Node (nrd-merge §2.3).
//
// Всё, что просит fs / spawn / process / discovery. Собрано из четырёх бывших
// пакетов: nr-infra (fsStorage, execShell/runFile), nrd-exec (spawnExecutor),
// nrd-context (nodeCapabilities, fs-функции ${loadMDD}/…), nr-runtime
// (buildRuntimeContext, discoverFunctions) и ntpl (FileSystemLoader).
//
// Имя `nr-runtime` здесь умирает: пакета больше нет, его три файла — рядовые
// модули node-ступени (спека §2.3).

// ---------- Storage / exec — примитивы Node-IO ----------
export { type IStorage, fsStorage } from './storage.js'
export {
  type ExecOptions,
  type ExecResult,
  ExecError,
  execShell,
  runFile,
} from './exec.js'

// ---------- Executor поверх child_process ----------
export { spawnExecutor } from './spawn.js'

// ---------- Node-комплект capabilities для buildContext ----------
export { nodeCapabilities, fetchHttp } from './capabilities.js'

// ---------- Единственная реализация синхронного чтения файла ----------
export { nodeFileIO, readTextSync } from './fs.js'
export { readTextWithIncludes, INCLUDE_EXTENSIONS } from './includes.js'
export type { ReadIncludesOptions } from './includes.js'
export { IncludeCycleError } from '../md/index.js'

// ---------- ${fn()}: fs-функции + discovery по соглашению ----------
export { builtinFunctions, discoverFunctions } from './functions.js'

// ---------- Сборка контекста из файла (бывший nr-runtime) ----------
export { buildRuntimeContext, buildFunctionContext } from './context.js'
export type { RuntimeOptions } from './types.js'

// ---------- Документ как программа: детект, загрузка, capability ----------
export { detectKind, loadProgram, PROGRAM_EXTENSIONS } from './program.js'
export type { LoadProgramOptions } from './program.js'
// ---------- Профили: инклюд по выбору (поле формы `preset`) ----------
export {
  expandPresets,
  globIn,
  presetDirs,
  presetFields,
  presetLines,
  presetMeta,
  presetOptions,
  presetValues,
  resolvePreset,
} from './presets.js'
export type { ExpandPresetsOptions, PresetField, PresetOption } from './presets.js'
export { nodeCodeLoader, TMP_PREFIX } from './code-loader.js'
export { nodeProgramCaps, syncFsStorage } from './capability-program.js'
export { buildHelpers, EMBED_DIR } from './helpers.js'
export type {
  ProgramHelpers,
  HelpersOptions,
  LlmOptions,
  LlmDone,
  EmbedOptions,
  ImageOptions,
  ImageOutput,
  VideoOptions,
  AudioOptions,
  MediaOutput,
  ImageSetup,
  ProviderSetup,
  StreamProvider,
  StreamChunk,
} from './helpers.js'

// ---------- Эмбеды: CAS-стор векторов на node:sqlite (embed-cas-spec §3) ----------
export { sqliteEmbedStore, embedSpaceSlug, type SqliteEmbedStore } from './embed-store.js'

// ---------- ntpl: загрузка шаблонов с диска ----------
export {
  upwardDirs,
  searchDirs,
  findTemplate,
  nodeLoader,
  discoverSites,
} from './template.js'
