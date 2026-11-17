// @kerneldreams/nrd/batch — комбинаторика документа (batch-spec §2–§3).
//
// Документ → группы батчей → комбинации. Оси — блоки `## $name` со списком или
// tbl-таблицей в теле, до которых дотягиваются «параметры» хоста через `${}`;
// группы — `## $batch <id>` со своими атрибутами (слой поверх корня) и осями
// `###`. Ступень portable: ноль IO, никаких знаний про ноды, workflow, HTTP —
// инклюды раскрывает хост, применение комбинации — тоже хост.

import { scanPlaceholders } from '../core/placeholder.js'
import type { Placeholder, PathSegment, PlaceholderArg } from '../core/placeholder.js'
import { arrayValue, chainContext, objectContext } from '../core/contexts.js'
import { cartesian } from '../core/cartesian.js'
import { asText, isArray, isContext } from '../core/icontext.js'
import type { IArray, IContext, Value } from '../core/icontext.js'
import { parseAxisBody } from './lists.js'
import type { AxisBody, BatchPoint } from './lists.js'

export { parseAxisBody, parseList, parseRange, extractFencedBlock } from './lists.js'
export type { AxisBody, BatchPoint, ListEntry } from './lists.js'

/** Ошибка документа батча: неоднозначность, неизвестная группа, нет точки. */
export class BatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BatchError'
  }
}

/** Слой группы до перемножения — то, что видит колбэк `params`. */
export interface BatchLayer {
  /** id группы (`## $batch <id>`); undefined — документ без групп. */
  id?: string
  /** Все атрибуты группы поверх корня, сырой текст (`${}` не раскрыт), last-wins. */
  texts: Map<string, string>
  /** Переменные: бесточечные атрибуты и фенс-тела, группа поверх корня. */
  attrs: IContext
  /** Атрибуты как разобраны (список — списком, `${}` — InterpolatedValue), группа поверх корня. */
  values: IContext
}

/** Одна комбинация. */
export interface Combo {
  /** Слой переменных точки: ось → точка, колонки таблиц — простыми именами. */
  ctx: IContext
  /** Ось → метка точки (`// label`, колонка `label`, иначе значение). */
  labels: Record<string, string>
  /** Ось → точка как есть (метка только явная — для имён файлов). */
  points: Record<string, BatchPoint>
  /** Номер комбинации в группе, с 1. */
  index: number
}

export interface BatchGroup extends BatchLayer {
  /** Оси группы в порядке документа (корневые, затем свои). */
  axes: string[]
  combos: Combo[]
}

export interface BatchOptions {
  /**
   * Корни достижимости: «атрибут → сырой текст» (для comfy — поля нод).
   * Функция — на группу (у группы свой профиль). Не задано (или функция вернула
   * `undefined` для группы) — осями становятся все списки и таблицы (imagen;
   * в одном документе imagen группы на профиле comfy — с корнями, прочие — все).
   */
  params?:
    | Map<string, string>
    | ((layer: BatchLayer) => Map<string, string> | Iterable<string> | undefined)
  /** Сильный слой (CLI): значение с именем оси схлопывает ось. */
  strong?: IContext
  /** Только эти группы (`--batch=a,b`); неизвестное имя — BatchError. */
  batches?: string[]
  /** Предупреждения (таблица, ставшая списком; колонка ни на что не влияет). */
  warn?: (msg: string) => void
}

/** Имя блока-группы. */
export const BATCH_BLOCK = 'batch'

// ---------- чтение дерева через IContext ----------

interface RawBlock {
  name: string
  id?: string
  text: string
  texts: Map<string, string>
  values: Record<string, Value>
  children: RawBlock[]
}

/** Сырой текст атрибута: `${}` цел (резолвит хост на комбинацию). */
function attrText(attr: IContext): string {
  const value = attr.get(['value'])
  const text = asText(value)
  if (text !== undefined) return text
  if (isContext(value)) {
    const raw = value.get(['raw'])
    if (typeof raw === 'string') return raw
  }
  return ''
}

function attrValues(node: IContext): Record<string, Value> {
  const rec: Record<string, Value> = {}
  const attrs = node.cast<IArray>('attrs')
  if (!attrs || !isArray(attrs)) return rec
  for (const attr of attrs.iterate()) {
    if (!isContext(attr)) continue
    const key = attr.get(['key'])
    const value = attr.get(['value'])
    if (typeof key === 'string' && value !== undefined) rec[key] = value
  }
  return rec
}

function attrTexts(node: IContext): Map<string, string> {
  const map = new Map<string, string>()
  const attrs = node.cast<IArray>('attrs')
  if (!attrs || !isArray(attrs)) return map
  for (const attr of attrs.iterate()) {
    if (!isContext(attr)) continue
    const key = attr.get(['key'])
    if (typeof key !== 'string') continue
    map.set(key, attrText(attr)) // last-wins по значению, позиция — первого
  }
  return map
}

function blocks(node: IContext, depth: number): RawBlock[] {
  const out: RawBlock[] = []
  const records = node.cast<IArray>('records')
  if (!records || !isArray(records)) return out
  for (const rec of records.iterate()) {
    if (!isContext(rec)) continue
    const name = rec.cast<string>('name')
    if (!name) continue
    const id = rec.cast<string>('id')
    out.push({
      name,
      ...(id ? { id } : {}),
      text: rec.cast<string>('text') ?? '',
      texts: depth > 0 ? attrTexts(rec) : new Map(),
      values: depth > 0 ? attrValues(rec) : {},
      children: depth > 0 ? blocks(rec, depth - 1) : [],
    })
  }
  return out
}

// ---------- достижимость ----------

/** Имена, на которые ссылается текст: головы путей во всех `${}`, включая вложенные и аргументы. */
export function referencedNames(text: string): string[] {
  const out: string[] = []
  const visitSegs = (segs: PathSegment[] | undefined, head: boolean) => {
    segs?.forEach((s, i) => {
      if (s.kind === 'name' && i === 0 && head) out.push(s.value)
      else if (s.kind === 'placeholder') visit(s.value)
    })
  }
  const visitArg = (a: PlaceholderArg) => {
    if (a.kind === 'path') visitSegs(a.segments, true)
    else if (a.kind === 'placeholder') visit(a.value)
  }
  const visit = (p: Placeholder) => {
    const e = p.expr
    if (e.kind === 'path') visitSegs(e.segments, true)
    else {
      e.args.forEach(visitArg)
      visitSegs(e.path, false)
    }
  }
  let found: Placeholder[]
  try {
    found = scanPlaceholders(text)
  } catch {
    // Битое выражение — не повод терять ось: головы `${name` как есть.
    for (const m of text.matchAll(/\$\{\s*([A-Za-z_][\w-]*)/g)) out.push(m[1])
    return out
  }
  for (const p of found) visit(p)
  return out
}

// ---------- точки ----------

function pointContext(p: BatchPoint): IContext {
  return {
    get(path) {
      const seg = path[0]
      if (seg === 'value') return p.value
      if (seg === 'label') return p.label
      if (typeof seg === 'string' && p.vars && seg in p.vars) return p.vars[seg]
      return undefined
    },
    func: () => undefined,
    cast(name: string): any {
      return name === 'text' ? p.value : undefined
    },
    toString: () => p.value,
  }
}

function labelOf(p: BatchPoint): string {
  return p.label ?? p.value
}

// ---------- группы ----------

interface Level {
  texts: Map<string, string>
  values: Record<string, Value>
  bodies: Map<string, string>
  parsed: Map<string, AxisBody>
}

function level(
  texts: Map<string, string>,
  values: Record<string, Value>,
  blks: RawBlock[],
  warn: BatchOptions['warn'],
): Level {
  // Одноимённые блоки — последний выигрывает.
  const bodies = new Map<string, string>()
  for (const b of blks) if (b.text) bodies.set(b.name, b.text)
  const parsed = new Map<string, AxisBody>()
  for (const [name, text] of bodies) {
    const body = parseAxisBody(text, warn, name)
    if (body) parsed.set(name, body)
  }
  return { texts, values, bodies, parsed }
}

/** Переменные уровня: бесточечные атрибуты, фенс-тело поверх одноимённого атрибута. */
function varsRecord(lv: Level): Record<string, Value> {
  const rec: Record<string, Value> = {}
  for (const [k, v] of lv.texts) if (!k.includes('.')) rec[k] = v
  for (const [k, b] of lv.parsed) if (b.kind === 'fenced') rec[k] = b.value
  return rec
}

function merge<V>(a: Map<string, V>, b: Map<string, V>): Map<string, V> {
  const out = new Map(a)
  for (const [k, v] of b) out.set(k, v)
  return out
}

function readOrder(strong: IContext | undefined, texts: Map<string, string>): string[] | undefined {
  const raw = (strong && asText(strong.get(['order']))) ?? texts.get('order')
  if (!raw) return undefined
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : undefined
}

function buildGroup(
  id: string | undefined,
  root: Level,
  own: Level | undefined,
  opts: BatchOptions,
): BatchGroup {
  const texts = own ? merge(root.texts, own.texts) : root.texts
  const bodies = own ? merge(root.bodies, own.bodies) : root.bodies
  const parsed = own ? merge(root.parsed, own.parsed) : root.parsed
  const attrs = own
    ? chainContext(objectContext(varsRecord(own)), objectContext(varsRecord(root)))
    : objectContext(varsRecord(root))
  const values = own
    ? chainContext(objectContext(own.values), objectContext(root.values))
    : objectContext(root.values)
  const layer: BatchLayer = { ...(id !== undefined ? { id } : {}), texts, attrs, values }

  // Кандидаты в оси: списки и таблицы (фенс — значение, не ось).
  const candidates = new Map<string, AxisBody & { kind: 'list' | 'table' }>()
  for (const [name, b] of parsed) if (b.kind !== 'fenced') candidates.set(name, b)

  // Колонка таблицы → её ось; колонка с именем другой оси — неоднозначность.
  const columnOf = new Map<string, string>()
  for (const [name, b] of candidates) {
    if (b.kind !== 'table') continue
    for (const col of b.columns) {
      if (col !== name && candidates.has(col)) {
        throw new BatchError(`колонка ${col} оси ${name} совпадает с именем оси ${col} — неоднозначно`)
      }
      const other = columnOf.get(col)
      if (other && other !== name) {
        throw new BatchError(`колонка ${col} есть у осей ${other} и ${name} — неоднозначно`)
      }
      columnOf.set(col, name)
    }
  }

  // Достижимость от корней хоста: транзитивно через бесточечные атрибуты и тела блоков.
  let axes: string[]
  const p = typeof opts.params === 'function' ? opts.params(layer) : opts.params
  if (p) {
    const seeds = p instanceof Map ? [...p.values()] : [...p]
    const visited = new Set<string>()
    const queue: string[] = []
    const seed = (text: string) => {
      for (const n of referencedNames(text)) {
        if (!visited.has(n)) {
          visited.add(n)
          queue.push(n)
        }
      }
    }
    seeds.forEach(seed)
    while (queue.length > 0) {
      const ref = queue.pop()!
      const attr = texts.get(ref)
      if (attr && !ref.includes('.')) seed(attr)
      const body = bodies.get(ref) ?? (columnOf.has(ref) ? bodies.get(columnOf.get(ref)!) : undefined)
      if (body) seed(body)
    }
    axes = []
    for (const [name, b] of candidates) {
      if (b.kind === 'list') {
        if (visited.has(name)) axes.push(name)
        continue
      }
      const hit = visited.has(name) || b.columns.some((c) => visited.has(c))
      if (!hit) continue
      axes.push(name)
      for (const c of b.columns) {
        if (!visited.has(c)) opts.warn?.(`колонка ${c} оси ${name} ни на что не влияет`)
      }
    }
  } else {
    axes = [...candidates.keys()]
  }

  // CLI-схлопывание: точка по метке, затем по значению; список без совпадения — ось уходит
  // (значение берётся из сильного слоя), таблица без совпадения — ошибка.
  const points = new Map<string, BatchPoint[]>()
  const strong = opts.strong
  for (const name of [...axes]) {
    const b = candidates.get(name)!
    const cli = strong?.get([name])
    if (cli === undefined) {
      points.set(name, b.points)
      continue
    }
    const v = asText(cli) ?? ''
    const hit = b.points.find((p) => p.label === v) ?? b.points.find((p) => p.value === v)
    if (hit) points.set(name, [hit])
    else if (b.kind === 'list') axes.splice(axes.indexOf(name), 1)
    else {
      const known = b.points.map(labelOf).join(', ')
      throw new BatchError(`у оси ${name} нет точки «${v}»; есть: ${known}`)
    }
  }

  // Перемножаются номера точек: точку за номером достаём сами.
  const collections = new Map<string, IArray>()
  for (const name of axes) collections.set(name, arrayValue(points.get(name)!.map((_, i) => i)))
  const order = readOrder(strong, texts)
  const raw = cartesian(collections, order ? { order } : undefined)

  // Колонки — простыми переменными точки; колонку, заданную в CLI, сильный слой не уступает.
  const combos: Combo[] = raw.map((c, i) => {
    const rec: Record<string, Value> = {}
    const labels: Record<string, string> = {}
    const pts: Record<string, BatchPoint> = {}
    for (const name of axes) {
      const p = points.get(name)![c.get([name]) as number]
      rec[name] = pointContext(p)
      labels[name] = labelOf(p)
      pts[name] = p
      for (const [k, v] of Object.entries(p.vars ?? {})) {
        if (strong?.get([k]) === undefined) rec[k] = v
      }
    }
    return { ctx: objectContext(rec), labels, points: pts, index: i + 1 }
  })

  return { ...layer, axes, combos }
}

/**
 * Документ → группы батчей с комбинациями.
 *
 * `doc` — NRDocument (или любой IContext с кастами `attrs`/`records`) с уже
 * раскрытыми инклюдами. Без `## $batch` — одна безымянная группа (id undefined).
 */
export function planBatches(doc: IContext, opts: BatchOptions = {}): BatchGroup[] {
  const top = blocks(doc, 1)
  const root = level(
    attrTexts(doc),
    attrValues(doc),
    top.filter((b) => b.name !== BATCH_BLOCK),
    opts.warn,
  )
  const groupBlocks = top.filter((b) => b.name === BATCH_BLOCK)

  if (groupBlocks.length === 0) {
    if (opts.batches?.length) {
      throw new BatchError(`в документе нет групп ## $batch; запрошены: ${opts.batches.join(', ')}`)
    }
    return [buildGroup(undefined, root, undefined, opts)]
  }

  const ids = groupBlocks.map((b, i) => {
    if (!b.id) throw new BatchError(`## $batch №${i + 1} без id — группе нужно имя`)
    return b.id
  })
  if (opts.batches?.length) {
    const unknown = opts.batches.filter((x) => !ids.includes(x))
    if (unknown.length) {
      throw new BatchError(`нет групп: ${unknown.join(', ')}; есть: ${ids.join(', ')}`)
    }
  }
  const wanted = opts.batches?.length ? new Set(opts.batches) : undefined
  return groupBlocks
    .filter((b) => !wanted || wanted.has(b.id!))
    .map((b) => buildGroup(b.id, root, level(b.texts, b.values, b.children, opts.warn), opts))
}
