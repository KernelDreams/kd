/**
 * Конвертер темы Obsidian (`theme.css` + `manifest.json`) → `.skin.css` (skin-convert-spec §2).
 *
 * Тема Obsidian — переменные (`--background-primary`, `--text-normal`, `--interactive-accent`…) по
 * режимам `.theme-light` / `.theme-dark` плюс правила под DOM Obsidian. Переменные ложатся в токены
 * `--nr-*` (недостающие — из шкалы `--color-base-*` и умолчаний Obsidian, затем вывод ядра), правила
 * разметки заметки (`.markdown-rendered …`) — в `.nr-text …`, ручки Style Settings переносятся как
 * есть, `body.<класс>` — `[data-skin="<имя>"].<класс>`. Интерфейс Obsidian (рабочая область, вкладки,
 * граф, статус-бар) — в отчёт «не легло».
 */

import * as csstree from 'css-tree'
import { FONT_HOSTS, TEXT_TAGS } from './contract.js'
import { evalColor } from './convert/color.js'
import {
  classifyProp,
  Coverage,
  derivePalette,
  emitCss,
  headerOf,
  liftContrast,
  lintOf,
  resolveVars,
  settingsBlocksOf,
  skinName,
  todoOf,
  toHex,
  TokenSet,
  type ConvertOptions,
  type ConvertResult,
  type ElementRule,
  type PaletteMode,
} from './convert/core.js'
import type { SkinMode } from './contract.js'

// ────────────────────────────────────────────────────────────────────────────
// Таблицы
// ────────────────────────────────────────────────────────────────────────────

export type ObsidianTokenKind = 'color' | 'font' | 'length' | 'shadow'

export interface ObsidianTokenRule {
  token: `--nr-${string}`
  /** Переменные Obsidian по порядку: первая заданная темой (или умолчанием) — источник. */
  vars: readonly string[]
  kind: ObsidianTokenKind
  /** Режимная (цвета) или общая (шрифты, радиусы). */
  modal: boolean
}

/** Переменные Obsidian → токены (skin-convert-spec §2). */
export const OBSIDIAN_TOKEN_MAP: readonly ObsidianTokenRule[] = [
  { token: '--nr-bg', vars: ['--background-primary', '--color-base-00'], kind: 'color', modal: true },
  { token: '--nr-surface', vars: ['--background-secondary', '--color-base-20'], kind: 'color', modal: true },
  { token: '--nr-raised', vars: ['--background-primary-alt', '--background-modifier-form-field', '--color-base-10'], kind: 'color', modal: true },
  { token: '--nr-fg', vars: ['--text-normal', '--color-base-100'], kind: 'color', modal: true },
  { token: '--nr-muted', vars: ['--text-muted', '--color-base-70'], kind: 'color', modal: true },
  { token: '--nr-line-soft', vars: ['--text-faint', '--color-base-25'], kind: 'color', modal: true },
  { token: '--nr-accent', vars: ['--interactive-accent', '--color-accent', '--text-accent'], kind: 'color', modal: true },
  { token: '--nr-accent-fg', vars: ['--text-on-accent'], kind: 'color', modal: true },
  { token: '--nr-line', vars: ['--background-modifier-border', '--color-base-30'], kind: 'color', modal: true },
  { token: '--nr-ok', vars: ['--text-success', '--color-green'], kind: 'color', modal: true },
  { token: '--nr-error', vars: ['--text-error', '--color-red'], kind: 'color', modal: true },
  { token: '--nr-focus', vars: ['--background-modifier-border-focus', '--interactive-accent-hover'], kind: 'color', modal: true },
  { token: '--nr-em', vars: ['--italic-color'], kind: 'color', modal: true },
  { token: '--nr-rule', vars: ['--hr-color'], kind: 'color', modal: true },
  { token: '--nr-shadow-pop', vars: ['--shadow-s', '--shadow-l'], kind: 'shadow', modal: true },
  { token: '--nr-code-comment', vars: ['--code-comment'], kind: 'color', modal: true },
  { token: '--nr-code-keyword', vars: ['--code-keyword'], kind: 'color', modal: true },
  { token: '--nr-code-string', vars: ['--code-string'], kind: 'color', modal: true },
  { token: '--nr-code-number', vars: ['--code-value'], kind: 'color', modal: true },
  { token: '--nr-code-title', vars: ['--code-function'], kind: 'color', modal: true },
  { token: '--nr-code-type', vars: ['--code-tag'], kind: 'color', modal: true },
  { token: '--nr-code-attr', vars: ['--code-property'], kind: 'color', modal: true },
  { token: '--nr-font-body', vars: ['--font-text-theme', '--font-text'], kind: 'font', modal: false },
  { token: '--nr-font-ui', vars: ['--font-interface-theme', '--font-interface'], kind: 'font', modal: false },
  { token: '--nr-font-mono', vars: ['--font-monospace-theme', '--font-monospace'], kind: 'font', modal: false },
  { token: '--nr-radius', vars: ['--radius-m', '--radius-s', '--radius-l'], kind: 'length', modal: false },
  { token: '--nr-radius-lg', vars: ['--radius-xl', '--radius-l'], kind: 'length', modal: false },
]

/** Переменные Obsidian → свойство тега разметки (`.nr-text <тег>`): заголовки, ссылки, цитата, код. */
export const OBSIDIAN_VAR_ELEMENTS: ReadonlyArray<{ re: RegExp; sel: (m: RegExpExecArray) => string; prop: string }> = [
  ...(['color', 'font', 'weight', 'style', 'variant', 'letter-spacing', 'line-height', 'size'] as const).map((k) => ({
    re: new RegExp(`^--h([1-6])-${k}$`),
    sel: (m: RegExpExecArray) => `h${m[1]}`,
    prop: k === 'color' ? 'color' : k === 'font' ? 'font-family' : k === 'weight' ? 'font-weight' : k === 'style' ? 'font-style' : k === 'variant' ? 'font-variant' : k === 'size' ? 'font-size' : k,
  })),
  { re: /^--link-color$/, sel: () => 'a', prop: 'color' },
  { re: /^--link-decoration$/, sel: () => 'a', prop: 'text-decoration' },
  { re: /^--link-weight$/, sel: () => 'a', prop: 'font-weight' },
  { re: /^--bold-color$/, sel: () => 'strong', prop: 'color' },
  { re: /^--bold-weight$/, sel: () => 'strong', prop: 'font-weight' },
  { re: /^--blockquote-color$/, sel: () => 'blockquote', prop: 'color' },
  { re: /^--blockquote-background-color$/, sel: () => 'blockquote', prop: 'background-color' },
  { re: /^--blockquote-border-color$/, sel: () => 'blockquote', prop: 'border-left-color' },
  { re: /^--blockquote-border-thickness$/, sel: () => 'blockquote', prop: 'border-left-width' },
  { re: /^--blockquote-font-style$/, sel: () => 'blockquote', prop: 'font-style' },
  { re: /^--code-background$/, sel: () => 'code', prop: 'background-color' },
  { re: /^--code-normal$/, sel: () => 'code', prop: 'color' },
]

/**
 * Умолчания Obsidian (app.css 1.x, по памяти — приближённо): ими добиваются переменные, которых
 * тема не задала, иначе цепочки `var()` не замыкаются. Акцент — `254 80% 68%` (skin-convert-spec §2).
 */
export const OBSIDIAN_DEFAULTS: Readonly<Record<'common' | PaletteMode, Readonly<Record<string, string>>>> = {
  common: {
    '--accent-h': '254',
    '--accent-s': '80%',
    '--accent-l': '68%',
    '--background-primary': 'var(--color-base-00)',
    '--background-primary-alt': 'var(--color-base-10)',
    '--background-secondary': 'var(--color-base-20)',
    '--background-modifier-border': 'var(--color-base-30)',
    '--background-modifier-form-field': 'var(--color-base-00)',
    '--text-normal': 'var(--color-base-100)',
    '--text-muted': 'var(--color-base-70)',
    '--text-faint': 'var(--color-base-50)',
    '--text-on-accent': 'white',
    '--color-accent': 'hsl(var(--accent-h), var(--accent-s), var(--accent-l))',
    '--interactive-accent': 'var(--color-accent)',
    '--text-accent': 'var(--color-accent)',
    '--text-error': 'var(--color-red)',
    '--text-success': 'var(--color-green)',
    '--font-text-theme': "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif",
    '--font-interface-theme': "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif",
    '--font-monospace-theme': "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Source Code Pro', monospace",
  },
  light: {
    '--color-base-00': '#ffffff',
    '--color-base-10': '#fafafa',
    '--color-base-20': '#f6f6f6',
    '--color-base-25': '#e3e3e3',
    '--color-base-30': '#e0e0e0',
    '--color-base-50': '#ababab',
    '--color-base-70': '#5a5a5a',
    '--color-base-100': '#222222',
    '--color-red': '#e93147',
    '--color-green': '#08b94e',
  },
  dark: {
    '--color-base-00': '#1e1e1e',
    '--color-base-10': '#242424',
    '--color-base-20': '#262626',
    '--color-base-25': '#2a2a2a',
    '--color-base-30': '#363636',
    '--color-base-50': '#666666',
    '--color-base-70': '#b3b3b3',
    '--color-base-100': '#dadada',
    '--color-red': '#fb464c',
    '--color-green': '#44cf6e',
  },
}

/** Переменные интерфейса Obsidian, которые не переносятся, — почему (по префиксу). */
export const OBSIDIAN_VARS_DROPPED: ReadonlyArray<{ prefix: string; why: string }> = [
  { prefix: '--workspace-', why: 'рабочая область Obsidian — нет в nrchat' },
  { prefix: '--tab-', why: 'вкладки Obsidian — у nrchat свои (dockview)' },
  { prefix: '--nav-', why: 'дерево файлов Obsidian — нет в nrchat' },
  { prefix: '--graph-', why: 'граф — нет в nrchat' },
  { prefix: '--canvas-', why: 'канвас — нет в nrchat' },
  { prefix: '--status-bar-', why: 'статус-бар Obsidian — нет в nrchat' },
  { prefix: '--titlebar-', why: 'заголовок окна Obsidian — нет в nrchat' },
  { prefix: '--ribbon-', why: 'риббон — нет в nrchat' },
  { prefix: '--sidebar-', why: 'сайдбар Obsidian — у nrchat своя панель' },
  { prefix: '--modal-', why: 'модалки Obsidian — нет в nrchat' },
  { prefix: '--prompt-', why: 'палитра Obsidian — у nrchat своя' },
  { prefix: '--file-', why: 'вид файла Obsidian (ширина строки, отступы) — не переносится' },
  { prefix: '--metadata-', why: 'свойства заметки — нет в ленте' },
  { prefix: '--callout-', why: 'callout — у нас цитата, свои цвета не переносятся' },
  { prefix: '--checkbox-', why: 'чекбоксы задач — нет звена в ленте' },
  { prefix: '--table-', why: 'таблицы — нет звена в контракте' },
  { prefix: '--list-', why: 'маркеры списков — нет звена в контракте' },
  { prefix: '--tag-', why: 'теги Obsidian — нет в ленте' },
  { prefix: '--scrollbar-', why: 'полосы прокрутки — не скин' },
  { prefix: '--icon-', why: 'иконки Obsidian — нет в nrchat' },
  { prefix: '--indentation-', why: 'направляющие отступов редактора — нет в ленте' },
  { prefix: '--embed-', why: 'встраивания заметок — нет в ленте' },
  { prefix: '--inline-title-', why: 'заголовок заметки — нет в ленте' },
  { prefix: '--bases-', why: 'Bases — нет в nrchat' },
  { prefix: '--slider-', why: 'контролы Obsidian — нет в nrchat' },
  { prefix: '--toggle-', why: 'контролы Obsidian — нет в nrchat' },
  { prefix: '--input-', why: 'контролы Obsidian — нет в nrchat' },
  { prefix: '--dropdown-', why: 'контролы Obsidian — нет в nrchat' },
  { prefix: '--font-text-size', why: 'размер текста — настройка пользователя (у нас тоже)' },
  { prefix: '--font-ui-', why: 'шкала кеглей интерфейса Obsidian — у nrchat своя' },
  { prefix: '--zoom-', why: 'масштаб — настройка пользователя' },
]

/** Таблица «их селектор → наш» (skin-convert-spec §2) — для отчёта и агента. */
export const OBSIDIAN_SELECTOR_MAP: ReadonlyArray<{ obsidian: string; nr?: string; note: string }> = [
  { obsidian: 'body, :root, .theme-light, .theme-dark', nr: 'tokens', note: 'переменные → токены по режимам' },
  { obsidian: 'body.<класс>, .theme-dark.<класс>', nr: '[data-skin="<имя>"].<класс>', note: 'ручки Style Settings и варианты темы' },
  { obsidian: '.markdown-rendered, .markdown-preview-view', nr: '.nr-text', note: 'разметка заметки = текст реплики' },
  { obsidian: '.markdown-rendered <тег>', nr: '.nr-text <тег>', note: `теги контракта: ${TEXT_TAGS.join(', ')}; прочие (h4–h6, списки, таблицы) — вне контракта, переносятся` },
  { obsidian: '.internal-link, .external-link', nr: '.nr-text a', note: 'ссылки' },
  { obsidian: '.callout[data-callout]', nr: '.nr-text blockquote', note: 'приближённо: callout в ленте нет, `> [!note]` у нас — цитата' },
  { obsidian: '.workspace*, .nav-*, .graph-*, .view-header, .status-bar, .titlebar, .modal, .menu…', note: 'интерфейс Obsidian — нет в nrchat' },
  { obsidian: '.markdown-source-view, .cm-*, .HyperMD-*', note: 'редактор Obsidian — у нас лента, не редактор' },
  { obsidian: '::before, ::after, @media, @keyframes', note: 'псевдоэлементы, адаптив и анимации — не переносятся' },
]

const CONTAINERS = new Set(['markdown-rendered', 'markdown-preview-view', 'markdown-reading-view', 'markdown-preview-section'])
const PASS_ANCESTORS = new Set(['view-content', 'workspace-leaf-content', 'markdown-preview-sizer', 'markdown-preview-pusher'])
const LINK_CLASSES = new Set(['internal-link', 'external-link'])
const TAG_ALIAS: Readonly<Record<string, string>> = { i: 'em', b: 'strong' }
/** Теги нашей разметки реплики (markdown nrchat), кроме контрактных — переносятся вне контракта. */
const FEED_TAGS = new Set([...TEXT_TAGS, 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'del', 's', 'mark', 'sup', 'sub', 'kbd', 'img', 'u', 'span'])
/** Классы состояния окна Obsidian на `body` — правило под них нам не нужно. */
const BODY_STATE = /^(is-|mod-|native-|show-|css-settings-manager$|theme-|styled-scrollbars$|hider-|auto-full-screen$)/
const UI_PREFIX = /^(workspace|nav-|graph|view-|status-bar|titlebar|modal|menu|setting|side-dock|sidebar|ribbon|mod-|tree-item|suggestion|prompt|popover|tab-|canvas|cm-|HyperMD|markdown-source-view|metadata|inline-title|cm|document-search|search|bookmark|tooltip|notice|vertical-tab|horizontal-tab|clickable-icon|community|checkbox|dropdown|slider|button|setting-item|app-container|mobile|bases-|frontmatter|callout-icon|collapse|heading-collapse|empty-state|outline|backlink|file-|folder-|nav|internal-embed|embed|image-embed|pdf|kanban|dataview|excalidraw|tag)/

// ────────────────────────────────────────────────────────────────────────────
// Ручки Style Settings
// ────────────────────────────────────────────────────────────────────────────

interface StyleHandle {
  id: string
  type: string
  options: string[]
  default?: string
  defaultLight?: string
  defaultDark?: string
  format?: string
}

/** Ручки из блоков `@settings` (мини-разбор YAML: `id`, `type`, `options`/`value`, `default*`). */
export function parseStyleSettings(blocks: readonly string[]): StyleHandle[] {
  const out: StyleHandle[] = []
  for (const b of blocks) {
    let cur: StyleHandle | null = null
    for (const raw of b.split('\n')) {
      const line = raw.replace(/\t/g, '    ')
      const kv = /^\s*-?\s*([a-zA-Z-]+):\s*(.*?)\s*$/.exec(line)
      if (!kv) continue
      const key = kv[1]!
      const value = kv[2]!.replace(/^['"]|['"]$/g, '')
      if (key === 'id' && /^\s*-?\s*id:/.test(line)) {
        // Новый пункт `- id:` (или `id:` первым ключом после `-`).
        if (cur) out.push(cur)
        cur = { id: value, type: '', options: [] }
      } else if (cur && key === 'type' && !cur.type) cur.type = value
      else if (cur && key === 'value' && value) cur.options.push(value)
      else if (cur && key === 'default') cur.default = value
      else if (cur && key === 'default-light') cur.defaultLight = value
      else if (cur && key === 'default-dark') cur.defaultDark = value
      else if (cur && key === 'format') cur.format = value
    }
    if (cur) out.push(cur)
  }
  // Значения class-select списком `- foo` без `value:`.
  return out.filter((h) => h.type && h.type !== 'heading')
}

// ────────────────────────────────────────────────────────────────────────────
// Конвертер
// ────────────────────────────────────────────────────────────────────────────

export interface ObsidianManifest {
  name?: string
  author?: string
  version?: string
  authorUrl?: string
}

export interface ObsidianConvertOptions extends ConvertOptions {
  manifest?: ObsidianManifest
}

type Scope = { mode?: PaletteMode; handle?: string }

interface Compound {
  nodes: csstree.CssNode[]
  /** Комбинатор перед звеном (`' '`, `>`, `+`, `~`); у первого — нет. */
  combinator?: string
}

function compoundsOf(sel: csstree.Selector): Compound[] {
  const out: Compound[] = [{ nodes: [] }]
  sel.children.forEach((n) => {
    if (n.type === 'Combinator') out.push({ nodes: [], combinator: n.name })
    else out[out.length - 1]!.nodes.push(n)
  })
  return out.filter((c) => c.nodes.length)
}

const classes = (c: Compound): string[] => c.nodes.filter((n): n is csstree.ClassSelector => n.type === 'ClassSelector').map((n) => n.name)
const tagOf = (c: Compound): string | null => {
  const t = c.nodes.find((n): n is csstree.TypeSelector => n.type === 'TypeSelector')
  return t ? t.name.toLowerCase() : null
}

/** Звено — область темы (`body`, `:root`, `.theme-dark`, `body.<класс>`): режим и класс ручки. */
function scopeOf(c: Compound, handles: ReadonlySet<string>): Scope | 'state' | null {
  let mode: PaletteMode | undefined
  let handle: string | undefined
  let root = false
  for (const n of c.nodes) {
    if (n.type === 'TypeSelector' && (n.name === 'body' || n.name === 'html')) root = true
    else if (n.type === 'PseudoClassSelector' && n.name === 'root') root = true
    else if (n.type === 'ClassSelector' && (n.name === 'theme-light' || n.name === 'theme-dark')) {
      mode = n.name === 'theme-light' ? 'light' : 'dark'
      root = true
    } else if (n.type === 'ClassSelector') {
      if (handles.has(n.name) || !BODY_STATE.test(n.name)) {
        if (handle) return 'state'
        handle = n.name
      } else return root || c.nodes.some((x) => x.type === 'TypeSelector' && x.name === 'body') ? 'state' : null
    } else return null
  }
  if (!root && !(handle && handles.has(handle))) return null
  return { ...(mode ? { mode } : {}), ...(handle ? { handle } : {}) }
}

type Projection = { kind: 'element'; sel: string; approx?: string } | { kind: 'drop'; why: string; foreign?: boolean }

/** Звенья после области → селектор ленты или причина «не легло». */
function project(rest: Compound[]): Projection {
  if (!rest.length) return { kind: 'drop', why: 'пустой селектор' }
  let ci = rest.findIndex((c) => classes(c).some((x) => CONTAINERS.has(x)))
  if (ci < 0) {
    const cls = rest.flatMap(classes)
    const first = cls[0] ?? tagOf(rest[0]!) ?? ''
    if (cls.some((x) => /^(cm-|HyperMD)/.test(x)) || cls.includes('markdown-source-view')) return { kind: 'drop', why: 'редактор Obsidian — у нас лента, не редактор', foreign: true }
    if (UI_PREFIX.test(first)) return { kind: 'drop', why: `интерфейс Obsidian (.${first}) — нет в nrchat`, foreign: true }
    if (!cls.length) return { kind: 'drop', why: 'тег без контейнера разметки — у нас лёг бы на всё приложение', foreign: true }
    return { kind: 'drop', why: `DOM Obsidian (.${first}) — нет звена в ленте`, foreign: true }
  }
  // Предки контейнера — только «прозрачные» обёртки вида заметки.
  for (const c of rest.slice(0, ci)) {
    if (!classes(c).every((x) => PASS_ANCESTORS.has(x)) || tagOf(c)) return { kind: 'drop', why: `разметка внутри .${classes(c)[0] ?? tagOf(c)} — панель Obsidian`, foreign: true }
  }
  const box = rest[ci]!
  const extra = box.nodes.filter((n) => !(n.type === 'ClassSelector' && CONTAINERS.has(n.name)))
  if (extra.some((n) => n.type !== 'PseudoClassSelector')) return { kind: 'drop', why: 'вариант вида заметки (.markdown-preview-view.<класс>) — нет в ленте', foreign: true }
  const parts = ['.nr-text' + extra.map((n) => csstree.generate(n)).join('')]
  let approx: string | undefined
  for (const c of rest.slice(ci + 1)) {
    if (c.combinator && c.combinator !== ' ') parts.push(c.combinator)
    let tag = tagOf(c)
    const cls = classes(c)
    const pseudo: string[] = []
    for (const n of c.nodes) {
      if (n.type === 'PseudoElementSelector') return { kind: 'drop', why: `псевдоэлемент ::${n.name} — скин не добавляет контент` }
      if (n.type === 'PseudoClassSelector') pseudo.push(csstree.generate(n))
      if (n.type === 'AttributeSelector' && n.name.name !== 'data-callout') return { kind: 'drop', why: `атрибут [${n.name.name}] — разметка Obsidian` }
      if (n.type === 'IdSelector' || n.type === 'NestingSelector') return { kind: 'drop', why: 'id / вложение — разметка Obsidian' }
    }
    if (cls.includes('callout')) {
      if (cls.length > 1 || (tag && tag !== 'div')) return { kind: 'drop', why: `часть callout (.${cls.find((x) => x !== 'callout') ?? tag}) — у нас цитата без частей` }
      tag = 'blockquote'
      approx = 'callout → цитата: в ленте нет callout, `> [!note]` — цитата'
    } else if (cls.length) {
      if (cls.every((x) => LINK_CLASSES.has(x)) && (!tag || tag === 'a')) tag = 'a'
      else return { kind: 'drop', why: `блок Obsidian .${cls.find((x) => !LINK_CLASSES.has(x))} — нет в ленте` }
    }
    if (!tag) {
      if (c.nodes.some((n) => n.type === 'TypeSelector' && n.name === '*')) tag = '*'
      else return { kind: 'drop', why: 'звено без тега' }
    }
    tag = TAG_ALIAS[tag] ?? tag
    if (tag !== '*' && !FEED_TAGS.has(tag)) return { kind: 'drop', why: `тег ${tag} — нет в разметке ленты` }
    parts.push(tag + pseudo.join(''))
  }
  return { kind: 'element', sel: parts.join(' '), ...(approx ? { approx } : {}) }
}

/** Значение токена под вид: цвет — вычисленный hex (или выражение, если не вычислился, но без `var()`). */
function tokenOf(kind: ObsidianTokenKind, value: string): { value: string; color?: string } | null {
  const v = value.trim().replace(/\s*!important$/i, '')
  if (!v || /var\(/.test(v)) return null
  switch (kind) {
    case 'color': {
      const c = evalColor(v)
      if (c) return { value: toHex(c), color: toHex(c) }
      return /url\(|gradient/i.test(v) ? null : { value: v }
    }
    case 'font':
      return /url\(/i.test(v) || /^(inherit|initial|unset|revert|revert-layer)$/i.test(v) ? null : { value: v }
    case 'length':
      return /^-?[\d.]+(px|rem|em)$|^0$/.test(v) ? { value: v } : null
    case 'shadow':
      return v === 'none' || /\d/.test(v) ? { value: v } : null
  }
}

/**
 * Перевести тему Obsidian в `.skin.css`. `css` — содержимое `theme.css`; `manifest` — имя и автор.
 */
export function convertObsidian(input: string, opts: ObsidianConvertOptions = {}): ConvertResult {
  const target = opts.target ?? 'skin'
  const name = opts.name ?? skinName(opts.manifest?.name ?? opts.source ?? 'obsidian-theme')
  const cov = new Coverage()
  const settings = settingsBlocksOf(input)
  const handles = parseStyleSettings(settings)
  const handleClasses = new Set<string>()
  for (const h of handles) {
    if (h.type === 'class-toggle') handleClasses.add(h.id)
    if (h.type === 'class-select') for (const o of h.options) handleClasses.add(o)
  }
  const handleVars = handles.filter((h) => h.type.startsWith('variable-'))
  for (const h of handles) if (!/^(class-toggle|class-select|variable-(number|number-slider|text|select|color|themed-color))$/.test(h.type)) cov.drop(`@settings ${h.id}`, `тип ручки ${h.type} — у нас нет`)

  const ast = csstree.parse(input, { positions: true, parseValue: false, parseCustomProperty: false, onParseError: () => {} })
  const raw = (d: csstree.Declaration): string => (d.value.type === 'Raw' ? d.value.value : csstree.generate(d.value)).trim()
  const fonts: string[] = []
  const imports: string[] = []
  const fontFaces: string[] = []
  const vars: Record<'common' | PaletteMode, Record<string, string>> = { common: {}, light: {}, dark: {} }
  /** Переменные вариантов (`.theme-dark.minimal-dark-black`, `body.<ручка>`). */
  const variants = new Map<string, { scope: Scope; vars: Record<string, string> }>()
  /** Правила разметки: селектор ленты и область → свойства. */
  const rules: Array<{ scope: Scope; sel: string; approx?: string; from: string; decls: Array<[string, string]>; line?: number }> = []
  const walk = (list: csstree.List<csstree.CssNode>): void => {
    list.forEach((node) => {
      const line = node.loc?.start.line
      if (node.type === 'Atrule') {
        const at = node.name.toLowerCase()
        if (at === 'import') {
          const urls: string[] = []
          csstree.walk(node, (x) => {
            if (x.type === 'Url' || x.type === 'String') urls.push(x.value)
          })
          if (node.prelude?.type === 'Raw') {
            const m = /(?:url\(\s*)?['"]?([^'")\s]+)/.exec(node.prelude.value)
            if (m) urls.push(m[1]!)
          }
          const u = urls[0]
          if (!u) cov.drop('@import', 'адрес не разобран', line)
          else if (FONT_HOSTS.some((h) => u.includes(h))) fonts.includes(u) || fonts.push(u)
          else imports.includes(u) || imports.push(u)
          return
        }
        if (at === 'font-face') {
          fontFaces.push(csstree.generate(node))
          return
        }
        if (at === 'charset' || at === 'layer') return
        let inner = 0
        if (node.block) csstree.walk(node.block, (x) => (x.type === 'Declaration' ? inner++ : undefined))
        cov.drop(`@${node.name}${node.prelude ? ' ' + csstree.generate(node.prelude).slice(0, 50) : ''}`, at === 'media' ? 'адаптив Obsidian (мобильный, печать) — не переносится' : at === 'keyframes' ? 'анимации — не переносятся' : 'at-правило — не переносится', line, Math.max(1, inner))
        return
      }
      if (node.type !== 'Rule' || node.prelude.type !== 'SelectorList') return
      // Вложенные правила (CSS nesting) и мусор разбора (`h1: :before {…}`) — не объявления.
      const decls = node.block.children.toArray().filter((d): d is csstree.Declaration => d.type === 'Declaration' && /^(--[\w-]+|-?[a-z][a-z-]*)$/i.test(d.property) && !/[{}]/.test(raw(d)))
      const nested = node.block.children.toArray().length - decls.length
      if (nested) cov.drop(`${csstree.generate(node.prelude)} { … }`, 'вложенные правила (CSS nesting) — не переносятся', line, nested)
      const custom = decls.filter((d) => d.property.startsWith('--'))
      const plain = decls.filter((d) => !d.property.startsWith('--'))
      node.prelude.children.forEach((sel) => {
        if (sel.type !== 'Selector') return
        const text = csstree.generate(sel)
        const cs = compoundsOf(sel)
        const scope = scopeOf(cs[0]!, handleClasses)
        if (scope === 'state') {
          if (custom.length || plain.length) cov.drop(text, 'состояние окна Obsidian (мобильный, платформа, режим) — нет в nrchat', line, plain.length || 1, true)
          return
        }
        const rest = scope ? cs.slice(1) : cs
        // Переменные: область — палитра или вариант; под элементом — локальные переменные элемента.
        if (!rest.length && scope) {
          const key = scope.handle ? `${scope.mode ?? ''}|${scope.handle}` : null
          for (const d of custom) {
            if (key) {
              const v = variants.get(key) ?? { scope, vars: {} }
              v.vars[d.property] = raw(d)
              variants.set(key, v)
            } else vars[scope.mode ?? 'common'][d.property] = raw(d)
          }
          for (const d of plain) cov.drop(`${text} { ${d.property} }`, 'оформление окна Obsidian целиком — у нас токены', line, 1, true)
          return
        }
        if (!plain.length && !custom.length) return
        const p = project(rest)
        if (p.kind === 'drop') {
          cov.drop(text, p.why, line, plain.length || 1, p.foreign)
          return
        }
        rules.push({ scope: scope ?? {}, sel: p.sel, ...(p.approx ? { approx: p.approx } : {}), from: text, decls: decls.map((d) => [d.property, raw(d)]), ...(line ? { line } : {}) })
      })
    })
  }
  if (ast.type === 'StyleSheet') walk(ast.children)

  // ── Режимы ──
  const defines = (m: PaletteMode): boolean => Object.keys(vars[m]).length > 0
  const commonPalette = OBSIDIAN_TOKEN_MAP.some((r) => r.modal && r.vars.some((v) => v in vars.common))
  const modes: PaletteMode[] = defines('light') && defines('dark') ? ['light', 'dark'] : defines('dark') ? (commonPalette ? ['light', 'dark'] : ['dark']) : defines('light') ? (commonPalette ? ['light', 'dark'] : ['light']) : ['light', 'dark']
  const mode: SkinMode = modes.length === 2 ? 'both' : modes[0]!
  const handleIds = new Set(handleVars.map((h) => `--${h.id}`))
  const dictOf = (m: PaletteMode): Record<string, string> => ({ ...OBSIDIAN_DEFAULTS.common, ...OBSIDIAN_DEFAULTS[m], ...vars.common, ...vars[m] })
  const themeHas = (v: string, m?: PaletteMode): boolean => v in vars.common || (m ? v in vars[m] : v in vars.light || v in vars.dark)
  // Акцент Obsidian `--accent-h/s/l` раскрывается в цвет: заданы темой — в отчёт как легло.
  const usedVars = new Set<string>()

  /** Значение переменной: полностью раскрытое (для вычислений) и «живое» — с переменными ручек. */
  const valueOf = (v: string, dict: Record<string, string>): { full: string; live: string } | null => {
    if (!(v in dict)) return null
    const full = resolveVars(dict[v]!, dict)
    const liveDict = Object.fromEntries(Object.entries(dict).filter(([k]) => !handleIds.has(k)))
    const live = resolveVars(dict[v]!, liveDict)
    return { full, live }
  }

  const common = new TokenSet()
  const palettes: Partial<Record<PaletteMode, TokenSet>> = {}
  const liveTokens: Partial<Record<PaletteMode | 'common', Record<string, string>>> = {}
  const pick = (rule: ObsidianTokenRule, m: PaletteMode, set: TokenSet, live: Record<string, string>): void => {
    const dict = dictOf(m)
    // Сначала — заданные темой, потом умолчания Obsidian (шкала --color-base-*).
    const order = [...rule.vars.filter((v) => themeHas(v, rule.modal ? m : undefined)), ...rule.vars]
    for (const v of order) {
      const val = valueOf(v, dict)
      if (!val) continue
      const t = tokenOf(rule.kind, val.full)
      if (!t) continue
      const fromTheme = themeHas(v, rule.modal ? m : undefined)
      set.set(rule.token, t.value, fromTheme ? `var ${v}` : `default Obsidian ${v}`)
      if (fromTheme) usedVars.add(v)
      if (val.live !== val.full && /var\(--/.test(val.live) && t.color) live[rule.token] = val.live
      return
    }
  }
  for (const m of modes) {
    const set = new TokenSet(m)
    const live: Record<string, string> = {}
    for (const rule of OBSIDIAN_TOKEN_MAP) if (rule.modal) pick(rule, m, set, live)
    const pm = derivePalette(set, { mode: m })
    liftContrast(set, pm)
    // Живое значение (с переменной ручки) — в выход, только если подтяжка контраста его не тронула.
    for (const k of Object.keys(live)) if (set.sources.find((s) => s.token === k)?.from.startsWith('contrast')) delete live[k]
    palettes[m] = set
    liveTokens[m] = live
  }
  for (const rule of OBSIDIAN_TOKEN_MAP) if (!rule.modal) pick(rule, modes[0]!, common, (liveTokens.common ??= {}))

  // Переменные ручек: значение темы (или умолчание ручки) — в корень, иначе `var(--id)` пуст.
  const handleDefaults: Record<'common' | PaletteMode, Record<string, string>> = { common: {}, light: {}, dark: {} }
  for (const h of handleVars) {
    const id = `--${h.id}`
    const used = Object.values(liveTokens).some((t) => Object.values(t ?? {}).some((v) => v.includes(`var(${id})`)))
    if (!used) continue
    for (const m of modes) {
      const raw0 = resolveVars(dictOf(m)[id] ?? (m === 'dark' ? (h.defaultDark ?? h.default) : (h.defaultLight ?? h.default)) ?? '', dictOf(m))
      // Цвет — вычисленным hex (`hsl(…, calc())` линтер не прочтёт), прочее — как есть.
      const c = h.type.includes('color') || /^(hsla?|rgba?|oklch|lch|color-mix)\(/i.test(raw0.trim()) ? evalColor(raw0.replace(/\s+/g, ' ')) : null
      const val = c ? toHex(c) : raw0.replace(/\s+/g, ' ').trim()
      if (val) handleDefaults[modes.length === 1 ? 'common' : m][id] = val
    }
  }

  // ── Покрытие переменных темы ──
  const themeVars = new Set([...Object.keys(vars.common), ...Object.keys(vars.light), ...Object.keys(vars.dark)])
  const varElements: ElementRule[] = []
  for (const v of themeVars) {
    if (usedVars.has(v)) {
      cov.keep(v, OBSIDIAN_TOKEN_MAP.find((r) => r.vars.includes(v))!.token)
      continue
    }
    if (OBSIDIAN_TOKEN_MAP.some((r) => r.vars.includes(v))) {
      cov.keep(v, `${OBSIDIAN_TOKEN_MAP.find((r) => r.vars.includes(v))!.token} (запасной источник)`)
      continue
    }
    if (/^--accent-[hsl]$/.test(v)) {
      cov.keep(v, '--nr-accent')
      continue
    }
    const el = OBSIDIAN_VAR_ELEMENTS.map((x) => ({ x, m: x.re.exec(v) })).find((y) => y.m)
    if (el) {
      const sel = `.nr-text ${el.x.sel(el.m!)}`
      for (const m of modes) {
        const val = valueOf(v, dictOf(m))
        if (!val || /var\(/.test(val.full) || /url\(/i.test(val.full)) continue
        const target = modes.length === 1 ? undefined : m
        let rule = varElements.find((r) => r.sel === sel && r.mode === target)
        if (!rule) varElements.push((rule = { sel, ...(target ? { mode: target } : {}), props: new Map() }))
        rule.props.set(el.x.prop, val.full)
      }
      cov.keep(v, sel, el.x.prop)
      continue
    }
    const dropped = OBSIDIAN_VARS_DROPPED.find((x) => v.startsWith(x.prefix))
    if (dropped) cov.drop(v, dropped.why, undefined, 1, true)
    // Свои переменные темы (`--rtm-*`, `--bg1`) — подставлены значениями, в покрытие не входят.
  }
  // Одинаковые по режимам — одним правилом без режима.
  const elements: ElementRule[] = []
  const merge = (list: ElementRule[]): void => {
    for (const r of list) {
      if (r.mode) {
        const twin = list.find((x) => x !== r && x.sel === r.sel && x.handle === r.handle && x.mode && x.mode !== r.mode)
        if (twin && [...r.props].every(([k, v]) => twin.props.get(k) === v) && twin.props.size === r.props.size) {
          if (r.mode === 'light') elements.push({ sel: r.sel, ...(r.handle ? { handle: r.handle } : {}), props: r.props })
          continue
        }
      }
      elements.push(r)
    }
  }
  merge(varElements)

  // ── Правила разметки ──
  const reverse = new Map<string, string>()
  for (const r of OBSIDIAN_TOKEN_MAP) reverse.has(r.vars[0]!) || reverse.set(r.vars[0]!, r.token)
  reverse.set('--text-accent', '--nr-accent')
  reverse.set('--italic-color', '--nr-em')
  const toToken = (value: string): string => value.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (all, n: string) => (reverse.has(n) ? `var(${reverse.get(n)})` : all))
  const ruleElements: ElementRule[] = []
  for (const r of rules) {
    if (r.approx) cov.approximate(r.from, r.sel, r.approx)
    const targetModes: Array<PaletteMode | undefined> = r.scope.mode ? [r.scope.mode] : [undefined]
    for (const [prop, value] of r.decls) {
      if (prop.startsWith('--')) continue
      const cls = classifyProp(prop)
      if (cls === 'layout') {
        cov.dropProp(r.sel, prop)
        continue
      }
      const v0 = toToken(value).replace(/\s*!important\s*$/i, '')
      // Значение по режимам: переменные темы раскрываются в каждом режиме; совпали — одно правило.
      const perMode = new Map<PaletteMode | undefined, string>()
      let broken = false
      for (const tm of targetModes) {
        const ms = tm ? [tm] : modes
        const vals = ms.map((m) => resolveVars(v0, Object.fromEntries(Object.entries(dictOf(m)).filter(([k]) => !k.startsWith('--nr-')))))
        if (vals.some((x) => /var\(--(?!nr-)/.test(x))) {
          broken = true
          break
        }
        if (/url\(\s*['"]?(?!data:|https:)/i.test(vals[0]!)) {
          broken = true
          break
        }
        if (tm || vals.every((x) => x === vals[0])) perMode.set(tm, vals[0]!)
        else ms.forEach((m, i) => perMode.set(m, vals[i]!))
      }
      if (broken) {
        cov.dropProp(r.sel, `${prop} (переменная Obsidian без значения)`)
        continue
      }
      for (const [m, v] of perMode) {
        let rule = ruleElements.find((x) => x.sel === r.sel && x.mode === m && x.handle === r.scope.handle)
        if (!rule) ruleElements.push((rule = { sel: r.sel, ...(m ? { mode: m } : {}), ...(r.scope.handle ? { handle: r.scope.handle } : {}), props: new Map() }))
        rule.props.set(prop, v)
      }
      if (cls === 'contract') {
        if (!r.approx) cov.keep(r.from, r.sel, prop)
      } else cov.carry(r.sel, prop)
    }
  }
  elements.push(...ruleElements)

  // Варианты (`body.<ручка>`, `.theme-dark.<класс>`): переменные через карту — токены под классом.
  for (const { scope, vars: vv } of variants.values()) {
    const m = scope.mode ?? modes[0]!
    const dict = { ...dictOf(m), ...vv }
    const props = new Map<string, string>()
    for (const rule of OBSIDIAN_TOKEN_MAP) {
      const hit = rule.vars.find((v) => v in vv) ?? null
      const touched = hit ?? (Object.keys(vv).some((k) => k.startsWith('--color-base-') || k.startsWith('--accent-') || k.startsWith('--bg') || k.startsWith('--tx') || k.startsWith('--ui')) ? rule.vars[0]! : null)
      if (!touched || !rule.modal) continue
      const full = resolveVars(dict[touched] ?? '', dict)
      const base = resolveVars(dictOf(m)[touched] ?? '', dictOf(m))
      if (full === base && !hit) continue
      const t = tokenOf(rule.kind, full)
      if (t) props.set(rule.token, t.value)
    }
    for (const k of Object.keys(vv)) if (OBSIDIAN_TOKEN_MAP.some((r) => r.vars.includes(k))) cov.keep(`.${scope.handle} ${k}`, `[data-skin].${scope.handle}`)
    if (props.size) elements.push({ sel: '', ...(scope.mode && modes.length > 1 ? { mode: scope.mode } : {}), handle: scope.handle!, props })
  }

  // ── Сборка ──
  const header = headerOf(name, mode, opts, { ...(opts.manifest?.author ? { author: opts.manifest.author } : {}), description: `порт темы Obsidian ${opts.manifest?.name ?? name}${opts.manifest?.version ? ` ${opts.manifest.version}` : ''}` })
  const single = modes.length === 1
  // Выход — с живыми значениями (переменные ручек), результат — вычисленные цвета.
  const out = (t: TokenSet, live: Record<string, string> | undefined, extra: Record<string, string>): Record<string, string> => ({ ...t.tokens, ...(live ?? {}), ...extra })
  const commonOut = out(common, liveTokens.common, handleDefaults.common)
  const css = emitCss({
    target,
    ...(target === 'skin' ? { header } : {}),
    comment: `obsidian → nr (nr-skins convertObsidian)${opts.manifest?.name ? ` · ${opts.manifest.name}` : ''}`,
    imports: [...fonts, ...imports],
    fontFaces,
    settings,
    common: single && target === 'bot' ? { ...commonOut, ...out(palettes[modes[0]!]!, liveTokens[modes[0]!], {}) } : commonOut,
    palettes: single
      ? target === 'skin'
        ? { [modes[0]!]: out(palettes[modes[0]!]!, liveTokens[modes[0]!], {}) }
        : {}
      : { light: out(palettes.light!, liveTokens.light, handleDefaults.light), dark: out(palettes.dark!, liveTokens.dark, handleDefaults.dark) },
    elements,
  })
  const cleaned = css
  const lint = lintOf(target, cleaned, target === 'skin' ? name : undefined)
  const sources = [...common.sources, ...modes.flatMap((m) => palettes[m]!.sources)]
  const result: ConvertResult = {
    source: 'obsidian',
    target,
    name,
    ...(target === 'skin' ? { header } : {}),
    css: cleaned,
    tokens: single ? { ...common.tokens, ...palettes[modes[0]!]!.tokens } : { ...common.tokens },
    palettes: Object.fromEntries(modes.map((m) => [m, palettes[m]!.tokens])),
    sources,
    mode,
    fonts,
    imports,
    report: cov.report(),
    lint,
  }
  result.report.todo = todoOf(result)
  return result
}
