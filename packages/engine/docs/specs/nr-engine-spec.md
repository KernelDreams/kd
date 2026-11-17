# nr-engine — LLM Execution Pipeline

**Статус:** спека v1 — частично заменена ампутацией sessions/ (18.07.2026).
**Зависимости:** `@kerneldreams/nrd` (+ subpath `/web`, `/node`), `@kerneldreams/chat-store`

> **sessions/ ампутирован → хранение в nr-chat-store.**
> `ISession`/`IEditableSession`/`ISessionManager`/`MessageDTO`/`SessionConfig` и
> `FileSession`/`MemorySession` **удалены**. Движок — чистая генерация; хранение
> отдаёт `SessionStore` из `@kerneldreams/chat-store`, который приходит в
> `run()` через `RunInput.target = { store | storeName, sessionId }`.
> Словарь движка — модель стора (`Message`/`Part`/`MessageFlags`), не nrd-core.
> Три подменяемых интерфейса: `IAssembler`, `IOrchestrator`, `IHandler`.
> Секции §2 (граф), §3.1, §4 (`$store`/`$path` вместо `$session`), §7
> (session-management → стор), §8.2 (`scope`/события несут модельный `Message`)
> читать через призму этой ампутации. **Канон:**
> `S:\skills\nr-system.dev\specs\nr-engine-store-migration-spec.md` (вариант A, закрыт).
**Расположение:** `S:\nrlib\nr-engine`

## 1. Назначение

Пайплайн "собрать промпт → отправить в LLM → обработать ответ".

Универсальный движок для: чат-ботов, переводчиков, коммит-генераторов, оркестраторов, авто-тестов, агентов — любой задачи где нужно вызвать LLM и что-то сделать с ответом.

**nr-engine НЕ знает:** откуда данные (nrd-context), как рендерить шаблоны (ntpl), как делать HTTP (nr-infra). Он оркестрирует вызовы между ними.

**nr-engine знает:** ISession, IAssembler, IOrchestrator, IHandler. Четыре интерфейса, всё подменяемо.

## 2. Архитектура

```
потребитель (chat3, commit, translate, bot-server)
     │
     ▼
  run(config)                      ← entry point
     │
     ├─ resolveSession(config)     → ISession
     ├─ resolveAssembler(config)   → IAssembler
     ├─ resolveOrchestrator(config)→ IOrchestrator
     ├─ resolveHandler(config)     → IHandler
     │
     ▼
  ISession.getMessages()
     │
     ▼
  IAssembler.render(messages, context) → LLMMessage[]
     │
     ▼
  IOrchestrator.execute(messages, provider)
     │  ← tool loop, retry, hooks
     ▼
  EngineResponse
     │
     ▼
  IHandler.handle(response, session) → result
```

## 3. Интерфейсы

### 3.1 ~~ISession~~ → SessionStore (ампутирован)

**Удалено.** Хранение больше не интерфейс движка: `run()` получает готовый
`SessionStore` из `@kerneldreams/chat-store` через `RunInput.target`:

```typescript
interface RunTarget {
  store?: SessionStore   // готовый инстанс, ЛИБО
  storeName?: string     //   имя из реестра + storeOpts (резолвит движок)
  storeOpts?: unknown
  sessionId: string
}
```

Движок: `store.load(sessionId)` → `toHistory(model)` (активный путь) → фильтр
`flags.hidden` → assembly. Запись ответа — `appendNode` **id-first** (id
ассистентской ноды генерится до записи, едет в `done`-событии, совпадает с id
записи). Свайпы/regenerate — вне движка (`appendNode(parent=sibling)` +
`setActiveLeaf` на стороне потребителя). Одноразовые задачи (translate/extract)
берут in-process `./memory`-драйвер вместо бывшего `MemorySession`.

<details><summary>Историческое: ISession v1 (удалён)</summary>

```typescript
interface ISession {
  readonly config: SessionConfig

  getAllMessages(): Message[]
  getMessages(): Message[]
  last(): Message | undefined
  appendMessage(role: string, content: string, attrs?: Record<string, Value>): string
  removeLast(role: string): Message | undefined
}

/** Full — для чата, RP, UI. Extends ISession. */
interface IEditableSession extends ISession {
  // --- identity ---
  getById(id: string): Message | undefined
  ensureId(m: Message): string

  // --- правки ---
  edit(id: string, content: string, ifHash?: string): boolean
  delete(id: string): boolean

  // --- флаги ---
  hide(id: string): void
  unhide(id: string): void
  setInjected(id: string, value: boolean): void

  // --- свайпы ---
  addSwipe(id: string, content: string): number
  switchSwipe(id: string, index: number): void
  getSwipes(id: string): Message[]

  // --- sync ---
  version(): string
}
```
</details>

Соответствие в store-модели: identity → `Message.id` / `StoreNode.parent`;
флаги (§3.1.2) → `MessageFlags {hidden, frozen, injected}`; version (§3.1.3) →
`store.version(sid)`; свайпы → `swipeInfo`/`setActiveLeaf`. Ниже §3.1.1–3.1.3
описывают модель, действующую и в сторе (термины `.mds`/FileSession —
исторические).

#### 3.1.1 Message Identity

Сообщение адресуется **opaque string id**. UI не знает что внутри.

**Два класса id:**
- **Эфемерный** — для простых сообщений без `$id` в .mds. Позиционный хэндл, генерируется на лету (напр. `"pos:3"`). Меняется при структурных операциях (delete/insert) → UI перечитывает. Не персистится в файле — .mds остаётся чистым.
- **Стабильный** — для свайп-слотов. Хранимый `$id: weruka` в .mds. Переживает структурные операции. Создаётся лениво при первом свайпе.

UI не различает эти два класса — для него оба `id: string`. Бэк знает, какой из них.

#### 3.1.2 Два пространства видимости

| Флаг | UI видит | LLM видит | Кто ставит |
|------|----------|-----------|------------|
| (без флагов) | да | да | — |
| `$hidden` | да | нет | юзер |
| `$injected` | нет | да | промт-билдер |
| `$frozen` | да | всегда | юзер |

- `$hidden` — OOC заметки, дебаг. В UI видно (серым/зачёркнуто), LLM не видит.
- `$injected` — системные сообщения от промт-билдера (карточка, лорбук). LLM видит, UI не показывает.
- `$frozen` — всегда в контексте, никогда не trimmed. Видно и UI, и LLM.

#### 3.1.3 Version token

`version()` возвращает непрозрачную строку — xxh64 от max-mtime dep-set'а (для FileSession: mds файл + referenced includes).

Потребитель (UI, адаптер) передаёт `version` с каждым запросом. Бэк сравнивает:
- совпадает → возвращает только результат операции
- не совпадает → результат + полный скоуп (перечитай)

Conditional request — часть каждой операции, не отдельный endpoint.

**Реализации:**

| Имя | Интерфейс | Хранение | Когда |
|-----|-----------|----------|-------|
| `FileSession` | IEditableSession | mds файл, хирургические записи | chat, RP, долгие сессии |
| `MemorySession` | ISession | в памяти, без persist | commit, translate, одноразовые |
| `RemoteSession` | IEditableSession | API площадки | интеграция с площадкой (внешний модуль) |

`MemorySession` — ключевой для не-чат потребителей. commit не нужен файл — промпт собрался, ответ получен, использован, забыт.

### 3.2 IAssembler — сборка промпта

```typescript
interface IAssembler {
  /** Async — шаблон может загружаться по сети, buildContext внутри async. */
  render(messages: Message[], context: IContext): Promise<LLMMessage[]>
}
```

> **Message** — тип из `@kerneldreams/nrd` (`parseMessages()`): `{ role, attrs, blocks: ContentBlock[] }`.
> ISession оперирует этим же типом. FileSession парсит mds → Message[]. MemorySession строит в памяти.

**Реализации:**

| Имя | Стратегия | Когда |
|-----|-----------|-------|
| `DirectAssembler` | Хардкод: system → history → post | Простые случаи, MVP |
| `NtplAssembler` | ntpl шаблон через nrd-context | Полный контроль layout |

`NtplAssembler`:
```typescript
class NtplAssembler implements IAssembler {
  constructor(private templatePath: string) {}

  render(messages: Message[], context: IContext): LLMMessage[] {
    const template = readFileSync(this.templatePath, 'utf-8')
    const { nrdBlock, body } = extractNrd(template)

    // Добавить messages в контекст
    const fullCtx = chainContext(
      objectContext({ messages }),
      context
    )

    const env = createEnv([dirname(this.templatePath)])
    const rendered = render(env, body, fullCtx)

    // Выход шаблона — %role поток → parseMessages()
    return parseMessages(rendered, '$').map(msgToLLM)
  }
}
```

### 3.3 IOrchestrator — управление вызовами

```typescript
interface IOrchestrator {
  execute(
    messages: LLMMessage[],
    provider: LLMProvider,
    hooks: OrchestratorHook[]
  ): Promise<EngineResponse>

  /** Прервать текущую генерацию. Частичный ответ отбрасывается.
   *  Механика зависит от транспорта:
   *  - CLI: адаптер убивает child process по PID
   *  - Server/in-process: abort() на orchestrator instance
   *  - В обоих случаях стрим получает {type:'cancelled'} */
  abort(): void
}

interface OrchestratorHook {
  beforeRequest?(req: LLMRequest): LLMRequest | Promise<LLMRequest>
  afterResponse?(res: EngineResponse): EngineResponse | Promise<EngineResponse>
  handleToolUse?(call: ToolCall): Promise<ToolResult>
  /** Typed stream events (not raw text). */
  onEvent?(event: StreamEvent): void
}

/** Structured stream events — UI-safe, typed. */
type StreamEvent =
  | { type: 'delta', text: string }
  | { type: 'thinking_delta', text: string }
  | { type: 'tool_use', name: string, id: string, input: unknown }
  | { type: 'tool_result', id: string, content: unknown, error?: string }
  | { type: 'done', message: MessageDTO, version: string, usage?: { input: number, output: number } }
  | { type: 'error', message: string, code?: string }
  | { type: 'cancelled', version: string }
  | { type: 'user_appended', message: MessageDTO }

/** DTO for UI — what the frontend sees. */
interface MessageDTO {
  id: string
  role: string
  name?: string              // speaker name (group chats, multi-character)
  content: string           // text blocks joined
  hidden: boolean
  frozen: boolean
  injected: boolean
  hash?: string             // xxh64, for edit precondition
  swipes?: { active: number, count: number }
  blocks?: ContentBlock[]   // full typed blocks if UI needs them
}

/** Результат оркестрации. НЕ путать с LLMResponse из nr-infra. */
interface EngineResponse {
  content: ContentBlock[]   // text, thinking, tool_use — typed blocks
  stopReason: string        // 'end_turn' | 'tool_use' | 'max_tokens'
  usage?: { input: number, output: number }
}
```

**Реализации:**

| Имя | Поведение | Когда |
|-----|-----------|-------|
| `SimpleOrchestrator` | Один вызов, без tool loop | commit, translate |
| `AgentOrchestrator` | Tool loop до end_turn или лимита | агенты, chat с tools |

`SimpleOrchestrator` — отправил, получил, вернул. Без цикла.

`AgentOrchestrator`:
```
1. send(messages) → response
2. if response.stopReason === 'tool_use':
   a. для каждого tool_use → найти hook.handleToolUse → выполнить
   b. добавить tool_result в messages
   c. goto 1
3. if response.stopReason === 'end_turn':
   return response
4. if iterations > maxIterations:
   return response (с предупреждением)
```

### 3.4 IHandler — обработка ответа

```typescript
interface IHandler {
  handle(
    response: EngineResponse,
    session: ISession,
    config: EngineConfig
  ): Promise<HandlerResult>
}

interface HandlerResult {
  /** Текст для stdout (потребитель печатает). */
  output: string
  /** Файлы, side effects, метаданные. */
  artifacts?: Record<string, unknown>
}
```

**Реализации:**

| Имя | Что делает | Потребитель |
|-----|-----------|-------------|
| `ChatHandler` | append в session, стриминг | chat3 |
| `RawHandler` | вернуть текст ответа, не сохранять | commit, одноразовые |
| `TranslateHandler` | вернуть текст, записать в файл | translate |
| `ExtractHandler` | парсить JSON из ответа, вернуть объект | авто-тесты, extract |

## 4. EngineConfig — конфигурация

Из mdz-атрибутов сессии или программно:

```typescript
interface EngineConfig {
  // Что использовать
  session: string       // 'file' | 'memory' | 'remote'   — default: 'file'
  assembly: string      // 'direct' | 'ntpl'            — default: 'direct'
  orchestrator: string  // 'simple' | 'agent'           — default: 'simple'
  handler: string       // 'chat' | 'raw' | 'translate' | 'extract' — default: 'chat'

  // LLM
  model: string
  provider: string

  // Assembly
  template?: string     // путь к ntpl шаблону (для NtplAssembler)

  // Orchestrator
  maxIterations?: number  // лимит tool loop (default: 10)
  tools?: ToolDef[]       // доступные tools

  // Session
  persona?: string
  bot?: string

  // Display (для UI — из карточки или конфига)
  display?: {
    botName?: string       // отображаемое имя бота
    botAvatar?: string     // путь к аватарке или URL
    userName?: string      // отображаемое имя юзера
    userAvatar?: string
    description?: string   // описание чата/сценария
  }

  // Commands
  cmd?: string           // dry, dump, swipe, retry, gen

  // всё остальное — pass-through для плагинов
  [key: string]: Value
}
```

В mds файле:

```
$model: anthropic/claude-sonnet-4
$provider: openrouter
$handler: chat
$assembly: ntpl
$template: roleplay
$orchestrator: agent
$tools: web_search, code_exec
```

Для commit:

```typescript
run({
  session: 'memory',
  assembly: 'direct',
  orchestrator: 'simple',
  handler: 'raw',
  model: 'google/gemini-2.5-flash',
  provider: 'openrouter',
})
```

## 5. run() — entry point

```typescript
async function run(config: EngineConfig, input?: RunInput): Promise<HandlerResult> {
  // 1. Resolve components
  const session = resolveSession(config)
  const assembler = resolveAssembler(config)
  const orchestrator = resolveOrchestrator(config)
  const handler = resolveHandler(config)
  const provider = resolveProvider(config)

  // 2. Input (опционально — для не-чат сценариев)
  if (input?.userMessage) {
    session.appendMessage('user', input.userMessage)
  }
  if (input?.systemPrompt) {
    session.appendMessage('system', input.systemPrompt)
  }

  // 3. Commands (dry, dump, swipe, retry)
  if (config.cmd === 'dry' || config.cmd === 'dump') {
    const messages = session.getMessages()
    const context = input?.context ?? emptyContext
    const llm = assembler.render(messages, context)
    return formatPrompt(llm, config)
  }

  // 4. Assemble
  const messages = session.getMessages()
  const context = input?.context ?? emptyContext
  const llm = assembler.render(messages, context)

  // 5. Orchestrate
  const hooks = resolveHooks(config)
  const response = await orchestrator.execute(llm, provider, hooks)

  // 6. Handle
  return handler.handle(response, session, config)
}

interface RunInput {
  /** IContext из nrd-context (карточка, лорбук, и т.д.) */
  context?: IContext
  /** Добавить user message перед генерацией. */
  userMessage?: string
  /** Добавить system prompt. */
  systemPrompt?: string
  /** Typed stream callback. */
  onEvent?: (event: StreamEvent) => void
}
```

> **Связь RunInput.onEvent и OrchestratorHook.onEvent:** `run()` оборачивает `input.onEvent`
> в hook и передаёт в `orchestrator.execute()`. Потребитель подписывается через RunInput, не через hooks напрямую.

> **buildContext:** `run()` проверяет наличие NRD-блока в сессии (карточка, лорбук как `## $source`).
> Если есть — вызывает `buildContext()` из nrd-context и строит chain. `input.context` — override,
> добавляется поверх. Потребителю не нужно вызывать buildContext самому для типичных случаев.

> **Thinking persistence:** `````%thinking` блоки сохраняются в сессии как часть сообщения.
> `--cmd=history` возвращает их в `blocks[]`. UI решает как рендерить (свёрнуто, скрыто, развёрнуто).
```

## 6. Потребители — примеры

### 6.1 chat3

```typescript
export default async function(ctx: IContext, meta: ScriptMeta) {
  const file = meta.args[0]
  return run({
    session: 'file',
    handler: 'chat',
    assembly: ctx.get(['template']) ? 'ntpl' : 'direct',
    ...sessionConfig(file),
  })
}
```

### 6.2 commit

```typescript
export default async function(ctx: IContext, meta: ScriptMeta) {
  const diff = execSync('git diff --cached', { encoding: 'utf-8' })
  const result = await run({
    session: 'memory',
    handler: 'raw',
    orchestrator: 'simple',
    model: 'google/gemini-2.5-flash',
    provider: 'openrouter',
  }, {
    systemPrompt: 'Generate a git commit message...',
    userMessage: diff,
  })
  execSync(`git commit -m "${result.output}"`)
  return { output: `✓ ${result.output}` }
}
```

### 6.3 translate (одиночный текст)

```typescript
const result = await run({
  session: 'memory',
  handler: 'raw',
  model: 'deepseek/deepseek-chat',
}, {
  systemPrompt: `Translate from ${source} to ${target}. Output only the translation.`,
  userMessage: text,
})
```

### 6.4 bot-server (Telegram)

```typescript
bot.on('message', async (msg) => {
  const context = await buildContext(botConfig)  // nrd-context
  const result = await run({
    session: 'remote',
    handler: 'chat',
    assembly: 'ntpl',
    template: 'roleplay',
    model: 'anthropic/claude-sonnet-4',
    remote_chat_id: chatId,
  }, {
    context,
    userMessage: msg.text,
    onStream: (chunk) => bot.sendChatAction(chatId, 'typing'),
  })
  bot.sendMessage(chatId, result.output)
})
```

## 7. Session Management

Операции над сессиями (не над сообщениями внутри). Отдельный интерфейс:

```typescript
interface ISessionManager {
  /** Список сессий (пути/id). */
  list(dir?: string): SessionInfo[]
  /** Создать новую сессию. */
  create(config: Partial<SessionConfig>): ISession
  /** Открыть существующую. */
  open(id: string): ISession
  /** Переименовать. */
  rename(id: string, title: string): void
  /** Удалить. */
  remove(id: string): void
}

interface SessionInfo {
  id: string              // путь к файлу или id на площадке
  title?: string
  model?: string
  updated?: string        // ISO datetime
  messageCount?: number
}
```

Реализации:
- `FileSessionManager` — сканирует директорию, ищет `.mds`/`.md` с `$type: chat2`
- `RemoteSessionManager` — API площадки `/chats` (внешний модуль)

Session management НЕ часть ISession (сессия не знает о других сессиях). Это отдельный слой, потребляемый UI.

## 8. UI Protocol

Транспорт-агностичный протокол: CLI args (shell), HTTP query, IPC — одна и та же форма. Сейчас реализация через CLI/chain.

### 8.1 Операции

Каждая операция — `--cmd=<op>` через chain. Chat id = путь к файлу. Message id = opaque string.

```
# Read
runz chat3 <path> --cmd=history                        → {messages: MessageDTO[], version}
runz chat3 <path> --cmd=status                         → {version}

# Write
runz chat3 <path> --cmd=append --role=user --text=...  → MessageDTO
runz chat3 <path> --cmd=edit --id=<id> --text=...      → MessageDTO
  --if-hash=<hash>                                       (precondition, optional)
runz chat3 <path> --cmd=delete --id=<id>               → {ok, version}
runz chat3 <path> --cmd=hide --id=<id>                 → {ok, version}
runz chat3 <path> --cmd=unhide --id=<id>               → {ok, version}

# Generate
runz chat3 <path> --cmd=generate                       → NDJSON StreamEvent
runz chat3 <path> --cmd=generate --at=<id>             → NDJSON (regenerate = new swipe at slot)
runz chat3 <path> --cmd=generate --text=<msg>           → NDJSON (append user + generate = send)
runz chat3 <path> --cmd=cancel                         → {ok, version} (прервать генерацию, частичный ответ НЕ сохраняется)

# Swipes
runz chat3 <path> --cmd=swipe --id=<id> --dir=next     → MessageDTO (switched)
runz chat3 <path> --cmd=swipe --id=<id> --dir=prev     → MessageDTO
runz chat3 <path> --cmd=swipe --id=<id> --index=<N>     → MessageDTO (jump to variant N)

# Debug
runz chat3 <path> --cmd=dry                            → assembled prompt as mds
runz chat3 <path> --cmd=dump                           → prompt written to .prompt.md

# Session management
runz chat3 --cmd=list --dir=<path>                     → SessionInfo[]
runz chat3 --cmd=create --title=... --model=...        → {id, path}
runz chat3 <path> --cmd=meta                           → SessionConfig + display (из карточки через nrd-context, если подключена)
```

### 8.2 Response envelope

**Все** операции (включая стрим-финал) возвращают единый конверт:

```typescript
interface OperationResponse<T = unknown> {
  ok: boolean
  result?: T              // MessageDTO, SessionInfo[], etc.
  version: string         // текущая версия после операции
  scope?: MessageDTO[]    // полный скоуп, если клиент был stale
  error?: string          // при ok: false
}
```

Обычные операции → JSON `OperationResponse` на stdout.

Generate → NDJSON (один JSON-объект на строку):
```
{"type":"user_appended","message":{...}}
{"type":"delta","text":"Hel"}
{"type":"delta","text":"lo!"}
{"type":"thinking_delta","text":"reasoning..."}
{"type":"done","message":{...},"version":"abc123"}
```

`user_appended` — первое событие при `generate --text=` (combined send). UI получает id добавленного user-сообщения до начала генерации.

### 8.3 Conditional responses (sync)

Каждый запрос может передать `--version=<token>`.
- Версия совпала с текущей → операция выполняется, ответ содержит только результат.
- Версия не совпала → ответ содержит результат + `scope` (полный скоуп для sync).
- **edit --if-hash провалился** (precondition) → ответ содержит `{ok: false, version, scope}` — UI восстанавливается через полный scope, та же механика что stale version.

```json
// Версия актуальна — только результат
{"message": {...}, "version": "new-version"}

// Версия устарела — результат + полный скоуп
{"message": {...}, "version": "new-version", "scope": {"messages": [...]}}
```

UI: получил `scope` → заменил локальное состояние целиком. Не мержит, не диффит — одна истина на бэке.

### 8.4 Chain priority (транспорт-агностичность)

CLI args = HTTP query = IPC params. Всё попадает в IContext через chain:
- `--cmd=history` → `ctx.get(['cmd'])` = `'history'`
- `$cmd: history` в файле → то же, но ниже приоритетом
- CLI перегружает файл, как GET перегружает POST

Один механизм, все транспорты. Будущий HTTP-сервер — тонкая обёртка: query params → chain → run() → JSON response.

## 9. Module Resolution

Convention-based, как nrd-context:

```
nr-engine/
  sessions/
    file.ts       ← FileSession
    memory.ts     ← MemorySession
  assembly/
    direct.ts     ← DirectAssembler
    ntpl.ts       ← NtplAssembler
  orchestrators/
    simple.ts     ← один вызов
    agent.ts      ← tool loop
  handlers/
    chat.ts       ← append + stream
    raw.ts        ← вернуть текст
    translate.ts  ← перевод
    extract.ts    ← JSON parse
```

Внешние модули — `.nr-engine/sessions/remote.ts` и т.д. Upward search.

## 10. Связь с существующими либами

```
nrd-core        → IContext, Value, resolve (Message/ContentBlock — свои с nrd-core 4.0.0, src/message-model.ts)
nrd-context     → buildContext, wrapContext, source plugins
ntpl            → extractNrd, createEnv, render (через NtplAssembler)
nr-infra        → LLMProvider, stream, LLMMessage, tool types
nrd-exec        → execBlock (для script tools в AgentOrchestrator)
```

nr-engine НЕ дублирует логику из этих либ. Он импортирует и оркестрирует.

## 11. Миграция из chat2

FileSession, DirectAssembler, provider logic — переезжают из `S:\appz\chat2\src\` в nr-engine. chat2 остаётся рабочим as-is. chat3 — новый потребитель поверх nr-engine.

Порядок:
1. Перенести FileSession → nr-engine/sessions/file.ts
2. Перенести DirectAssembler → nr-engine/assembly/direct.ts
3. Добавить MemorySession, NtplAssembler
4. Добавить SimpleOrchestrator
5. Добавить handlers (chat, raw)
6. run() entry point
7. chat3 — тонкий потребитель
8. Переписать commit на nr-engine
9. chat2 не трогаем

## 12. Что НЕ делаем

- Data pipeline, sources → nrd-context
- Template rendering → ntpl
- HTTP, streaming → nr-infra
- Block execution (zx, shell) → nrd-exec
- ClaudAgent (подписочный Claude с MCP) → отдельная либа, позже
- Web UI, Telegram bot framework → отдельные проекты, потребители nr-engine
- Context Engine (budget, trimming, summary) → модуль в nr-engine, этап 2
- Envelope/JSON Schema формализация sync — когда появится второй доменный потребитель
- Diff/CRDT/merge — одна истина на бэке, UI не держит авторитетного состояния
- Insert в середину / reorder сообщений — append-only + delete покрывают 99% кейсов; вставка нарратора — позже
