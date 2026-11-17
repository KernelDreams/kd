// LorebookInjector — первый плагин на публичном шве (решение №10, dogfooding).
//
// ВАЖНО: импортирует РОВНО две вещи — `@kerneldreams/nrd` (парсер формата) и
// `../types.js` (публичный шов движка). Ни одного приватного хука внутрь
// движка: ни scoring'а, ни tokens.ts, ни fs. Токены считает caps.countTokens,
// файлы читает caps.storage, пишет в caps.log. Если плагину чего-то не хватает
// — дыра чинится в интерфейсе, а не приватным доступом.
//
// Формат — mdd (sigil `@`), v1 §4.6:
//
//   @name: Fantasy World
//   @scan_depth: 10
//
//   ## @entry elves
//   @keys: @[elves, elven, эльфы]
//   @secondary_keys: @[forest]
//   @priority: 50
//   @tags: @[lore, before_char]
//   @cooldown: 3
//
//   Elves in this world are ancient beings...

import { asText, parseDocument } from '@kerneldreams/nrd'
import type { IArray, IContext, Value } from '@kerneldreams/nrd'
import type {
  IContextInjector,
  InjectedEntry,
  InjectorCapabilities,
  ScanContext,
  Visibility,
} from '../types.js'

export interface LorebookEntry {
  id: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  enabled: boolean
  constant: boolean
  tags: string[]
  priority: number
  cooldown: number
  scanDepth?: number
  visibility?: Visibility
  depth?: number
}

export interface LorebookInjectorOptions {
  id: string
  /** Готовый mdd-текст лорбука. */
  source?: string
  /** Путь для caps.storage — читается лениво при первом scan(). */
  path?: string
  /** Глобальная глубина сканирования, если у лорбука своей нет. */
  scanDepth?: number
}

const WORD = /[\p{L}\p{N}_]/u

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Границы слова, работающие для кириллицы (\b завязан на [A-Za-z0-9_]). */
function matchesKey(haystack: string, key: string): boolean {
  const k = key.trim().toLowerCase()
  if (!k) return false
  const re = new RegExp(escapeRe(k), 'giu')
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack)) !== null) {
    const before = haystack[m.index - 1]
    const after = haystack[m.index + m[0].length]
    const boundedLeft = before === undefined || !WORD.test(before)
    const boundedRight = after === undefined || !WORD.test(after)
    if (boundedLeft && boundedRight) return true
  }
  return false
}

function list(v: Value): string[] {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v.map((x) => String(asText(x) ?? x).trim()).filter(Boolean)
  const arr = v as { iterate?: () => Iterable<Value> }
  if (typeof arr.iterate === 'function') {
    return [...arr.iterate()].map((x) => String(asText(x) ?? x).trim()).filter(Boolean)
  }
  return String(asText(v) ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function numOf(v: Value, fallback: number): number {
  if (typeof v === 'number') return v
  const t = asText(v)
  return t !== undefined && t.trim() !== '' && !Number.isNaN(Number(t)) ? Number(t) : fallback
}

function visibilityOf(v: Value): Visibility | undefined {
  const t = asText(v)
  return t === 'model' || t === 'ui' || t === 'both' ? t : undefined
}

/** Разобрать mdd-лорбук в entries. Экспортируется — импортёр ST переиспользует. */
export function parseLorebook(mdd: string): { scanDepth?: number; entries: LorebookEntry[] } {
  const doc = parseDocument(mdd, { sigil: '@' })
  const rootDepth = doc.get(['scan_depth'])
  const entries: LorebookEntry[] = []

  const records = doc.cast('records') as IArray | undefined
  if (records) {
    for (const rec of records.iterate()) {
      const r = rec as unknown as IContext
      if (asText(r.cast('name')) !== 'entry') continue
      const id = asText(r.cast('id')) ?? `entry-${entries.length}`
      const content = (asText(r.cast('text')) ?? '').trim()
      if (!content) continue

      const enabled = r.get(['enabled'])
      const scanDepth = r.get(['scan_depth'])
      entries.push({
        id,
        keys: list(r.get(['keys'])),
        secondaryKeys: list(r.get(['secondary_keys'])),
        content,
        enabled: enabled === undefined ? true : enabled !== false && enabled !== 'false',
        constant: r.get(['constant']) === true || r.get(['constant']) === 'true',
        tags: list(r.get(['tags'])),
        priority: numOf(r.get(['priority']), 0),
        cooldown: numOf(r.get(['cooldown']), 0),
        ...(scanDepth === undefined ? {} : { scanDepth: numOf(scanDepth, 0) }),
        ...(visibilityOf(r.get(['visibility'])) ? { visibility: visibilityOf(r.get(['visibility']))! } : {}),
        ...(r.get(['depth']) === undefined ? {} : { depth: numOf(r.get(['depth']), 0) }),
      })
    }
  }

  return {
    ...(rootDepth === undefined ? {} : { scanDepth: numOf(rootDepth, 0) }),
    entries,
  }
}

/** Текст сообщений для сканирования — последние `depth` штук, без служебных. */
function scanText(ctx: ScanContext, depth: number): string {
  const msgs = ctx.messages.slice(-Math.max(1, depth))
  return msgs
    .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.body))
    .join('\n')
    .toLowerCase()
}

export class LorebookInjector implements IContextInjector {
  readonly id: string
  private readonly opts: LorebookInjectorOptions
  private book?: { scanDepth?: number; entries: LorebookEntry[] }
  /** entry.id → ход, на котором entry сработал последний раз (cooldown). */
  private firedAt = new Map<string, number>()
  private stateLoaded = false

  constructor(opts: LorebookInjectorOptions) {
    this.id = opts.id
    this.opts = opts
  }

  private async load(caps: InjectorCapabilities): Promise<void> {
    if (this.book) return
    if (this.opts.source !== undefined) {
      this.book = parseLorebook(this.opts.source)
      return
    }
    if (this.opts.path && caps.storage) {
      const res = await caps.storage.read(this.opts.path)
      if (res.ok && res.value !== undefined) {
        this.book = parseLorebook(res.value)
        return
      }
      caps.log.warn(`lorebook "${this.id}": не прочитан (${this.opts.path})`)
    }
    this.book = { entries: [] }
  }

  private stateKey(): string {
    return `.lorebook-state/${this.id}.json`
  }

  private async loadState(caps: InjectorCapabilities): Promise<void> {
    if (this.stateLoaded || !caps.storage) return
    this.stateLoaded = true
    const res = await caps.storage.read(this.stateKey())
    if (!res.ok || res.value === undefined) return
    try {
      const raw = JSON.parse(res.value) as Record<string, number>
      for (const [k, v] of Object.entries(raw)) this.firedAt.set(k, v)
    } catch {
      caps.log.warn(`lorebook "${this.id}": битый state, сброшен`)
    }
  }

  private async saveState(caps: InjectorCapabilities): Promise<void> {
    if (!caps.storage || this.firedAt.size === 0) return
    await caps.storage.write(this.stateKey(), JSON.stringify(Object.fromEntries(this.firedAt)))
  }

  async scan(ctx: ScanContext, caps: InjectorCapabilities): Promise<InjectedEntry[]> {
    await this.load(caps)
    await this.loadState(caps)
    const book = this.book!
    const globalDepth = book.scanDepth ?? this.opts.scanDepth ?? 10
    const out: InjectedEntry[] = []

    for (const e of book.entries) {
      if (!e.enabled) continue

      const fired = this.firedAt.get(e.id)
      if (e.cooldown > 0 && fired !== undefined && ctx.turn - fired < e.cooldown) {
        caps.log.debug(`lorebook "${this.id}": entry "${e.id}" на cooldown`)
        continue
      }

      const matched: string[] = []
      if (!e.constant) {
        const hay = scanText(ctx, e.scanDepth ?? globalDepth)
        for (const k of e.keys) if (matchesKey(hay, k)) matched.push(k)
        if (matched.length === 0) continue
        if (e.secondaryKeys.length > 0) {
          const sec = e.secondaryKeys.filter((k) => matchesKey(hay, k))
          if (sec.length === 0) continue
          matched.push(...sec)
        }
      }

      this.firedAt.set(e.id, ctx.turn)
      out.push({
        id: `${this.id}:${e.id}`,
        content: e.content,
        tags: e.tags,
        priority: e.priority,
        tokens: caps.countTokens(e.content),
        source: this.id,
        matchedKeys: e.constant ? ['$constant'] : matched,
        triggeredAtDepth: e.constant ? undefined : this.triggerDepth(ctx, matched),
        ...(e.visibility ? { visibility: e.visibility } : {}),
        ...(e.depth === undefined ? {} : { depth: e.depth }),
      })
    }

    await this.saveState(caps)
    return out
  }

  /** Глубина ближайшего сообщения, в котором нашёлся хоть один ключ. */
  private triggerDepth(ctx: ScanContext, keys: string[]): number | undefined {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const text = ctx.messages[i]!.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.body)
        .join('\n')
        .toLowerCase()
      if (keys.some((k) => matchesKey(text, k))) return ctx.messages.length - 1 - i
    }
    return undefined
  }
}
