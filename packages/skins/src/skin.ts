/**
 * Файл скина (skin-spec §1): `<имя>.skin.css` — шапка-комментарий `@skin` и
 * CSS по контракту. Здесь — разбор шапки, валидатор и сборка с наследованием
 * `base`. Без IO: файлы читает источник (`./node`), здесь только текст.
 *
 *   /* @skin
 *    * name: scene
 *    * description: РП — длинные реплики, засечки, крупные аватары
 *    * mode: both
 *    * base: parchment
 *    *\/
 *   [data-skin="scene"][data-mode="dark"] { --nr-bg: #14110f; … }
 *   [data-skin="scene"] .nr-message[data-role=user] { border-left: 2px solid var(--nr-line); }
 */

import * as csstree from 'css-tree'
import {
  DEFAULT_PALETTE,
  DEFAULT_SKIN,
  ELEMENT_HIDEABLE,
  ELEMENT_PROPERTIES,
  ELEMENT_SELECTORS,
  ELEMENT_SELECTOR_SET,
  FORBIDDEN_TOKEN_PREFIXES,
  MAX_ELEMENT_DEPTH,
  PLUGIN_TOKEN_PREFIXES,
  REQUIRED_TOKENS,
  SKIN_MODES,
  SKIN_NAME_RE,
  TEXT_TAGS,
  TOKEN_BY_NAME,
  URL_TOKENS,
  type SkinMode,
} from './contract.js'
import { checkContrast, checkIcons, checkTextSize } from './readability.js'

export interface SkinHeader {
  name?: string
  description?: string
  mode?: SkinMode
  base?: string
  /** Откуда скин: репа темы, файл, бот (конвертеры, skin-convert-spec §1). */
  source?: string
  /** Лицензия источника (`MIT`, `GPL-3.0`…) — видна рядом с именем в списке. */
  license?: string
  /** Автор исходной темы. */
  author?: string
}

/** Ключи шапки, которые несут строку как есть. */
const HEADER_TEXT_KEYS = ['name', 'description', 'base', 'source', 'license', 'author'] as const

/** Замечание валидатора: строка файла, что не так и что делать. */
export interface SkinIssue {
  line?: number
  message: string
  hint?: string
}

/** Переменные корневых правил: общие для режимов и по режимам. */
export interface SkinVars {
  /** `--nr-*` и свои переменные скина (`--tx1` ручек) — по ним раскрываются ссылки палитры. */
  common: Record<string, string>
  light: Record<string, string>
  dark: Record<string, string>
}

export interface ValidateResult {
  ok: boolean
  header: SkinHeader
  errors: SkinIssue[]
  warnings: SkinIssue[]
  vars: SkinVars
}

export interface ValidateOptions {
  /** Имя скина (из имени файла). Нет — берётся из шапки; нет и там — ошибка. */
  name?: string
  /** Известные скины — проверка `base`. Не задано — `base` не проверяется на существование. */
  known?: ReadonlySet<string> | readonly string[]
  /** Многоцветные пакеты иконок стенда (`$mode: color` в `pack.mdz`) — линтер их не проверяет на тонкий контур. */
  colorPacks?: readonly string[]
}

/** Текст замечания одной строкой: «строка 12: … — подсказка». */
export function formatIssue(i: SkinIssue): string {
  return `${i.line ? `строка ${i.line}: ` : ''}${i.message}${i.hint ? ` — ${i.hint}` : ''}`
}

// ────────────────────────────────────────────────────────────────────────────
// Шапка
// ────────────────────────────────────────────────────────────────────────────

const HEADER_RE = /^\s*\/\*\s*@skin\b([\s\S]*?)\*\//

/**
 * Шапка `/* @skin … *\/` в начале файла; нет — пустая. Ошибка — только `mode` вне списка;
 * неизвестный ключ — предупреждение (skin-spec §2 v1.1).
 */
export function parseHeader(text: string): { header: SkinHeader; errors: SkinIssue[]; warnings: SkinIssue[] } {
  const m = HEADER_RE.exec(text)
  const header: SkinHeader = {}
  const errors: SkinIssue[] = []
  const warnings: SkinIssue[] = []
  if (!m) return { header, errors, warnings }
  const body = m[1] ?? ''
  const startLine = text.slice(0, m.index).split('\n').length
  body.split('\n').forEach((raw, i) => {
    const line = raw.replace(/^\s*\*?\s?/, '').trim()
    if (!line) return
    const kv = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!kv) return
    const key = kv[1]!.toLowerCase()
    const value = kv[2]!.trim()
    const at = startLine + i
    if ((HEADER_TEXT_KEYS as readonly string[]).includes(key)) header[key as (typeof HEADER_TEXT_KEYS)[number]] = value
    else if (key === 'mode') {
      if ((SKIN_MODES as readonly string[]).includes(value)) header.mode = value as SkinMode
      else errors.push({ line: at, message: `mode: "${value}"`, hint: `допустимо ${SKIN_MODES.join(' | ')}` })
    } else warnings.push({ line: at, message: `неизвестный ключ шапки "${key}"`, hint: `в шапке: ${[...HEADER_TEXT_KEYS, 'mode'].join(', ')}` })
  })
  return { header, errors, warnings }
}

/** Шапка текстом — для `save` без своей шапки и для редактора. */
export function formatHeader(h: SkinHeader & { name: string }): string {
  const lines = [`name: ${h.name}`]
  if (h.description) lines.push(`description: ${h.description.replace(/\*\//g, '* /')}`)
  lines.push(`mode: ${h.mode ?? 'both'}`)
  if (h.base) lines.push(`base: ${h.base}`)
  for (const k of ['source', 'license', 'author'] as const) if (h[k]) lines.push(`${k}: ${h[k]!.replace(/\*\//g, '* /').replace(/\n/g, ' ')}`)
  return `/* @skin\n${lines.map((l) => ` * ${l}`).join('\n')}\n */\n`
}

/** Текст скина с заменённой (или добавленной) шапкой. */
export function withHeader(text: string, h: SkinHeader & { name: string }): string {
  return formatHeader(h) + text.replace(HEADER_RE, '').replace(/^\s*\n/, '')
}

// ────────────────────────────────────────────────────────────────────────────
// Линтер (skin-spec §2 v1.1, DECISIONS 05.11 «скин ничего не запрещает»)
// ────────────────────────────────────────────────────────────────────────────
//
// Ошибка — только нечитаемый CSS и шапка (имя, `mode`, `base`). Всё вне контракта —
// предупреждение «не гарантируем после перекройки разметки»: скин пишется, собирается
// и применяется как есть. Переменные палитры (`vars`) собираются только из корневых
// правил по контракту — их видят редактор, выжимка агенту и проверка контраста.

const ALLOWED_LIST = ELEMENT_SELECTORS.map((s) => s.selector).join(', ')
const BOT_ROOT_HINT = 'тема бота ложится поверх любого скина: [data-skin][data-mode] (+ [data-mode="light|dark"] вместо [data-mode]), без имени скина'
const ROOT_HINT = (name: string) => `правило начинается с [data-skin="${name}"] (+ [data-mode="light|dark"])`
/** Хвост подсказки у всего, что вне контракта. */
const NO_GUARANTEE = 'работает, но после перекройки разметки ядра может отвалиться'

type Mode = 'common' | 'light' | 'dark'

/** Значение атрибута селектора без кавычек. */
function attrValue(node: csstree.AttributeSelector): string | null {
  const v = node.value
  if (!v) return null
  return v.type === 'String' ? v.value : v.type === 'Identifier' ? v.name : null
}

/** Звено селектора каноническим текстом: `.nr-message[data-role=user]`. */
function compoundText(nodes: csstree.CssNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'AttributeSelector') {
        const v = attrValue(n)
        return `[${n.name.name}${n.matcher ?? ''}${v ?? ''}]`
      }
      return csstree.generate(n)
    })
    .join('')
}

interface SelectorCheck {
  /** Селектор по контракту (замечаний нет). */
  ok: boolean
  /** Правило сработает в этом скине (корень — свой или общий). Нет — переменные не в палитру. */
  applies: boolean
  mode: Mode
  /** Корневое правило (переменные) или элементное. */
  element: boolean
  /** Корень с классом ручки (`[data-skin="x"].glow`): переменные условные, не палитра. */
  handle: boolean
  /** Последнее звено элементного селектора — к нему относятся свойства. */
  last?: string
  issue?: SkinIssue
}

/** Корень CSS бота (слой «бот», settings-spec §1a): `[data-skin]` без значения — поверх любого скина. */
export const BOT_ROOT = '[data-skin][data-mode]'

function checkSelector(sel: csstree.Selector, name: string | null, line: number | undefined): SelectorCheck {
  const nodes = sel.children.toArray()
  const text = csstree.generate(sel)
  const warn = (applies: boolean, element: boolean, mode: Mode, message: string, hint: string, handle = false): SelectorCheck => ({
    ok: false,
    applies,
    mode,
    element,
    handle,
    issue: { line, message, hint },
  })
  // Корень: первое звено до комбинатора — [data-skin], [data-mode] и классы ручек Style Settings.
  const first: csstree.CssNode[] = []
  let i = 0
  for (; i < nodes.length && nodes[i]!.type !== 'Combinator'; i++) first.push(nodes[i]!)
  let skin: string | null = null
  let mode: Mode = 'common'
  let handle = false
  let foreignRoot = false
  for (const n of first) {
    if (name === null && n.type === 'AttributeSelector' && !n.matcher && (n.name.name === 'data-skin' || n.name.name === 'data-mode')) {
      if (n.name.name === 'data-skin') skin = ''
    } else if (n.type === 'AttributeSelector' && n.name.name === 'data-skin' && n.matcher === '=') skin = attrValue(n)
    else if (n.type === 'AttributeSelector' && n.name.name === 'data-mode' && n.matcher === '=') {
      const v = attrValue(n)
      if (v !== 'light' && v !== 'dark') return warn(false, false, mode, `[data-mode="${v}"]`, 'режим — light или dark; правило не сработает')
      mode = v
    } else if (n.type === 'ClassSelector') handle = true
    else foreignRoot = true
  }
  if (name === null) {
    if (skin !== '') return warn(true, i < nodes.length, mode, `селектор «${text}»: корень CSS бота — ${BOT_ROOT}`, `${BOT_ROOT_HINT}; ${NO_GUARANTEE}`)
  } else if (skin === null) {
    return warn(true, i < nodes.length, mode, `селектор «${text}» без [data-skin="${name}"]`, `правило ляжет на всё приложение, не только на этот скин; ${ROOT_HINT(name)}`)
  } else if (skin !== name) {
    return warn(false, i < nodes.length, mode, `селектор для чужого скина [data-skin="${skin}"]`, `этот файл — скин "${name}", правило не сработает; наследование — base: ${skin} в шапке`)
  }
  if (foreignRoot) {
    return warn(true, i < nodes.length, mode, `селектор «${text}»: в корне только [data-skin], [data-mode] и классы ручек`, `${name === null ? BOT_ROOT_HINT : ROOT_HINT(name)}; ${NO_GUARANTEE}`, handle)
  }
  if (i >= nodes.length) return { ok: true, applies: true, mode, element: false, handle }

  // Звенья ленты по контракту: только потомок (пробел), каждое — хук §4; теги — внутри .nr-text.
  const chain: string[] = []
  let compound: csstree.CssNode[] = []
  const outOf = (message: string, hint: string): SelectorCheck => warn(true, true, mode, message, `${hint}; ${NO_GUARANTEE}`, handle)
  const flush = (): SelectorCheck | null => {
    if (!compound.length) return outOf(`селектор «${text}»: пустое звено`, 'звенья — через пробел')
    const t = compoundText(compound)
    const isTag = compound.length === 1 && compound[0]!.type === 'TypeSelector'
    if (isTag) {
      if (!TEXT_TAGS.includes(t)) return outOf(`тег ${t} вне контракта`, `внутри .nr-text гарантированы: ${TEXT_TAGS.join(', ')}`)
      if (!chain.includes('.nr-text')) return outOf(`тег ${t} вне .nr-text`, `теги разметки гарантированы как «.nr-text ${t}»`)
    } else if (!ELEMENT_SELECTOR_SET.has(t)) {
      return outOf(`селектор «${t}» вне контракта`, `гарантированы: ${ALLOWED_LIST}; теги внутри .nr-text: ${TEXT_TAGS.join(', ')}`)
    }
    chain.push(t)
    compound = []
    return null
  }
  for (; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.type === 'Combinator') {
      if (n.name !== ' ') return outOf(`комбинатор «${n.name}» вне контракта`, 'гарантированы звенья через пробел (потомок)')
      if (compound.length) {
        const issue = flush()
        if (issue) return issue
      }
      continue
    }
    if (n.type === 'PseudoClassSelector' || n.type === 'PseudoElementSelector') {
      return outOf(`псевдо-селектор ${csstree.generate(n)} вне контракта`, 'состояния и псевдоэлементы ядро не обещает')
    }
    compound.push(n)
  }
  const issue = flush()
  if (issue) return issue
  if (chain.length > MAX_ELEMENT_DEPTH) return outOf(`селектор «${text}» длиннее ${MAX_ELEMENT_DEPTH} звеньев`, 'упрости цепочку')
  return { ok: true, applies: true, mode, element: true, handle, last: chain[chain.length - 1] }
}

/** Url-узлы значения. */
function urlsOf(node: csstree.CssNode | null | undefined): string[] {
  const out: string[] = []
  if (!node) return out
  csstree.walk(node, (x) => {
    if (x.type === 'Url') out.push(x.value)
  })
  return out
}

/** Внешний лист или шрифт: https с любого хоста, относительный путь (ассет), `data:`. */
const urlOk = (u: string): boolean => /^(https:\/\/|data:)/i.test(u) || !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(u)

/** Объявление: замечания — предупреждения. `true` — переменная годится в палитру. */
function checkDeclaration(d: csstree.Declaration, element: boolean, line: number | undefined, warnings: SkinIssue[], hideable = false): boolean {
  const prop = d.property
  const value = csstree.generate(d.value).trim()
  if (d.important) warnings.push({ line, message: `${prop}: !important`, hint: 'скину !important обычно не нужен — правила скина и так сильнее дефолтов' })
  if (prop.startsWith('--')) {
    // Свои переменные скина (ручки, промежуточные цвета, переменные исходной темы) — его дело, ядро их не читает.
    if (!prop.startsWith('--nr-')) return false
    const forbidden = FORBIDDEN_TOKEN_PREFIXES.find((f) => prop.startsWith(f.prefix))
    if (forbidden) {
      warnings.push({ line, message: `${prop} — служебная переменная`, hint: `${forbidden.why}; перебьёт ядро` })
      return false
    }
    if (/url\(/i.test(value) && !URL_TOKENS.includes(prop)) warnings.push({ line, message: `${prop}: url() в значении`, hint: `ядро читает картинку только из ${URL_TOKENS.join(', ')}` })
    if (!TOKEN_BY_NAME.has(prop) && !PLUGIN_TOKEN_PREFIXES.some((p) => prop.startsWith(p))) {
      warnings.push({ line, message: `неизвестный токен ${prop}`, hint: 'опечатка? Ядро его не читает (список — skin-spec §3)' })
    }
    if (value === '') {
      warnings.push({ line, message: `${prop}: пустое значение` })
      return false
    }
    // Читаемость: кегль ступеней текста — не мельче минимума.
    const small = checkTextSize(prop, value)
    if (small) warnings.push({ line, ...small })
    return true
  }
  if (!element) {
    warnings.push({ line, message: `свойство ${prop} в корневом правиле`, hint: `ляжет на корень приложения; палитра — --nr-* переменными, оформление элемента — правилом .nr-…; ${NO_GUARANTEE}` })
    return false
  }
  if (prop === 'display') {
    if (hideable && value === 'none') return true
    warnings.push({ line, message: `display: ${value} вне контракта`, hint: `гарантировано только display: none у ${ELEMENT_HIDEABLE.join(', ')}; ${NO_GUARANTEE}` })
    return false
  }
  if (!ELEMENT_PROPERTIES.includes(prop)) {
    warnings.push({ line, message: `свойство ${prop} вне контракта`, hint: `гарантированы цвет, фон, рамка, шрифт, прозрачность, padding (${ELEMENT_PROPERTIES.slice(0, 8).join(', ')}, …); ${NO_GUARANTEE}` })
    return false
  }
  const bad = urlsOf(d.value).filter((u) => !urlOk(u))
  if (bad.length) warnings.push({ line, message: `${prop}: url(${bad[0]})`, hint: 'адрес не https — браузер может не загрузить' })
  return true
}

/**
 * Проверка текста скина по контракту. `ok` — нет ошибок (CSS разбирается, шапка верна);
 * предупреждения не мешают ни записи, ни применению. `vars` — переменные корневых правил
 * (для редактора и выжимки агенту).
 */
export function validateSkin(text: string, opts: ValidateOptions = {}): ValidateResult {
  const { header, errors, warnings } = parseHeader(text)
  const vars: SkinVars = { common: {}, light: {}, dark: {} }
  const name = opts.name ?? header.name
  const done = (): ValidateResult => ({ ok: errors.length === 0, header, errors, warnings, vars })

  if (!name) {
    errors.push({ message: 'у скина нет имени', hint: 'файл <имя>.skin.css или name: в шапке /* @skin */' })
    return done()
  }
  if (!SKIN_NAME_RE.test(name)) errors.push({ message: `имя "${name}"`, hint: 'латиница в нижнем регистре, цифры, дефис; с буквы; до 40' })
  if (header.name && opts.name && header.name !== opts.name) {
    errors.push({ message: `name: ${header.name} в шапке, а файл — ${opts.name}.skin.css`, hint: 'имя скина = имя файла' })
  }
  if (header.base !== undefined) {
    const known = opts.known ? new Set(opts.known) : null
    if (header.base === name) errors.push({ message: `base: ${name} — скин наследует сам себя` })
    else if (!SKIN_NAME_RE.test(header.base)) errors.push({ message: `base: "${header.base}" — не имя скина` })
    else if (known && !known.has(header.base)) {
      errors.push({ message: `base: ${header.base} — такого скина нет`, hint: `есть: ${[...known].sort().join(', ') || '—'}` })
    }
  }

  checkSheet(text, name, errors, warnings, vars)
  // Читаемость иконок (icons-spec §2): предупреждение, по каждому режиму, без повторов.
  const seen = new Set(warnings.map((w) => w.message))
  for (const mode of ['light', 'dark'] as const) {
    for (const w of checkIcons(modeVars(vars, mode), opts.colorPacks ? { colorPacks: opts.colorPacks } : {})) {
      if (seen.has(w.message)) continue
      seen.add(w.message)
      warnings.push(w)
    }
  }
  return done()
}

/**
 * CSS темы бота (слой «бот», `theme.botCss`, settings-spec §1a) тем же линтером, что скин:
 * корень по контракту — `[data-skin][data-mode]` без имени (тема ложится поверх любого скина).
 * Шапки нет, полноту палитры не требует (недостающее даёт скин). Ошибка — только нечитаемый CSS.
 */
export function validateBotCss(text: string): ValidateResult {
  const errors: SkinIssue[] = []
  const warnings: SkinIssue[] = []
  const vars: SkinVars = { common: {}, light: {}, dark: {} }
  checkSheet(text, null, errors, warnings, vars)
  return { ok: errors.length === 0, header: {}, errors, warnings, vars }
}

function checkSheet(text: string, name: string | null, errors: SkinIssue[], warnings: SkinIssue[], vars: SkinVars): void {
  let ast: csstree.CssNode
  try {
    ast = csstree.parse(text, {
      positions: true,
      parseCustomProperty: false,
      onParseError: (e: { message: string; line?: number }) => errors.push({ line: e.line, message: `CSS не разбирается: ${e.message}` }),
    })
  } catch (e) {
    errors.push({ message: `CSS не разбирается: ${e instanceof Error ? e.message : String(e)}` })
    return
  }
  if (ast.type !== 'StyleSheet') return

  let sawRule = false
  ast.children.forEach((node) => {
    const line = node.loc?.start.line
    if (node.type === 'Atrule') {
      const at = node.name.toLowerCase()
      if (at === 'import') {
        const urls = urlsOf(node.prelude)
        csstree.walk(node.prelude ?? node, (x) => {
          if (x.type === 'String') urls.push(x.value)
        })
        if (sawRule) warnings.push({ line, message: '@import после правил', hint: 'браузер его пропустит: @import — в начале файла, сразу после шапки' })
        if (!urls.length) warnings.push({ line, message: '@import без адреса' })
        else if (!urls.every(urlOk)) warnings.push({ line, message: `@import ${urls[0]}`, hint: 'адрес не https — браузер может не загрузить' })
        return
      }
      if (at === 'font-face') {
        node.block?.children.forEach((d) => {
          if (d.type === 'Declaration' && d.property === 'src') {
            const bad = urlsOf(d.value).filter((u) => !urlOk(u))
            if (bad.length) warnings.push({ line: d.loc?.start.line, message: `@font-face src: ${bad[0]}`, hint: 'адрес не https — браузер может не загрузить' })
          }
        })
        return
      }
      warnings.push({
        line,
        message: `@${node.name} вне контракта`,
        hint: at === 'media' ? `режимы — через [data-mode="light|dark"]; ${NO_GUARANTEE}` : NO_GUARANTEE,
      })
      return
    }
    if (node.type !== 'Rule') return
    sawRule = true
    if (node.prelude.type !== 'SelectorList') {
      errors.push({ line, message: 'селектор не разбирается' })
      return
    }
    const checks: SelectorCheck[] = []
    node.prelude.children.forEach((sel) => {
      if (sel.type !== 'Selector') return
      const c = checkSelector(sel, name, line)
      if (c.issue) warnings.push(c.issue)
      checks.push(c)
    })
    if (!checks.length) return
    const element = checks.some((c) => c.element)
    if (element && checks.some((c) => !c.element)) {
      warnings.push({ line, message: 'корневой и элементный селекторы в одном правиле', hint: 'раздели на два правила — так их видит редактор' })
    }
    // Свойства — по контракту, только если все селекторы по контракту (иначе замечание уже есть).
    const inContract = checks.every((c) => c.ok)
    const hideable = element && checks.every((c) => c.last !== undefined && ELEMENT_HIDEABLE.includes(c.last))
    const palette = inContract && !element ? checks.filter((c) => c.applies && !c.handle) : []
    node.block.children.forEach((d) => {
      const dl = d.loc?.start.line ?? line
      if (d.type === 'Rule' || d.type === 'Atrule') {
        warnings.push({ line: dl, message: 'вложенные правила вне контракта', hint: `вложенность CSS работает в свежих браузерах; ${NO_GUARANTEE}` })
        return
      }
      if (d.type !== 'Declaration') return
      if (!inContract) {
        if (d.important) warnings.push({ line: dl, message: `${d.property}: !important`, hint: 'скину !important обычно не нужен — правила скина и так сильнее дефолтов' })
        return
      }
      // Свои переменные корня (ручки Style Settings `--tx1`, промежуточные цвета) — молча, но в `vars`:
      // через них токены палитры ссылаются на ручки, и контраст считается по ним.
      const own = !element && d.property.startsWith('--') && !d.property.startsWith('--nr-')
      if (!own && !checkDeclaration(d, element, dl, warnings, hideable)) return
      if (!element && d.property.startsWith('--')) {
        const value = csstree.generate(d.value).trim()
        for (const c of palette) vars[c.mode][d.property] = value
      }
    })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Сборка с наследованием
// ────────────────────────────────────────────────────────────────────────────

export interface CompiledSkin {
  name: string
  header: SkinHeader
  /** Итоговый CSS: база (переименованная в этот скин) + свой, `@import` — наверху. */
  css: string
  /** Переменные с учётом базы. */
  vars: SkinVars
  /** Цепочка наследования: [имя, база, база базы…]. */
  chain: string[]
  errors: SkinIssue[]
  warnings: SkinIssue[]
}

/** Палитра режима для дыр: дефолтный скин набора (не сам скин и не его база) или встроенная. */
function fallbackPalette(chain: readonly string[], lookup: SkinLookup, fallback: string | null, mode: 'light' | 'dark'): { vars: Record<string, string>; label: string } {
  if (fallback && !chain.includes(fallback)) {
    const text = lookup(fallback)
    if (text !== undefined) {
      const c = compileSkin(fallback, lookup, undefined, { fallback: null })
      const v = modeVars(c.vars, mode)
      if (!c.errors.length && Object.keys(v).length) return { vars: { ...DEFAULT_PALETTE[mode], ...v }, label: `дефолтного скина ${fallback}` }
    }
  }
  return { vars: { ...DEFAULT_PALETTE[mode] }, label: 'встроенной палитры (parchment)' }
}

/** Текст скина по имени — у источника (файлы, память). */
export type SkinLookup = (name: string) => string | undefined

/** Режимы, в которых скин обязан нести палитру. */
export function modesOf(mode: SkinMode | undefined): Array<'light' | 'dark'> {
  return mode === 'light' ? ['light'] : mode === 'dark' ? ['dark'] : ['light', 'dark']
}

/** Итоговые значения режима: общие + режимные. */
export function modeVars(vars: SkinVars, mode: 'light' | 'dark'): Record<string, string> {
  return { ...vars.common, ...vars[mode] }
}

/** Переименовать `[data-skin=from]` → `[data-skin="to"]` в AST и сгенерировать; `@import` — отдельно. */
function renamed(text: string, from: string, to: string): { imports: string[]; body: string } {
  const ast = csstree.parse(text, { parseCustomProperty: false })
  const imports: string[] = []
  const body: string[] = []
  if (ast.type !== 'StyleSheet') return { imports, body: '' }
  csstree.walk(ast, (node) => {
    if (node.type === 'AttributeSelector' && node.name.name === 'data-skin' && attrValue(node) === from) {
      node.value = { type: 'String', value: to }
    }
  })
  ast.children.forEach((node) => {
    const css = csstree.generate(node)
    if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') imports.push(css)
    else body.push(css)
  })
  return { imports, body: body.join('\n') }
}

/**
 * Блоки ручек `/* @settings … *​/` (settings-spec §10.1): csstree комментарии выбрасывает,
 * а фронт читает ручки из скомпилированного CSS — переносим блоки как есть.
 */
function settingsBlocks(text: string): string[] {
  return [...text.matchAll(/\/\*\s*@settings\b[\s\S]*?\*\//g)].map((m) => m[0])
}

/**
 * Собрать скин: проверить его и цепочку баз, CSS базы переименовать в этот
 * скин и поставить перед своим (своё правило сильнее — оно позже). Ошибка базы
 * — ошибка скина (с именем базы). Предупреждения базы не поднимаются. Неполная
 * палитра режима — предупреждение: дыры добиваются палитрой дефолтного скина
 * (`opts.fallback`) или встроенной `DEFAULT_PALETTE` отдельным правилом в начале.
 */
export interface CompileOptions {
  /**
   * Дефолтный скин дистрибутива: его палитрой добиваются дыры скина без `base` (skin-spec §2 v1.1).
   * Нет в наборе или `null` — встроенная `DEFAULT_PALETTE`. По умолчанию `DEFAULT_SKIN`.
   */
  fallback?: string | null
}

export function compileSkin(name: string, lookup: SkinLookup, known?: ReadonlySet<string> | readonly string[], opts: CompileOptions = {}): CompiledSkin {
  const chain: string[] = []
  const errors: SkinIssue[] = []
  const warnings: SkinIssue[] = []
  const layers: Array<{ name: string; text: string; vars: SkinVars }> = []
  let header: SkinHeader = {}
  let cur: string | undefined = name
  while (cur !== undefined) {
    if (chain.includes(cur)) {
      errors.push({ message: `цикл наследования: ${[...chain, cur].join(' → ')}`, hint: 'убери base у одного из скинов' })
      break
    }
    chain.push(cur)
    const text = lookup(cur)
    if (text === undefined) {
      errors.push({ message: cur === name ? `скина ${name} нет` : `base: ${cur} — такого скина нет`, ...(known ? { hint: `есть: ${[...known].sort().join(', ')}` } : {}) })
      break
    }
    const v = validateSkin(text, { name: cur, ...(known ? { known } : {}) })
    const prefix = cur === name ? '' : `база ${cur}: `
    errors.push(...v.errors.map((e) => ({ ...e, message: prefix + e.message })))
    if (cur === name) {
      header = v.header
      warnings.push(...v.warnings)
    }
    layers.unshift({ name: cur, text, vars: v.vars })
    cur = v.header.base
  }
  const vars: SkinVars = { common: {}, light: {}, dark: {} }
  let css = ''
  if (!errors.length) {
    const imports: string[] = []
    const bodies: string[] = []
    for (const layer of layers) {
      const r = renamed(layer.text, layer.name, name)
      imports.push(...r.imports)
      bodies.push(`/* ${layer.name === name ? name : `base: ${layer.name}`} */\n${[...settingsBlocks(layer.text), r.body].join('\n')}`)
      for (const m of ['common', 'light', 'dark'] as const) Object.assign(vars[m], layer.vars[m])
    }
    const fill: string[] = []
    for (const mode of modesOf(header.mode)) {
      const have = modeVars(vars, mode)
      const missing = REQUIRED_TOKENS.filter((tok) => !(tok in have))
      if (missing.length) {
        const from = fallbackPalette(chain, lookup, opts.fallback === undefined ? DEFAULT_SKIN : opts.fallback, mode)
        const add: Record<string, string> = {}
        for (const tok of missing) if (from.vars[tok] !== undefined) add[tok] = from.vars[tok]!
        Object.assign(vars[mode], add)
        if (Object.keys(add).length) fill.push(`[data-skin="${name}"][data-mode="${mode}"] {\n${Object.entries(add).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`)
        warnings.push({
          message: `палитра режима ${mode} неполная: нет ${missing.join(', ')}`,
          hint: `взяты из ${from.label}; свои — в [data-skin="${name}"][data-mode="${mode}"], или base: <скин>, или mode: ${mode === 'dark' ? 'light' : 'dark'} в шапке`,
        })
      }
      // Контраст текста и статусов — предупреждение: скин рисуется,
      // редактор тем и агент видят, что поправить; строго — тест скинов.
      for (const c of checkContrast(modeVars(vars, mode), mode)) warnings.push({ message: c.message, ...(c.hint ? { hint: c.hint } : {}) })
    }
    if (fill.length) bodies.unshift(`/* палитра добита: дыры уровня A */\n${fill.join('\n')}`)
    css = [...new Set(imports)].join('\n') + (imports.length ? '\n' : '') + bodies.join('\n')
  }
  return { name, header, css: errors.length ? '' : css, vars, chain, errors, warnings }
}
