// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * @kerneldreams/runz-runtime/llm — types
 */

export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  role: Role
  content: string
}

export type ProviderType = 'openrouter' | 'anthropic' | 'openai' | string

/** How to connect to an LLM API. */
export interface ProviderConfig {
  /** Provider name as referenced in `provider/model`. */
  name: string
  /** Adapter type — selects request/response format. */
  type: ProviderType
  /** API base URL. Defaults per type if omitted. */
  baseUrl?: string
  /** API key. */
  apiKey?: string
  /** Extra request headers. */
  headers?: Record<string, string>
}

export interface LLMConfig {
  providers: Record<string, ProviderConfig>
  /** Provider used when a model has no `provider/` prefix. */
  defaultProvider?: string
  /** Request timeout in ms. Default 60000. */
  timeout?: number
}

export interface CompletionRequest {
  /** `provider/model` or bare `model` (uses defaultProvider). */
  model: string
  messages: Message[]
  /** System prompt (merged with any system message). */
  system?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface CompletionResponse {
  content: string
  model: string
  stopReason: string
  usage: Usage
  /** Original provider response. */
  raw: unknown
}

/** An HTTP adapter: knows one API's request/response shape. */
export interface HttpAdapter {
  readonly name: string
  /** Build the `/messages` or `/chat/completions` endpoint from a base URL. */
  endpoint(baseUrl: string): string
  /** Auth + content headers. */
  headers(config: ProviderConfig): Record<string, string>
  buildBody(request: CompletionRequest, model: string): unknown
  parseResponse(raw: unknown): CompletionResponse
}
