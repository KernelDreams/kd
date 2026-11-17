/**
 * Конвертер темы SillyTavern (`public/themes/*.json`) → `.skin.css` (skin-convert-spec §3).
 *
 * Тема ST — палитра ключами (`main_text_color`, `chat_tint_color`…), размеры (`font_scale`,
 * `chat_width`), вид ленты (`chat_display`, `avatar_style`) и `custom_css` под DOM ST. Палитра — в
 * токены (rgba сохраняется, непрозрачный `--nr-bg` для контраста — поверх чёрного/белого по режиму),
 * размеры — в шкалу `--nr-text-*` и меру, вид — в правила реплик, `custom_css` — проекцией
 * селекторов (`.mes` → `.nr-message`…). Флажки поведения (таймер, счётчик токенов…) — не про вид.
 * Имена ключей ST (AGPL) берём, сами темы ST в набор не кладём.
 */

import * as csstree from 'css-tree'
import { FONT_HOSTS } from './contract.js'
import { evalColor } from './convert/color.js'
import {
  BLACK,
  classifyProp,
  Coverage,
  derivePalette,
  emitCss,
  headerOf,
  isLight,
  liftContrast,
  lintOf,
  remSize,
  resolveVars,
  skinName,
  todoOf,
  toHex,
  TokenSet,
  WHITE,
  type ConvertOptions,
  type ConvertResult,
  type ElementRule,
} from './convert/core.js'
import { over, TEXT_BASE_MIN_PX, TEXT_MIN_PX } from './readability.js'

/** Тема ST как в файле (ключи, что нам интересны; остальное — флажки поведения). */
export interface SillyTavernTheme {
  name?: string
  main_text_color?: string
  italics_text_color?: string
  underline_text_color?: string
  quote_text_color?: string
  blur_tint_color?: string
  chat_tint_color?: string
  user_mes_blur_tint_color?: string
  bot_mes_blur_tint_color?: string
  shadow_color?: string
  border_color?: string
  font_scale?: number
  blur_strength?: number
  shadow_width?: number
  chat_width?: number
  avatar_style?: number | string
  chat_display?: number | string
  noShadows?: boolean
  custom_css?: string
  [key: string]: unknown
}

/** Палитра ST → токены (skin-convert-spec §3). */
export const ST_TOKEN_MAP: ReadonlyArray<{ key: keyof SillyTavernTheme & string; token: `--nr-${string}`; note: string }> = [
  { key: 'main_text_color', token: '--nr-fg', note: 'основной текст' },
  { key: 'italics_text_color', token: '--nr-em', note: 'курсив — РП-действия' },
  { key: 'blur_tint_color', token: '--nr-surface', note: 'подложка панелей' },
  { key: 'chat_tint_color', token: '--nr-bg-chat', note: 'фон колонки ленты (rgba как есть); непрозрачный --nr-bg — поверх чёрного/белого' },
  { key: 'border_color', token: '--nr-line', note: 'рамки и разделители' },
  { key: 'shadow_color', token: '--nr-shadow-pop', note: 'тень поповеров (и текста, если shadow_width)' },
]

/** Ключи вида, которые ложатся в правила и размеры. */
const ST_VIEW_KEYS = ['quote_text_color', 'underline_text_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color', 'font_scale', 'chat_width', 'avatar_style', 'chat_display', 'blur_strength', 'shadow_width', 'noShadows', 'custom_css', 'name'] as const

/** `custom_css` ST: селектор → звено ленты (skin-convert-spec §3). */
export const ST_SELECTOR_MAP: ReadonlyArray<{ st: string; nr: string }> = [
  { st: '.mes', nr: '.nr-message' },
  { st: '.mes[is_user="true"]', nr: '.nr-message[data-role=user]' },
  { st: '.mes[is_user="false"]', nr: '.nr-message[data-role=assistant]' },
  { st: '.mes[is_system="true"]', nr: '.nr-message[data-role=system]' },
  { st: '.mes_text', nr: '.nr-text' },
  { st: '.mes_block', nr: '.nr-body' },
  { st: '.name_text, .ch_name', nr: '.nr-author' },
  { st: '.avatar, .mesAvatarWrapper', nr: '.nr-avatar' },
  { st: '#send_textarea, #send_form', nr: '.nr-composer' },
  { st: '#chat', nr: '.nr-feed' },
  { st: '.mes_reasoning_details, .mes_reasoning', nr: '.nr-thinking' },
]
const CLASS_MAP: Readonly<Record<string, string>> = {
  mes: '.nr-message',
  mes_text: '.nr-text',
  mes_block: '.nr-body',
  name_text: '.nr-author',
  ch_name: '.nr-author',
  avatar: '.nr-avatar',
  mesAvatarWrapper: '.nr-avatar',
  mes_reasoning: '.nr-thinking',
  mes_reasoning_details: '.nr-thinking',
}
const ID_MAP: Readonly<Record<string, string>> = { send_textarea: '.nr-composer', send_form: '.nr-composer', chat: '.nr-feed' }

/** Переменные SmartTheme в `custom_css` → наши токены (ссылкой) или ключ темы (значением). */
const SMART_VARS: Readonly<Record<string, { token?: string; key?: keyof SillyTavernTheme & string }>> = {
  '--SmartThemeBodyColor': { token: '--nr-fg', key: 'main_text_color' },
  '--SmartThemeEmColor': { token: '--nr-em', key: 'italics_text_color' },
  '--SmartThemeUnderlineColor': { key: 'underline_text_color' },
  '--SmartThemeQuoteColor': { key: 'quote_text_color' },
  '--SmartThemeBlurTintColor': { token: '--nr-surface', key: 'blur_tint_color' },
  '--SmartThemeChatTintColor': { token: '--nr-bg-chat', key: 'chat_tint_color' },
  '--SmartThemeUserMesBlurTintColor': { key: 'user_mes_blur_tint_color' },
  '--SmartThemeBotMesBlurTintColor': { key: 'bot_mes_blur_tint_color' },
  '--SmartThemeShadowColor': { key: 'shadow_color' },
  '--SmartThemeBorderColor': { token: '--nr-line', key: 'border_color' },
}

/** Кегли контракта по умолчанию (px) и полы читаемости — база для `font_scale`. */
export const TEXT_BASES: Readonly<Record<string, { px: number; min: number }>> = {
  '--nr-text-xs': { px: 13, min: TEXT_MIN_PX },
  '--nr-text-sm': { px: 15, min: TEXT_BASE_MIN_PX },
  '--nr-text-md': { px: 16, min: TEXT_MIN_PX },
  '--nr-text-lg': { px: 18, min: TEXT_MIN_PX },
  '--nr-text-body': { px: 16, min: TEXT_BASE_MIN_PX },
}

/** Ширина окна и ширина знака, в которых считаем `chat_width` (% окна) → `ch`. */
const WINDOW_PX = 1440
const CH_PX = 8.5

const chatDisplay = (v: unknown): 'flat' | 'bubbles' | 'document' => (v === 1 || v === 'bubbles' ? 'bubbles' : v === 2 || v === 'document' ? 'document' : 'flat')
const avatarRadius = (v: unknown): string | null => (v === 0 || v === 'round' ? '9999px' : v === 1 || v === 'rect' || v === 'rectangular' ? '0' : v === 2 || v === 'square' ? '0' : v === 3 || v === 'rounded' ? '20%' : null)

/** Похоже ли на тему ST (для угадывания источника). */
export function isSillyTavernTheme(j: unknown): j is SillyTavernTheme {
  return typeof j === 'object' && j !== null && ('main_text_color' in j || 'chat_tint_color' in j || 'blur_tint_color' in j)
}

/** Перевести тему ST в `.skin.css`. `input` — JSON темы (текст или объект). */
export function convertSillyTavern(input: string | SillyTavernTheme, opts: ConvertOptions = {}): ConvertResult {
  const theme: SillyTavernTheme = typeof input === 'string' ? (JSON.parse(input) as SillyTavernTheme) : input
  const target = opts.target ?? 'skin'
  const name = opts.name ?? skinName(theme.name ?? opts.source ?? 'st-theme')
  const cov = new Coverage()
  const set = new TokenSet()
  const color = (k: keyof SillyTavernTheme & string): string | null => {
    const v = theme[k]
    return typeof v === 'string' && evalColor(v) ? v.trim() : null
  }

  // ── Режим: по яркости фона ленты (флага у темы нет) ──
  const chat = color('chat_tint_color') ?? color('blur_tint_color')
  const chatC = chat ? evalColor(chat)! : null
  const mode: 'light' | 'dark' = chatC ? (isLight({ ...chatC, a: 1 }) ? 'light' : 'dark') : 'dark'
  const under = mode === 'light' ? WHITE : BLACK

  // ── Палитра ──
  for (const r of ST_TOKEN_MAP) {
    const v = color(r.key)
    if (!v) continue
    if (r.token === '--nr-shadow-pop') set.set(r.token, `0 6px 20px ${v}`, `key ${r.key}`)
    else if (r.token === '--nr-surface') {
      const c = evalColor(v)!
      set.set(r.token, c.a < 1 ? toHex(over(c, chatC ? over(chatC, under) : under)) : v, `key ${r.key}${c.a < 1 ? ' поверх фона' : ''}`)
    } else set.set(r.token, v, `key ${r.key}`)
    cov.keep(r.key, r.token)
  }
  if (chatC) set.set('--nr-bg', toHex(over(chatC, under)), `key chat_tint_color поверх ${mode === 'light' ? 'белого' : 'чёрного'}`)
  const pm = derivePalette(set, { mode })
  liftContrast(set, pm)

  // ── Размеры и вид ──
  const elements: ElementRule[] = []
  const el = (sel: string): Map<string, string> => {
    let r = elements.find((x) => x.sel === sel)
    if (!r) elements.push((r = { sel, props: new Map() }))
    return r.props
  }
  if (typeof theme.font_scale === 'number' && theme.font_scale > 0) {
    if (theme.font_scale !== 1) for (const [tok, b] of Object.entries(TEXT_BASES)) set.set(tok, remSize(`${b.px}px`, b.min, theme.font_scale)!, `key font_scale ×${theme.font_scale} (база ${b.px}px, пол ${b.min}px)`)
    cov.keep('font_scale', '--nr-text-*')
  }
  if (typeof theme.chat_width === 'number' && theme.chat_width > 0) {
    const ch = Math.round(((theme.chat_width / 100) * WINDOW_PX) / CH_PX)
    set.set('--nr-measure', `${ch}ch`, `key chat_width ${theme.chat_width}% (окно ${WINDOW_PX}px, знак ${CH_PX}px)`)
    cov.approximate('chat_width', '--nr-measure', `ширина в % окна → мера строки в ch (при окне ${WINDOW_PX}px)`)
  }
  const ar = avatarRadius(theme.avatar_style)
  if (ar !== null) {
    set.set('--nr-avatar-radius', ar, `key avatar_style ${String(theme.avatar_style)}`)
    cov.keep('avatar_style', '--nr-avatar-radius')
  }
  const display = chatDisplay(theme.chat_display)
  const userTint = color('user_mes_blur_tint_color')
  const botTint = color('bot_mes_blur_tint_color')
  if (userTint) {
    el('.nr-message[data-role=user]').set('background', userTint)
    cov.keep('user_mes_blur_tint_color', '.nr-message[data-role=user]', 'background')
  }
  if (botTint) {
    el('.nr-message[data-role=assistant]').set('background', botTint)
    cov.keep('bot_mes_blur_tint_color', '.nr-message[data-role=assistant]', 'background')
  }
  if (theme.chat_display !== undefined) {
    if (display === 'bubbles') {
      for (const role of ['user', 'assistant']) {
        const p = el(`.nr-message[data-role=${role}]`)
        p.set('border-radius', 'var(--nr-radius-lg)')
        p.set('padding', 'var(--nr-space-4) var(--nr-space-5)')
        if (!p.has('background')) p.set('background', 'var(--nr-surface)')
      }
      cov.keep('chat_display', '.nr-message[data-role=…]', 'bubbles: фон и радиус')
    } else if (display === 'document') {
      el('.nr-avatar').set('display', 'none')
      set.set('--nr-gutter-w', '0', 'key chat_display document')
      cov.keep('chat_display', '.nr-avatar, --nr-gutter-w', 'document: без аватаров')
    } else cov.keep('chat_display', '—', 'flat: как есть')
  }
  const quote = color('quote_text_color')
  if (quote) {
    el('.nr-text blockquote').set('color', quote)
    cov.approximate('quote_text_color', '.nr-text blockquote', 'ST красит реплики в кавычках, у нас — цитату')
  }
  const underline = color('underline_text_color')
  if (underline) {
    el('.nr-text u').set('color', underline)
    cov.carry('.nr-text u', 'color')
  }
  if (typeof theme.blur_strength === 'number' && theme.blur_strength > 0) {
    el('.nr-message').set('backdrop-filter', `blur(${theme.blur_strength}px)`)
    cov.carry('.nr-message', 'backdrop-filter')
  }
  // ST рисует shadow_width тенью текста реплики (`--shadowWidth` × `--SmartThemeShadowColor`); noShadows — выкл.
  const shadow = color('shadow_color')
  if (typeof theme.shadow_width === 'number' && theme.shadow_width > 0 && shadow && !theme.noShadows) {
    el('.nr-text').set('text-shadow', `0 0 ${theme.shadow_width}px ${shadow}`)
    cov.keep('shadow_width', '.nr-text', 'text-shadow')
  }

  // ── custom_css ──
  const fonts: string[] = []
  const imports: string[] = []
  const fontFaces: string[] = []
  if (typeof theme.custom_css === 'string' && theme.custom_css.trim()) projectCustomCss(theme.custom_css, theme, set, cov, el, fonts, imports, fontFaces)

  // Флажки поведения — не про вид (в покрытие не входят).
  for (const k of Object.keys(theme)) {
    if ((ST_VIEW_KEYS as readonly string[]).includes(k) || ST_TOKEN_MAP.some((r) => r.key === k)) continue
    cov.drop(k, 'флажок поведения ST — не про вид', undefined, 1, true)
  }

  const header = headerOf(name, mode, opts, { description: `порт темы SillyTavern ${theme.name ?? name}` })
  const css = emitCss({
    target,
    ...(target === 'skin' ? { header } : {}),
    comment: `sillytavern → nr (nr-skins convertSillyTavern)${theme.name ? ` · ${theme.name}` : ''}`,
    imports: [...fonts, ...imports],
    fontFaces,
    common: target === 'skin' ? {} : set.tokens,
    ...(target === 'skin' ? { palettes: { [mode]: set.tokens } } : {}),
    elements,
  })
  const result: ConvertResult = {
    source: 'sillytavern',
    target,
    name,
    ...(target === 'skin' ? { header } : {}),
    css,
    tokens: set.tokens,
    palettes: { [mode]: set.tokens },
    sources: set.sources,
    mode,
    fonts,
    imports,
    report: cov.report(),
    lint: lintOf(target, css, target === 'skin' ? name : undefined),
  }
  result.report.todo = todoOf(result)
  return result
}

/** `custom_css` ST: переменные SmartTheme и `:root` — в палитру, правила под `.mes…` — в звенья ленты. */
function projectCustomCss(
  text: string,
  theme: SillyTavernTheme,
  set: TokenSet,
  cov: Coverage,
  el: (sel: string) => Map<string, string>,
  fonts: string[],
  imports: string[],
  fontFaces: string[],
): void {
  const ast = csstree.parse(text, { positions: true, parseValue: false, parseCustomProperty: false, onParseError: () => {} })
  if (ast.type !== 'StyleSheet') return
  const raw = (d: csstree.Declaration): string => (d.value.type === 'Raw' ? d.value.value : csstree.generate(d.value)).trim()
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(SMART_VARS)) if (v.key && typeof theme[v.key] === 'string') vars[k] = theme[v.key] as string
  // Значение правила: SmartTheme с токеном — ссылкой на токен (контраст и ручки доходят), прочее — значением.
  const value = (v: string): string =>
    resolveVars(
      v.replace(/var\(\s*(--SmartTheme\w+)\s*(?:,[^)]*)?\)/g, (all, n: string) => (SMART_VARS[n]?.token ? `var(${SMART_VARS[n]!.token})` : all)),
      vars,
    )
  ast.children.forEach((node) => {
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
        if (u) (FONT_HOSTS.some((h) => u.includes(h)) ? fonts : imports).push(u)
        return
      }
      if (at === 'font-face') {
        fontFaces.push(csstree.generate(node))
        return
      }
      cov.drop(`@${node.name}`, at === 'media' ? 'адаптив ST — не переносится' : 'at-правило — не переносится', line)
      return
    }
    if (node.type !== 'Rule' || node.prelude.type !== 'SelectorList') return
    const decls = node.block.children.toArray().filter((d): d is csstree.Declaration => d.type === 'Declaration')
    node.prelude.children.forEach((sel) => {
      if (sel.type !== 'Selector') return
      const text = csstree.generate(sel)
      const nodes = sel.children.toArray()
      const isRoot = nodes.length === 1 && ((nodes[0]!.type === 'PseudoClassSelector' && nodes[0]!.name === 'root') || (nodes[0]!.type === 'TypeSelector' && (nodes[0]!.name === 'body' || nodes[0]!.name === 'html')))
      if (isRoot) {
        for (const d of decls) {
          const smart = SMART_VARS[d.property]
          if (smart?.token) {
            set.set(smart.token, value(raw(d)), `custom_css ${d.property}`)
            cov.keep(`${text} ${d.property}`, smart.token)
          } else if (d.property.startsWith('--')) vars[d.property] = raw(d)
          else if (d.property === 'font-family') {
            set.set('--nr-font-body', raw(d), `custom_css ${text} font-family`)
            set.set('--nr-font-ui', raw(d), `custom_css ${text} font-family`)
            cov.keep(`${text} font-family`, '--nr-font-body, --nr-font-ui')
          } else cov.drop(`${text} { ${d.property} }`, 'оформление страницы ST целиком — у нас токены', line)
        }
        return
      }
      const nr = mapStSelector(sel)
      if (!nr) {
        cov.drop(text, 'интерфейс ST — нет звена в ленте', line, decls.length || 1, true)
        return
      }
      for (const d of decls) {
        if (d.property.startsWith('--')) continue
        const cls = classifyProp(d.property)
        if (cls === 'layout') {
          cov.dropProp(nr, d.property)
          continue
        }
        el(nr).set(d.property, value(raw(d)).replace(/\s*!important\s*$/i, ''))
        if (cls === 'contract') cov.keep(text, nr, d.property)
        else cov.carry(nr, d.property)
      }
    })
  })
}

/** Селектор ST → звенья ленты (null — интерфейс ST). Теги и псевдоклассы после известного звена — как есть. */
function mapStSelector(sel: csstree.Selector): string | null {
  const out: string[] = []
  let compound = ''
  let known = false
  let ok = true
  const flush = (): void => {
    if (compound) out.push(compound)
    compound = ''
  }
  sel.children.forEach((n) => {
    if (!ok) return
    if (n.type === 'Combinator') {
      flush()
      if (n.name !== ' ') out.push(n.name)
      return
    }
    if (n.type === 'ClassSelector') {
      const m = CLASS_MAP[n.name]
      if (!m) {
        ok = false
        return
      }
      compound += m
      known = true
    } else if (n.type === 'IdSelector') {
      const m = ID_MAP[n.name]
      if (!m) {
        ok = false
        return
      }
      compound += m
      known = true
    } else if (n.type === 'AttributeSelector') {
      const v = n.value ? (n.value.type === 'String' ? n.value.value : n.value.type === 'Identifier' ? n.value.name : '') : ''
      if (n.name.name === 'is_user') compound += `[data-role=${v === 'true' ? 'user' : 'assistant'}]`
      else if (n.name.name === 'is_system' && v === 'true') compound += '[data-role=system]'
      else ok = false
    } else if (n.type === 'TypeSelector') {
      if (!known) {
        ok = n.name === 'body' || n.name === 'html'
        return
      }
      compound += n.name.toLowerCase()
    } else if (n.type === 'PseudoClassSelector') {
      compound += csstree.generate(n)
    } else ok = false
  })
  flush()
  if (!ok || !known) return null
  // `.nr-message.nr-message[data-role=user]` → `.nr-message[data-role=user]`.
  return out.join(' ').replace(/(\.nr-message)\1/g, '$1')
}
