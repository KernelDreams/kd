/**
 * Общее ядро конвертеров тем (skin-convert-spec §1): Obsidian, SillyTavern, VS Code и внешние (реестр
 * `registerThemeConverter`) →
 * `.skin.css` (цель `skin`) или CSS темы бота (цель `bot`). Без IO — текст на входе.
 *
 * Конвейер источника: разбор → карта переменных → проекция селекторов → ручки → шрифты; ядро даёт
 * общее: цвета (смесь, сплошной цвет из `background`, градиент), вывод недостающих токенов уровня A
 * из фона и текста, подтяжку контраста до 4.5:1, px → rem с полом читаемости, сборку CSS под цель,
 * линтер и отчёт покрытия.
 *
 * Покрытие считается по контракту (`contract.ts`): «легло» — в токен или в свойство звена из
 * контракта; «приближено» — перенесено с потерей; «вне контракта» — перенесено как есть (линтер
 * предупреждает); «не легло» — правило под чужой DOM, которому в ленте не на что лечь.
 */

import { ELEMENT_PROPERTIES, REQUIRED_TOKENS, type SkinMode } from '../contract.js'
import { CONTRAST_MIN, contrastRatio, over, parseColor, ROOT_PX, TEXT_BASE_MIN_PX, type Rgba } from '../readability.js'
import { BOT_ROOT, formatHeader, validateBotCss, validateSkin, type SkinHeader, type ValidateResult } from '../skin.js'

export type ConvertTarget = 'skin' | 'bot'
/** Источник темы: встроенные и id внешних конвертеров (`registerThemeConverter`). */
export type ConvertSource = 'obsidian' | 'sillytavern' | 'vscode' | (string & {})
export type PaletteMode = 'light' | 'dark'

// ────────────────────────────────────────────────────────────────────────────
// Цвета и значения
// ────────────────────────────────────────────────────────────────────────────

export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }
export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }

const hex2 = (n: number): string =>
  Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0')
export const toHex = (c: Rgba): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 1 ? hex2(c.a * 255) : ''}`
export const mix = (a: Rgba, b: Rgba, t: number): Rgba => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t })
export const isLight = (c: Rgba): boolean => contrastRatio(c, BLACK) > contrastRatio(c, WHITE)

/** HSL → hex (акцент Obsidian `--accent-h/s/l`). */
export function hslHex(h: number, s: number, l: number): string {
  const S = s / 100
  const L = l / 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n: number): number => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return toHex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: 1 })
}

/** Подставить `var(--x[, запас])` из словаря рекурсивно; неизвестная без запаса — как есть. */
export function resolveVars(value: string, vars: Readonly<Record<string, string>>, depth = 0): string {
  if (depth > 10 || !value.includes('var(')) return value
  let out = ''
  let i = 0
  while (i < value.length) {
    const at = value.indexOf('var(', i)
    if (at < 0) {
      out += value.slice(i)
      break
    }
    out += value.slice(i, at)
    let j = at + 4
    let level = 1
    for (; j < value.length && level > 0; j++) {
      if (value[j] === '(') level++
      else if (value[j] === ')') level--
    }
    const inner = value.slice(at + 4, j - 1)
    const comma = topLevelComma(inner)
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim()
    const hit = vars[name] ?? fallback
    out += hit === undefined ? value.slice(at, j) : resolveVars(hit, vars, depth + 1)
    i = j
  }
  return out
}

function topLevelComma(s: string): number {
  let level = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') level++
    else if (s[i] === ')') level--
    else if (s[i] === ',' && level === 0) return i
  }
  return -1
}

/** Сплошной цвет из `background` (первый слой без картинки и градиента) — или null. */
export function solidColor(value: string): string | null {
  const v = value.trim()
  if (/url\(|gradient\(/i.test(v)) return null
  if (parseColor(v)) return v
  // `background: #fff no-repeat …` — цвет первым словом.
  const first = v.split(/\s+(?![^(]*\))/)[0] ?? ''
  return parseColor(first) ? first : null
}

/** Градиент без картинок — средний цвет его стопов (фон под текст), иначе null. */
export function gradientColor(value: string): string | null {
  const m = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/i.exec(value.trim())
  if (!m) return null
  const stops: Rgba[] = []
  let level = 0
  let cur = ''
  for (const ch of `${m[1]!},`) {
    if (ch === '(') level++
    if (ch === ')') level--
    if (ch === ',' && level === 0) {
      const c = cur.trim().split(/\s+(?![^(]*\))/)[0] ?? ''
      const rgba = parseColor(c)
      if (rgba) stops.push(rgba)
      cur = ''
    } else cur += ch
  }
  if (!stops.length) return null
  const n = stops.length
  return toHex(stops.reduce((a, c) => ({ r: a.r + c.r / n, g: a.g + c.g / n, b: a.b + c.b / n, a: a.a + c.a / n }), { r: 0, g: 0, b: 0, a: 0 }))
}

/** Цвет рамки из `border: 2px solid #8b4513`. */
export function borderColor(value: string): string | null {
  for (const part of value.split(/\s+(?![^(]*\))/)) if (parseColor(part)) return part
  return null
}

/** Кегль px/rem/em → rem не мельче `minPx` (читаемость); `scale` — множитель. Не размер — null. */
export function remSize(value: string, minPx = TEXT_BASE_MIN_PX, scale = 1): string | null {
  const v = value.trim()
  const px = /^([\d.]+)px$/.exec(v)
  const rem = /^([\d.]+)r?em$/.exec(v)
  const n = px ? Number(px[1]) : rem ? Number(rem[1]) * ROOT_PX : NaN
  if (!Number.isFinite(n)) return null
  return `${round4(Math.max(n * scale, minPx) / ROOT_PX)}rem`
}

export const round4 = (n: number): number => Math.round(n * 10000) / 10000

// ────────────────────────────────────────────────────────────────────────────
// Палитра: набор токенов с источниками, вывод недостающих, контраст
// ────────────────────────────────────────────────────────────────────────────

export interface TokenSource {
  token: string
  value: string
  /** `var --color-primary` | `rule strong.color` | `key main_text_color` | `derived …` | `contrast …` */
  from: string
  /** Режим палитры, если токен режимный. */
  mode?: PaletteMode
}

/** Токены одного слоя (общий или режим) с журналом «откуда». */
export class TokenSet {
  readonly tokens: Record<string, string> = {}
  readonly sources: TokenSource[] = []
  constructor(readonly mode?: PaletteMode) {}
  set(token: string, value: string, from: string): void {
    this.tokens[token] = value
    const i = this.sources.findIndex((s) => s.token === token)
    if (i >= 0) this.sources.splice(i, 1)
    this.sources.push({ token, value, from, ...(this.mode ? { mode: this.mode } : {}) })
  }
  has(token: string): boolean {
    return token in this.tokens
  }
}

export interface DeriveOptions {
  /** Режим, если известен из источника (VS Code `type`, Obsidian `.theme-dark`); нет — по яркости фона. */
  mode?: PaletteMode
  /**
   * Декор поверх чужого скина (цель `bot`): фон окна и колонки, отбивка, фокус, курсив, имена — от
   * палитры темы, иначе голубое имя игрока или текстура скина остаются поверх пергамента темы.
   */
  decor?: boolean
}

/**
 * Вывести недостающие токены уровня A (и декор для `bot`) от фона и текста. Полупрозрачный фон —
 * поверх белого (светлый) / чёрного (тёмный), если режим известен; иначе поверх белого. Возвращает
 * режим палитры (по фону) или null, если фона нет.
 */
export function derivePalette(t: TokenSet, opts: DeriveOptions = {}): PaletteMode | null {
  const tokens = t.tokens
  const set = t.set.bind(t)
  const bg = tokens['--nr-bg'] ? parseColor(tokens['--nr-bg']) : null
  const under = opts.mode === 'dark' ? BLACK : WHITE
  const bgSolid = bg ? (bg.a < 1 ? over(bg, under) : bg) : null
  if (bgSolid && bg && bg.a < 1) set('--nr-bg', toHex(bgSolid), `derived --nr-bg поверх ${opts.mode === 'dark' ? 'чёрного' : 'белого'} (${tokens['--nr-bg']})`)
  const mode: PaletteMode | null = opts.mode ?? (bgSolid ? (isLight(bgSolid) ? 'light' : 'dark') : null)
  if (!bgSolid) return mode
  const fg = tokens['--nr-fg'] ? parseColor(tokens['--nr-fg']) : null
  if (!fg) set('--nr-fg', mode === 'light' ? '#1a1a1a' : '#ececec', 'derived текст по режиму фона')
  const fgC = parseColor(tokens['--nr-fg'] ?? '') ?? (mode === 'light' ? BLACK : WHITE)
  // Полупрозрачные подложки — сплошным цветом поверх фона: панели лежат не на ленте, а контраст считается к ним.
  for (const name of ['--nr-surface', '--nr-raised']) {
    const c = tokens[name] ? parseColor(tokens[name]!) : null
    if (c && c.a < 1) set(name, toHex(over(c, bgSolid)), `derived ${tokens[name]} поверх --nr-bg`)
  }
  if (!tokens['--nr-surface']) set('--nr-surface', toHex(mix(bgSolid, fgC, 0.05)), 'derived фон 5% к тексту')
  if (!tokens['--nr-raised']) set('--nr-raised', toHex(mix(bgSolid, fgC, 0.09)), 'derived фон 9% к тексту')
  if (!tokens['--nr-muted']) set('--nr-muted', toHex(mix(fgC, bgSolid, 0.3)), 'derived текст 30% к фону')
  if (!tokens['--nr-line']) set('--nr-line', toHex(mix(bgSolid, fgC, 0.2)), 'derived фон 20% к тексту')
  if (!tokens['--nr-accent']) set('--nr-accent', toHex(fgC), 'derived = текст (акцента нет)')
  const line = parseColor(tokens['--nr-line']!)
  if (line && !tokens['--nr-line-soft']) set('--nr-line-soft', toHex(line.a < 1 ? { ...line, a: line.a * 0.5 } : mix(line, bgSolid, 0.5)), 'derived линия вполсилы')
  if (!tokens['--nr-ok']) set('--nr-ok', mode === 'light' ? '#2f6b2f' : '#8fd18f', 'derived статус по режиму фона')
  if (!tokens['--nr-error']) set('--nr-error', mode === 'light' ? '#a32020' : '#ff8a80', 'derived статус по режиму фона')
  if (!tokens['--nr-shadow-pop']) set('--nr-shadow-pop', mode === 'light' ? '0 6px 20px rgba(0, 0, 0, 0.18)' : '0 10px 30px rgba(0, 0, 0, 0.5)', 'derived тень по режиму фона')
  if (opts.decor) {
    if (!tokens['--nr-bg-app']) set('--nr-bg-app', tokens['--nr-bg']!, 'derived = --nr-bg (декор скина снят)')
    if (!tokens['--nr-bg-chat']) set('--nr-bg-chat', tokens['--nr-bg']!, 'derived = --nr-bg (декор скина снят)')
    if (!tokens['--nr-rule']) set('--nr-rule', tokens['--nr-line']!, 'derived = --nr-line')
    if (!tokens['--nr-focus']) set('--nr-focus', tokens['--nr-accent']!, 'derived = --nr-accent')
    if (!tokens['--nr-em']) set('--nr-em', tokens['--nr-fg']!, 'derived = --nr-fg')
    set('--nr-author-assistant', tokens['--nr-accent']!, 'derived = --nr-accent')
    set('--nr-author-user', tokens['--nr-muted']!, 'derived = --nr-muted')
  }
  const accent = parseColor(tokens['--nr-accent']!)
  if (accent && !tokens['--nr-accent-fg']) set('--nr-accent-fg', contrastRatio(BLACK, accent) >= contrastRatio(WHITE, accent) ? '#000000' : '#ffffff', 'derived чёрный/белый по контрасту к акценту')
  return mode
}

/** Токены, которые подтягиваются до контраста к фону и подложке. */
export const LIFT_TOKENS: readonly string[] = ['--nr-fg', '--nr-muted', '--nr-accent', '--nr-ok', '--nr-error', '--nr-em']

/**
 * Контраст: текст, акцент, статусы к фону и подложке — не ниже 4.5:1; тот же оттенок
 * темнее (светлый режим) или светлее (тёмный) шагами по 5%. Имена (декор `bot`) — следом за акцентом.
 */
export function liftContrast(t: TokenSet, mode: PaletteMode | null): void {
  const tokens = t.tokens
  const bg = parseColor(tokens['--nr-bg'] ?? '')
  if (!bg || !mode) return
  const bgSolid = bg.a < 1 ? over(bg, mode === 'dark' ? BLACK : WHITE) : bg
  const surface = parseColor(tokens['--nr-surface'] ?? '')
  const backs = [bgSolid, surface ? over(surface, bgSolid) : null].filter((x): x is Rgba => x !== null)
  const toward = mode === 'light' ? BLACK : WHITE
  for (const name of LIFT_TOKENS) {
    const c0 = parseColor(tokens[name] ?? '')
    if (!c0) continue
    const solid = c0.a < 1 ? over(c0, bgSolid) : c0
    const worst = (c: Rgba): number => Math.min(...backs.map((b) => contrastRatio(c, b)))
    if (worst(solid) + 1e-9 >= CONTRAST_MIN) continue
    let k = 0
    let c = solid
    while (worst(c) + 1e-9 < CONTRAST_MIN && k < 1) {
      k = Math.min(1, k + 0.05)
      c = mix(solid, toward, k)
    }
    const before = tokens[name]!
    t.set(name, toHex(c), `contrast ${before} → ${CONTRAST_MIN}:1 (${Math.round(k * 100)}% к ${mode === 'light' ? 'чёрному' : 'белому'})`)
  }
  // Имена — после подтяжки: те же значения, что у акцента и вторичного.
  if (tokens['--nr-author-assistant']) t.set('--nr-author-assistant', tokens['--nr-accent']!, 'derived = --nr-accent')
  if (tokens['--nr-author-user']) t.set('--nr-author-user', tokens['--nr-muted']!, 'derived = --nr-muted')
}

// ────────────────────────────────────────────────────────────────────────────
// Свойства: контракт, вне контракта, вёрстка
// ────────────────────────────────────────────────────────────────────────────

/** Свойства вёрстки: правило под чужой DOM, у нас ломает раскладку ленты — не переносятся. */
const LAYOUT_RE = /^(display|position|top|right|bottom|left|inset.*|float|clear|z-index|margin.*|width|height|min-.*|max-.*|flex.*|grid.*|order|align-.*|justify-.*|place-.*|gap|row-gap|column-gap|transform.*|translate|rotate|scale|content|overflow.*|visibility|pointer-events|cursor|transition.*|animation.*|will-change|contain|resize|user-select|-webkit-.*|-moz-.*|-ms-.*|appearance|columns?.*|box-sizing|vertical-align|white-space|word-break|overflow-wrap|text-align|text-indent|list-style.*|counter-.*|table-layout|border-collapse|border-spacing|aspect-ratio|object-.*|backface-visibility|perspective.*)$/

export type PropClass = 'contract' | 'outside' | 'layout'

/** Свойство элементного правила: по контракту, вне контракта (переносится, линтер предупредит) или вёрстка. */
export function classifyProp(prop: string): PropClass {
  const p = prop.toLowerCase()
  if (ELEMENT_PROPERTIES.includes(p)) return 'contract'
  if (LAYOUT_RE.test(p)) return 'layout'
  return 'outside'
}

// ────────────────────────────────────────────────────────────────────────────
// Отчёт
// ────────────────────────────────────────────────────────────────────────────

export interface ConvertDropped {
  /** Селектор, переменная, ключ или at-правило источника. */
  what: string
  why: string
  line?: number
}

export interface ConvertMapped {
  /** Что в источнике: переменная, ключ, селектор. */
  from: string
  /** Куда: токен, звено ленты или `tokens`. */
  nr: string
  props: string[]
}

export interface ConvertApproximated {
  from: string
  nr: string
  /** Что потеряно. */
  note: string
}

export interface ConvertReport {
  mapped: ConvertMapped[]
  approximated: ConvertApproximated[]
  dropped: ConvertDropped[]
  /** Перенесено как есть вне контракта (линтер предупреждает): `.nr-text: filter ×2`. */
  outside: Record<string, number>
  /** Свойства вёрстки, срезанные у перенесённых звеньев: `.nr-text: margin ×3`. */
  droppedProps: Record<string, number>
  /** Единиц на входе (визуальные переменные, ключи, объявления правил) / сколько легло по контракту. */
  total: number
  kept: number
  /** Из `total` — под чужой интерфейс (рабочая область Obsidian, `#chat` ST): лечь не на что, в покрытие не входят. */
  foreign: number
  /** kept / (total − foreign), 0…1 (приближённое считается половиной). */
  coverage: number
  /** Что добить агентом — короткими строками (skin-convert-spec §5). */
  todo: string[]
}

/** Счётчик единиц покрытия. */
export class Coverage {
  total = 0
  kept = 0
  approx = 0
  foreign = 0
  readonly mapped: ConvertMapped[] = []
  readonly approximated: ConvertApproximated[] = []
  readonly dropped: ConvertDropped[] = []
  readonly outside: Record<string, number> = {}
  readonly droppedProps: Record<string, number> = {}
  /** Единица легла по контракту. */
  keep(from: string, nr: string, prop?: string): void {
    this.total++
    this.kept++
    const m = this.mapped.find((x) => x.from === from && x.nr === nr)
    if (m) {
      if (prop && !m.props.includes(prop)) m.props.push(prop)
    } else this.mapped.push({ from, nr, props: prop ? [prop] : [] })
  }
  /** Единица перенесена с потерей. */
  approximate(from: string, nr: string, note: string): void {
    this.total++
    this.approx++
    if (!this.approximated.some((x) => x.from === from && x.nr === nr)) this.approximated.push({ from, nr, note })
  }
  /** Перенесено вне контракта (как есть). */
  carry(nr: string, prop: string): void {
    this.total++
    const k = `${nr}: ${prop}`
    this.outside[k] = (this.outside[k] ?? 0) + 1
  }
  /** Единица не легла; `foreign` — под чужой интерфейс, которого в nrchat нет (в покрытие не входит). */
  drop(what: string, why: string, line?: number, n = 1, foreign = false): void {
    this.total += n
    if (foreign) this.foreign += n
    this.dropped.push({ what, why, ...(line ? { line } : {}) })
  }
  /** Свойство вёрстки у перенесённого звена. */
  dropProp(nr: string, prop: string): void {
    this.total++
    const k = `${nr}: ${prop}`
    this.droppedProps[k] = (this.droppedProps[k] ?? 0) + 1
  }
  report(todo: string[] = []): ConvertReport {
    const base = this.total - this.foreign
    const coverage = base > 0 ? Math.round(((this.kept + this.approx / 2) / base) * 1000) / 1000 : 1
    return {
      mapped: this.mapped,
      approximated: this.approximated,
      dropped: this.dropped,
      outside: this.outside,
      droppedProps: this.droppedProps,
      total: this.total,
      kept: this.kept,
      foreign: this.foreign,
      coverage,
      todo,
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Результат и сборка CSS
// ────────────────────────────────────────────────────────────────────────────

export interface ConvertResult {
  source: ConvertSource
  target: ConvertTarget
  /** Имя скина (цель `skin`). */
  name?: string
  /** Шапка скина (цель `skin`). */
  header?: SkinHeader & { name: string }
  css: string
  /** Общие токены (для одной палитры без режима — вся палитра). */
  tokens: Record<string, string>
  /** Токены по режимам (тема с light и dark). */
  palettes: Partial<Record<PaletteMode, Record<string, string>>>
  sources: TokenSource[]
  /** Какие режимы несёт тема; null — палитры нет (не нашлось фона). */
  mode: SkinMode | null
  /** Таблицы шрифтов (`@import` хостов шрифтов). */
  fonts: string[]
  /** Прочие внешние листы (`@import`). */
  imports: string[]
  report: ConvertReport
  /** Линтер выхода: `validateSkin` (skin) / `validateBotCss` (bot). */
  lint: ValidateResult
}

export interface ConvertOptions {
  /** Цель; по умолчанию `skin` (внешний конвертер, вызванный напрямую, может выбрать свою). */
  target?: ConvertTarget
  /** Имя скина (цель `skin`); нет — из темы. */
  name?: string
  /** Подпись источника: в шапку `source:` и комментарий выхода (файл, репа, бот). */
  source?: string
  license?: string
  author?: string
  description?: string
}

/** Элементное правило выхода: звено(я) ленты после корня. */
export interface ElementRule {
  /** Селектор после корня (`.nr-text em`, `.nr-message[data-role=user]`); пусто — сам корень (вариант под классом). */
  sel: string
  mode?: PaletteMode
  /** Класс ручки на корне (`[data-skin="x"].<класс>`). */
  handle?: string
  props: Map<string, string>
}

export interface EmitSpec {
  target: ConvertTarget
  header?: SkinHeader & { name: string }
  comment?: string
  /** Адреса `@import` (шрифты, внешние листы). */
  imports: readonly string[]
  fontFaces?: readonly string[]
  /** Блоки `/* @settings … *​/` как есть. */
  settings?: readonly string[]
  common: Readonly<Record<string, string>>
  palettes?: Partial<Record<PaletteMode, Readonly<Record<string, string>>>>
  elements?: readonly ElementRule[]
  /** Сырой CSS в конец (переписанные at-правила). */
  extra?: readonly string[]
}

/** Корень правила под цель. */
export function rootOf(target: ConvertTarget, name: string | undefined, mode?: PaletteMode, handle?: string): string {
  const h = handle ? `.${handle}` : ''
  if (target === 'bot') return `${mode ? `[data-skin][data-mode="${mode}"]` : BOT_ROOT}${h}`
  return `[data-skin="${name}"]${mode ? `[data-mode="${mode}"]` : ''}${h}`
}

const block = (sel: string, entries: Iterable<[string, string]>): string | null => {
  const lines = [...entries].map(([k, v]) => `  ${k}: ${v.replace(/\s*!important\s*$/i, '')};`)
  return lines.length ? `${sel} {\n${lines.join('\n')}\n}` : null
}

/** Собрать CSS выхода: шапка, `@import`, `@font-face`, ручки, токены, элементные правила. */
export function emitCss(spec: EmitSpec): string {
  const name = spec.header?.name
  const out: string[] = []
  if (spec.target === 'skin') {
    if (!spec.header) throw new Error('emitCss: цель skin — нужна шапка с именем')
    out.push(formatHeader(spec.header).trimEnd())
  }
  if (spec.comment) out.push(`/* ${spec.comment.replace(/\*\//g, '* /')} */`)
  for (const u of spec.imports) out.push(`@import url("${u.replace(/"/g, '%22')}");`)
  out.push(...(spec.fontFaces ?? []))
  out.push(...(spec.settings ?? []))
  const common = block(rootOf(spec.target, name), Object.entries(spec.common))
  if (common) out.push(common)
  for (const mode of ['light', 'dark'] as const) {
    const p = spec.palettes?.[mode]
    const b = p ? block(rootOf(spec.target, name, mode), Object.entries(p)) : null
    if (b) out.push(b)
  }
  for (const e of spec.elements ?? []) {
    const b = block(`${rootOf(spec.target, name, e.mode, e.handle)}${e.sel ? ` ${e.sel}` : ''}`, e.props)
    if (b) out.push(b)
  }
  out.push(...(spec.extra ?? []))
  return `${out.join('\n')}\n`
}

/** Линтер выхода под цель. */
export function lintOf(target: ConvertTarget, css: string, name?: string): ValidateResult {
  return target === 'skin' ? validateSkin(css, name ? { name } : {}) : validateBotCss(css)
}

/** Имя скина из названия темы: латиница, дефис, с буквы, до 40. */
export function skinName(raw: string, fallback = 'imported'): string {
  const s = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.(skin\.)?(css|json|vsix)$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return s || fallback
}

/** Токены уровня A, которых нет в палитре (для отчёта и тестов). */
export function missingRequired(tokens: Readonly<Record<string, string>>): string[] {
  return REQUIRED_TOKENS.filter((t) => !(t in tokens))
}

/** Пункты «добить агентом» по итогу конверсии. */
export function todoOf(r: Pick<ConvertResult, 'sources' | 'lint'> & { report: Pick<ConvertReport, 'dropped' | 'approximated' | 'outside'> }): string[] {
  const out: string[] = []
  const derived = r.sources.filter((s) => s.from.startsWith('derived')).map((s) => s.token)
  if (derived.length) out.push(`проверить выведенные токены (${[...new Set(derived)].slice(0, 8).join(', ')}${derived.length > 8 ? '…' : ''}) — в теме их не было`)
  const lifted = r.sources.filter((s) => s.from.startsWith('contrast')).map((s) => s.token)
  if (lifted.length) out.push(`контраст подтянут у ${[...new Set(lifted)].join(', ')} — сверить с оригиналом на глаз`)
  if (r.report.approximated.length) out.push(`приближённое (${r.report.approximated.length}) — сверить «было | стало»`)
  const outside = Object.keys(r.report.outside).length
  if (outside) out.push(`${outside} свойств вне контракта перенесены как есть — переложить на токены или оставить`)
  if (r.report.dropped.length) out.push(`не легло ${r.report.dropped.length} правил — посмотреть, есть ли у нас похожее звено`)
  if (r.lint.warnings.length) out.push(`предупреждений линтера: ${r.lint.warnings.length}`)
  return out
}

/** Отчёт покрытия текстом (markdown) — `report.md`, задача, ответ тула. */
export function formatReport(r: ConvertResult, title = r.name ?? 'тема'): string {
  const c = r.report
  // «Не легло» — по причине: число и до трёх примеров (у тем Obsidian их тысячи).
  const byWhy = new Map<string, string[]>()
  for (const d of c.dropped) byWhy.set(d.why, [...(byWhy.get(d.why) ?? []), d.what])
  const lines = [
    `## ${title}`,
    '',
    `- источник: ${r.source}${r.header?.source ? ` (${r.header.source})` : ''}; цель: ${r.target}${r.header?.license ? `; лицензия: ${r.header.license}` : ''}`,
    `- режим: ${r.mode ?? '—'}; токенов: ${Object.keys(r.tokens).length + Object.values(r.palettes).reduce((a, p) => a + Object.keys(p ?? {}).length, 0)}`,
    `- покрытие по контракту: ${Math.round(c.coverage * 100)}% (легло ${c.kept} из ${c.total - c.foreign}${c.approximated.length ? `, приближено ${c.approximated.length}` : ''}${c.foreign ? `; под чужой интерфейс, лечь не на что: ${c.foreign}` : ''})`,
    `- линтер: ${r.lint.ok ? 'ok' : 'ошибки'}${r.lint.errors.length ? ' — ' + r.lint.errors.map((e) => e.message).join('; ') : ''}${r.lint.warnings.length ? `; предупреждений: ${r.lint.warnings.length}` : ''}`,
    `- шрифты: ${r.fonts.length ? r.fonts.join(', ') : '—'}${r.imports.length ? `; внешние листы: ${r.imports.join(', ')}` : ''}`,
    '',
    '### Токены',
    '',
    '| токен | режим | значение | откуда |',
    '|---|---|---|---|',
    ...r.sources.map((s) => `| \`${s.token}\` | ${s.mode ?? '—'} | \`${s.value}\` | ${s.from} |`),
    '',
    '### Легло',
    '',
    ...c.mapped.map((m) => `- \`${m.from}\` → \`${m.nr}\`${m.props.length ? ` (${m.props.join(', ')})` : ''}`),
  ]
  if (c.approximated.length) lines.push('', '### Приближено', '', ...c.approximated.map((a) => `- \`${a.from}\` → \`${a.nr}\` — ${a.note}`))
  if (Object.keys(c.outside).length) lines.push('', '### Вне контракта (перенесено как есть)', '', ...Object.entries(c.outside).map(([k, n]) => `- \`${k}\`${n > 1 ? ` ×${n}` : ''}`))
  lines.push(
    '',
    '### Не легло',
    '',
    ...[...byWhy].map(([why, list]) => {
      const uniq = [...new Set(list)]
      return `- ${why}${list.length > 1 ? ` (×${list.length})` : ''}: ${uniq.slice(0, 3).map((w) => `\`${w.slice(0, 80)}\``).join(', ')}${uniq.length > 3 ? ', …' : ''}`
    }),
    ...Object.entries(c.droppedProps).map(([k, n]) => `- свойство \`${k}\`${n > 1 ? ` ×${n}` : ''} — вне контракта звена (вёрстка, размеры, состояния)`),
  )
  if (r.lint.warnings.length) lines.push('', '### Линтер', '', ...r.lint.warnings.slice(0, 30).map((w) => `- ${w.line ? `строка ${w.line}: ` : ''}${w.message}`), ...(r.lint.warnings.length > 30 ? [`- … ещё ${r.lint.warnings.length - 30}`] : []))
  if (c.todo.length) lines.push('', '### Хвост добить агентом', '', ...c.todo.map((t) => `- ${t}`))
  lines.push('')
  return lines.join('\n')
}

/** Блоки ручек `/* @settings … *​/` (Style Settings) как есть. */
export function settingsBlocksOf(text: string): string[] {
  return [...text.matchAll(/\/\*\s*@settings\b[\s\S]*?\*\//g)].map((m) => m[0])
}

/** Шапка скина выхода из опций и данных темы. */
export function headerOf(name: string, mode: SkinMode | null, opts: ConvertOptions, theme: { description?: string; author?: string; license?: string } = {}): SkinHeader & { name: string } {
  const description = opts.description ?? theme.description
  const author = opts.author ?? theme.author
  const license = opts.license ?? theme.license
  return {
    name,
    ...(description ? { description } : {}),
    mode: mode ?? 'both',
    ...(opts.source ? { source: opts.source } : {}),
    ...(license ? { license } : {}),
    ...(author ? { author } : {}),
  }
}

/** Первое значение подходящего вида у токена — или null. */
export function tokenValue(kind: 'color' | 'font' | 'size' | 'number' | 'length' | 'shadow', raw: string): string | null {
  const v = raw.trim()
  if (!v || /var\(/.test(v) || /url\(/i.test(v)) return null
  switch (kind) {
    case 'color':
      return solidColor(v) ?? borderColor(v) ?? gradientColor(v)
    case 'font':
      return /^[\w\s'",-]+$/.test(v) ? v : null
    case 'size': {
      const px = /^([\d.]+)px$/.exec(v)
      if (px) return `${Math.max(Number(px[1]), TEXT_BASE_MIN_PX) / ROOT_PX}rem`
      const rem = /^([\d.]+)rem$/.exec(v)
      return rem ? `${Math.max(Number(rem[1]), TEXT_BASE_MIN_PX / ROOT_PX)}rem` : null
    }
    case 'number':
      return /^[\d.]+$/.test(v) && Number(v) >= 1 && Number(v) <= 3 ? v : null
    case 'length':
      return /^[\d.]+(px|rem|em)$|^0$/.test(v) ? v : null
    case 'shadow':
      return v === 'none' || /\d/.test(v) ? v : null
  }
}
