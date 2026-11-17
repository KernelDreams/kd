// DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.
/**
 * @kerneldreams/runz-runtime/llm — OpenAI-compatible adapter (chat/completions).
 *
 * Also used for OpenRouter and any OpenAI-compatible service.
 */

import type { HttpAdapter, ProviderConfig, CompletionRequest, CompletionResponse } from '../types.ts'

interface OpenAIResponse {
  model: string
  choices: {
    message: { role: string; content: string | null }
    finish_reason: string
  }[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export const openAIAdapter: HttpAdapter = {
  name: 'openai',

  endpoint(baseUrl: string): string {
    const base = baseUrl.replace(/\/$/, '')
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  },

  headers(config: ProviderConfig): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiKey) h['Authorization'] = `Bearer ${config.apiKey}`
    if (config.headers) Object.assign(h, config.headers)
    return h
  },

  buildBody(request: CompletionRequest, model: string): unknown {
    const messages: { role: string; content: string }[] = []
    if (request.system) messages.push({ role: 'system', content: request.system })
    for (const m of request.messages) {
      messages.push({ role: m.role, content: m.content })
    }
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? 0.7,
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.stop?.length) body.stop = request.stop
    return body
  },

  parseResponse(raw: unknown): CompletionResponse {
    const data = raw as OpenAIResponse
    const choice = data.choices?.[0]
    return {
      content: choice?.message?.content ?? '',
      model: data.model,
      stopReason: choice?.finish_reason ?? 'stop',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      raw,
    }
  },
}
