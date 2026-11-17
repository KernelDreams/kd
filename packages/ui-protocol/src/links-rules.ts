/**
 * Правила ссылок без состояния и ввода-вывода (link-resolver-spec §3–4, kd-cli-spec §4):
 * разбор файла `links.mdz` (nrd приходит снаружи), сведение слоёв, поиск совпадений в тексте
 * и сопоставление целого слова (командная строка `kd <адрес>`). Хаб (`backend-http` links),
 * фронт и `kd` зовут эту одну библиотеку: файлы читает и пути раскрывает вызывающий.
 */

import type { LinkActionDef, LinkLayer, LinkRuleDef, LinkRules, LinkTone } from './links.js'

/** То, что нужно от nrd (`@kerneldreams/nrd`): модуль целиком подходит. */
export interface LinksNrd {
  parseDocument(text: string, opts: { sigil: string }): unknown
  blockSelf(block: unknown): { get(path: string[]): unknown }
  asText(v: unknown): string | undefined
  isArray(v: unknown): boolean
  resolve(text: string, ctx: unknown): string
  chainContext(...ctxs: unknown[]): unknown
  objectContext(rec: Record<string, unknown>): unknown
  funcContext(fns: Record<string, (args: unknown[], ctx?: unknown) => unknown>): unknown
  coreFunctions: Record<string, (args: unknown[], ctx?: unknown) => unknown>
}

export const LINK_KEYS = ['pattern', 'kind', 'target', 'label', 'status', 'tone', 'title', 'hover', 'expand', 'icons', 'default'] as const
export const ACTION_KEYS = ['for', 'title', 'icon', 'alt', 'default', 'where', 'run', 'cmd', 'path', 'after'] as const
const TONES = new Set<LinkTone>(['ok', 'warn', 'bad', 'muted', 'accent'])

/** Значение атрибута строкой: снять одинарные кавычки (`'…'` в примерах спеки); `${}` остаётся сырым. */
export function linkTextOf(nrd: LinksNrd, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const t = typeof v === 'string' ? v : nrd.asText(v)
  if (t === undefined) return undefined
  const s = t.trim()
  return s.length >= 2 && s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1) : s
}

/** Список: flow `$[a, b]` (IArray) или строка `[a, b]` / `a, b`. */
export function linkListOf(nrd: LinksNrd, v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (nrd.isArray(v)) {
    const it = v as { iterate(): Iterable<unknown> }
    return [...it.iterate()].map((x) => linkTextOf(nrd, x) ?? '').filter(Boolean)
  }
  const s = linkTextOf(nrd, v)
  if (s === undefined) return undefined
  return s
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

const boolOf = (v: unknown): boolean | undefined => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined)

export interface ParsedLinksFile {
  path: string
  links: Array<LinkRuleDef & { off?: boolean }>
  actions: Array<LinkActionDef & { off?: boolean }>
  /** Корневой `$links` — ещё файлы того же слоя, как написаны (раскрывает вызывающий). */
  includes: string[]
}

/** Текст файла слоя → блоки. Внутри файла одноимённые — последний (лента mdz). */
export function parseLinksText(nrd: LinksNrd, path: string, text: string, layer: LinkLayer): ParsedLinksFile {
  const doc = nrd.parseDocument(text, { sigil: '$' }) as { doc: { root: { children: Array<{ name: string; id?: string }> } }; get(p: string[]): unknown }
  const links = new Map<string, LinkRuleDef & { off?: boolean }>()
  const actions = new Map<string, LinkActionDef & { off?: boolean }>()
  for (const block of doc.doc.root.children) {
    if ((block.name !== 'link' && block.name !== 'action') || !block.id) continue
    const self = nrd.blockSelf(block)
    const get = (k: string): unknown => self.get([k])
    const off = boolOf(get('off')) === true
    if (block.name === 'link') {
      const r: LinkRuleDef & { off?: boolean } = { id: block.id, layer, source: path }
      for (const k of LINK_KEYS) {
        if (k === 'icons') {
          const l = linkListOf(nrd, get(k))
          if (l) r.icons = l
          continue
        }
        const t = linkTextOf(nrd, get(k))
        if (t === undefined || t === '') continue
        if (k === 'tone') {
          if (TONES.has(t as LinkTone)) r.tone = t as LinkTone
          continue
        }
        ;(r as unknown as Record<string, string>)[k] = t
      }
      if (off) r.off = true
      links.delete(block.id)
      links.set(block.id, r)
    } else {
      const a: LinkActionDef & { off?: boolean } = { id: block.id, layer, for: '', run: '', source: path }
      for (const k of ACTION_KEYS) {
        const v = get(k)
        if (k === 'alt' || k === 'default') {
          if (boolOf(v) === true) a[k] = true
          continue
        }
        const t = linkTextOf(nrd, v)
        if (t === undefined || t === '') continue
        ;(a as unknown as Record<string, string>)[k] = t
      }
      if (off) a.off = true
      if (!a.off && (!a.for || !a.run)) continue // без `$for`/`$run` — не действие
      actions.delete(block.id)
      actions.set(block.id, a)
    }
  }
  return { path, links: [...links.values()], actions: [...actions.values()], includes: linkListOf(nrd, doc.get(['links'])) ?? [] }
}

/** Разобранный файл в своём слое (сильный слой первым, в слое — сильный файл первым). */
export interface LayeredLinksFile {
  layer: LinkLayer
  trusted: boolean
  file: ParsedLinksFile
}

/**
 * Свести слои (§3): одноимённый блок сильного слоя вытесняет нижние, `$off: true` снимает нижнее;
 * без доверия действия `exec` / `script` выбрасываются.
 */
export function mergeLinkRules(files: readonly LayeredLinksFile[], trusted = true): LinkRules {
  const links = new Map<string, LinkRuleDef>()
  const actions = new Map<string, LinkActionDef>()
  const taken = new Set<string>()
  const takenActions = new Set<string>()
  const off = new Set<string>()
  const layers: LinkRules['layers'] = []
  for (const { layer, trusted: layerTrusted, file } of files) {
    layers.push({ layer, path: file.path, trusted: layerTrusted })
    for (const { off: isOff, ...r } of file.links) {
      if (taken.has(r.id)) continue
      taken.add(r.id)
      if (isOff) off.add(r.id)
      else links.set(r.id, r)
    }
    for (const { off: isOff, ...a } of file.actions) {
      if (takenActions.has(a.id)) continue
      if (!layerTrusted && (a.run === 'exec' || a.run === 'script')) continue
      takenActions.add(a.id)
      if (isOff) off.add(a.id)
      else actions.set(a.id, a)
    }
  }
  return { links: [...links.values()], actions: [...actions.values()], off: [...off], layers, trusted }
}

// ────────────────────────────────────────────────────────────────────────────
// Совпадения в тексте
// ────────────────────────────────────────────────────────────────────────────

/** Шаблон, готовый к поиску (флаг `g` уже стоит). */
export interface CompiledLinkPattern {
  /** Id резолвера. */
  resolver: string
  /** Id правила (у резолвера с одним шаблоном — его id). */
  rule: string
  re: RegExp
  /** Меньше — сильнее. */
  order: number
}

export interface LinkHit {
  start: number
  end: number
  text: string
  resolver: string
  rule: string
  groups: string[]
  named: Record<string, string>
}

/** Шаблон с флагом `g` (без него `matchAll` бросает); пустой — `null`. */
export function globalPattern(re: RegExp | null | undefined): RegExp | null {
  if (!re || re.source === '(?:)') return null
  return re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`)
}

/** Строка regex из правила данных → шаблон; битый — `null`, причина — в `onError`. */
export function patternFrom(source: string, id: string, onError?: (id: string, err: unknown) => void): RegExp | null {
  try {
    return globalPattern(new RegExp(source, 'gu'))
  } catch {
    try {
      return globalPattern(new RegExp(source, 'g'))
    } catch (err) {
      onError?.(id, err)
      return null
    }
  }
}

/** Хвостовая пунктуация совпадения — не часть ссылки (`см. TASK-10.`, `(https://x)`). */
const TRAILING = /[.,;:!?)\]»"'”’…]+$/

/** Все ссылки текста: длиннее — побеждает, равные — сильнее (`order` меньше), дальше — раньше зарегистрированный. */
export function findLinkHits(text: string, patterns: readonly CompiledLinkPattern[], opts: { trimTrailing?: (resolver: string) => boolean } = {}): LinkHit[] {
  if (patterns.length === 0 || text === '') return []
  const all: Array<LinkHit & { order: number; seq: number }> = []
  patterns.forEach((p, seq) => {
    p.re.lastIndex = 0
    for (const m of text.matchAll(p.re)) {
      let raw = m[0]
      if (raw === '') continue
      if (opts.trimTrailing?.(p.resolver)) raw = raw.replace(TRAILING, '')
      if (raw === '') continue
      const start = m.index!
      const named: Record<string, string> = {}
      for (const [k, v] of Object.entries(m.groups ?? {})) if (typeof v === 'string') named[k] = v
      all.push({ start, end: start + raw.length, text: raw, resolver: p.resolver, rule: p.rule, groups: m.slice(1).map((g) => g ?? ''), named, order: p.order, seq })
    }
  })
  all.sort((a, b) => b.end - b.start - (a.end - a.start) || a.order - b.order || a.seq - b.seq || a.start - b.start)
  const taken: LinkHit[] = []
  for (const h of all) {
    if (taken.some((t) => h.start < t.end && t.start < h.end)) continue
    const { order: _o, seq: _s, ...hit } = h
    taken.push(hit)
  }
  return taken.sort((a, b) => a.start - b.start)
}

/** Сила слоя: меньше — сильнее. */
const LAYER_ORDER: Record<LinkLayer, number> = { agent: 0, space: 1, user: 2, stand: 3 }

/** Совпадение целого слова с правилом (командная строка). */
export interface LinkMatch {
  rule: LinkRuleDef
  groups: string[]
  named: Record<string, string>
  /** Длина совпадения (= длина слова). */
  length: number
}

/**
 * Слово целиком → правила, которые его покрывают (kd-cli-spec §4): самое длинное совпадение,
 * при равных — сильнее слой, дальше — порядок правил. Правила без `$pattern` не участвуют.
 * Совпадение не во всё слово — не совпадение.
 */
export function matchWord(word: string, rules: readonly LinkRuleDef[], onError?: (id: string, err: unknown) => void): LinkMatch[] {
  const out: Array<LinkMatch & { order: number; seq: number }> = []
  rules.forEach((rule, seq) => {
    if (!rule.pattern) return
    const re = patternFrom(rule.pattern, rule.id, onError)
    if (!re) return
    re.lastIndex = 0
    for (const m of word.matchAll(re)) {
      // Хвостовая пунктуация из шаблона не считается: слово командной строки уже отделено.
      if (m.index !== 0 || m[0].length !== word.length) continue
      const named: Record<string, string> = {}
      for (const [k, v] of Object.entries(m.groups ?? {})) if (typeof v === 'string') named[k] = v
      out.push({ rule, groups: m.slice(1).map((g) => g ?? ''), named, length: m[0].length, order: LAYER_ORDER[rule.layer] ?? 9, seq })
      break
    }
  })
  out.sort((a, b) => b.length - a.length || a.order - b.order || a.seq - b.seq)
  return out.map(({ order: _o, seq: _s, ...m }) => m)
}

/** Действия правила: `$for` — id правила или его `$kind`; сильный слой первым, `$default` — первым из равных. */
export function actionsFor(rules: LinkRules, rule: LinkRuleDef): LinkActionDef[] {
  const off = new Set(rules.off)
  return rules.actions
    .filter((a) => !off.has(a.id) && (a.for === rule.id || (rule.kind !== undefined && a.for === rule.kind)))
    .sort((a, b) => Number(b.default === true) - Number(a.default === true) || (LAYER_ORDER[a.layer] ?? 9) - (LAYER_ORDER[b.layer] ?? 9))
}
