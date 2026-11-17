// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * @kerneldreams/runz-runtime/llm — provider adapter registry
 *
 * Adding a new provider = a new file here + an entry in `adapterFor`.
 */

import type { HttpAdapter, ProviderType } from '../types.ts'
import { anthropicAdapter } from './anthropic.ts'
import { openAIAdapter } from './openai.ts'

/** Default base URL per provider type. */
export function defaultBaseUrl(type: ProviderType): string {
  switch (type) {
    case 'anthropic': return 'https://api.anthropic.com/v1'
    case 'openrouter': return 'https://openrouter.ai/api/v1'
    case 'openai': return 'https://api.openai.com/v1'
    default: return 'https://api.openai.com/v1'
  }
}

/** Select the HTTP adapter for a provider type. */
export function adapterFor(type: ProviderType): HttpAdapter | undefined {
  switch (type) {
    case 'anthropic': return anthropicAdapter
    case 'openrouter': return openAIAdapter
    case 'openai': return openAIAdapter
    default: return openAIAdapter
  }
}

export { anthropicAdapter, openAIAdapter }
