/**
 * Конвертер темы VS Code (`colors` + `tokenColors`) → `.skin.css` (skin-convert-spec §4).
 *
 * `colors` — цвета рабочего места (`editor.background`, `sideBar.background`, `button.background`…)
 * ложатся в палитру, `tokenColors` (TextMate scope → цвет) — в семь токенов подсветки `--nr-code-*`
 * по первому подходящему scope (префиксом). Режим — `type: light|dark` (нет — по яркости фона).
 * `include` (тема поверх базовой) разворачивает вызывающий: `.vsix` и папку расширения читает CLI.
 */

import { evalColor } from './convert/color.js'
import { Coverage, derivePalette, emitCss, headerOf, isLight, liftContrast, lintOf, skinName, todoOf, toHex, TokenSet, type ConvertOptions, type ConvertResult } from './convert/core.js'

export interface VsCodeTokenColor {
  name?: string
  scope?: string | string[]
  settings?: { foreground?: string; fontStyle?: string; background?: string }
}

export interface VsCodeTheme {
  name?: string
  type?: 'light' | 'dark' | 'hc' | 'hcLight' | 'hcDark' | string
  include?: string
  colors?: Record<string, string>
  tokenColors?: VsCodeTokenColor[] | string
  semanticTokenColors?: Record<string, unknown>
  [key: string]: unknown
}

/** `colors` VS Code → токены: ключи по порядку, первый заданный — источник (skin-convert-spec §4). */
export const VSCODE_TOKEN_MAP: ReadonlyArray<{ token: `--nr-${string}`; keys: readonly string[] }> = [
  { token: '--nr-bg', keys: ['editor.background'] },
  { token: '--nr-surface', keys: ['sideBar.background', 'panel.background', 'activityBar.background'] },
  { token: '--nr-raised', keys: ['input.background', 'dropdown.background', 'editorWidget.background'] },
  { token: '--nr-fg', keys: ['editor.foreground', 'foreground'] },
  { token: '--nr-muted', keys: ['descriptionForeground', 'sideBar.foreground', 'disabledForeground'] },
  { token: '--nr-accent', keys: ['button.background', 'focusBorder', 'textLink.foreground'] },
  { token: '--nr-accent-fg', keys: ['button.foreground'] },
  { token: '--nr-focus', keys: ['focusBorder'] },
  { token: '--nr-line', keys: ['panel.border', 'sideBar.border', 'editorGroup.border', 'widget.border'] },
  { token: '--nr-line-soft', keys: ['editorGroup.border', 'editorIndentGuide.background1', 'editorIndentGuide.background', 'tree.indentGuidesStroke'] },
  { token: '--nr-error', keys: ['errorForeground', 'editorError.foreground'] },
  { token: '--nr-ok', keys: ['terminal.ansiGreen', 'gitDecoration.addedResourceForeground'] },
  { token: '--nr-shadow-pop', keys: ['widget.shadow'] },
  { token: '--nr-chrome', keys: ['titleBar.activeBackground'] },
]

/** `tokenColors` scope → токен подсветки: первый подходящий scope (префиксом). */
export const VSCODE_SCOPE_MAP: ReadonlyArray<{ token: `--nr-code-${string}`; scopes: readonly string[] }> = [
  { token: '--nr-code-comment', scopes: ['comment'] },
  { token: '--nr-code-keyword', scopes: ['keyword', 'storage.type', 'storage'] },
  { token: '--nr-code-string', scopes: ['string'] },
  { token: '--nr-code-number', scopes: ['constant.numeric', 'constant.language', 'constant'] },
  { token: '--nr-code-title', scopes: ['entity.name.function', 'entity.name.class', 'support.function'] },
  { token: '--nr-code-type', scopes: ['entity.name.type', 'support.type', 'support.class'] },
  { token: '--nr-code-attr', scopes: ['entity.other.attribute-name', 'variable.other.property', 'support.type.property-name'] },
]

/** Похоже ли на тему VS Code. */
export function isVsCodeTheme(j: unknown): j is VsCodeTheme {
  return typeof j === 'object' && j !== null && ('colors' in j || 'tokenColors' in j) && !('main_text_color' in j)
}

/** Тема поверх базовой (`include`): цвета и токены базы, своё — сверху. */
export function mergeVsCodeThemes(base: VsCodeTheme, own: VsCodeTheme): VsCodeTheme {
  return {
    ...base,
    ...own,
    colors: { ...(base.colors ?? {}), ...(own.colors ?? {}) },
    tokenColors: [...(Array.isArray(base.tokenColors) ? base.tokenColors : []), ...(Array.isArray(own.tokenColors) ? own.tokenColors : [])],
  }
}

/** JSON темы VS Code с комментариями и висячими запятыми (JSONC). */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let str = false
  while (i < text.length) {
    const ch = text[i]!
    if (str) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') str = false
      i++
      continue
    }
    if (ch === '"') {
      str = true
      out += ch
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      i = i < 0 ? text.length : i + 2
    } else {
      out += ch
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** Перевести тему VS Code в `.skin.css`. `input` — JSON темы (с уже развёрнутым `include`) или объект. */
export function convertVsCode(input: string | VsCodeTheme, opts: ConvertOptions = {}): ConvertResult {
  const theme = (typeof input === 'string' ? parseJsonc(input) : input) as VsCodeTheme
  const target = opts.target ?? 'skin'
  const name = opts.name ?? skinName(theme.name ?? opts.source ?? 'vscode-theme')
  const cov = new Coverage()
  const colors = theme.colors ?? {}
  const set = new TokenSet()
  const col = (k: string): string | null => {
    const v = colors[k]
    return typeof v === 'string' && evalColor(v) ? v : null
  }
  // Режим: `type`, иначе по яркости фона.
  const bg = col('editor.background')
  const declared = theme.type === 'light' || theme.type === 'hcLight' ? 'light' : theme.type === 'dark' || theme.type === 'hc' || theme.type === 'hcDark' ? 'dark' : null
  const mode: 'light' | 'dark' = declared ?? (bg && isLight({ ...evalColor(bg)!, a: 1 }) ? 'light' : 'dark')

  const used = new Set<string>()
  for (const r of VSCODE_TOKEN_MAP) {
    const k = r.keys.find((x) => col(x))
    if (!k) continue
    const v = col(k)!
    const c = evalColor(v)!
    if (r.token === '--nr-shadow-pop') set.set(r.token, `0 6px 20px ${toHex(c)}`, `colors ${k}`)
    else set.set(r.token, toHex(c), `colors ${k}`)
    used.add(k)
  }
  // Покрытие: ключи `colors`, которые мы знаем (из карты), — легли; прочее — интерфейс VS Code (лечь не на что).
  const known = new Set(VSCODE_TOKEN_MAP.flatMap((r) => r.keys))
  for (const k of Object.keys(colors)) {
    if (used.has(k)) cov.keep(k, VSCODE_TOKEN_MAP.find((r) => r.keys.includes(k))!.token)
    else if (known.has(k)) cov.keep(k, `${VSCODE_TOKEN_MAP.find((r) => r.keys.includes(k))!.token} (запасной источник)`)
    else cov.drop(k, 'цвет интерфейса VS Code — нет звена в nrchat', undefined, 1, true)
  }
  const pm = derivePalette(set, { mode })
  liftContrast(set, pm)

  // ── tokenColors ──
  const rules = Array.isArray(theme.tokenColors) ? theme.tokenColors : []
  const scopesOf = (r: VsCodeTokenColor): string[] => (Array.isArray(r.scope) ? r.scope : typeof r.scope === 'string' ? r.scope.split(',') : []).map((s) => s.trim()).filter(Boolean)
  for (const m of VSCODE_SCOPE_MAP) {
    // Сначала точный scope, потом уточнения префиксом (`comment.line`); позднее правило VS Code сильнее — с конца.
    let hit: { scope: string; color: string } | null = null
    for (const want of m.scopes) {
      for (const exact of [true, false]) {
        for (let i = rules.length - 1; i >= 0 && !hit; i--) {
          const r = rules[i]!
          const fg = r.settings?.foreground
          if (!fg || !evalColor(fg)) continue
          const s = scopesOf(r).find((x) => (exact ? x === want : x.startsWith(`${want}.`)))
          if (s) hit = { scope: s, color: fg }
        }
        if (hit) break
      }
      if (hit) break
    }
    if (hit) {
      set.set(m.token, toHex(evalColor(hit.color)!), `tokenColors ${hit.scope}`)
      cov.keep(`tokenColors ${hit.scope}`, m.token)
    }
  }
  const usedRules = rules.filter((r) => scopesOf(r).some((s) => VSCODE_SCOPE_MAP.some((m) => m.scopes.some((w) => s === w || s.startsWith(`${w}.`)))))
  const rest = rules.length - usedRules.length
  if (rest > 0) cov.drop(`tokenColors ×${rest}`, 'подсветка тоньше семи токенов контракта (--nr-code-*) — не переносится', undefined, 1)
  if (theme.semanticTokenColors) cov.drop('semanticTokenColors', 'семантическая подсветка — у нас highlight.js по семи токенам', undefined, 1)

  const header = headerOf(name, mode, opts, { description: `порт темы VS Code ${theme.name ?? name}` })
  const css = emitCss({
    target,
    ...(target === 'skin' ? { header } : {}),
    comment: `vscode → nr (nr-skins convertVsCode)${theme.name ? ` · ${theme.name}` : ''}`,
    imports: [],
    common: target === 'skin' ? {} : set.tokens,
    ...(target === 'skin' ? { palettes: { [mode]: set.tokens } } : {}),
  })
  const result: ConvertResult = {
    source: 'vscode',
    target,
    name,
    ...(target === 'skin' ? { header } : {}),
    css,
    tokens: set.tokens,
    palettes: { [mode]: set.tokens },
    sources: set.sources,
    mode,
    fonts: [],
    imports: [],
    report: cov.report(),
    lint: lintOf(target, css, target === 'skin' ? name : undefined),
  }
  result.report.todo = todoOf(result)
  return result
}
