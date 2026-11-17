/**
 * Ollama native provider — uses /api/chat (NDJSON streaming).
 * Supports `think` toggle that the OpenAI-compatible endpoint ignores.
 */

import { httpPost, httpPostStream } from '../http.js'
import { type AsyncResult, ok, err, isErr } from '../../infra/result.js'
import type {
  EmbedRequest,
  EmbedResponse,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMChunk,
  LLMUsage,
  ProviderOptions,
} from './types.js'
import { LLMError, errorCodeFromStatus } from './errors.js'
import { postEmbeddings } from './openai.js'

// ==================== Options ====================

export interface OllamaProviderOptions extends ProviderOptions {
  /** Toggle model thinking. undefined = model default, false = disable. */
  think?: boolean
}

// ==================== NDJSON parser ====================

async function* parseNDJSON(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) {
          try { yield JSON.parse(line) } catch { /* skip malformed */ }
        }
      }
    }
    const tail = buffer.trim()
    if (tail) {
      try { yield JSON.parse(tail) } catch { /* skip */ }
    }
  } finally {
    reader.releaseLock()
  }
}

// ==================== Request building ====================

function mapContent(content: string | import('./types.js').ContentBlock[]): string {
  if (typeof content === 'string') return content
  // Ollama native API: content is a string; images go in a separate `images` array.
  // For now, concatenate text blocks. Image support can be added later.
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('\n')
}

function mapImages(content: string | import('./types.js').ContentBlock[]): string[] | undefined {
  if (typeof content === 'string') return undefined
  const imgs = content
    .filter((b) => b.type === 'image')
    .map((b) => (b as { type: 'image'; media_type: string; data: string }).data)
  return imgs.length ? imgs : undefined
}

interface OllamaMessage {
  role: string
  content: string
  images?: string[]
}

function mapMessage(msg: import('./types.js').LLMMessage): OllamaMessage {
  const out: OllamaMessage = { role: msg.role, content: mapContent(msg.content) }
  const imgs = mapImages(msg.content)
  if (imgs) out.images = imgs
  return out
}

export function toOllamaRequest(
  req: LLMRequest,
  defaults: Partial<OllamaProviderOptions> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model || defaults.defaultModel,
    messages: req.messages.map(mapMessage),
  }

  if (req.stream !== undefined) body.stream = req.stream

  // think toggle — provider-level default, request-level override
  const think = defaults.think
  if (think !== undefined) body.think = think

  // Ollama model options (temperature, num_predict, top_p, etc.)
  const options: Record<string, unknown> = {}
  if (req.temperature !== undefined) options.temperature = req.temperature
  if (req.top_p !== undefined) options.top_p = req.top_p
  if (req.max_tokens !== undefined) options.num_predict = req.max_tokens
  else if (defaults.defaultMaxTokens !== undefined) options.num_predict = defaults.defaultMaxTokens
  if (req.stop_sequences?.length) options.stop = req.stop_sequences
  if (req.frequency_penalty !== undefined) options.frequency_penalty = req.frequency_penalty
  if (req.presence_penalty !== undefined) options.presence_penalty = req.presence_penalty

  // Backend-specific pass-through → Ollama options (min_p, top_k, repeat_penalty, ...).
  if (req.extra) Object.assign(options, req.extra)

  if (Object.keys(options).length) body.options = options

  // Tools (Ollama native format matches OpenAI)
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
  }

  return body
}

// ==================== Response parsing ====================

function mapStopReason(reason: string | undefined): LLMResponse['stop_reason'] {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

function fromOllamaResponse(data: any): LLMResponse {
  const message = data.message ?? {}
  const res: LLMResponse = {
    content: message.content ?? '',
    stop_reason: mapStopReason(data.done_reason),
    model: data.model,
    raw: data,
  }

  if (message.thinking) res.thinking = message.thinking

  if (message.tool_calls?.length) {
    res.tool_calls = message.tool_calls.map((tc: any) => ({
      id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      name: tc.function?.name,
      input: tc.function?.arguments ?? {},
    }))
  }

  if (data.prompt_eval_count !== undefined || data.eval_count !== undefined) {
    res.usage = {
      input_tokens: data.prompt_eval_count ?? 0,
      output_tokens: data.eval_count ?? 0,
    }
  }

  return res
}

// ==================== Error parsing ====================

function parseOllamaError(status: number, body: string): LLMError {
  let message = `Ollama HTTP ${status}`
  let raw: unknown = body
  try {
    const parsed = JSON.parse(body)
    raw = parsed
    if (parsed?.error) message = parsed.error
  } catch { /* keep raw string */ }
  return new LLMError(message, {
    code: errorCodeFromStatus(status),
    status,
    provider: 'ollama',
    raw,
  })
}

// ==================== Provider ====================

export function ollamaProvider(opts: OllamaProviderOptions): LLMProvider {
  const root = opts.baseUrl.replace(/\/+$/, '').replace(/\/(v\d+|api)$/, '')
  const chatUrl = `${root}/api/chat`
  const buildHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  })

  return {
    // Эмбеды — OpenAI-вайр ollama (`/v1/embeddings` от корня хоста).
    embed(req: EmbedRequest): AsyncResult<EmbedResponse> {
      return postEmbeddings(`${root}/v1/embeddings`, req, {
        headers: buildHeaders(),
        timeout: opts.timeout,
        provider: 'ollama',
      })
    },

    async chat(req: LLMRequest): AsyncResult<LLMResponse> {
      const body = toOllamaRequest({ ...req, stream: false }, opts)
      const httpOpts = { headers: buildHeaders(), timeout: opts.timeout, idleTimeout: opts.idleTimeout }
      const res = await httpPost(chatUrl, body, httpOpts)
      if (isErr(res)) {
        return err(new LLMError(res.error.message, { code: 'network', provider: 'ollama', raw: res.error }))
      }
      if (res.value.status >= 400) {
        return err(parseOllamaError(res.value.status, res.value.body))
      }
      const parsed = res.value.json<any>()
      if (isErr(parsed)) {
        return err(new LLMError('Invalid JSON response', { code: 'server', provider: 'ollama', raw: parsed.error }))
      }
      return ok(fromOllamaResponse(parsed.value))
    },

    async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
      const body = toOllamaRequest({ ...req, stream: true }, opts)
      const httpOpts = { headers: buildHeaders(), timeout: opts.timeout, idleTimeout: opts.idleTimeout }
      const streamRes = await httpPostStream(chatUrl, body, httpOpts)
      if (isErr(streamRes)) {
        throw new LLMError(streamRes.error.message, { code: 'network', provider: 'ollama', raw: streamRes.error })
      }

      for await (const json of parseNDJSON(streamRes.value)) {
        const data = json as any
        if (!data) continue

        // Error chunk
        if (data.error) {
          throw new LLMError(data.error, { code: 'server', provider: 'ollama', raw: data })
        }

        const message = data.message

        // Thinking content
        if (message?.thinking) {
          yield { type: 'thinking', text: message.thinking }
        }

        // Text content
        if (message?.content) {
          yield { type: 'text', text: message.content }
        }

        // Tool calls (non-streaming — Ollama sends them in one chunk)
        if (message?.tool_calls?.length) {
          for (const tc of message.tool_calls) {
            const id = tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`
            yield {
              type: 'tool_call_start',
              tool_call: { id, name: tc.function?.name, input: tc.function?.arguments ?? {} },
            }
          }
        }

        // Done
        if (data.done) {
          const chunk: LLMChunk = {
            type: 'done',
            stop_reason: mapStopReason(data.done_reason),
          }
          if (data.prompt_eval_count !== undefined || data.eval_count !== undefined) {
            chunk.usage = {
              input_tokens: data.prompt_eval_count ?? 0,
              output_tokens: data.eval_count ?? 0,
            }
          }
          yield chunk
        }
      }
    },
  }
}
