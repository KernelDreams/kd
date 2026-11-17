/**
 * Интерфейс тула агента (backend-nr-spec §6, вынесен из backend-nr в):
 * один на все источники — профиль (встроенный реестр), сервисы плагинов,
 * сессия (артефакты), MCP — и на всех потребителей: стенд nr, Claude Code
 * через ACP (`nr-tools`), MCP-сервер.
 *
 * Схема аргументов — JSON Schema как есть: провайдер (pi-ai) отдаёт её модели
 * без TypeBox; валидация — минимальная (обязательные поля, типы верхнего уровня),
 * остальное — дело тула.
 */

/** Кто исполняет тул: процесс бэкенда или фронт (через `ask` вида `tool`). */
export type ToolExecutor = 'backend' | 'frontend'

/** Откуда тул попал в реестр рана. */
export type ToolSource = 'registry' | 'service' | 'session' | 'mcp'

/**
 * Политика вызова (tools-spec §3): `auto` — исполнить, `ask` — спросить
 * пользователя (`ask` вида `tool_approval`), `deny` — отказать текстом модели.
 */
export type ToolPolicy = 'auto' | 'ask' | 'deny'

/** Превью для карточки апрува (протокол `ToolApprovalPreview`). */
export type ToolPreview =
  | { kind: 'diff'; diff: string; path?: string }
  | { kind: 'command'; command: string; cwd: string }
  | { kind: 'text'; text: string }

export interface ToolContext {
  signal: AbortSignal
  sessionId: string
  callId: string
  /**
   * Рабочий каталог вызова (сессии), если хост его знает. Тулы со своим
   * корнем (`fs`, `exec` — `FsRoot.cwd`) его не читают; `runz` — читает.
   */
  cwd?: string
  /**
   * Вопрос пользователю (`ask` протокола, §5.3): `kind` — `text`/`select`/
   * `permission`/`tool`; резолвится ответом `respond`, отменой рана — reject.
   * Бэкенд без `ask` — reject сразу.
   */
  ask(kind: string, payload: unknown): Promise<unknown>
}

/** Картинка результата (read картинки, MCP): модели — image-блоком tool result. */
export interface ToolImage {
  mimeType: string
  /** base64 */
  data: string
}

/** Картинка результата человеку (П-3): в ленту отдельным сообщением, байты — во вложения сессии. */
export interface ToolFile {
  name: string
  mime: string
  data: Uint8Array
  /** Файл на диске — модель отдаёт картинку рефом следующему тулу. */
  path?: string
}

/**
 * Результат тула: текст — модели, `data` — фронту (part `tool_result.data`),
 * `images` — модели картинками, `files` — человеку картинками в ленте.
 */
export interface ToolResult {
  text: string
  data?: unknown
  isError?: boolean
  images?: ToolImage[]
  files?: ToolFile[]
}

export interface ToolCallInfo {
  callId: string
  name: string
  args: Record<string, unknown>
}

/** Решение before-хука: заменить аргументы или заблокировать вызов (текст — модели). */
export interface BeforeToolDecision {
  args?: Record<string, unknown>
  block?: string
}

export interface ToolHooks {
  before?(call: ToolCallInfo, ctx: ToolContext): void | BeforeToolDecision | Promise<void | BeforeToolDecision>
  /** Может заменить результат. */
  after?(call: ToolCallInfo, result: ToolResult, ctx: ToolContext): void | ToolResult | Promise<void | ToolResult>
}

export interface ToolDef extends ToolHooks {
  name: string
  description: string
  /** JSON Schema аргументов (`{type:'object', properties, required}`). */
  schema: Record<string, unknown>
  executor: ToolExecutor
  source?: ToolSource
  /**
   * Только по имени (П-3): `$tools: all` тул не берёт — профиль называет его
   * (`$tools: all, image_*` или списком). Тулы с внешними затратами (comfy, медиа).
   */
  optIn?: boolean
  /** Политика тула по умолчанию (профиль `$tool_policy` перекрывает). Нет — `auto`. */
  policy?: ToolPolicy
  /**
   * Превью карточки апрува (политика `ask`). Бросает — план вызова негоден
   * (oldText не найден): ошибка уходит модели сразу, без карточки.
   */
  preview?(args: Record<string, unknown>, ctx: ToolContext): ToolPreview | undefined | Promise<ToolPreview | undefined>
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | string>
}
