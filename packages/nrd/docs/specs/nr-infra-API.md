# @kerneldreams/nrd/web

## main
Result<T, E = Error> = | { ok: true; value: T } | { ok: false; error: E }
AsyncResult<T, E = Error> = Promise<Result<T, E>>
ok<T>(value: T): Result<T, never>
> Успешный результат.
err<E = Error>(error: E): Result<never, E>
> Результат с ошибкой.
isOk<T, E>(r: Result<T, E>): boolean
> Type guard: результат успешен.
isErr<T, E>(r: Result<T, E>): boolean
> Type guard: результат — ошибка.
generateId(length?: number): string
> Сгенерировать id длиной `length` (дефолт 6). Чётные позиции — согласные,
нечётные — гласные.
HttpOptions { headers?, timeout?, retries?, retryDelay? }
HttpResponse { status, headers, body, json }
httpGet(url: string, opts?: HttpOptions): AsyncResult<HttpResponse>
> GET-запрос.
httpPost(url: string, body: unknown, opts?: HttpOptions): AsyncResult<HttpResponse>
> POST-запрос. Объект body сериализуется в JSON.
httpPostStream(url: string, body: unknown, opts?: HttpOptions): AsyncResult<ReadableStream<Uint8Array<ArrayBufferLike>>>
> POST со стримом ответа — для SSE/стриминга. Возвращает raw ReadableStream,
потребитель парсит сам. Статус >= 400 трактуется как err.
IStorage { read, write, exists, list, delete }
fsStorage(root: string): IStorage
> Файловое хранилище. `root` — базовая директория, пути относительные от root.
Авто-создание директорий при write.
memoryStorage(): IStorage
> In-memory хранилище, для тестов.
ExecOptions { cwd?, env?, timeout?, shell?, input? }
ExecResult { stdout, stderr, code }
ExecError {  }
> Ошибка исполнения. Несёт `result` — `ExecResult` доступен и на провале
(ненулевой код / spawn-ошибка / таймаут), не только на успехе.
execShell(cmd: string, opts?: ExecOptions): AsyncResult<ExecResult, ExecError>
> Выполнить shell-команду. `child_process.spawn` с оболочкой по умолчанию
(команда — строка для шелла). Ноль зависимостей.
runFile(path: string, args?: string[], opts?: ExecOptions): AsyncResult<ExecResult, ExecError>
> Запустить файл: `node <path> args`. Без оболочки по умолчанию —
node вызывается напрямую (честные аргументы, без шелл-экранирования).
IncludeResolver { resolve }
fileIncludeResolver(opts: { storage: IStorage; roots?: string[] | undefined; rootMarkers?: string[] | undefined; extensions?: string[] | undefined; }): IncludeResolver
ContentBlock = | { type: 'text'; text: string } | { type: 'image'; media_type: string; data: string } | { type: 'audio'; media_type: string; data: string } | { type: 'file'; media_type: string; data: string }
LLMMessage { role, content, tool_call_id?, name? }
LLMTool { name, description, input_schema }
LLMToolCall { id, name, input }
LLMRequest { model, messages, max_tokens?, temperature?, top_p?, frequency_penalty?, presence_penalty?, tools?, tool_choice?, stream?, stop_sequences?, thinking?, effort? }
LLMResponse { content, tool_calls?, stop_reason, usage?, model?, thinking?, raw? }
LLMChunk { type, text?, tool_call?, usage?, stop_reason? }
LLMUsage { input_tokens, output_tokens, cache_creation_tokens?, cache_read_tokens?, thinking_tokens? }
LLMProvider { chat, stream }
ProviderOptions { baseUrl, apiKey, defaultModel?, defaultMaxTokens?, headers?, timeout? }
ThinkingConfig { enabled, budget_tokens? }
parseSSE(stream: ReadableStream<Uint8Array<ArrayBufferLike>>): AsyncGenerator<string, void, unknown>
> Разбить SSE-стрим ReadableStream на строки `data: ...`.
LLMError {  }
> Структурированная ошибка LLM. Extends Error — проходит через
Result<T, Error> прозрачно; кто хочет подробности — instanceof LLMError.
LLMErrorCode = | 'rate_limit' | 'auth' | 'invalid_request' | 'server' | 'timeout' | 'network'
parseRetryAfter(header: string | null): number | undefined
> Парсинг Retry-After: число (секунды) или HTTP-date.
errorCodeFromStatus(status: number): LLMErrorCode
> Определить LLMErrorCode по HTTP-статусу.
openaiProvider(opts: ProviderOptions): LLMProvider
toOpenAIRequest(req: LLMRequest, defaults?: Partial<ProviderOptions>): Record<string, unknown>
> LLMRequest → тело запроса OpenAI Chat Completions.
fromOpenAIResponse(data: any): LLMResponse
> Тело ответа OpenAI → LLMResponse.
anthropicProvider(opts: ProviderOptions): LLMProvider
toAnthropicRequest(req: LLMRequest, defaults?: Partial<ProviderOptions>): Record<string, unknown>
> LLMRequest → тело запроса Anthropic Messages. System извлекается отдельно.
fromAnthropicResponse(data: any): LLMResponse
> Тело ответа Anthropic → LLMResponse.