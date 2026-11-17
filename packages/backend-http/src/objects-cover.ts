/**
 * Лицо записи (objects-spec §19): цвет `$color` и обложка с иконкой `## $cover` типа.
 *
 * Цвет — оттенок по хэшу id (или по полю через `$palette`) поверх эталона скина: строке уходит
 * `hue`, CSS — `oklch(from var(--nr-record-base) l c <hue>)` (фронт, код о скинах не знает).
 *
 * Обложка — правило данными: рефы (поля записи → картинки), шаблон промпта ntpl + стиль
 * (`<стенд>/cover-styles/<id>.mdz`), пресеты моделей. Результат лежит рядом с записью —
 * `<запись>.assets/cover.<ext>` + `icon.<ext>` + `cover.json` (хэш входов, модель, промпт, стиль,
 * дата). Хэш входов поменялся — запись «stale» и встаёт в очередь сама (`$auto`); картинка без
 * sidecar (положена руками) и закреплённая (`locked`) правилом не трогаются. Генерацию делает
 * генератор хоста ({@link CoverGenerator}: в nrchat — задача jobs), движок только решает, кому.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parse } from '@kerneldreams/nrd/md'
import { recordHue, type ObjectColorRule, type ObjectCoverState, type ObjectSlice } from '@kerneldreams/ui-protocol'

export const COVER_EXTS = ['png', 'webp', 'jpg', 'jpeg'] as const
export const COVER_SIDECAR = 'cover.json'
/** Ожидание задачи дольше этого — считается потерянной (авто может поставить заново). */
export const COVER_PENDING_MS = 2 * 60 * 60_000
const MAX_REFS = 10

/** `$color` + `$color_steps` + `$palette` типа. */
export interface ColorRuleDef extends ObjectColorRule {
  /** Значение поля → оттенок (градусы) или цвет (`--токен` / CSS). */
  palette?: Record<string, string>
}

/** Реф правила: поле записи (путь картинки), `поле → тип` (картинка другой записи), `@avatar`. */
export interface CoverRef {
  field: string
  type?: string
}

/** `## $cover` типа. */
export interface CoverRule {
  refs: CoverRef[]
  /** Шаблон ntpl по полям записи (+ `hue`, `color_name`, `title`, `id`). */
  prompt: string
  negative?: string
  style?: string
  styles: string[]
  preset: string[]
  /** Сама ставит в очередь: `stale` (по умолчанию) — только устаревшие, `all` — и недостающие, `off`. */
  auto: 'stale' | 'all' | 'off'
  /** Сторона квадратной иконки, px (`$icon_size`; старое имя `$icon` читается с предупреждением, icons-spec §3). */
  iconSize: number
  /** Замечания разбора — не ошибки (старый `$icon`). */
  warnings?: string[]
  /** Ключи лимитов jobs (`$job_keys`); нет — по пресету. */
  keys: string[]
}

const scalar = (raw: unknown): string => {
  const s = String(raw ?? '').trim()
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1)
  return s.replace(/\s+#\s.*$/, '').trim()
}
const list = (raw: unknown): string[] => scalar(raw).split(',').map((x) => x.trim()).filter(Boolean)

/** `$color` / `$color_steps` / `$palette` → правило; ошибка — строкой. */
export function parseColorRule(a: Record<string, string>): ColorRuleDef | string {
  const raw = scalar(a.color) || 'hash'
  const stepsRaw = scalar(a.color_steps)
  const steps = stepsRaw ? Number(stepsRaw) : 12
  if (!Number.isInteger(steps) || steps < 1 || steps > 360) return `\`$color_steps: ${stepsRaw}\` — целое 1…360`
  const palette: Record<string, string> = {}
  for (const p of list(a.palette)) {
    const i = p.indexOf('=')
    if (i <= 0) return `\`$palette\`: «${p}» — <значение>=<оттенок | --токен | цвет>`
    palette[p.slice(0, i).trim()] = p.slice(i + 1).trim()
  }
  if (raw === 'off') return { by: 'off', steps }
  if (raw === 'hash') return { by: 'hash', steps, ...(Object.keys(palette).length ? { palette } : {}) }
  if (!/^[\w.-]+$/.test(raw)) return `\`$color: ${raw}\` — hash | off | <поле>`
  return { by: 'field', field: raw, steps, ...(Object.keys(palette).length ? { palette } : {}) }
}

/** Цвет записи: `{hue}` или `{color}` (токен палитры); `off` — пусто. */
export function colorOf(rule: ColorRuleDef, id: string, value: string): { hue?: number; color?: string } {
  if (rule.by === 'off') return {}
  if (rule.by === 'field' && value) {
    const p = rule.palette?.[value]
    if (p !== undefined) {
      const n = Number(p)
      if (p !== '' && Number.isFinite(n)) return { hue: ((Math.round(n) % 360) + 360) % 360 }
      return { color: p.startsWith('--') ? `var(${p})` : p }
    }
    // Значение без палитры — свой оттенок по значению: один провайдер — один цвет.
    return { hue: recordHue(value, rule.steps) }
  }
  return { hue: recordHue(id, rule.steps) }
}

/** Имя оттенка для промпта: «иконка одного цвета со строкой». */
export function hueName(hue: number): string {
  const names = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'azure', 'blue', 'violet', 'magenta']
  return names[Math.floor((((hue % 360) + 360) % 360 + 15) / 30) % 12] ?? 'red'
}

/** Секция `## $cover` (дочерний узел mdz) → правило; нет секции — `undefined`. */
export function parseCoverRule(text: string): CoverRule | string | undefined {
  type Node = { name: string; attrs: Array<{ key: string[]; value: unknown }>; children: Node[]; body?: string }
  let root: Node
  try {
    root = (parse(text) as { root: Node }).root
  } catch {
    return undefined
  }
  const node = root.children.find((c) => c.name === 'cover')
  if (!node) return undefined
  const a: Record<string, string> = {}
  for (const at of node.attrs) if (at.key.length === 1 && at.key[0]) a[at.key[0]] = at.value as string
  const known = new Set(['refs', 'prompt', 'negative', 'style', 'styles', 'preset', 'auto', 'icon_size', 'icon', 'job_keys'])
  const unknown = Object.keys(a).filter((k) => !known.has(k))
  if (unknown.length) return `\`## $cover\`: неизвестные ключи ${unknown.map((k) => `$${k}`).join(', ')}`
  const refs: CoverRef[] = []
  for (const r of list(a.refs)) {
    const m = /^(@?[\w.-]+)\s*(?:(?:→|->)\s*([a-z0-9][a-z0-9_-]*))?$/.exec(r)
    if (!m) return `\`$refs\`: «${r}» — <поле>, <поле> → <тип> или @avatar`
    refs.push({ field: m[1]!, ...(m[2] ? { type: m[2] } : {}) })
  }
  const prompt = scalar(a.prompt) || String(node.body ?? '').replace(/^\s*\$\/\/.*$/gm, '').trim()
  if (!prompt) return '`## $cover`: нужен `$prompt` или текст секции (шаблон промпта)'
  const auto = scalar(a.auto) || 'stale'
  if (auto !== 'stale' && auto !== 'all' && auto !== 'off') return `\`$auto: ${auto}\` — stale | all | off`
  // Размер иконки — `$icon_size` (`$icon` путался с иконкой типа); старое имя — с предупреждением.
  const warnings: string[] = []
  const sizeKey = a.icon_size !== undefined ? 'icon_size' : a.icon !== undefined ? 'icon' : 'icon_size'
  if (sizeKey === 'icon') warnings.push('`## $cover`: `$icon` — старое имя размера иконки, теперь `$icon_size`')
  const icon = Number(scalar(a[sizeKey]) || 256)
  if (!Number.isInteger(icon) || icon < 16 || icon > 1024) return `\`$${sizeKey}: ${scalar(a[sizeKey])}\` — px 16…1024`
  const style = scalar(a.style)
  const styles = list(a.styles)
  return {
    refs,
    prompt,
    ...(scalar(a.negative) ? { negative: scalar(a.negative) } : {}),
    ...(style ? { style } : {}),
    styles: style && !styles.includes(style) ? [style, ...styles] : styles,
    preset: list(a.preset).length ? list(a.preset) : ['qwen'],
    auto,
    iconSize: icon,
    ...(warnings.length ? { warnings } : {}),
    keys: list(a.job_keys),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Стили
// ────────────────────────────────────────────────────────────────────────────

export interface CoverStyle {
  id: string
  title: string
  prompt: string
  negative?: string
}

/** Стиль из каталогов (позже — старше): `<id>.mdz` — `$title`, `$prompt` (или текст), `$negative`. */
export function readCoverStyle(dirs: readonly string[], id: string): CoverStyle | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return null
  for (const d of [...dirs].reverse()) {
    const file = join(d, `${id}.mdz`)
    if (!existsSync(file)) continue
    try {
      const doc = parse(readFileSync(file, 'utf-8')) as { root: { attrs: Array<{ key: string[]; value: unknown }>; body?: string } }
      const a: Record<string, string> = {}
      for (const at of doc.root.attrs) if (at.key.length === 1 && at.key[0]) a[at.key[0]] = at.value as string
      const prompt = scalar(a.prompt) || String(doc.root.body ?? '').replace(/^\s*\$\/\/.*$/gm, '').trim()
      return { id, title: scalar(a.title) || id, prompt, ...(scalar(a.negative) ? { negative: scalar(a.negative) } : {}) }
    } catch {
      return null
    }
  }
  return null
}

/** Все стили каталогов: id → заголовок. */
export function listCoverStyles(dirs: readonly string[]): Array<{ id: string; title: string }> {
  const ids = new Set<string>()
  for (const d of dirs) {
    if (!existsSync(d)) continue
    for (const n of readdirSync(d)) if (n.endsWith('.mdz')) ids.add(n.slice(0, -4))
  }
  return [...ids].sort().map((id) => ({ id, title: readCoverStyle(dirs, id)?.title ?? id }))
}

// ────────────────────────────────────────────────────────────────────────────
// Файлы обложки записи
// ────────────────────────────────────────────────────────────────────────────

export interface CoverSidecar {
  hash?: string
  model?: string
  preset?: string
  prompt?: string
  style?: string
  refs?: string[]
  date?: string
  job?: string
  locked?: boolean
  pending?: { hash: string; at: string; job?: string }
  error?: { hash: string; message: string; at: string }
}

/** Каталог ассетов записи: `<файл без расширения>.assets` (у `<папка>/CARD.mdz` — `CARD.assets`). */
export function assetsDir(file: string): string {
  return `${file.slice(0, file.length - extname(file).length)}.assets`
}

export function imageIn(dir: string, stem: string): string | null {
  for (const e of COVER_EXTS) {
    const f = join(dir, `${stem}.${e}`)
    if (existsSync(f)) return f
  }
  return null
}

export function readSidecar(dir: string): CoverSidecar | null {
  const f = join(dir, COVER_SIDECAR)
  if (!existsSync(f)) return null
  try {
    const v = JSON.parse(readFileSync(f, 'utf-8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as CoverSidecar) : null
  } catch {
    return null
  }
}

export function writeSidecar(dir: string, data: CoverSidecar): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, COVER_SIDECAR), JSON.stringify(data, null, 2) + '\n')
}

/** Состояние обложки по файлам и текущему хэшу входов. */
export function coverStateOf(dir: string, hash: string, now = Date.now()): { state: ObjectCoverState; cover: string | null; icon: string | null; error?: string } {
  const cover = imageIn(dir, 'cover')
  const icon = imageIn(dir, 'icon')
  const side = readSidecar(dir)
  const pending = !!side?.pending && side.pending.hash === hash && now - Date.parse(side.pending.at) < COVER_PENDING_MS
  const error = side?.error && side.error.hash === hash ? side.error.message : undefined
  const base = { cover, icon, ...(error ? { error } : {}) }
  if (!cover) return { ...base, state: pending ? 'queued' : 'missing' }
  if (!side || (!side.hash && !side.pending && !side.locked)) return { ...base, state: 'manual' }
  if (side.locked) return { ...base, state: 'locked' }
  if (side.hash === hash) return { ...base, state: 'ready' }
  return { ...base, state: pending ? 'queued' : 'stale' }
}

// ────────────────────────────────────────────────────────────────────────────
// Хэш входов
// ────────────────────────────────────────────────────────────────────────────

const fileHashes = new Map<string, { mtime: number; size: number; hash: string }>()

/** Хэш содержимого файла (кэш по mtime/size): «touch» обложку не перегенерирует. */
export function fileHash(file: string): string {
  const st = statSync(file)
  const hit = fileHashes.get(file)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.hash
  const hash = createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 16)
  fileHashes.set(file, { mtime: st.mtimeMs, size: st.size, hash })
  return hash
}

export const IMAGE_RE = /\.(png|webp|jpe?g|gif)$/i

/** Значения поля-рефа → существующие картинки (путь от папки записи, `~`). */
export function refFiles(values: readonly string[], recordFile: string, home: string): string[] {
  const out: string[] = []
  for (const v of values) {
    const p = v.trim()
    if (!p || !IMAGE_RE.test(p)) continue
    const abs = p.startsWith('~/') ? join(home, p.slice(2)) : resolve(dirname(recordFile), p)
    try {
      if (statSync(abs).isFile()) out.push(abs)
    } catch {
      // нет файла — реф выпадает
    }
  }
  return out
}

export interface CoverInputs {
  prompt: string
  negative?: string
  refs: string[]
  style?: string
  preset: string[]
  hash: string
}

/** Входы генерации и их хэш: промпт (с стилем), рефы содержимым, пресеты. */
export function coverInputs(p: { prompt: string; negative?: string; refs: string[]; style?: CoverStyle | null; preset: string[] }): CoverInputs {
  const prompt = [p.prompt.trim(), p.style?.prompt?.trim()].filter(Boolean).join('\n\n')
  const negative = [p.negative, p.style?.negative].filter(Boolean).join(', ') || undefined
  const refs = p.refs.slice(0, MAX_REFS)
  const hash = createHash('sha1')
    .update(JSON.stringify({ prompt, negative: negative ?? '', refs: refs.map((f) => [basename(f), fileHash(f)]), preset: p.preset }))
    .digest('hex')
    .slice(0, 16)
  return { prompt, ...(negative ? { negative } : {}), refs, ...(p.style ? { style: p.style.id } : {}), preset: p.preset, hash }
}

/** Запрос генератору: одна запись, все входы и куда класть. */
export interface CoverJobRequest {
  type: string
  id: string
  title: string
  prompt: string
  negative?: string
  refs: string[]
  preset: string[]
  style?: string
  hash: string
  hue?: number
  /** Каталог ассетов записи: генератор кладёт `cover.<ext>`, `icon.<ext>` и дописывает `cover.json`. */
  dir: string
  icon: number
  keys: string[]
}

/** Генератор хоста: ставит работу (задача jobs) и сразу отвечает; файлы — по готовности. */
export type CoverGenerator = (req: CoverJobRequest) => Promise<{ job?: string }> | { job?: string }

/**
 * Срезы списка типа (`## $slice <id>`, v1.58): `$title`, `$icon`, `$q` — строка поиска, прочие ключи —
 * фасеты (`$customer: erin`, список — `[a, b]`) → `f.<поле>: a,b` — параметры списка левой панели (§18).
 * Ошибка — строкой (тип не грузится).
 */
export function parseSlices(text: string): ObjectSlice[] | string {
  type Node = { name: string; id?: string; attrs: Array<{ key: string[]; value: unknown }>; children: Node[] }
  let root: Node
  try {
    root = (parse(text) as { root: Node }).root
  } catch {
    return []
  }
  const out: ObjectSlice[] = []
  for (const node of root.children) {
    if (node.name !== 'slice') continue
    const id = String(node.id ?? '').trim()
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return `\`## $slice ${id}\`: id — a-z, 0-9, _ и -`
    if (out.some((x) => x.id === id)) return `\`## $slice ${id}\` дважды`
    let title = id
    let icon: string | undefined
    const params: Record<string, string> = {}
    for (const at of node.attrs) {
      const k = at.key.join('.')
      const v = scalar(at.value)
      if (k === 'title') title = v || id
      else if (k === 'icon') icon = v
      else if (k === 'q') params.q = v
      else if (v) params[`f.${k}`] = list(v.replace(/^\[|\]$/g, '')).join(',')
    }
    out.push({ id, title, ...(icon ? { icon } : {}), params })
  }
  return out
}
