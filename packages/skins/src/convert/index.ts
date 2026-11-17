/**
 * Вход конвертеров одной функцией (skin-convert-spec §1): источник угадывается по содержимому,
 * если не задан. CLI (`runz skin convert`), тул `skin_convert` и плагин импорта зовут это.
 *
 * Конвертеры — реестр: встроенные Obsidian, SillyTavern, VS Code; внешние (темы площадок)
 * регистрируются снаружи `registerThemeConverter` и сразу видны `detectSource` / `convertTheme`.
 */

import { convertObsidian, type ObsidianManifest } from '../obsidian.js'
import { convertSillyTavern, isSillyTavernTheme } from '../sillytavern.js'
import { convertVsCode, isVsCodeTheme, parseJsonc } from '../vscode.js'
import type { ConvertOptions, ConvertResult, ConvertSource } from './core.js'

export interface ConvertThemeOptions extends ConvertOptions {
  from?: ConvertSource
  /** `manifest.json` темы Obsidian (имя, автор). */
  manifest?: ObsidianManifest
}

/** Конвертер темы в реестре. */
export interface ThemeConverter {
  /** Имя источника: значение `from` и `ConvertResult.source`. */
  id: string
  /**
   * Узнать тему по тексту (и имени файла). false / 0 / null — не наша; true — 1; число — уверенность:
   * побеждает наибольшая, при равенстве — раньше зарегистрированный.
   */
  detect?(text: string, file: string): boolean | number | null | undefined
  convert(text: string, opts: ConvertThemeOptions): ConvertResult
}

/** Текст похож на JSON (или файл `.json`) — CSS-детекторы его не берут. */
export function isJsonTheme(text: string, file = ''): boolean {
  return text.trimStart().startsWith('{') || /\.json$/i.test(file)
}

function jsonOf(text: string): unknown {
  try {
    return parseJsonc(text.trimStart())
  } catch {
    return undefined
  }
}

const OBSIDIAN = /\.theme-(dark|light)\b|--background-primary\b|--text-normal\b|\.markdown-(rendered|preview-view)\b|--interactive-accent\b/

const BUILTIN: ThemeConverter[] = [
  {
    id: 'obsidian',
    detect: (text, file) => !isJsonTheme(text, file) && OBSIDIAN.test(text),
    convert: (text, { from: _f, manifest, ...rest }) => convertObsidian(text, { ...rest, ...(manifest ? { manifest } : {}) }),
  },
  {
    id: 'sillytavern',
    detect: (text, file) => isJsonTheme(text, file) && isSillyTavernTheme(jsonOf(text)),
    convert: (text, { from: _f, manifest: _m, ...rest }) => convertSillyTavern(text, rest),
  },
  {
    id: 'vscode',
    detect: (text, file) => {
      if (!isJsonTheme(text, file)) return false
      const j = jsonOf(text)
      return !isSillyTavernTheme(j) && isVsCodeTheme(j)
    },
    convert: (text, { from: _f, manifest: _m, ...rest }) => convertVsCode(text, rest),
  },
]

const registry = new Map<string, ThemeConverter>(BUILTIN.map((c) => [c.id, c]))

/** Зарегистрировать конвертер (повтор с тем же id — замена). Возвращает снятие. */
export function registerThemeConverter(converter: ThemeConverter): () => void {
  registry.set(converter.id, converter)
  return () => {
    if (registry.get(converter.id) === converter) {
      const builtin = BUILTIN.find((c) => c.id === converter.id)
      if (builtin) registry.set(builtin.id, builtin)
      else registry.delete(converter.id)
    }
  }
}

/** Зарегистрированные конвертеры в порядке регистрации. */
export function themeConverters(): ThemeConverter[] {
  return [...registry.values()]
}

/** Источник по тексту (и имени файла) — id конвертера; null — не узнали. */
export function detectSource(text: string, file = ''): ConvertSource | null {
  let best: { id: string; score: number } | null = null
  for (const c of registry.values()) {
    const r = c.detect?.(text, file)
    const score = r === true ? 1 : typeof r === 'number' ? r : 0
    if (score > 0 && (!best || score > best.score)) best = { id: c.id, score }
  }
  return best?.id ?? null
}

/** Конвертировать тему любого зарегистрированного источника. Не узнали — ошибка с подсказкой `from`. */
export function convertTheme(text: string, opts: ConvertThemeOptions = {}): ConvertResult {
  const from = opts.from ?? detectSource(text, opts.source)
  const c = from ? registry.get(from) : undefined
  if (!c) {
    const known = [...registry.keys()].join(' | ')
    throw new Error(from ? `нет конвертера тем «${from}» — from: ${known}` : `источник темы не узнан — укажи from: ${known}`)
  }
  return c.convert(text, opts)
}
