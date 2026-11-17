// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * @kerneldreams/runz-runtime/llm — LLM client
 *
 * Single client over multiple providers. Routes `provider/model` to the
 * matching provider; bare `model` uses `defaultProvider`.
 */

import type {
  LLMConfig,
  ProviderConfig,
  CompletionRequest,
  CompletionResponse,
} from './types.ts'
import { LLMError, codeForStatus } from './errors.ts'
import { adapterFor, defaultBaseUrl } from './providers/index.ts'

const DEFAULT_TIMEOUT = 60000
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 2

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class LLMClient {
  private readonly providers: Record<string, ProviderConfig>
  private readonly defaultProvider?: string
  private readonly timeout: number

  constructor(config: LLMConfig) {
    this.providers = config.providers
    this.defaultProvider = config.defaultProvider
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
  }

  /** Provider names known to this client. */
  providerNames(): string[] {
    return Object.keys(this.providers)
  }

  private route(model: string): { provider: ProviderConfig; modelName: string } {
    const slash = model.indexOf('/')
    if (slash >= 0) {
      const prefix = model.slice(0, slash)
      const direct = this.providers[prefix]
      if (direct) {
        return { provider: direct, modelName: model.slice(slash + 1) }
      }
      // e.g. OpenRouter-style `google/gemini-...` — use defaultProvider, full model.
      if (this.defaultProvider && this.providers[this.defaultProvider]) {
        return { provider: this.providers[this.defaultProvider], modelName: model }
      }
      throw new LLMError(`Unknown provider: ${prefix}`, 'config', { provider: prefix })
    }
    if (this.defaultProvider && this.providers[this.defaultProvider]) {
      return { provider: this.providers[this.defaultProvider], modelName: model }
    }
    throw new LLMError('No provider prefix and no defaultProvider configured', 'config')
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const { provider, modelName } = this.route(request.model)
    const adapter = adapterFor(provider.type)
    if (!adapter) {
      throw new LLMError(`Unknown provider type: ${provider.type}`, 'config', { provider: provider.name })
    }

    const baseUrl = provider.baseUrl ?? defaultBaseUrl(provider.type)
    const endpoint = adapter.endpoint(baseUrl)
    const headers = adapter.headers(provider)
    const body = adapter.buildBody(request, modelName)

    let lastError: LLMError | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout)
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!response.ok) {
          let errBody: unknown
          try { errBody = await response.json() } catch { errBody = await response.text() }
          const message = extractErrorMessage(errBody) ?? `HTTP ${response.status}`
          const error = new LLMError(message, codeForStatus(response.status), {
            status: response.status,
            provider: provider.name,
          })
          if (RETRY_STATUS.has(response.status) && attempt < MAX_RETRIES) {
            lastError = error
            await sleep(1000 * (attempt + 1))
            continue
          }
          throw error
        }
        const data = await response.json()
        return adapter.parseResponse(data)
      } catch (e) {
        if (e instanceof LLMError) throw e
        const isTimeout = e instanceof Error && e.name === 'AbortError'
        lastError = new LLMError(
          isTimeout ? 'Request timeout' : `Network error: ${e instanceof Error ? e.message : String(e)}`,
          isTimeout ? 'timeout' : 'network',
          { provider: provider.name },
        )
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * (attempt + 1))
          continue
        }
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError ?? new LLMError('Unknown error', 'network', { provider: provider.name })
  }
}

function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    const err = obj.error
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return (err as Record<string, unknown>).message as string
    }
    if (typeof obj.message === 'string') return obj.message
  }
  return undefined
}

export function createClient(config: LLMConfig): LLMClient {
  return new LLMClient(config)
}
