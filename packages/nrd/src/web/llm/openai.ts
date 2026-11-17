import { httpPost, httpPostStream } from '../http.js'
import { type AsyncResult, ok, err, isErr } from '../../infra/result.js'
import {
  type EmbedRequest,
  type EmbedResponse,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMChunk,
  type LLMToolCall,
  type LLMUsage,
  type ContentBlock,
  type ProviderOptions,
  parseSSE,
} from './types.js'
import { LLMError, errorCodeFromStatus, parseRetryAfter } from './errors.js'

// ==================== Content conversion ====================

/** Контент-блок → OpenAI формат (vision: image → image_url с data-URL). */
function mapContent(content: string | ContentBlock[]): unknown {
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    // image, audio, file → data-URL через image_url
    const dataUrl = `data:${block.media_type};base64,${block.data}`
    return { type: 'image_url', image_url: { url: dataUrl } }
  })
}

function mapMessage(msg: import('./types.js').LLMMessage): unknown {
  switch (msg.role) {
    case 'system':
      return { role: 'system', content: typeof msg.content === 'string' ? msg.content : '' }
    case 'user':
      return { role: 'user', content: mapContent(msg.content) }
    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : null }
      // If content has tool_calls, we'd need them here — but in our model
      // tool_calls come from response, not from messages we send.
      // Assistant messages in history may need reconstruction — handled by assembler.
      return out
    }
    case 'tool':
      return { role: 'tool', content: typeof msg.content === 'string' ? msg.content : '', tool_call_id: msg.tool_call_id }
  }
}

// ==================== Request building ====================

/** LLMRequest → тело запроса OpenAI Chat Completions. */
export function toOpenAIRequest(req: LLMRequest, defaults: Partial<ProviderOptions> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model || defaults.defaultModel,
    messages: req.messages.map(mapMessage),
  }
  const maxTokens = req.max_tokens ?? defaults.defaultMaxTokens
  if (maxTokens !== undefined) body.max_tokens = maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.top_p !== undefined) body.top_p = req.top_p
  if (req.frequency_penalty !== undefined) body.frequency_penalty = req.frequency_penalty
  if (req.presence_penalty !== undefined) body.presence_penalty = req.presence_penalty
  if (req.stop_sequences) body.stop = req.stop_sequences
  // Usage в стриме: OpenAI и llama-server отдают его ТОЛЬКО по include_usage
  // (без флага у llama-server в финальном кадре одни timings — usage=0 у
  // локальных моделей). OpenRouter шлёт и так; флаг ему не мешает.
  // Отключить для сервера, который флаг не переваривает: extra.stream_options.
  if (req.stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }

  // Reasoning effort (Grok 4.3, etc.)
  if (req.effort) body.reasoning_effort = req.effort

  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
  }

  // Backend-specific pass-through — merged last, wins over standard fields.
  if (req.extra) Object.assign(body, req.extra)

  if (req.tool_choice !== undefined) {
    if (req.tool_choice === 'auto') body.tool_choice = 'auto'
    else if (req.tool_choice === 'none') body.tool_choice = 'none'
    else if (req.tool_choice === 'any') body.tool_choice = 'required'
    else body.tool_choice = { type: 'function', function: { name: req.tool_choice.name } }
  }

  return body
}

// ==================== Response parsing ====================

function mapFinishReason(reason: string | undefined): LLMResponse['stop_reason'] {
  switch (reason) {
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'stop': return 'end_turn'
    default: return 'end_turn'
  }
}

/** `block_reason` блокировки промпта: Gemini (`promptFeedback.blockReason`) или его OpenAI-совместимые прокси. */
export function blockReasonOf(json: any): string | undefined {
  const fb = json?.prompt_feedback ?? json?.promptFeedback
  const r = fb?.block_reason ?? fb?.blockReason
  return typeof r === 'string' && r !== '' ? r : undefined
}

function safeParse(s: string | undefined): Record<string, unknown> {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return {} }
}

/** Тело ответа OpenAI → LLMResponse. */
/**
 * Reasoning text of a delta/message: first non-empty of `reasoning_content`
 * (DeepSeek, llama-server), `reasoning` (nano-gpt GLM, OpenRouter),
 * `reasoning_text`. Providers that send two of them send the same text.
 */
export function reasoningOf(x: any): string {
  for (const f of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    const v = x?.[f]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

export function fromOpenAIResponse(data: any): LLMResponse {
  const choice = data.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const res: LLMResponse = {
    content: message.content ?? '',
    stop_reason: mapFinishReason(choice.finish_reason),
    model: data.model,
    raw: data,
  }
  const thinking = reasoningOf(message)
  if (thinking) res.thinking = thinking
  if (message.tool_calls?.length) {
    res.tool_calls = message.tool_calls.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      input: safeParse(tc.function?.arguments),
    }))
  }
  if (data.usage) {
    res.usage = {
      input_tokens: data.usage.prompt_tokens ?? 0,
      output_tokens: data.usage.completion_tokens ?? 0,
    }
  }
  return res
}

// ==================== Error parsing ====================

function parseOpenAIError(
  status: number,
  body: string,
  headers: Record<string, string>,
  provider = 'openai',
): LLMError {
  let message = `${provider === 'openai' ? 'OpenAI' : provider} HTTP ${status}`
  let raw: unknown = body
  try {
    const parsed = JSON.parse(body)
    raw = parsed
    const errObj = parsed?.error
    if (typeof errObj === 'object' && errObj?.message) message = errObj.message
    else if (typeof parsed?.message === 'string') message = parsed.message
  } catch { /* keep raw string */ }

  return new LLMError(message, {
    code: errorCodeFromStatus(status),
    status,
    provider,
    retryAfter: parseRetryAfter(headers['retry-after'] ?? null),
    raw,
  })
}

// ==================== Embeddings ====================

/** Тело ответа OpenAI-embeddings → вектора в порядке `index`. */
export function fromOpenAIEmbeddings(data: any, inputs: number): EmbedResponse | string {
  const rows: any[] = Array.isArray(data?.data) ? data.data : []
  if (rows.length !== inputs) return `embeddings: ${rows.length} векторов на ${inputs} входов`
  const sorted = [...rows].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
  const vectors: Float32Array[] = []
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]?.embedding
    if (!Array.isArray(e)) return `embeddings: data[${i}].embedding — не массив чисел`
    vectors.push(Float32Array.from(e as number[]))
  }
  const res: EmbedResponse = { vectors }
  if (typeof data?.model === 'string') res.model = data.model
  return res
}

/**
 * POST `{model, input}` на OpenAI-вайр `/embeddings`. Общий для openai и
 * ollama (у ollama та же ручка от корня хоста). Ошибки — как у `chat`.
 * Картинки (`modality: 'image'`) — то же тело с полем `modality`, вход — data URL.
 */
export async function postEmbeddings(
  url: string,
  req: EmbedRequest,
  o: { headers: Record<string, string>; timeout?: number; provider: string },
): AsyncResult<EmbedResponse> {
  const body = { model: req.model, input: req.input, ...(req.modality === 'image' ? { modality: 'image' } : {}) }
  const res = await httpPost(url, body, { headers: o.headers, timeout: o.timeout })
  if (isErr(res)) return err(new LLMError(res.error.message, { code: 'network', provider: o.provider, raw: res.error }))
  if (res.value.status >= 400) {
    return err(parseOpenAIError(res.value.status, res.value.body, res.value.headers, o.provider))
  }
  const parsed = res.value.json<any>()
  if (isErr(parsed)) return err(new LLMError('Invalid JSON response', { code: 'server', provider: o.provider, raw: parsed.error }))
  const out = fromOpenAIEmbeddings(parsed.value, req.input.length)
  if (typeof out === 'string') return err(new LLMError(out, { code: 'server', provider: o.provider, raw: parsed.value }))
  return ok(out)
}

// ==================== Provider ====================

export function openaiProvider(opts: ProviderOptions): LLMProvider {
  const base = opts.baseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const buildHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  })

  return {
    embed(req: EmbedRequest): AsyncResult<EmbedResponse> {
      return postEmbeddings(`${base}/embeddings`, req, {
        headers: buildHeaders(),
        timeout: opts.timeout,
        provider: 'openai',
      })
    },

    async chat(req: LLMRequest): AsyncResult<LLMResponse> {
      const body = toOpenAIRequest({ ...req, stream: false }, opts)
      const httpOpts = { headers: buildHeaders(), timeout: opts.timeout, idleTimeout: opts.idleTimeout }
      const res = await httpPost(url, body, httpOpts)
      if (isErr(res)) return err(new LLMError(res.error.message, { code: 'network', provider: 'openai', raw: res.error }))
      if (res.value.status >= 400) {
        return err(parseOpenAIError(res.value.status, res.value.body, res.value.headers))
      }
      const parsed = res.value.json<any>()
      if (isErr(parsed)) return err(new LLMError('Invalid JSON response', { code: 'server', provider: 'openai', raw: parsed.error }))
      return ok(fromOpenAIResponse(parsed.value))
    },

    async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
      const body = toOpenAIRequest({ ...req, stream: true }, opts)
      const httpOpts = { headers: buildHeaders(), timeout: opts.timeout, idleTimeout: opts.idleTimeout }
      const streamRes = await httpPostStream(url, body, httpOpts)
      if (isErr(streamRes)) {
        throw new LLMError(streamRes.error.message, { code: 'network', provider: 'openai', raw: streamRes.error })
      }

      const toolIndex = new Map<number, boolean>()
      for await (const data of parseSSE(streamRes.value)) {
        if (data === '[DONE]') {
          yield { type: 'done' }
          continue
        }
        let json: any
        try { json = JSON.parse(data) } catch { continue }

        // Ошибка посреди стрима при HTTP 200 (гейт, OpenRouter): `data: {"error": …}`.
        // Раньше кадр молча пропускался, и вызывающий получал пустой ответ (14.11.2026).
        if (json?.error && !json.choices) {
          const e = json.error
          const msg = typeof e === 'string' ? e : String(e.message ?? JSON.stringify(e))
          throw new LLMError(msg, { code: errorCodeFromStatus(Number(e.code) || 500), provider: 'openai', raw: e })
        }

        const choice = json.choices?.[0]
        const delta = choice?.delta
        const blocked = blockReasonOf(json)

        // Finish reason
        if (choice?.finish_reason) {
          const chunk: LLMChunk = {
            type: 'done',
            stop_reason: mapFinishReason(choice.finish_reason),
            // Сырой: SAFETY / content_filter сворачиваются в end_turn — а вызывающему важно, почему ответ пуст.
            finish_reason: String(choice.native_finish_reason ?? choice.finish_reason),
          }
          if (blocked) chunk.block_reason = blocked
          if (json.usage) {
            chunk.usage = {
              input_tokens: json.usage.prompt_tokens ?? 0,
              output_tokens: json.usage.completion_tokens ?? 0,
            }
          }
          yield chunk
          continue
        }

        // Text content
        if (delta?.content) {
          yield { type: 'text', text: delta.content }
        }

        // Reasoning: DeepSeek-style reasoning_content (llama-server, DeepSeek API), reasoning (nano-gpt GLM, OpenRouter)
        const reasoning = reasoningOf(delta)
        if (reasoning) {
          yield { type: 'thinking', text: reasoning }
        }

        // Tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolIndex.has(idx)) {
              toolIndex.set(idx, true)
              yield {
                type: 'tool_call_start',
                tool_call: { id: tc.id, name: tc.function?.name, input: {} },
              }
            }
            if (tc.function?.arguments) {
              yield {
                type: 'tool_call_delta',
                tool_call: { id: tc.id },
                text: tc.function.arguments,
              }
            }
          }
        }

        // Промпт заблокирован (Gemini через OpenAI-совместимый слой): кадр без choices, только prompt_feedback.
        if (!json.choices?.length && blocked) {
          yield { type: 'done', stop_reason: 'end_turn', block_reason: blocked }
          continue
        }

        // Usage-only chunk (no choices, just usage at the end)
        if (!json.choices?.length && json.usage) {
          yield {
            type: 'done',
            usage: {
              input_tokens: json.usage.prompt_tokens ?? 0,
              output_tokens: json.usage.completion_tokens ?? 0,
            },
          }
        }
      }
    },
  }
}
