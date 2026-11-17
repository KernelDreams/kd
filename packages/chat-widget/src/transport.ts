/**
 * Шов виджета: транспорт ведёт сессию и наполняет ленту, элемент — рисует и
 * отдаёт ответы пользователя. Два транспорта: `nr` (nr-ui-protocol, HTTP+SSE)
 * и `acp` (Agent Client Protocol, WebSocket).
 */

import type { Feed } from './feed.js'
import type { Strings } from './i18n.js'

/** Тул страницы: объявление для модели и исполнитель в странице. */
export interface PageToolDef {
  name: string
  description?: string
  /** JSON Schema аргументов (`type: 'object'`). */
  schema?: Record<string, unknown>
}

/** Результат тула страницы: строка — текст модели; объект — текст и данные. */
export type PageToolResult = string | { text: string; data?: unknown }

export type PageToolHandler = (args: Record<string, unknown>) => PageToolResult | Promise<PageToolResult>

export interface WidgetOptions {
  /** URL бэкенда: `http(s)://…` для nr, `ws(s)://…/acp` для acp, `local` — бэкенд в странице. */
  backend: string
  transport?: 'nr' | 'acp' | 'local'
  /** `auto` (default) — новая сессия; иначе id существующей. */
  session?: string
  /** Профиль новой сессии (nr) или режим (acp, `session/set_mode`). */
  profile?: string
  /** Ключ доступа (`$auth_key` стенда). */
  auth?: string
  /** Рабочий каталог новой сессии (абсолютный, v1.20). */
  cwd?: string
  lang?: 'ru' | 'en'
  theme?: 'light' | 'dark' | 'auto'
  placeholder?: string
  /** local: OpenAI-совместимый гейт (`…/v1`) и ключ к нему. */
  providerUrl?: string
  providerKey?: string
  /** local: URL ESM-модуля бэкенда страницы (`createBrowserHost`, `createLocalBackend`); нет — нужен `localBackend`. */
  localModule?: string
  /** local: носитель — `auto` (OPFS, иначе IndexedDB), `opfs`, `idb`. */
  localStorage?: 'auto' | 'opfs' | 'idb'
  /** local (JS): готовый бэкенд — модуль не грузится. */
  localBackend?: import('@kerneldreams/ui-protocol').ProtocolBackend
  /** local (JS): прочие опции `createLocalBackend` (профили, skillbox, cwd…). */
  localOptions?: Record<string, unknown>
}

export interface TransportHost {
  readonly feed: Feed
  readonly t: Strings
  readonly options: WidgetOptions
  readonly pageTools: ReadonlyMap<string, { def: PageToolDef; handler: PageToolHandler }>
  readonly context: (() => unknown | Promise<unknown>) | undefined
  emit(name: string, detail: unknown): void
}

export interface Transport {
  readonly kind: 'nr' | 'acp' | 'local'
  /** id сессии после `connect`. */
  readonly sessionId: string | undefined
  /** Подключиться, создать/открыть сессию, загрузить ленту. */
  connect(): Promise<void>
  /** Ран: сообщение пользователя → ответ (резолвится по концу рана). */
  send(text: string): Promise<void>
  /** Остановить текущий ран. */
  stop(): void
  /** Ответ пользователя на карточку вопроса/апрува. */
  answer(askId: string, value: string): void
  /** Объявить тулы страницы бэкенду (после `registerTool`). */
  syncTools(): Promise<void>
  close(): void
}

/** Текст ошибки для ленты. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

/** Результат тула страницы → ответ `respond` (`SessionToolCall`, v1.16). */
export async function runPageTool(host: TransportHost, name: string, args: unknown, callId: string): Promise<{ text: string; data?: unknown; error?: true }> {
  const tool = host.pageTools.get(name)
  host.emit('tool-call', { name, args, callId, page: true })
  if (!tool) return { text: `page tool ${name} is not registered on this page`, error: true }
  try {
    const res = await tool.handler((args && typeof args === 'object' ? args : {}) as Record<string, unknown>)
    if (typeof res === 'string') return { text: res }
    return res.data === undefined ? { text: res.text } : { text: res.text, data: res.data }
  } catch (err) {
    return { text: `error: ${errorText(err)}`, error: true }
  }
}
