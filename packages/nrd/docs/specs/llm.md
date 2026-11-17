# @kerneldreams/nrd/web — LLM

Единый интерфейс для LLM-провайдеров. Два встроенных адаптера (OpenAI, Anthropic), расширяемый через `LLMProvider` интерфейс.

## Архитектура

Провайдер — фабричная функция, принимает `ProviderOptions`, возвращает `LLMProvider`. Конфиг запечатан при создании; на каждый вызов передаётся только `LLMRequest`. Ошибки — через `Result<T, Error>` для `chat()`, через `throw` для `stream()`.

```
ProviderOptions → openaiProvider() → LLMProvider { chat(), stream() }
                  anthropicProvider()
```

Провайдер не знает о роутинге, retry, алиасах — это слой выше (llm-gate, @kerneldreams/runz-runtime/llm).

## Типы

### ContentBlock

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }   // base64
  | { type: 'audio'; media_type: string; data: string }   // base64
  | { type: 'file'; media_type: string; data: string }    // base64
```

`image` маппится в Anthropic `image` source, OpenAI `image_url` (data-URL). `audio`/`file` → Anthropic `document` source, OpenAI `image_url` (data-URL).

### LLMMessage

```ts
interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  tool_call_id?: string   // для role: 'tool'
  name?: string           // для role: 'tool'
}
```

`tool` role — результат вызова инструмента. При конвертации:
- OpenAI: отправляется as-is (`role: 'tool'`, `tool_call_id`)
- Anthropic: конвертируется в `role: 'user'` с `tool_result` content block

### LLMRequest

```ts
interface LLMRequest {
  model: string
  messages: LLMMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  tools?: LLMTool[]
  tool_choice?: 'auto' | 'any' | 'none' | { name: string }
  stream?: boolean
  stop_sequences?: string[]
  thinking?: ThinkingConfig     // extended thinking
  effort?: string               // 'low' | 'medium' | 'high'
}

interface ThinkingConfig {
  enabled: boolean
  budget_tokens?: number        // 1024–128000
}
```

`thinking` — extended thinking (Anthropic), thinkingConfig (Gemini). При включённом thinking `temperature` игнорируется (Anthropic ограничение). `effort` — Claude Code effort level.

`tool_choice` маппинг:
- `'any'` → OpenAI `'required'`, Anthropic `{type: 'any'}`
- `'none'` → OpenAI `'none'`, Anthropic `{type: 'none'}`
- `{name}` → OpenAI `{type: 'function', function: {name}}`, Anthropic `{type: 'tool', name}`

### LLMResponse

```ts
interface LLMResponse {
  content: string
  tool_calls?: LLMToolCall[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage?: LLMUsage
  model?: string          // реальная модель (может отличаться от запрошенной)
  thinking?: string       // thinking content
  raw?: unknown           // оригинальный ответ (для дебага)
}

interface LLMUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_tokens?: number   // Anthropic prompt caching
  cache_read_tokens?: number
  thinking_tokens?: number
}
```

### LLMChunk (streaming)

```ts
interface LLMChunk {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_delta' | 'done'
  text?: string
  tool_call?: Partial<LLMToolCall>
  usage?: LLMUsage
  stop_reason?: LLMResponse['stop_reason']
}
```

Стрим-события:
- `text` — фрагмент текста
- `thinking` — фрагмент thinking content
- `tool_call_start` — начало tool call (id, name)
- `tool_call_delta` — фрагмент JSON-аргументов tool call
- `done` — конец стрима (stop_reason, usage)

### LLMError

```ts
class LLMError extends Error {
  readonly code: LLMErrorCode
  readonly status?: number
  readonly retryAfter?: number
  readonly provider?: string
  readonly raw?: unknown
}

type LLMErrorCode = 'rate_limit' | 'auth' | 'invalid_request' | 'server' | 'timeout' | 'network'
```

Extends `Error` — проходит через `Result<T, Error>` прозрачно. Кто хочет структуру — `instanceof LLMError`.

Маппинг HTTP статусов: 429 → `rate_limit`, 401/403 → `auth`, 4xx → `invalid_request`, 5xx → `server`.

## Провайдеры

### openaiProvider(opts)

OpenAI Chat Completions формат. Покрывает: OpenAI, OpenRouter, Ollama, любой compatible.

```ts
const p = openaiProvider({
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-...',
})
const r = await p.chat({ model: 'google/gemini-2.5-flash', messages: [...] })
```

Endpoint: `${baseUrl}/chat/completions`. Auth: `Authorization: Bearer ${apiKey}`.

### anthropicProvider(opts)

Anthropic Messages API. Полная поддержка: thinking blocks, cache_control, tool_use.

```ts
const p = anthropicProvider({
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-...',
})
```

Endpoint: `${baseUrl}/messages`. Auth: `x-api-key`. API version: `2023-06-01`.

Конвертации:
- System messages → `system` parameter (объединяются через `\n\n`)
- Tool messages → `user` + `tool_result` content block
- `thinking.enabled` → `thinking: {type: 'enabled', budget_tokens}`
- Cache metrics из usage → `cache_creation_tokens`, `cache_read_tokens`

### ProviderOptions

```ts
interface ProviderOptions {
  baseUrl: string
  apiKey: string
  defaultModel?: string
  defaultMaxTokens?: number
  headers?: Record<string, string>   // доп. заголовки
  timeout?: number                    // ms
}
```

`headers` — кастомные заголовки для subscription провайдеров (Codex originator, Grok metadata). Мержатся с обязательными.

## Утилиты

```ts
parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string>
```
Разбивает SSE-стрим на строки `data: ...`. Буферизация, trim, пропуск не-data строк.

```ts
toOpenAIRequest(req, defaults?): Record<string, unknown>
fromOpenAIResponse(data): LLMResponse
toAnthropicRequest(req, defaults?): Record<string, unknown>
fromAnthropicResponse(data): LLMResponse
```
Экспортированы отдельно — можно использовать напрямую без провайдера (например, для batch API или кастомного транспорта).

```ts
parseRetryAfter(header: string | null): number | undefined
errorCodeFromStatus(status: number): LLMErrorCode
```
