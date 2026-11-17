import { describe, it, expect, vi, afterEach } from 'vitest'
import { toOpenAIRequest, fromOpenAIResponse, openaiProvider } from '../../src/web/llm/openai.js'
import { toAnthropicRequest, fromAnthropicResponse, anthropicProvider } from '../../src/web/llm/anthropic.js'
import { type LLMRequest } from '../../src/web/llm/types.js'
import { isOk } from '../../src/infra/result.js'

afterEach(() => vi.restoreAllMocks())

function mockResponse(status: number, body: string) {
  return {
    status,
    headers: new Headers(),
    text: async () => body,
  } as unknown as Response
}

const base: LLMRequest = {
  model: 'gpt-x',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ],
  max_tokens: 100,
  temperature: 0.5,
}

describe('OpenAI mapping', () => {
  it('базовый запрос: system остаётся сообщением', () => {
    const b = toOpenAIRequest(base) as any
    expect(b.model).toBe('gpt-x')
    expect(b.messages).toHaveLength(2)
    expect(b.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(b.max_tokens).toBe(100)
    expect(b.temperature).toBe(0.5)
  })

  it('vision: image → image_url с data-URL', () => {
    const req: LLMRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', media_type: 'image/png', data: 'BASE64' },
          ],
        },
      ],
    }
    const b = toOpenAIRequest(req) as any
    const content = b.messages[0].content
    expect(content[0]).toEqual({ type: 'text', text: 'what is this' })
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,BASE64' },
    })
  })

  it('tools → function format, tool_choice any → required', () => {
    const req: LLMRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'get', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: 'any',
    }
    const b = toOpenAIRequest(req) as any
    expect(b.tools[0]).toEqual({
      type: 'function',
      function: { name: 'get', description: 'd', parameters: { type: 'object' } },
    })
    expect(b.tool_choice).toBe('required')
  })

  it('fromOpenAIResponse: текст + finish_reason + usage', () => {
    const res = fromOpenAIResponse({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    })
    expect(res.content).toBe('hello')
    expect(res.stop_reason).toBe('end_turn')
    expect(res.usage).toEqual({ input_tokens: 5, output_tokens: 3 })
  })

  it('fromOpenAIResponse: reasoning (nano-gpt GLM) — тоже thinking (ABC-305)', () => {
    expect(fromOpenAIResponse({ choices: [{ message: { content: 'ok', reasoning: 'думаю' }, finish_reason: 'stop' }] }).thinking).toBe('думаю')
    expect(fromOpenAIResponse({ choices: [{ message: { content: 'ok', reasoning_content: 'а' } }] }).thinking).toBe('а')
    expect(fromOpenAIResponse({ choices: [{ message: { content: 'ok' } }] }).thinking).toBeUndefined()
  })

  it('fromOpenAIResponse: tool_calls парсятся', () => {
    const res = fromOpenAIResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 't1', function: { name: 'get', arguments: '{"a":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    expect(res.stop_reason).toBe('tool_use')
    expect(res.tool_calls?.[0]).toEqual({ id: 't1', name: 'get', input: { a: 1 } })
  })

  it('chat() через мок fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(200, JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })),
      ),
    )
    const p = openaiProvider({ baseUrl: 'http://api/v1', apiKey: 'k' })
    const r = await p.chat(base)
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value.content).toBe('ok')
  })
})

describe('Anthropic mapping', () => {
  it('system извлекается в отдельное поле', () => {
    const b = toAnthropicRequest(base) as any
    expect(b.system).toBe('be brief')
    expect(b.messages).toHaveLength(1)
    expect(b.messages[0].role).toBe('user')
    expect(b.max_tokens).toBe(100)
  })

  it('max_tokens обязателен — дефолт если не задан', () => {
    const b = toAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) as any
    expect(typeof b.max_tokens).toBe('number')
    expect(b.max_tokens).toBeGreaterThan(0)
  })

  it('vision: image → source base64', () => {
    const req: LLMRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', media_type: 'image/jpeg', data: 'B64' },
          ],
        },
      ],
    }
    const b = toAnthropicRequest(req) as any
    expect(b.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'B64' },
    })
  })

  it('tools и tool_choice any → {type:any}', () => {
    const req: LLMRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'get', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: 'any',
    }
    const b = toAnthropicRequest(req) as any
    expect(b.tools[0]).toEqual({ name: 'get', description: 'd', input_schema: { type: 'object' } })
    expect(b.tool_choice).toEqual({ type: 'any' })
  })

  it('fromAnthropicResponse: текст + tool_use + usage', () => {
    const res = fromAnthropicResponse({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'u1', name: 'get', input: { a: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 2 },
    })
    expect(res.content).toBe('hi')
    expect(res.tool_calls?.[0]).toEqual({ id: 'u1', name: 'get', input: { a: 1 } })
    expect(res.stop_reason).toBe('tool_use')
    expect(res.usage).toEqual({ input_tokens: 7, output_tokens: 2 })
  })

  it('chat() через мок fetch с правильными заголовками', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(200, JSON.stringify({ content: [{ type: 'text', text: 'yo' }], stop_reason: 'end_turn' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const p = anthropicProvider({ baseUrl: 'http://api', apiKey: 'secret' })
    const r = await p.chat(base)
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value.content).toBe('yo')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('secret')
    expect(headers['anthropic-version']).toBeDefined()
  })
})


// ==================== New functionality tests ====================

import { LLMError, errorCodeFromStatus, parseRetryAfter } from '../../src/web/llm/errors.js'

describe('LLMError', () => {
  it('extends Error — проходит через Result<T, Error>', () => {
    const e = new LLMError('rate limited', { code: 'rate_limit', status: 429, provider: 'anthropic' })
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(LLMError)
    expect(e.code).toBe('rate_limit')
    expect(e.status).toBe(429)
    expect(e.provider).toBe('anthropic')
    expect(e.name).toBe('LLMError')
  })

  it('errorCodeFromStatus', () => {
    expect(errorCodeFromStatus(429)).toBe('rate_limit')
    expect(errorCodeFromStatus(401)).toBe('auth')
    expect(errorCodeFromStatus(403)).toBe('auth')
    expect(errorCodeFromStatus(400)).toBe('invalid_request')
    expect(errorCodeFromStatus(500)).toBe('server')
    expect(errorCodeFromStatus(502)).toBe('server')
  })

  it('parseRetryAfter: число', () => {
    expect(parseRetryAfter('30')).toBe(30)
  })

  it('parseRetryAfter: null', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})

describe('Tool messages', () => {
  it('OpenAI: tool role → tool message с tool_call_id', () => {
    const req: LLMRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: 'search for cats' },
        { role: 'tool', content: '{"results": ["cat1"]}', tool_call_id: 'call_123', name: 'search' },
      ],
    }
    const b = toOpenAIRequest(req) as any
    expect(b.messages[1]).toEqual({
      role: 'tool',
      content: '{"results": ["cat1"]}',
      tool_call_id: 'call_123',
    })
  })

  it('Anthropic: tool role → user message с tool_result', () => {
    const req: LLMRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: 'search' },
        { role: 'tool', content: 'found it', tool_call_id: 'call_1' },
      ],
    }
    const b = toAnthropicRequest(req) as any
    expect(b.messages[1].role).toBe('user')
    expect(b.messages[1].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: 'found it',
    })
  })
})

describe('Thinking', () => {
  it('Anthropic: thinking.enabled → thinking block в запросе', () => {
    const req: LLMRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'think hard' }],
      thinking: { enabled: true, budget_tokens: 5000 },
    }
    const b = toAnthropicRequest(req) as any
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 })
    // temperature не должен быть при thinking
    expect(b.temperature).toBeUndefined()
  })

  it('Anthropic: thinking в ответе парсится', () => {
    const res = fromAnthropicResponse({
      content: [
        { type: 'thinking', thinking: 'let me think...' },
        { type: 'text', text: 'the answer is 42' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'claude-sonnet-4-6',
    })
    expect(res.thinking).toBe('let me think...')
    expect(res.content).toBe('the answer is 42')
    expect(res.model).toBe('claude-sonnet-4-6')
  })
})

describe('Extended usage', () => {
  it('Anthropic: cache metrics парсятся', () => {
    const res = fromAnthropicResponse({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 800,
      },
    })
    expect(res.usage?.cache_creation_tokens).toBe(1000)
    expect(res.usage?.cache_read_tokens).toBe(800)
  })
})

describe('tool_choice none', () => {
  it('OpenAI: none → none', () => {
    const req: LLMRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tool_choice: 'none',
    }
    const b = toOpenAIRequest(req) as any
    expect(b.tool_choice).toBe('none')
  })

  it('Anthropic: none → {type: none}', () => {
    const req: LLMRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tool_choice: 'none',
    }
    const b = toAnthropicRequest(req) as any
    expect(b.tool_choice).toEqual({ type: 'none' })
  })
})

describe('ProviderOptions headers', () => {
  it('OpenAI: кастомные headers передаются', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(200, JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const p = openaiProvider({ baseUrl: 'http://api/v1', apiKey: 'k', headers: { 'X-Custom': 'val' } })
    await p.chat(base)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('val')
  })
})

describe('OpenAI stream usage (ABC-55)', () => {
  function sseResponse(frames: unknown[]): Response {
    const text = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')
    return new Response(new Blob([text]).stream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  it('стрим просит include_usage, non-stream — нет', () => {
    expect((toOpenAIRequest({ ...base, stream: true }) as any).stream_options).toEqual({ include_usage: true })
    expect((toOpenAIRequest(base) as any).stream_options).toBeUndefined()
  })

  it('extra перекрывает stream_options (сервер без поддержки флага)', () => {
    const b = toOpenAIRequest({ ...base, stream: true, extra: { stream_options: undefined } }) as any
    expect(b.stream_options).toBeUndefined()
  })

  it('llama-server: usage отдельным кадром после finish доезжает до done-чанка', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { choices: [{ index: 0, delta: { content: 'hi' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 14 } },
        { choices: [], usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 } },
        '[DONE]',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const p = openaiProvider({ baseUrl: 'http://api/v1', apiKey: 'k' })
    const chunks = []
    for await (const c of p.stream(base)) chunks.push(c)

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.stream_options).toEqual({ include_usage: true })
    const usage = chunks.filter((c) => c.type === 'done' && c.usage).map((c) => c.usage)
    expect(usage).toEqual([{ input_tokens: 14, output_tokens: 5 }])
  })
})
