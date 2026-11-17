// DefaultContextEngine — что попадает в контекст LLM (§3).
//
// Рюкзак по score: жадный набор по score desc, без density-оптимизации. Жирный
// entry с высоким score честно вытесняет мелочь — предсказуемо как в Таверне,
// а trace покажет почему (v1 открытый №5, закрыт).
//
// Движок решает ЧТО включить. КУДА положить — дело шаблона: tags на инъекциях —
// подсказка, не приказ.

import { emptyContext, isContext } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { Message } from '../message-model.js'
import type { IStorage } from '@kerneldreams/nrd/web'
import {
  isFrozen,
  isHidden,
  msgCollapsed,
  msgSummary,
  msgText,
  msgVisibility,
} from './model.js'
import { CARD_FIELDS, cardField } from './card.js'
import { readEngineConfig } from './config.js'
import { depthOf, filterBlocks, visibleToModel } from './filter.js'
import { estimateTokens } from './tokens.js'
import { resolveUntrusted, untrustedScope } from './untrusted.js'
import type {
  ContextMessage,
  ContextPackage,
  Decision,
  DroppedItem,
  EngineCtxConfig,
  EngineSession,
  IContextEngine,
  IContextInjector,
  InjectorCapabilities,
  ItemSource,
  Logger,
  LLMCallFn,
  ScanContext,
  TaggedInjection,
} from './types.js'

/** Событие движка едет существующим каналом nr-engine (RunInput.hooks, §6). */
export interface ContextEvent {
  type: 'budget:exceeded' | 'history:large'
  [key: string]: unknown
}

export interface ContextEngineOptions {
  /** Готовые injector'ы (бандл, тесты). Складываются с лорбуками из `$lorebooks`. */
  injectors?: IContextInjector[]
  /** Scoped storage для caps — свой namespace, не вся ФС. */
  storage?: IStorage
  /** provider.chat-обёртка. Нет — injector'ы без LLM. */
  llm?: LLMCallFn
  log?: Logger
  /** Канал событий (§6). */
  onEvent?: (event: ContextEvent) => void
  /** Порог рекомендации collapse: доля бюджета. */
  largeHistoryRatio?: number
}

const silentLog: Logger = { debug: () => {}, warn: () => {}, error: () => {} }

/** Кандидат в рюкзак. */
interface Candidate {
  key: string
  label: string
  source: ItemSource
  score: number
  tokens: number
  /** Данные для сборки пакета. */
  payload:
    | { kind: 'card'; field: string; text: string }
    | { kind: 'message'; index: number; message: ContextMessage }
    | { kind: 'injection'; injection: TaggedInjection }
    | { kind: 'example'; text: string }
}

export class DefaultContextEngine implements IContextEngine {
  private readonly opts: ContextEngineOptions
  private lastScan?: ScanContext

  constructor(opts: ContextEngineOptions = {}) {
    this.opts = opts
  }

  private caps(): InjectorCapabilities {
    const caps: InjectorCapabilities = {
      log: this.opts.log ?? silentLog,
      countTokens: estimateTokens,
    }
    if (this.opts.storage) caps.storage = this.opts.storage
    if (this.opts.llm) caps.llm = this.opts.llm
    return caps
  }

  async assemble(session: EngineSession, ctx: IContext): Promise<ContextPackage> {
    const cfg = readEngineConfig(ctx)
    const available = Math.max(0, cfg.maxTokens - cfg.reserveOutput)
    const decisions: Decision[] = []
    const dropped: DroppedItem[] = []
    const candidates: Candidate[] = []

    // Чужой контент (карточка, лорбук) резолвится ТОЛЬКО об этот скоуп: без env,
    // без fs-функций, без executor'а (решение №1). Одна строка — весь класс дыр.
    const scope = untrustedScope({
      char: ctx.get(['char']),
      user: ctx.get(['user']),
      persona: ctx.get(['persona']),
      bot: ctx.get(['bot']),
      model: ctx.get(['model']),
    })

    // --- 1–2. Карточка -----------------------------------------------------
    const cardTexts = new Map<string, string>()
    for (const field of CARD_FIELDS) {
      const raw = cardField(ctx, field)
      if (!raw) continue
      const text = resolveUntrusted(raw, scope)
      cardTexts.set(field, text)
      candidates.push({
        key: `card:${field}`,
        label: `card.${field}`,
        source: 'card',
        score: cfg.cardScore,
        tokens: estimateTokens(text),
        payload: { kind: 'card', field, text },
      })
    }

    // --- 4. История --------------------------------------------------------
    const all = session.getAllMessages()
    const kept: { m: Message; index: number }[] = []
    for (let i = 0; i < all.length; i++) {
      const m = all[i]!
      if (isHidden(m)) {
        decisions.push({ kind: 'dropped', item: label(m, i), reason: 'hidden' })
        dropped.push({ item: label(m, i), source: 'history', tokens: 0, score: 0, reason: 'hidden' })
        continue
      }
      if (!visibleToModel(msgVisibility(m))) {
        decisions.push({
          kind: 'dropped',
          item: label(m, i),
          reason: 'visibility',
          detail: '$visibility: ui',
        })
        dropped.push({ item: label(m, i), source: 'history', tokens: 0, score: 0, reason: 'visibility' })
        continue
      }
      kept.push({ m, index: i })
    }

    const contextMessages: ContextMessage[] = []
    for (let i = 0; i < kept.length; i++) {
      const { m, index } = kept[i]!
      const distance = kept.length - 1 - i
      const frozen = isFrozen(m)
      const collapsedId = msgCollapsed(m)
      const summary = msgSummary(m)
      const depth = depthOf(distance, cfg.recentDepth, cfg.summaryDepth)
      const name = label(m, index)

      const { blocks, replacedBySummary } = filterBlocks(
        m.blocks,
        { depth, frozen, toolsInMiddle: cfg.toolsInMiddle, inherited: msgVisibility(m) },
        summary,
      )
      if (blocks.length === 0) {
        decisions.push({ kind: 'dropped', item: name, reason: 'filtered', detail: `depth=${depth}` })
        dropped.push({ item: name, source: 'history', tokens: 0, score: 0, reason: 'filtered' })
        continue
      }

      if (collapsedId) decisions.push({ kind: 'replaced', item: name, by: 'collapsed' })
      else if (replacedBySummary) decisions.push({ kind: 'replaced', item: name, by: 'summary' })

      const base = frozen || m.role === 'system'
        ? Infinity
        : collapsedId
          ? cfg.collapsedScore
          : depth === 'old' || replacedBySummary
            ? cfg.summaryScore
            : cfg.historyScore
      const score = base === Infinity ? Infinity : base - distance

      const cm: ContextMessage = {
        role: m.role,
        blocks,
        attrs: m.attrs,
        isSummary: replacedBySummary,
        isFrozen: frozen,
        isCollapsedSummary: Boolean(collapsedId),
        originalTokens: estimateTokens(msgText(m)),
        ...(typeof m.attrs['name'] === 'string' ? { name: m.attrs['name'] } : {}),
      }
      contextMessages.push(cm)

      const tokens = blocks.reduce((sum, b) => sum + estimateTokens(b.body), 0)
      decisions.push({ kind: 'scored', item: name, source: 'history', base, final: score })
      candidates.push({
        key: `msg:${index}`,
        label: name,
        source: frozen || m.role === 'system' ? 'system' : 'history',
        score,
        tokens,
        payload: { kind: 'message', index, message: cm },
      })
    }

    // --- 3. Injector'ы (async, §5) -----------------------------------------
    const injectors = [...(this.opts.injectors ?? [])]
    const scanCtx: ScanContext = {
      recentText: contextMessages
        .slice(-cfg.scanDepth)
        .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.body))
        .join('\n'),
      messages: contextMessages,
      card: asContext(ctx.get(['card'])) ?? ctx,
      turn: all.length,
    }
    this.lastScan = scanCtx

    const caps = this.caps()
    let matched = 0
    for (const injector of injectors) {
      let entries
      try {
        entries = await injector.scan(scanCtx, caps)
      } catch (e) {
        caps.log.error(`injector "${injector.id}" упал: ${(e as Error).message}`)
        continue
      }
      for (const e of entries) {
        if (e.visibility && !visibleToModel(e.visibility)) {
          decisions.push({
            kind: 'dropped',
            item: e.id,
            reason: 'visibility',
            detail: '$visibility: ui',
          })
          dropped.push({ item: e.id, source: 'injector', tokens: 0, score: 0, reason: 'visibility' })
          continue
        }
        matched++
        const content = resolveUntrusted(e.content, scope)
        // Recency boost: entry, триггернутый свежим сообщением, бьёт такой же
        // priority, триггернутый из глубины. Аддитивно — иначе priority: 0
        // (частый дефолт) обнуляет любой boost.
        const boost = e.triggeredAtDepth === undefined ? 0 : Math.round(100 / (1 + e.triggeredAtDepth))
        const score = e.priority + boost
        const tokens = e.tokens ?? estimateTokens(content)

        decisions.push({
          kind: 'matched',
          entry: e.id,
          injector: injector.id,
          ...(e.matchedKeys ? { keys: e.matchedKeys } : {}),
          ...(e.triggeredBy ? { triggeredBy: e.triggeredBy } : {}),
        })
        decisions.push({
          kind: 'scored',
          item: e.id,
          source: 'injector',
          base: e.priority,
          ...(boost ? { boost } : {}),
          final: score,
        })
        candidates.push({
          key: `inj:${e.id}`,
          label: e.id,
          source: 'injector',
          score,
          tokens,
          payload: {
            kind: 'injection',
            injection: {
              id: e.id,
              content,
              tags: e.tags,
              source: e.source || injector.id,
              score,
              tokens,
              ...(e.depth === undefined ? {} : { depth: e.depth }),
            },
          },
        })
      }
    }

    // --- 5. Dialogue examples ----------------------------------------------
    const examplesRaw = cardField(ctx, 'mes_example')
    if (examplesRaw) {
      const text = resolveUntrusted(examplesRaw, scope)
      candidates.push({
        key: 'examples',
        label: 'examples',
        source: 'example',
        score: cfg.examplesScore,
        tokens: estimateTokens(text),
        payload: { kind: 'example', text },
      })
    }

    // --- 6. Рюкзак ----------------------------------------------------------
    candidates.sort((a, b) => b.score - a.score)

    const mandatory = candidates.filter((c) => c.score === Infinity)
    const mandatoryTokens = mandatory.reduce((s, c) => s + c.tokens, 0)
    if (mandatoryTokens > available) {
      throw new Error(
        `nr-engine: обязательный контекст (system/frozen) не влезает в бюджет: ` +
          `${mandatoryTokens} > ${available} токенов`,
      )
    }

    const included = new Set<string>()
    let used = 0
    let requiredTotal = 0
    for (const c of candidates) {
      requiredTotal += c.tokens
      if (used + c.tokens <= available) {
        used += c.tokens
        included.add(c.key)
        decisions.push({
          kind: 'included',
          item: c.label,
          tokens: c.tokens,
          budgetLeft: available - used,
        })
      } else {
        decisions.push({
          kind: 'dropped',
          item: c.label,
          reason: 'budget',
          detail: `${c.tokens} токенов не влезло (осталось ${available - used})`,
        })
        dropped.push({
          item: c.label,
          source: c.source,
          tokens: c.tokens,
          score: c.score,
          reason: 'budget',
        })
      }
    }

    // --- 7. ContextPackage --------------------------------------------------
    const cardOut: Record<string, string> = {}
    for (const [field, text] of cardTexts) {
      cardOut[field] = included.has(`card:${field}`) ? text : ''
    }

    const messages: ContextMessage[] = []
    let historyFull = 0
    let historySummarized = 0
    for (const c of candidates) {
      if (c.payload.kind !== 'message') continue
      if (!included.has(c.key)) continue
      messages.push(c.payload.message)
    }
    messages.sort(
      (a, b) => contextMessages.indexOf(a) - contextMessages.indexOf(b),
    )
    for (const m of messages) {
      if (m.isSummary || m.isCollapsedSummary) historySummarized++
      else historyFull++
    }

    const injections = candidates
      .filter((c) => c.payload.kind === 'injection' && included.has(c.key))
      .map((c) => (c.payload as { kind: 'injection'; injection: TaggedInjection }).injection)

    const examples = candidates
      .filter((c) => c.payload.kind === 'example' && included.has(c.key))
      .map((c) => (c.payload as { kind: 'example'; text: string }).text)

    const historyDropped = dropped.filter((d) => d.source === 'history' || d.source === 'system').length
    const injectionsDropped = dropped.filter((d) => d.source === 'injector').length

    const pkg: ContextPackage = {
      card: cardObject(cardOut, ctx),
      persona: asContext(ctx.get(['persona'])) ?? emptyContext,
      messages,
      injections,
      examples,
      meta: {
        totalTokens: used,
        budget: available,
        historyFull,
        historySummarized,
        historyDropped,
        injectionsMatched: matched,
        injectionsIncluded: injections.length,
        injectionsDropped,
        dropped,
        decisions,
      },
    }

    // --- 8. События ---------------------------------------------------------
    const budgetDropped = dropped.filter((d) => d.reason === 'budget')
    if (budgetDropped.length > 0) {
      this.opts.onEvent?.({
        type: 'budget:exceeded',
        totalRequired: requiredTotal,
        available,
        dropped: budgetDropped,
      })
    }
    const ratio = this.opts.largeHistoryRatio ?? 0.8
    if (available > 0 && used / available >= ratio) {
      this.opts.onEvent?.({
        type: 'history:large',
        messageCount: messages.length,
        totalTokens: used,
      })
    }

    return pkg
  }

  /**
   * Токен-статистика и injector state (cooldown'ы). Автосуммаризация — плагин,
   * не движок: для РП дроп норм, для рабочего чата — предложить collapse (§6).
   */
  async afterTurn(_session: EngineSession, _response: ContextMessage): Promise<void> {
    if (!this.lastScan) return
    const caps = this.caps()
    for (const injector of this.opts.injectors ?? []) {
      if (!injector.afterTurn) continue
      try {
        await injector.afterTurn(this.lastScan, caps)
      } catch (e) {
        caps.log.error(`injector "${injector.id}" afterTurn упал: ${(e as Error).message}`)
      }
    }
  }
}

/** Значение — живой IContext? (`$persona: User` — строка, не контекст.) */
function asContext(v: unknown): IContext | undefined {
  return isContext(v) ? v : undefined
}

/** Читаемая метка сообщения для decision log. */
function label(m: Message, index: number): string {
  const id = m.attrs['id']
  return typeof id === 'string' ? `${m.role}#${id}` : `${m.role}@${index}`
}

/** Карточка пакета: поля, прошедшие бюджет (дропнутые — пустые), поверх исходной. */
function cardObject(fields: Record<string, string>, base: IContext): IContext {
  return {
    get(path) {
      const head = path[0]
      if (path.length === 1 && typeof head === 'string' && head in fields) return fields[head]
      return base.get(path)
    },
    func: (name, args) => base.func(name, args),
    cast: (name: string) => base.cast(name),
  }
}
