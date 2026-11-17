// @kerneldreams/nrd/web — ступень web-standards (nrd-merge §2.2).
//
// Критерий принадлежности: модуль использует ТОЛЬКО WinterCG-API — fetch,
// streams, crypto. Ни одного `node:`-импорта. Работает в Node, браузере и
// CF Workers (Dreams). Всё, что просит fs/spawn/process, живёт в `nrd/node`.

// ---------- HTTP (fetch + retry + timeout) ----------
export {
  type HttpOptions,
  type HttpResponse,
  httpGet,
  httpPost,
  httpPostStream,
} from './http.js'

// ---------- Storage: in-memory (fsStorage — в nrd/node) ----------
export {
  type IStorage,
  memoryStorage,
} from './storage.js'

// ---------- LLM: контракты провайдеров + SSE ----------
export {
  type ContentBlock,
  type LLMMessage,
  type LLMTool,
  type LLMToolCall,
  type LLMRequest,
  type LLMResponse,
  type LLMChunk,
  type LLMUsage,
  type LLMProvider,
  type ProviderOptions,
  type ThinkingConfig,
  type EmbedRequest,
  type EmbedResponse,
  type EmbedStore,
  parseSSE,
} from './llm/types.js'

export {
  LLMError,
  type LLMErrorCode,
  parseRetryAfter,
  errorCodeFromStatus,
} from './llm/errors.js'

// ---------- LLM: провайдеры поверх fetch ----------
export {
  openaiProvider,
  toOpenAIRequest,
  fromOpenAIResponse,
  fromOpenAIEmbeddings,
} from './llm/openai.js'

export {
  anthropicProvider,
  toAnthropicRequest,
  fromAnthropicResponse,
} from './llm/anthropic.js'

export {
  ollamaProvider,
  toOllamaRequest,
  type OllamaProviderOptions,
} from './llm/ollama.js'

// ---------- Эмбеды: нормализация, хеш, f16, CAS-кеш (embed-cas-spec §2) ----------
export {
  NORM_V,
  normText,
  textHash,
  toF16Bytes,
  fromF16Bytes,
  memoryEmbedStore,
  cachedEmbed,
  type Embedder,
  type CachedEmbedOptions,
} from './embed.js'

// ---------- Медиа: контракт, BFL, nano-gpt, Google (image-gen-spec §1–2, image-gen-2-spec §1–3, media-gen-spec §1–2) ----------
export type {
  ImageRequest,
  ImageResult,
  ImageMeta,
  ImageProvider,
  ImageModelSchema,
  ImageModelField,
  ImageModelInfo,
  ImageProgress,
  ImageErrorName,
  MediaKind,
  MediaRefRole,
  MediaRequest,
  MediaResult,
  MediaProvider,
  MediaModelInfo,
  MediaModelSchema,
} from '../contracts/index.js'
export { imageError } from '../contracts/index.js'
export { bflImageProvider, type BflProviderOptions } from './image/bfl.js'
export { nanogptImageProvider, type NanogptProviderOptions } from './image/nanogpt.js'
export {
  googleMediaProvider,
  vertexMediaProvider,
  VERTEX_MEDIA_CANDIDATES,
  type GoogleMediaOptions,
  type VertexMediaOptions,
} from './image/google.js'
export { gateMediaProvider, gateRoot, type GateMediaOptions } from './image/gate.js'
export { toBase64, fromBase64, sniffImageMime, sniffMediaMime, imageExt, mediaExt, mediaKindOf } from './image/bytes.js'
