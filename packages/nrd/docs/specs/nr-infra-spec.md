# nr-infra — спецификация

**Статус:** черновик 2 (ревью 4.8 учтён).
**Назначение:** лёгкая инфраструктурная библиотека kd. Ноль тяжёлых зависимостей. Базовые примитивы для всех приложений.
**Не описывает:** формат mdd/mdz (nrd-core), тяжёлые провайдеры (отдельные сервисы), оркестрацию (mdz + runz).

---

## 1. Result

Rust-style обработка ошибок. Единая модель для всего IO в nr-infra.

```ts
type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E }

function ok<T>(value: T): Result<T, never>
function err<E = Error>(error: E): Result<never, E>
function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T }
function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E }

type AsyncResult<T, E = Error> = Promise<Result<T, E>>
```

Контракт: **все IO-функции** в nr-infra (http, storage, llm) возвращают `Result`. Предсказуемые ошибки (сеть, диск, невалидный JSON, permission denied) — через `err()`. Баги (null pointer, type error) — throws как обычно.

---

## 2. id

Генерация читаемых уникальных идентификаторов.

```ts
function generateId(length?: number): string
```

Формат: CVCVCV (согласная-гласная). Дефолт: 6 символов → ~300K вариантов. Достаточно для локальных ID (сессии, запросы, логи). Не криптографический.

**Ограничение:** парадокс дней рождения — коллизия вероятна при ~550 одновременных id. Для больших множеств увеличить length (8 → ~11M вариантов). Не для UUID-замены.

---

## 3. http

Fetch-обёртка с retry и timeout. Возвращает Result.

```ts
interface HttpOptions {
  headers?: Record<string, string>
  timeout?: number         // ms, default 30000
  retries?: number         // default 0
  retryDelay?: number      // ms, default 1000
}

function httpGet(url: string, opts?: HttpOptions): AsyncResult<HttpResponse>
function httpPost(url: string, body: unknown, opts?: HttpOptions): AsyncResult<HttpResponse>
function httpPostStream(url: string, body: unknown, opts?: HttpOptions): AsyncResult<ReadableStream<Uint8Array>>

interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
  json<T>(): Result<T>    // Result, не throws — невалидный JSON предсказуем
}
```

Реализация через `globalThis.fetch` (Node 18+, Bun, Deno, браузер). Ноль зависимостей.

Retry: только на network error и 5xx. Не на 4xx (клиентские ошибки не исправятся повтором).

`httpPostStream` — для SSE/стриминга. Возвращает raw ReadableStream, потребитель парсит сам.

---

## 4. storage

Абстракция чтения/записи. Для конфигов, кэша, логов. Все операции через Result.

```ts
interface IStorage {
  read(path: string): AsyncResult<string | undefined>     // ok(undefined) = файла нет, err = диск/права
  write(path: string, content: string): AsyncResult<void>
  exists(path: string): AsyncResult<boolean>
  list(prefix: string): AsyncResult<string[]>
  delete(path: string): AsyncResult<void>
}

function fsStorage(root: string): IStorage
function memoryStorage(): IStorage
```

**Модель ошибок:** `ok(undefined)` при read — файла нет (штатная ситуация). `err(Error)` — permission denied, путь кривой, диск мёртв (инфра-ошибка, текст всегда есть). Без Result `undefined` молчит — нет ни текста ошибки, ни возможности отличить «нет файла» от «нет прав».

`fsStorage` — файловая система, `root` = базовая директория. Пути относительные от root. Авто-создание директорий при write.

`memoryStorage` — in-memory, для тестов.

Контракт: пути всегда с прямым слешем (`config/models.md`), реализация конвертирует под OS. Кодировка — UTF-8.

---

## 5. llm

Два протокола, один интерфейс.

### Типы

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }

interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentBlock[]
}

interface LLMTool {
  name: string
  description: string
  input_schema: Record<string, unknown>   // JSON Schema
}

interface LLMToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

interface LLMRequest {
  model: string
  messages: LLMMessage[]
  max_tokens?: number
  temperature?: number
  tools?: LLMTool[]
  tool_choice?: 'auto' | 'any' | { name: string }
  stream?: boolean
  stop_sequences?: string[]
}

interface LLMResponse {
  content: string
  tool_calls?: LLMToolCall[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage?: { input_tokens: number; output_tokens: number }
}

interface LLMChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'done'
  text?: string
  tool_call?: Partial<LLMToolCall>
  usage?: { input_tokens: number; output_tokens: number }
}
```

### Провайдер

```ts
interface LLMProvider {
  chat(req: LLMRequest): AsyncResult<LLMResponse>
  stream(req: LLMRequest): AsyncIterable<LLMChunk>
}

interface ProviderOptions {
  baseUrl: string
  apiKey: string
  defaultModel?: string
  defaultMaxTokens?: number
}

function openaiProvider(opts: ProviderOptions): LLMProvider
function anthropicProvider(opts: ProviderOptions): LLMProvider
```

### stream() — модель ошибок

`stream()` возвращает `AsyncIterable`, не `AsyncResult<AsyncIterable>`. Ошибки старта стрима (auth 401, rate limit 429, network) прилетают как **throws из первого вызова итератора** (первый `next()`). Это асимметрично с `chat()` (Result), но стандартно для async iterators — ошибки всплывают через `for await...of` catch.

### openaiProvider

Маппит LLMRequest → OpenAI Chat Completions format. Ходит через `httpPost`/`httpPostStream`.

Покрывает: OpenAI API, OpenRouter, Ollama, любой OpenAI-compatible endpoint. Разница — только URL и ключ.

Vision: `ContentBlock type image` → `{ type: 'image_url', image_url: { url: 'data:{media_type};base64,{data}' } }`.

### anthropicProvider

Маппит LLMRequest → Anthropic Messages format. System message извлекается из messages[] в отдельное поле `system`.

Покрывает: Anthropic API, claude-sub-proxy, любой Anthropic-compatible endpoint.

Vision: `ContentBlock type image` → `{ type: 'image', source: { type: 'base64', media_type, data } }`.

### Что НЕ в провайдерах

- Кэширование — слой выше (app/middleware)
- Rate limiting — слой выше или прокси-сервис
- Балансировка — слой выше
- Subscription/SDK провайдеры — отдельные прокси-сервисы
- Retry LLM-запросов — через httpPost retry, не отдельная логика

---

## 6. Include-резолвер

Стыковка между nrd-core `resolveIncludes(text, callback)` и файловой системой. Три слоя:

```
nrd-core.resolveIncludes(text, callback)     ← механика подстановки, рекурсия, циклы, #section
  ↑ колбэк = (ref) => resolver.resolve(ref)
IncludeResolver                               ← стратегия поиска (vault-рут, расширения, пути)
  ↓ использует
IStorage.read(path)                           ← тупое чтение байтов
```

**Разделение:** `#section`-вырезка — в nrd-core (`extractSection`, уже есть). Резолвер не знает формат, только находит файл.

```ts
interface IncludeResolver {
  resolve(ref: string, fromPath?: string): Promise<string | undefined>
}

function fileIncludeResolver(opts: {
  storage: IStorage
  roots?: string[]              // корневые директории для поиска
  rootMarkers?: string[]        // ['.obsidian', '.runz'] — поиск рута вверх по дереву
  extensions?: string[]         // ['.md', '.mdd', '.mdz'] — автодобавление расширения
}): IncludeResolver
```

**Стратегия поиска fileIncludeResolver:**
1. Если `ref` — абсолютный путь → читать напрямую
2. Если `fromPath` задан → искать относительно директории файла-источника
3. Искать в `roots[]`
4. Если `rootMarkers` заданы → искать маркер вверх по дереву от fromPath, использовать как root
5. Пробовать с каждым из `extensions[]` если ref без расширения
6. Не нашли → undefined

`fromPath` — путь файла, из которого идёт include. Передаётся nrd-core при рекурсии.

**Web-резолвер (потом, тот же интерфейс):**
```ts
// function httpIncludeResolver(opts: { baseUrl: string, http: typeof httpGet }): IncludeResolver
```

---

## 7. Структура пакета

```
@kerneldreams/nrd/web
  src/
    result.ts      — Result type + ok/err/isOk/isErr
    id.ts          — generateId
    http.ts        — httpGet/httpPost/httpPostStream
    storage.ts     — IStorage + fsStorage + memoryStorage
    include.ts     — IncludeResolver + fileIncludeResolver
    llm/
      types.ts     — LLMMessage, LLMRequest, LLMResponse, LLMChunk, LLMProvider
      openai.ts    — openaiProvider
      anthropic.ts — anthropicProvider
    index.ts       — re-exports
```

Ноль рантайм-зависимостей. Только `globalThis.fetch` (Node 18+).

---

## 8. Что НЕ в этой спеке

- Формат mdd/mdz (nrd-core)
- Оркестрация (mdz + runz apps)
- Тяжёлые провайдеры (SDK, subscription — прокси-сервисы)
- JSON Schema / валидация (nrd-core Спека 3)
- DI контейнер (не нужен)
- format/token counting (llm-утилита, отдельно)
- ngen (отдельно)
