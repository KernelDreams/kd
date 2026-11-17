// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * @kerneldreams/runz-runtime/llm — public API
 *
 * Единый LLM-клиент. Провайдеры: OpenRouter, Anthropic, OpenAI-compatible.
 */

export type {
  Role,
  Message,
  ProviderType,
  ProviderConfig,
  LLMConfig,
  CompletionRequest,
  CompletionResponse,
  Usage,
  HttpAdapter,
} from './types.ts'

export { LLMError, codeForStatus } from './errors.ts'
export type { LLMErrorCode } from './errors.ts'

export { LLMClient, createClient } from './client.ts'

export { providersFromDoc, providersFromText, loadLLMConfig } from './config.ts'

export { adapterFor, defaultBaseUrl, anthropicAdapter, openAIAdapter } from './providers/index.ts'
