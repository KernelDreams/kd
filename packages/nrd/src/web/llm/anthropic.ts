import { httpPost, httpPostStream } from '../http.js'
import { type AsyncResult, ok, err, isErr } from '../../infra/result.js'
import {
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMChunk,
  type LLMMessage,
  type LLMToolCall,
  type LLMUsage,
  type ContentBlock,
  type ProviderOptions,
  parseSSE,
} from './types.js'
import { LLMError, errorCodeFromStatus, parseRetryAfter } from './errors.js'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

// ==================== Content conversion ====================

function mapContent(content: string | ContentBlock[]): unknown {
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.media_type, data: block.data },
      }
    }
    // audio, file → Anthropic document source
    return {
      type: 'document',
      source: { type: 'base64', media_type: block.media_type, data: block.data },
    }
  })
}

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

// ==================== Request building ====================

/** LLMRequest → тело запроса Anthropic Messages. System извлекается отдельно. */
export function toAnthropicRequest(
  req: LLMRequest,
  defaults: Partial<ProviderOptions> = {},
): Record<string, unknown> {
  const systemParts: string[] = []
  const messages: unknown[] = []

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : extractText(msg.content))
      continue
    }
    if (msg.role === 'tool') {
      // tool result → user message с tool_result content block
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : extractText(msg.content),
        }],
      })
      continue
    }
    if (msg.role === 'assistant') {
      const content: unknown[] = []
      if (typeof msg.content === 'string' && msg.content) {
        content.push({ type: 'text', text: msg.content })
      } else if (Array.isArray(msg.content)) {
        content.push(...(mapContent(msg.content) as unknown[]))
      }
      messages.push({ role: 'assistant', content: content.length ? content : '' })
      continue
    }
    // user
    messages.push({ role: 'user', content: mapContent(msg.content) })
  }

  const body: Record<string, unknown> = {
    model: req.model || defaults.defaultModel,
    messages,
    max_tokens: req.max_tokens ?? defaults.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
  }

  if (systemParts.length) body.system = systemParts.join('\n\n')
  if (req.stop_sequences) body.stop_sequences = req.stop_sequences
  if (req.top_p !== undefined) body.top_p = req.top_p
  if (req.stream) body.stream = true

  // Temperature несовместим с thinking
  if (req.temperature !== undefined && !req.thinking?.enabled) {
    body.temperature = req.temperature
  }

  // Thinking
  if (req.thinking?.enabled) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: req.thinking.budget_tokens ?? 10000,
    }
  }

  // Tools
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
  }

  // Tool choice
  if (req.tool_choice !== undefined) {
    if (req.tool_choice === 'auto') body.tool_choice = { type: 'auto' }
    else if (req.tool_choice === 'any') body.tool_choice = { type: 'any' }
    else if (req.tool_choice === 'none') body.tool_choice = { type: 'none' }
    else body.tool_choice = { type: 'tool', name: req.tool_choice.name }
  }

  // Backend-specific pass-through — merged last, wins over standard fields.
  if (req.extra) Object.assign(body, req.extra)

  return body
}

// ==================== Response parsing ====================

/** Тело ответа Anthropic → LLMResponse. */
export function fromAnthropicResponse(data: any): LLMResponse {
  let text = ''
  let thinking = ''
  const toolCalls: LLMToolCall[] = []

  for (const block of data.content ?? []) {
    if (block.type === 'text') text += block.text ?? ''
    else if (block.type === 'thinking') thinking += block.thinking ?? ''
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} })
    }
  }

  const res: LLMResponse = {
    content: text,
    stop_reason: (data.stop_reason as LLMResponse['stop_reason']) ?? 'end_turn',
    model: data.model,
    raw: data,
  }

  if (toolCalls.length) res.tool_calls = toolCalls
  if (thinking) res.thinking = thinking

  if (data.usage) {
    const usage: LLMUsage = {
      input_tokens: data.usage.input_tokens ?? 0,
      output_tokens: data.usage.output_tokens ?? 0,
    }
    if (data.usage.cache_creation_input_tokens) {
      usage.cache_creation_tokens = data.usage.cache_creation_input_tokens
    }
    if (data.usage.cache_read_input_tokens) {
      usage.cache_read_tokens = data.usage.cache_read_input_tokens
    }
    res.usage = usage
  }

  return res
}

// ==================== Error parsing ====================

function parseAnthropicError(status: number, body: string, headers: Record<string, string>): LLMError {
  let message = `Anthropic HTTP ${status}`
  let raw: unknown = body
  try {
    const parsed = JSON.parse(body)
    raw = parsed
    if (parsed?.error?.message) message = parsed.error.message
  } catch { /* keep raw string */ }

  return new LLMError(message, {
    code: errorCodeFromStatus(status),
    status,
    provider: 'anthropic',
    retryAfter: parseRetryAfter(headers['retry-after'] ?? null),
    raw,
  })
}

// ==================== Provider ====================

export function anthropicProvider(opts: ProviderOptions): LLMProvider {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/messages`
  const buildHeaders = (): Record<string, string> => ({
    'x-api-key': opts.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  })

  return {
    async chat(req: LLMRequest): AsyncResult<LLMResponse> {
      const body = toAnthropicRequest({ ...req, stream: false }, opts)
      const httpOpts = { headers: buildHeaders(), timeout: opts.timeout, idleTimeout: opts.idleTimeout }
      const res = await httpPost(url, body, httpOpts)
      if (isErr(res)) return err(new LLMError(res.error.message, { code: 'network', provider: 'anthropic', raw: res.error }))
      if (res.value.status >= 400) {
        return err(parseAnthropicError(res.value.status, res.value.body, res.value.headers))
      }
      const parsed = res.value.json<any>()
      if (isErr(parsed)) return err(new LLMError('Invalid JSON response', { code: 'server', provider: 'anthropic', raw: parsed.error }))
      return ok(fromAnthropicResponse(parsed.value))
    },

    async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
      const body = toAnthropicRequest({ ...req, stream: true }, opts)
      const httpOpts = { headers: buildHeaders(), timeout: opts.timeout, idleTimeout: opts.idleTimeout }
      const streamRes = await httpPostStream(url, body, httpOpts)
      if (isErr(streamRes)) {
        throw new LLMError(streamRes.error.message, { code: 'network', provider: 'anthropic', raw: streamRes.error })
      }

      let inputTokens = 0
      let outputTokens = 0
      let cacheCreation = 0
      let cacheRead = 0

      for await (const data of parseSSE(streamRes.value)) {
        let event: any
        try { event = JSON.parse(data) } catch { continue }

        switch (event.type) {
          case 'message_start':
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens ?? 0
              cacheCreation = event.message.usage.cache_creation_input_tokens ?? 0
              cacheRead = event.message.usage.cache_read_input_tokens ?? 0
            }
            break

          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              yield {
                type: 'tool_call_start',
                tool_call: {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  input: {},
                },
              }
            }
            break

          case 'content_block_delta':
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              yield { type: 'text', text: event.delta.text }
            } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
              yield { type: 'thinking', text: event.delta.thinking }
            } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
              yield { type: 'tool_call_delta', text: event.delta.partial_json }
            }
            break

          case 'message_delta':
            if (event.usage) {
              outputTokens = event.usage.output_tokens ?? 0
            }
            if (event.delta?.stop_reason) {
              const usage: LLMUsage = { input_tokens: inputTokens, output_tokens: outputTokens }
              if (cacheCreation) usage.cache_creation_tokens = cacheCreation
              if (cacheRead) usage.cache_read_tokens = cacheRead
              yield {
                type: 'done',
                stop_reason: event.delta.stop_reason,
                usage,
              }
            }
            break

          case 'message_stop':
            yield { type: 'done' }
            break
        }
      }
    },
  }
}
