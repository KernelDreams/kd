// Context Engine — публичные типы. Spec: docs/specs/context-engine-spec.md.
//
// Это ПУБЛИЧНЫЙ ШОВ. Плагины (injector'ы) импортируют только отсюда — ни одного
// приватного хука внутрь движка (решение №10, dogfooding). Если плагину чего-то
// не хватает — дыра чинится здесь, в интерфейсе, а не приватным доступом.

import type { IContext, Value } from '@kerneldreams/nrd'
import type { ContentBlock } from '../message-model.js'
import type { IStorage, LLMMessage, LLMResponse } from '@kerneldreams/nrd/web'
import type { Visibility } from './model.js'

export type { Visibility } from './model.js'

// ---------------------------------------------------------------------------
// Конфиг движка — атрибуты `$ctx-*` каскада (§2)
// ---------------------------------------------------------------------------

/** Внутреннее представление конфига. Читается из IContext-цепочки — §2. */
export interface EngineCtxConfig {
  maxTokens: number
  reserveOutput: number
  recentDepth: number
  summaryDepth: number
  toolsInMiddle: boolean
  cardScore: number
  historyScore: number
  summaryScore: number
  collapsedScore: number
  examplesScore: number
  scanDepth: number
  lorebooks: string[]
}

// ---------------------------------------------------------------------------
// Scoring (§3.1)
// ---------------------------------------------------------------------------

export type ItemSource = 'system' | 'card' | 'history' | 'injector' | 'example'

export interface ScoredItem {
  content: string
  tokens: number
  score: number
  source: ItemSource
  metadata: Record<string, unknown>
}

export interface DroppedItem {
  item: string
  source: ItemSource
  tokens: number
  score: number
  reason: DropReason
}

export type DropReason = 'budget' | 'hidden' | 'filtered' | 'visibility'

// ---------------------------------------------------------------------------
// Decision log (§7)
// ---------------------------------------------------------------------------

export type Decision =
  | { kind: 'matched'; entry: string; injector: string; keys?: string[]; triggeredBy?: string }
  | { kind: 'scored'; item: string; source: string; base: number; boost?: number; final: number }
  | { kind: 'included'; item: string; tokens: number; budgetLeft: number }
  | { kind: 'dropped'; item: string; reason: DropReason; detail?: string }
  | { kind: 'replaced'; item: string; by: 'summary' | 'collapsed' }

// ---------------------------------------------------------------------------
// ContextPackage (§3.3)
// ---------------------------------------------------------------------------

export interface ContextMessage {
  role: string
  blocks: ContentBlock[]
  attrs: Record<string, Value>
  isSummary: boolean
  isFrozen: boolean
  isCollapsedSummary: boolean
  originalTokens?: number
  name?: string
}

export interface TaggedInjection {
  id: string
  content: string
  tags: string[]
  source: string
  score: number
  tokens: number
  /** Глубина вставки от конца истории (для тега `at_depth`). */
  depth?: number
}

export interface ContextMeta {
  totalTokens: number
  budget: number
  historyFull: number
  historySummarized: number
  historyDropped: number
  injectionsMatched: number
  injectionsIncluded: number
  injectionsDropped: number
  dropped: DroppedItem[]
  decisions: Decision[]
}

export interface ContextPackage {
  card: IContext
  persona: IContext
  messages: ContextMessage[]
  injections: TaggedInjection[]
  examples: string[]
  meta: ContextMeta
}

// ---------------------------------------------------------------------------
// Injectors (§5)
// ---------------------------------------------------------------------------

/** Минимальный лог — то, что движок обещает плагину. */
export interface Logger {
  debug(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

/** Обёртка над provider.chat — injector с LLM внутри (pre-gen агент, §5.1). */
export type LLMCallFn = (messages: LLMMessage[]) => Promise<LLMResponse>

/**
 * Власть injector'а = то, что ему инжектнули (driver pattern, решение №1).
 * Нет `llm` — нет LLM-вызовов. Нет `storage` — нет ФС. Запрещать нечего.
 */
export interface InjectorCapabilities {
  llm?: LLMCallFn
  /** Scoped storage: свой namespace, не вся ФС. */
  storage?: IStorage
  log: Logger
  /** Счётчик токенов движка — чтобы плагин не тащил свой. */
  countTokens: (text: string) => number
}

export interface ScanContext {
  /** Текст последних сообщений (глубина — $ctx-scan-depth) для matching. */
  recentText: string
  /** Отобранная история (уже без $hidden и без ui-only). */
  messages: ContextMessage[]
  /** Карточка — для context-aware matching. */
  card: IContext
  /** Номер хода (кол-во сообщений) — для cooldown'ов. */
  turn: number
}

export interface InjectedEntry {
  id: string
  content: string
  tags: string[]
  priority: number
  /** Не задан → движок посчитает сам. */
  tokens?: number
  source: string
  /** Индекс сообщения-триггера (для recency boost). */
  triggeredBy?: string
  triggeredAtDepth?: number
  /** Какие ключи сработали — для trace (§7). */
  matchedKeys?: string[]
  visibility?: Visibility
  /** Глубина вставки от конца истории (тег `at_depth`). */
  depth?: number
}

/** Плагин контекста. Lorebook / RAG / memory / world-state — один интерфейс. */
export interface IContextInjector {
  id: string
  scan(context: ScanContext, caps: InjectorCapabilities): Promise<InjectedEntry[]>
  /** Опционально: обновить состояние после хода (cooldown'ы). */
  afterTurn?(context: ScanContext, caps: InjectorCapabilities): Promise<void>
}

// ---------------------------------------------------------------------------
// Engine (§8)
// ---------------------------------------------------------------------------

export interface IContextEngine {
  assemble(session: EngineSession, ctx: IContext): Promise<ContextPackage>
  afterTurn(session: EngineSession, response: ContextMessage): Promise<void>
}

/** Ровно то, что движку нужно от сессии (структурная типизация ISession). */
export interface EngineSession {
  getAllMessages(): import('../message-model.js').Message[]
}
