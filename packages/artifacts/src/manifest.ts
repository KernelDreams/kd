/**
 * `meta.mdz` артефакта (artifacts-spec §2, §5): NRD, не JSON.
 *
 * Разбор — `@kerneldreams/nrd` (свой парсер не пишем). Проекция корневых
 * атрибутов на типизированную форму; незнакомые ключи игнорируются (как в v1).
 * Битый манифест — значение-ошибка с номером строки, не throw: одна плохая
 * папка не роняет список.
 *
 * Скоупы прав пишутся как в спеке — `$fs-read: {artifact}, {workspace}`. Для NRD
 * `{…}` — JSON5-объект, поэтому строки `$fs-read/$fs-write/$run-allow` с сырым
 * значением перед разбором заворачиваются в строку (та же строка — номера строк
 * ошибок не съезжают). Форма списка `$[…]` тоже принимается.
 */

import { asText, isContext, parseDocument } from '@kerneldreams/nrd'
import type { IArray, IContext } from '@kerneldreams/nrd'

/** Закрытый набор прав `$uses` (v1 + v2; `comfy` —, `viewer` —, `session` —, `image` —, `speak`/`llm` —). */
export const CAPABILITIES = ['file', 'watch', 'dialog', 'run', 'job', 'service', 'clipboard', 'comfy', 'image', 'viewer', 'session', 'skins', 'app', 'speak', 'llm'] as const
export type Capability = (typeof CAPABILITIES)[number]

export interface ArtifactManifest {
  title: string
  description: string
  /** Путь иконки относительно папки артефакта. */
  icon: string | null
  /** `$version` — ставит finalize; нет ключа — 0. */
  version: number
  /** `$uses`; `null` — ключа нет (легаси-доступ + предупреждение). */
  uses: Capability[] | null
  /** Значения `$uses`, которых нет в закрытом наборе (опечатки, выдуманное). */
  unknownUses: string[]
  /** `$fs-read` / `$fs-write` как написано; `null` — ключа нет (умолчание §5). */
  fsRead: string[] | null
  fsWrite: string[] | null
  /**
   * `$session-read` / `$session-write`: что артефакт читает и пишет в
   * сессии чата (`meta`, `personas`, `history`); `null` — ключа нет (умолчание:
   * чтение всего, запись ничего).
   */
  sessionRead: string[] | null
  sessionWrite: string[] | null
  /** `$run-allow`: имена appz и глобы шаблонов; пусто — любой. */
  runAllow: string[]
  /** `$service: lazy | eager`. */
  service: 'lazy' | 'eager'
  /** `$service-idle`, секунды; 0 — не выгружать. */
  serviceIdle: number
  /**
   * `$handles` — kinds файлов (open-spec §3, §7): `comfy-image, ext:json`. Файл
   * с пересекающимися kinds открывается этим артефактом вкладкой окна файла.
   */
  handles: string[]
  /**
   * `$places` (plugin-registry-spec §2): места артефакта-плагина — `panel` (вкладка колонки смотрелки через
   * `slotFills` владельца места), `command`… Пусто — только свои входы (список, ⚡, вкладка окна файла).
   */
  places: string[]
  /**
   * `$widget: <id>` (+ `$types`, `$props` — JSON Schema props, `$widget-sandbox: strict`) — артефакт —
   * виджет поля универсального редактора (universal-editor-spec §4): сразу в каталоге,
   * говорит мостом v2 каналом `__host.widget`. `null` — не виджет.
   */
  widget: ArtifactWidget | null
}

export interface ArtifactWidget {
  id: string
  /** Типы данных поля (`boolean[]`, `string`…); пусто — любой. */
  types: string[]
  props?: Record<string, unknown>
  sandbox: 'default' | 'strict'
}

export type ManifestResult = { ok: true; value: ArtifactManifest } | { ok: false; error: string; line?: number }

const RAW_LIST_KEYS = ['fs-read', 'fs-write', 'run-allow', 'session-read', 'session-write']

/** Сырые значения скоупов → строка NRD. Та же строка: номера строк сохраняются. */
export function quoteScopeLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*\$([\w-]+)\s*:\s*)(.*?)\s*$/.exec(line)
      if (!m || !RAW_LIST_KEYS.includes(m[2]!)) return line
      const value = m[3]!
      if (value === '' || value.startsWith('$[') || value.startsWith('"') || value.startsWith("'")) return line
      // Хвостовой комментарий NRD `// …` — не часть значения.
      const cut = value.replace(/\s+\/\/.*$/, '')
      return `$${m[2]}: ${JSON.stringify(cut)}`
    })
    .join('\n')
}

function toList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'object' && typeof (value as IArray).iterate === 'function' && !isContext(value)) {
    const out: string[] = []
    for (const item of (value as IArray).iterate()) {
      const t = asText(item as never)
      if (typeof t === 'string' && t.trim()) out.push(t.trim())
    }
    return out
  }
  const text = typeof value === 'string' ? value : asText(value as never)
  if (typeof text !== 'string') return []
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const t = asText(value as never)
  return typeof t === 'string' ? t : null
}

/** Корневые атрибуты (last-wins). */
function rootAttrs(doc: IContext): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const attrs = doc.cast<IArray>('attrs')
  if (!attrs) return out
  for (const attr of attrs.iterate()) {
    if (!isContext(attr)) continue
    const key = attr.get(['key'])
    if (typeof key === 'string') out.set(key, attr.get(['value']))
  }
  return out
}

export function parseManifest(text: string): ManifestResult {
  let attrs: Map<string, unknown>
  try {
    attrs = rootAttrs(parseDocument(quoteScopeLines(text), { sigil: '$' }))
  } catch (e) {
    const err = e as Error & { line?: number }
    const line = typeof err.line === 'number' ? err.line : undefined
    return { ok: false, error: `meta.mdz: ${err.message}`, ...(line !== undefined ? { line } : {}) }
  }

  const title = toText(attrs.get('title'))?.trim()
  if (!title) return { ok: false, error: 'meta.mdz: $title обязателен', line: 1 }

  let uses: Capability[] | null = null
  const unknownUses: string[] = []
  if (attrs.has('uses')) {
    const seen = new Set<Capability>()
    for (const v of toList(attrs.get('uses'))) {
      if ((CAPABILITIES as readonly string[]).includes(v)) seen.add(v as Capability)
      else unknownUses.push(v)
    }
    uses = [...seen]
  }

  const versionNum = Number(toText(attrs.get('version')) ?? 0)
  const idleRaw = toText(attrs.get('service-idle'))
  const idle = idleRaw === null ? 300 : Number(idleRaw)

  return {
    ok: true,
    value: {
      title,
      description: toText(attrs.get('description'))?.trim() ?? '',
      icon: attrs.has('icon') ? (toText(attrs.get('icon'))?.trim() ?? null) : null,
      version: Number.isInteger(versionNum) && versionNum >= 0 ? versionNum : 0,
      uses,
      unknownUses,
      fsRead: attrs.has('fs-read') ? toList(attrs.get('fs-read')) : null,
      fsWrite: attrs.has('fs-write') ? toList(attrs.get('fs-write')) : null,
      sessionRead: attrs.has('session-read') ? toList(attrs.get('session-read')) : null,
      sessionWrite: attrs.has('session-write') ? toList(attrs.get('session-write')) : null,
      runAllow: toList(attrs.get('run-allow')),
      service: toText(attrs.get('service'))?.trim().toLowerCase() === 'eager' ? 'eager' : 'lazy',
      serviceIdle: Number.isFinite(idle) && idle >= 0 ? idle : 300,
      handles: toList(attrs.get('handles')),
      places: toList(attrs.get('places')),
      widget: widgetOf(attrs, text),
    },
  }
}

const WIDGET_ID = /^[a-z0-9][a-z0-9._-]*$/i

/** `$props` — JSON одной строкой (в кавычках или без): схема props виджета; битая — виджет без неё. */
function widgetOf(attrs: Map<string, unknown>, text: string): ArtifactWidget | null {
  const id = toText(attrs.get('widget'))?.trim()
  if (!id || !WIDGET_ID.test(id)) return null
  let props: Record<string, unknown> | undefined
  const line = /^\s*\$props\s*:\s*(.+?)\s*$/m.exec(text)?.[1]
  if (line) {
    const raw = /^(['"])([\s\S]*)\1$/.exec(line)?.[2] ?? line
    try {
      const v = JSON.parse(raw) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) props = v as Record<string, unknown>
    } catch {
      // Битая схема props — виджет без проверки props.
    }
  }
  return {
    id,
    types: toList(attrs.get('types')),
    ...(props ? { props } : {}),
    sandbox: toText(attrs.get('widget-sandbox'))?.trim() === 'strict' ? 'strict' : 'default',
  }
}

/**
 * Поставить `$version: n` в текст манифеста: заменить строку ключа либо
 * дописать после `$title`. Остальной текст (комментарии, порядок) — как был.
 */
export function setManifestVersion(text: string, version: number): string {
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => /^\s*\$version\s*:/.test(l))
  const line = `$version: ${version}`
  if (idx !== -1) {
    lines[idx] = line
    return lines.join('\n')
  }
  const titleIdx = lines.findIndex((l) => /^\s*\$title\s*:/.test(l))
  lines.splice(titleIdx === -1 ? 0 : titleIdx + 1, 0, line)
  return lines.join('\n')
}
