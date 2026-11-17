import type { AsyncResult } from './result.js'

// ==================== CONTENT BLOCKS ====================

/** Блок контента сообщения (LLM-версия). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }
  | { type: 'audio'; media_type: string; data: string }
  | { type: 'file'; media_type: string; data: string }

// ==================== MESSAGES ====================

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  /** ID вызова инструмента — для role: 'tool'. */
  tool_call_id?: string
  /** Имя функции — для role: 'tool'. */
  name?: string
}

// ==================== TOOLS ====================

export interface LLMTool {
  name: string
  description: string
  /** JSON Schema */
  input_schema: Record<string, unknown>
}

export interface LLMToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

// ==================== THINKING ====================

export interface ThinkingConfig {
  enabled: boolean
  /** Budget in tokens (1024–128000). */
  budget_tokens?: number
}

// ==================== REQUEST ====================

export interface LLMRequest {
  model: string
  messages: LLMMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  tools?: LLMTool[]
  tool_choice?: 'auto' | 'any' | 'none' | { name: string }
  stream?: boolean
  stop_sequences?: string[]

  /** Extended thinking (Anthropic, Gemini). */
  thinking?: ThinkingConfig
  /** Effort level (Claude). */
  effort?: string

  /** Backend-specific fields merged verbatim into the request body
   *  (llama.cpp: min_p, top_k, dry_*, response_format, json_schema, grammar, ...).
   *  Keys are the caller's responsibility; unknown keys are silently ignored by most backends. */
  extra?: Record<string, unknown>
}

// ==================== RESPONSE ====================

export interface LLMUsage {
  input_tokens: number
  output_tokens: number
  /** Anthropic prompt caching. */
  cache_creation_tokens?: number
  cache_read_tokens?: number
  /** Thinking budget consumed. */
  thinking_tokens?: number
}

export interface LLMResponse {
  content: string
  tool_calls?: LLMToolCall[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage?: LLMUsage
  /** Модель, реально ответившая (может отличаться от запрошенной). */
  model?: string
  /** Thinking content. */
  thinking?: string
  /** Оригинальный ответ провайдера (для дебага). */
  raw?: unknown
}

// ==================== STREAMING ====================

export interface LLMChunk {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_delta' | 'done'
  text?: string
  tool_call?: Partial<LLMToolCall>
  usage?: LLMUsage
  stop_reason?: LLMResponse['stop_reason']
  /** Сырой `finish_reason` провайдера (`SAFETY`, `content_filter`, `PROHIBITED_CONTENT`…): `stop_reason` его сворачивает. */
  finish_reason?: string
  /** Блокировка промпта провайдером (`prompt_feedback.block_reason` Gemini) — ответа не будет. */
  block_reason?: string
}

// ==================== EMBEDDINGS ====================

export interface EmbedRequest {
  model: string
  /** Тексты; при `modality: 'image'` — data URL картинок (`data:image/jpeg;base64,…`, RGB). */
  input: string[]
  /** Что во входе: текст (по умолчанию) или картинки (OpenAI-вайр Infinity: поле `modality` тела). */
  modality?: 'text' | 'image'
}

export interface EmbedResponse {
  /** Вектора в порядке `input`. */
  vectors: Float32Array[]
  /** Модель, реально ответившая. */
  model?: string
}

// ==================== PROVIDER ====================

export interface LLMProvider {
  chat(req: LLMRequest): AsyncResult<LLMResponse>
  /**
   * Стрим чанков. Ошибки старта (auth 401, 429, network) прилетают throws
   * из первого next() — стандартно для async iterators.
   */
  stream(req: LLMRequest): AsyncIterable<LLMChunk>
  /** Эмбеды. Нет у транспорта — метода нет (не заглушка, бросающая throw). */
  embed?(req: EmbedRequest): AsyncResult<EmbedResponse>
}

export interface ProviderOptions {
  baseUrl: string
  apiKey: string
  defaultModel?: string
  defaultMaxTokens?: number
  /** Доп. заголовки (Codex originator, Grok auth, etc.). */
  headers?: Record<string, string>
  /** Таймаут на запрос (до заголовков), ms. */
  timeout?: number
  /** Стрим: максимальный простой между чанками, ms. */
  idleTimeout?: number
}

// ==================== ERRORS ====================

/** Структурированные коды ошибок LLM. Класс LLMError и хелперы — в потребителе (nr-infra). */
export type LLMErrorCode =
  | 'rate_limit'
  | 'auth'
  | 'invalid_request'
  | 'server'
  | 'timeout'
  | 'network'
