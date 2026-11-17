// Provider resolution. Ported from chat2 provider.ts.
// Picks openai- vs anthropic-shaped HTTP from config + env, defaults to
// OpenRouter for OpenAI-compatible models.

import { openaiProvider, anthropicProvider, ollamaProvider } from '@kerneldreams/nrd/web'
import type { LLMProvider } from '@kerneldreams/nrd/web'
import type { IContext } from '@kerneldreams/nrd'

export interface ProviderInput {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  type?: string
  think?: boolean
  /** ms: до заголовков + idle-watchdog стрима одним значением. */
  timeout?: number
}

export interface ResolvedProvider {
  provider: LLMProvider
  model: string
  type: 'openai' | 'anthropic' | 'ollama'
  name: string
}

const DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://openrouter.ai/api/v1',
  ollama: 'http://127.0.0.1:11434',
}

function detectType(model: string, providerName?: string): 'openai' | 'anthropic' | 'ollama' {
  const p = (providerName ?? '').toLowerCase()
  if (p === 'ollama') return 'ollama'
  if (p === 'anthropic' || p === 'claude') return 'anthropic'
  if (p === 'openai' || p === 'openrouter') return 'openai'
  // openrouter exposes "anthropic/…" model ids over the OpenAI API; only a bare
  // claude id (no slash) implies the native Anthropic API.
  if (/^claude/i.test(model)) return 'anthropic'
  return 'openai'
}

export function buildProvider(
  input: ProviderInput,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const providerName = input.provider ?? env['LLM_PROVIDER']
  const model = input.model ?? env['LLM_MODEL']
  if (!model) throw new Error('nr-engine: no model configured ($model / config.model / LLM_MODEL)')

  const type = detectType(model, input.type ?? providerName)
  const envPrefix = (providerName ?? type).toUpperCase()

  const apiKey =
    input.apiKey ??
    env[`${envPrefix}_API_KEY`] ??
    env[`${type.toUpperCase()}_API_KEY`] ??
    env['LLM_API_KEY'] ??
    ''

  const baseUrl = input.baseUrl ?? env[`${envPrefix}_BASE_URL`] ?? DEFAULT_BASE_URL[type]

  const opts = {
    baseUrl,
    apiKey,
    defaultModel: model,
    ...(input.timeout !== undefined ? { timeout: input.timeout, idleTimeout: input.timeout } : {}),
  }
  let provider: LLMProvider
  if (type === 'ollama') {
    provider = ollamaProvider({ ...opts, think: input.think })
  } else if (type === 'anthropic') {
    provider = anthropicProvider(opts)
  } else {
    provider = openaiProvider(opts)
  }

  return { provider, model, type, name: providerName ?? type }
}

// ==================== chain → ProviderConfig ====================

/**
 * Резолв конфига провайдера из цепочки контекста (runz chain / mds config).
 *
 * Единственная точка, знающая форму `## $provider <name>`-блоков и фолбэков
 * ключа. Потребители (chat3, playground) вызывают это вместо локальных копий.
 * Эталон семантики — chat3.lookupProvider от 07.07.
 *
 * apiKey:  `<name>_api_key` | `<name>-api-key` (плоские attrs цепочки, CLI-слой
 *          выигрывает через chainContext) → блок.api_key | блок.api-key
 * baseUrl: блок.base_url | блок.base-url
 * type:    блок.type
 * think:   блок.think
 * timeout: блок.timeout (ms — заголовки + idle одним значением)
 */
export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  type?: string
  think?: boolean
  timeout?: number
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}

export function resolveProviderConfig(ctx: IContext, name: string): ProviderConfig {
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  // Плоские attrs цепочки: CLI-слой поверх конфига (chainContext).
  let apiKey = s(ctx.get([name + '_api_key'])) ?? s(ctx.get([name + '-api-key']))
  let baseUrl: string | undefined
  let type: string | undefined
  let think: boolean | undefined
  let timeout: number | undefined
  const block = ctx.get(['provider', name])
  if (block && typeof block === 'object' && 'get' in block) {
    const b = block as IContext
    baseUrl = s(b.get(['base_url'])) ?? s(b.get(['base-url']))
    apiKey = apiKey ?? s(b.get(['api_key'])) ?? s(b.get(['api-key']))
    type = s(b.get(['type']))
    think = toBool(b.get(['think']))
    timeout = toNum(b.get(['timeout']))
  }
  return { apiKey, baseUrl, type, think, timeout }
}
