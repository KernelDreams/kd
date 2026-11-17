// @kerneldreams/nrd/contracts — пакет-соглашение kd.
// Типы, интерфейсы, Result, протокол запуска. Ноль зависимостей, ноль
// реализаций (кроме чистых конструкторов/guards). Ступень 1 Total Refactor.

// ---------- Result ----------
export {
  type Result,
  type AsyncResult,
  ok,
  err,
  isOk,
  isErr,
} from './result.js'

// ---------- Value ----------
export type { Value } from './value.js'

// ---------- Engine protocol: типы + guards ----------
export {
  isScalar,
  isContext,
  isArray,
  isInterpolated,
} from './context.js'
export type {
  Segment,
  IContext,
  IArray,
  CastMap,
  ResolveOptions,
  FuncFn,
} from './context.js'

// ---------- Приведение к тексту (text-cast-spec §2.1) ----------
export { asText, toText, textView } from './text.js'
export type { TextCastOptions } from './text.js'

// ---------- Слоистые контексты: self / $nr-extends ----------
export type { ExtendsLoader, SelfOptions } from './extends.js'

// ---------- IO-контракты: storage / fs / kv / http / exec / include / code ----------
export type { IStorage } from './storage.js'
export type { IFileSystem, FileStat, DirEntry } from './fs.js'
export type { KvStore, KvSetOptions } from './kv.js'
export type { CodeLoader, CodeLoadOptions, CodeLang, LoadedModule } from './code-loader.js'
export type { HttpOptions, HttpResponse } from './http.js'
export type { ExecOptions, ExecResult } from './exec.js'
export type { IncludeResolver } from './include.js'

// ---------- LLM-словарь ----------
export type {
  ContentBlock,
  LLMMessage,
  LLMTool,
  LLMToolCall,
  LLMRequest,
  LLMResponse,
  LLMChunk,
  LLMUsage,
  LLMProvider,
  EmbedRequest,
  EmbedResponse,
  ProviderOptions,
  ThinkingConfig,
  LLMErrorCode,
} from './llm.js'

// ---------- Генерация медиа: картинки, видео, музыка (image-gen-spec §1, media-gen-spec §1) ----------
export { imageError } from './image.js'
export type {
  ImageRequest,
  ImageResult,
  ImageMeta,
  ImageProvider,
  ImageModelSchema,
  ImageModelField,
  ImageModelInfo,
  ImageProgress,
  ImageBatchOptions,
  ImageErrorName,
  MediaKind,
  MediaRefRole,
  MediaRequest,
  MediaProgress,
  MediaModelInfo,
  MediaMeta,
  MediaResult,
  MediaModelField,
  MediaModelSchema,
  MediaProvider,
  MediaBatchOptions,
} from './image.js'

// ---------- Эмбеды: контент-адресный стор векторов ----------
export type { EmbedStore } from './embed.js'

// ---------- Точки расширения сборки контекста ----------
export { noopLogger } from './plugins.js'
export type {
  Logger,
  HttpClient,
  SourceContext,
  SourcePlugin,
  TransformPlugin,
} from './plugins.js'

// ---------- Контракт исполнения блока ----------
export type { Engine, ExecInput, ExecOutput, Executor } from './executor.js'

// ---------- Протокол запуска ----------
export { isServiceResult } from './runtime.js'
export type {
  ScriptMeta,
  ScriptResult,
  ServiceResult,
  ScriptOutput,
  ScriptArtifact,
  ScriptFn,
  HostChain,
} from './runtime.js'
