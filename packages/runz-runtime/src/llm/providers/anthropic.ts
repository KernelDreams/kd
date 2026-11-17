// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * @kerneldreams/runz-runtime/llm — Anthropic adapter (Messages API)
 */

import type { HttpAdapter, ProviderConfig, CompletionRequest, CompletionResponse } from '../types.ts'

interface AnthropicBlock {
  type: string
  text?: string
}

interface AnthropicResponse {
  content: AnthropicBlock[]
  model: string
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}

export const anthropicAdapter: HttpAdapter = {
  name: 'anthropic',

  endpoint(baseUrl: string): string {
    const base = baseUrl.replace(/\/$/, '')
    return base.endsWith('/messages') ? base : `${base}/messages`
  },

  headers(config: ProviderConfig): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (config.apiKey) h['x-api-key'] = config.apiKey
    if (config.headers) Object.assign(h, config.headers)
    return h
  },

  buildBody(request: CompletionRequest, model: string): unknown {
    const systemParts: string[] = []
    if (request.system) systemParts.push(request.system)
    const messages: { role: string; content: string }[] = []
    for (const m of request.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content)
      } else {
        messages.push({ role: m.role, content: m.content })
      }
    }
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    }
    if (systemParts.length > 0) body.system = systemParts.join('\n\n')
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.stop?.length) body.stop_sequences = request.stop
    return body
  },

  parseResponse(raw: unknown): CompletionResponse {
    const data = raw as AnthropicResponse
    const content = data.content
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text!)
      .join('')
    return {
      content,
      model: data.model,
      stopReason: data.stop_reason ?? 'end_turn',
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      raw,
    }
  },
}
