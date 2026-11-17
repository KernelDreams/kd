// Профили — инклюд по выбору (поле формы `preset`).
//
// Поле `## $form` вида `$models: preset models/*.mdz // Модели` объявляет корневой
// атрибут `$models` профилем: его значение — файл из маски (`models/opus.mdz`,
// короткое имя `opus` или абсолютный путь), а корневые атрибуты этого файла
// действуют так, будто написаны сразу после строки `$models: …` — поверх всего,
// что выше (рецепт, база), и под всем, что ниже (вариант, значения запуска).
// `$title`/`$description` профиля — подпись и подсказка выбора, в документ не идут.
//
// Одна реализация на всех: `loadProgram` (runz — значение из документа и
// `--models=` CLI), сервис форм (дефолты формы, выбор в виджете и пульте) и
// задачи (`$job_keys` профиля — очередь). Работает по тексту с раскрытыми
// инклюдами, как и сами инклюды.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { asText, isArray, isContext, parseDocument } from '../core/index.js'
import type { IArray, IContext } from '../core/index.js'
import { readTextWithIncludes } from './includes.js'

export interface PresetField {
  /** Имя поля = корневой атрибут. */
  name: string
  /** Маска файлов профилей от папки файла формы (`models/*.mdz`; `*` и `?`). */
  glob: string
}

export interface PresetOption {
  /** Значение поля — путь от папки, где найден (`models/glm.mdz`). */
  value: string
  /** Абсолютный путь файла. */
  file: string
  /** `$title` профиля; нет — имя файла. */
  title: string
  /** `$description` профиля; нет — ''. */
  description: string
}

/** Атрибуты профиля, которые не подмешиваются: подпись и подсказка выбора. */
const META_KEYS = new Set(['title', 'description'])

const BLOCK_RE = /^## /
const ROOT_BLOCK_RE = /^##\s*\$@\s*$/
const FORM_BLOCK_RE = /^##\s*\$form(?:\s|$)/
const ATTR_RE = /^\$([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/
const PRESET_RE = /^\s*preset\??\s+(\S+)/

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile()

function expandHome(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** Строка документа → зона: `## $@` возвращает в корень, `## $form…` — форма, прочие `## ` — блок. */
type Zone = 'root' | 'form' | 'block'
function zoneOf(line: string): Zone {
  return ROOT_BLOCK_RE.test(line) ? 'root' : FORM_BLOCK_RE.test(line) ? 'form' : 'block'
}

/** Поля-профили всех блоков `## $form` текста (с раскрытыми инклюдами); одно имя — последнее. */
export function presetFields(text: string): PresetField[] {
  const out = new Map<string, PresetField>()
  let zone: Zone = 'root'
  for (const line of text.split(/\r?\n/)) {
    if (BLOCK_RE.test(line)) {
      zone = zoneOf(line)
      continue
    }
    if (zone !== 'form') continue
    const m = ATTR_RE.exec(line)
    const p = m ? PRESET_RE.exec(m[2]!) : null
    if (m && p) out.set(m[1]!, { name: m[1]!, glob: p[1]! })
  }
  return [...out.values()]
}

/** Один сегмент маски → RegExp: `*` — любые символы имени, `?` — один. */
function segmentRe(seg: string): RegExp {
  const body = seg
    .split('')
    .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^$(){}|[\]\\]/, '\\$&')))
    .join('')
  return new RegExp(`^${body}$`)
}

/** Пути относительно `dir`, подходящие под маску (`*`, `?`; `/` — каталоги). Скрытые — только явной маской. */
export function globIn(dir: string, glob: string): string[] {
  const segs = glob.split('/').filter((s) => s !== '' && s !== '.')
  const out: string[] = []
  const walk = (base: string, rel: string, i: number): void => {
    const seg = segs[i]!
    const last = i === segs.length - 1
    if (!/[*?]/.test(seg)) {
      const p = join(base, seg)
      try {
        const st = statSync(p)
        if (last ? st.isFile() : st.isDirectory()) last ? out.push(rel + seg) : walk(p, `${rel}${seg}/`, i + 1)
      } catch {
        // нет такого
      }
      return
    }
    const re = segmentRe(seg)
    let names: string[]
    try {
      names = readdirSync(base).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.') && !seg.startsWith('.')) continue
      if (!re.test(name)) continue
      const p = join(base, name)
      try {
        const st = statSync(p)
        if (last && st.isFile()) out.push(rel + name)
        else if (!last && st.isDirectory()) walk(p, `${rel}${name}/`, i + 1)
      } catch {
        // гонка с удалением
      }
    }
  }
  if (segs.length > 0) walk(dir, '', 0)
  return out
}

/** Корневые зоны текста профиля: группы «строка атрибута + продолжения», без `$//` и META_KEYS. */
function attrLines(text: string): { lines: string[]; meta: Record<string, string> } {
  const lines: string[] = []
  const meta: Record<string, string> = {}
  let zone: Zone = 'root'
  let keep = false
  for (const line of text.split(/\r?\n/)) {
    if (BLOCK_RE.test(line)) {
      zone = zoneOf(line)
      keep = false
      continue
    }
    if (zone !== 'root') continue
    if (line.startsWith('$')) {
      const m = ATTR_RE.exec(line)
      keep = !!m && !META_KEYS.has(m[1]!)
      if (m && META_KEYS.has(m[1]!)) meta[m[1]!] = unquote(m[2]!.trim())
      if (keep) lines.push(line)
      continue
    }
    if (keep && line.trim() !== '') lines.push(line)
    else keep = false
  }
  return { lines, meta }
}

/** Строки атрибутов профиля (свои инклюды раскрыты) — то, что встаёт после `$поле: …`. */
export function presetLines(file: string): string[] {
  return attrLines(readTextWithIncludes(file)).lines
}

/** Подпись и подсказка профиля. */
export function presetMeta(file: string): { title: string; description: string } {
  const { meta } = attrLines(readTextWithIncludes(file))
  return { title: meta.title || basename(file, extname(file)), description: meta.description ?? '' }
}

/** Элемент значения → строка; `${…}` — сырым текстом. */
function itemText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isContext(v)) return String((v as IContext).get(['raw']) ?? '')
  return asText(v as never) ?? ''
}

/**
 * Атрибуты профиля значениями (last-wins): скаляр — сырым текстом, список —
 * элементами. Для значений задачи и формы; `job_keys` — ключи очереди.
 */
export function presetValues(file: string): Record<string, string | string[]> {
  const doc = parseDocument(presetLines(file).join('\n'), { sigil: '$' })
  const out: Record<string, string | string[]> = {}
  const attrs = doc.cast('attrs') as IArray | undefined
  if (!attrs) return out
  for (const attr of attrs.iterate()) {
    if (!isContext(attr)) continue
    const key = attr.get(['key'])
    if (typeof key !== 'string') continue
    const value = attr.get(['value'])
    out[key] = isArray(value as never) ? [...(value as IArray).iterate()].map(itemText) : itemText(value)
  }
  return out
}

/** Профили по маске: из каждой папки по очереди, одинаковый путь — первый. */
export function presetOptions(dirs: readonly string[], glob: string): PresetOption[] {
  const seen = new Set<string>()
  const out: PresetOption[] = []
  for (const dir of dirs) {
    for (const rel of globIn(dir, glob)) {
      if (seen.has(rel)) continue
      seen.add(rel)
      const file = join(dir, rel)
      out.push({ value: rel, file, ...presetMeta(file) })
    }
  }
  return out
}

/** `"…"` значения → строка. */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string
    } catch {
      return v.slice(1, -1)
    }
  }
  return v
}

/**
 * Значение поля → файл профиля: абсолютный путь; путь от папки (`models/opus.mdz`);
 * короткое имя (`opus`) — файл маски с таким именем. Пусто — null. Не нашёлся —
 * throw: опечатка в `--models=` не должна молча запустить рецепт без профиля.
 */
export function resolvePreset(value: string, glob: string, dirs: readonly string[]): string | null {
  const v = expandHome(unquote(value.trim()))
  if (v === '') return null
  if (isAbsolute(v)) {
    if (isFile(v)) return v
  } else {
    for (const dir of dirs) {
      const p = resolve(dir, v)
      if (isFile(p)) return p
    }
    for (const dir of dirs) {
      for (const rel of globIn(dir, glob)) if (basename(rel, extname(rel)) === v) return join(dir, rel)
    }
  }
  const known = presetOptions(dirs, glob).map((o) => basename(o.value, extname(o.value)))
  throw new Error(`профиль "${value.trim()}" не найден (${glob}${known.length ? `: ${known.join(', ')}` : ''})`)
}

/** Папки поиска профилей: файл и все включённые в него, по порядку. */
export function presetDirs(file: string, included: readonly string[] = []): string[] {
  const out: string[] = []
  for (const d of [dirname(resolve(file)), ...included.map((f) => dirname(f))]) if (!out.includes(d)) out.push(d)
  return out
}

export interface ExpandPresetsOptions {
  /** Папки поиска профилей (`presetDirs`). */
  dirs: readonly string[]
  /**
   * Значения поверх документа (CLI `--models=opus`): поле-профиль из них — строка
   * `$поле: …` с атрибутами профиля в конец корня. Прочие ключи не трогаются.
   */
  values?: Record<string, unknown>
}

/**
 * Текст документа (инклюды раскрыты) → профили развёрнуты: после каждой корневой
 * строки `$поле: значение` поля-профиля — атрибуты его файла. Полей нет — текст
 * как есть. Значение с `${…}` не трогается: его разрешит резолвер, не загрузчик.
 */
export function expandPresets(text: string, opts: ExpandPresetsOptions): string {
  const fields = new Map(presetFields(text).map((f) => [f.name, f]))
  if (fields.size === 0) return text
  const out: string[] = []
  let zone: Zone = 'root'
  let changed = false
  for (const line of text.split(/\r?\n/)) {
    out.push(line)
    if (BLOCK_RE.test(line)) {
      zone = zoneOf(line)
      continue
    }
    if (zone !== 'root') continue
    const m = ATTR_RE.exec(line)
    const field = m ? fields.get(m[1]!) : undefined
    if (!m || !field || m[2]!.includes('${')) continue
    const file = resolvePreset(m[2]!, field.glob, opts.dirs)
    if (!file) continue
    out.push(...presetLines(file))
    changed = true
  }
  for (const [name, raw] of Object.entries(opts.values ?? {})) {
    const field = fields.get(name)
    const v = typeof raw === 'string' ? raw.trim() : ''
    if (!field || v === '' || v.includes('${')) continue
    const file = resolvePreset(v, field.glob, opts.dirs)
    if (!file) continue
    out.push('## $@', `$${name}: ${JSON.stringify(file)}`, ...presetLines(file))
    changed = true
  }
  return changed ? out.join('\n') : text
}
