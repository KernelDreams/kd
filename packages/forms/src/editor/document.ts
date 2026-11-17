// Документ объекта (spec §5): объект + описание → команды данных, история патчами (свой диалект
// JSON Patch с `@<_id>`), пачки, undo/redo, ошибки данных после каждой команды, dirty, события.
// Форма API — Trempel `scene/editor/document.ts`; правда — объект в памяти (без мутации: каждая
// команда даёт новый объект со структурным разделением).
//
// Ошибка аргументов или команды → `{ok: false, errors: ['E_PATH: …']}`, документ цел. Ошибки данных
// (схема, required, выражения, циклы) — в `doc.errors`, правку не блокируют.

import type { Catalog } from './catalog.js'
import { shown } from './cond.js'
import { createExpressions, get, type Expressions } from './expr.js'
import { ensureIds } from './ids.js'
import { applyOp, formatPointer, getAt, indexOf, parsePointer, PatchError, rowId, type PatchOp } from './patch.js'
import { schemaFor, typeOf } from './schema.js'
import { isKnown, type AnyNode, type EditorDef, type FieldNode, type Issue, type JSONSchema } from './types.js'

export interface DocumentOptions {
  catalog?: Catalog
  /** Схема типа; нет — своя схема описания или вывод из полей. */
  schema?: JSONSchema
  /** Генератор `_id` новых строк (тесты); по умолчанию — 6 символов base36. */
  id?: () => string
  /** Часы истории (тесты). */
  now?: () => number
}

export interface CommandResult {
  ok: boolean
  /** Ошибки аргументов или команды (`ok: false`, документ не тронут): `E_PATH: …`. */
  errors?: string[]
  /** Пути, которые команда изменила: `aspects[a7f3].text`. */
  changed: string[]
  /** Патчи команды (диалект). */
  patches?: PatchOp[]
  /** `_id` новой строки (`object.insert`). */
  id?: string
}

export interface CommandCall {
  name: string
  args?: unknown
}

export interface HistoryEntry {
  label: string
  /** ms. */
  at: number
  patches: PatchOp[]
  /** Обратные патчи — применять по порядку. */
  inverse: PatchOp[]
}

export interface ChangeEvent {
  /** rollback — открытая группа (begin…abort) откатана; reload — объект заменён снаружи. */
  type: 'exec' | 'batch' | 'undo' | 'redo' | 'rollback' | 'reload' | 'apply'
  label: string
  paths: string[]
}

export interface CommandSpec {
  /** JSON Schema аргументов. */
  schema: JSONSchema
  /** Одна строка: что делает (тул агенту, подсказка UI). */
  describe: string
}

export interface ObjectDocument<T = unknown> {
  readonly def: EditorDef
  readonly schema: JSONSchema
  readonly catalog: Catalog | undefined
  /** Текущий объект (новый после каждой правки). */
  readonly object: T
  readonly expressions: Expressions
  /** Значения вычислений: `id`, в повторителе — `aspects[<_id>].id`. */
  readonly computed: Readonly<Record<string, unknown>>
  /** Ошибки данных после последней команды (не блокируют). */
  readonly errors: Issue[]
  readonly dirty: boolean
  readonly history: HistoryEntry[]
  readonly canUndo: boolean
  readonly canRedo: boolean
  /** Открыта группа begin…end. */
  readonly grouping: boolean
  readonly commands: Record<string, CommandSpec>
  /** Значение по пути команды (`aspects[a7f3].text`) или указателю (`/aspects/@a7f3/text`). */
  get(path: string): unknown
  /** Значение вычисления; в повторителе — с ключом строки (`aspects[a7f3]`). */
  calc(id: string, row?: string): unknown
  exec(name: string, args?: unknown): CommandResult
  batch(label: string, calls: CommandCall[]): CommandResult
  /** Применить готовые патчи (агент, «Обновить из библиотеки») одной записью истории. */
  apply(patches: PatchOp[], label?: string): CommandResult
  begin(label: string): void
  end(): void
  abort(): void
  undo(): boolean
  redo(): boolean
  markClean(): void
  /** Заменить объект снаружи (перечитан файл): история сброшена, событие `reload`. */
  reload(object: T, label?: string): void
  on(event: 'change', fn: (e: ChangeEvent) => void): () => void
}

const randomId = (): string => Math.random().toString(36).slice(2, 8).padEnd(6, '0')

// ---------- пути ----------

/**
 * Путь команды → указатель диалекта. `aspects[a7f3].text` → `/aspects/@a7f3/text`; в массиве
 * скаляров `[2]` — индекс (`/stress/physical/2`). Строку массива объектов можно назвать и индексом
 * (`aspects[0]`), если строки с таким `_id` нет, — указатель всё равно получит `@<_id>`.
 * Указатель (`/…`) проходит как есть.
 */
export function toPointer(object: unknown, path: string): string {
  if (path.startsWith('/') || path === '') return path
  const segs: string[] = []
  let cur = object
  const re = /([^.[\]]+)|\[([^\]]*)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) {
      segs.push(m[1])
      cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>)[m[1]] : undefined
      continue
    }
    const x = m[2]!
    if (!Array.isArray(cur)) throw new PatchError('E_PATH', `${path}: [${x}] — не массив`)
    const byId = cur.find((r) => rowId(r) === x)
    if (byId !== undefined) {
      segs.push('@' + x)
      cur = byId
    } else if (/^\d+$/.test(x) && Number(x) < cur.length) {
      const it = cur[Number(x)]
      const id = rowId(it)
      segs.push(id !== undefined ? '@' + id : x)
      cur = it
    } else if (x === '-' ) {
      segs.push('-')
      cur = undefined
    } else throw new PatchError('E_ROW', `${path}: нет строки ${x}`)
  }
  return formatPointer(segs)
}

/** Указатель → путь для людей и событий: `/aspects/@a7f3/text` → `aspects[a7f3].text`. */
export function pointerToPath(p: string): string {
  let out = ''
  for (const s of parsePointer(p)) {
    if (s.startsWith('@')) out += `[${s.slice(1)}]`
    else if (/^\d+$/.test(s) || s === '-') out += `[${s}]`
    else out += (out ? '.' : '') + s
  }
  return out
}

const parentOf = (p: string): { parent: string; last: string } => {
  const segs = parsePointer(p)
  return { parent: formatPointer(segs.slice(0, -1)), last: segs.at(-1) ?? '' }
}

/** Схема по указателю (строки и индексы — `items`). */
export function schemaAt(schema: JSONSchema | undefined, pointer: string): JSONSchema | undefined {
  let cur = schema
  for (const s of parsePointer(pointer)) {
    if (!cur) return undefined
    if (s.startsWith('@') || /^\d+$/.test(s) || s === '-') cur = cur.items
    else cur = cur.properties?.[s] ?? (typeOf(cur) === 'object' && !Object.keys(cur.properties ?? {}).length ? {} : undefined)
  }
  return cur
}

// ---------- обратные патчи ----------

/** Обратная операция на состоянии перед `op`. */
export function invertOp(state: unknown, op: PatchOp): PatchOp {
  const after = (pointer: string): unknown => {
    const { parent } = parentOf(pointer)
    return getAt(state, parent)
  }
  if (op.op === 'replace') return { op: 'replace', path: op.path, value: getAt(state, op.path) }
  if (op.op === 'add') {
    const { parent, last } = parentOf(op.path)
    const c = after(op.path)
    if (Array.isArray(c)) {
      const id = rowId(op.value)
      if (id !== undefined) return { op: 'remove', path: `${parent}/@${id}` }
      return { op: 'remove', path: `${parent}/${indexOf(c, last, op.path, true)}` }
    }
    if (c && typeof c === 'object' && last in (c as object)) return { op: 'replace', path: op.path, value: (c as Record<string, unknown>)[last] }
    return { op: 'remove', path: op.path }
  }
  if (op.op === 'remove') {
    const { parent, last } = parentOf(op.path)
    const c = after(op.path)
    if (Array.isArray(c)) {
      const k = indexOf(c, last, op.path, false)
      return { op: 'add', path: `${parent}/${slotAfter(c, k)}`, value: c[k] }
    }
    return { op: 'add', path: op.path, value: getAt(state, op.path) }
  }
  // move: обратно — из нового места туда, где элемент стоял.
  const { parent: fp, last: fl } = parentOf(op.from)
  const src = getAt(state, fp)
  if (!Array.isArray(src)) return { op: 'move', from: op.path, path: op.from }
  const k = indexOf(src, fl, op.from, false)
  const id = rowId(src[k])
  const back = `${fp}/${slotAfter(src, k)}`
  if (id !== undefined) return { op: 'move', from: `${parentOf(op.path).parent}/@${id}`, path: back }
  const moved = applyOp(state, op)
  const { parent: tp } = parentOf(op.path)
  const dst = getAt(moved, tp) as unknown[]
  const at = dst.indexOf(src[k])
  return { op: 'move', from: `${tp}/${at}`, path: `${fp}/${k}` }
}

/** Сегмент «на место строки k» после её удаления: `@<_id следующей>`, индекс или `-`. */
function slotAfter(arr: unknown[], k: number): string {
  const rows = arr.every((r) => rowId(r) !== undefined)
  if (!rows) return String(k)
  const next = arr[k + 1]
  return next === undefined ? '-' : '@' + rowId(next)
}

// ---------- проверка аргументов ----------

const STR = { type: 'string' } as const
export const COMMANDS: Record<string, CommandSpec> = {
  'object.set': {
    schema: { type: 'object', properties: { path: { ...STR, description: 'путь: stress.physical, aspects[<_id>].text' }, value: { description: 'новое значение' } }, required: ['path', 'value'] },
    describe: 'поставить значение поля (недостающие объекты по пути создаются)',
  },
  'object.unset': {
    schema: { type: 'object', properties: { path: STR }, required: ['path'] },
    describe: 'убрать поле',
  },
  'object.insert': {
    schema: {
      type: 'object',
      properties: { path: { ...STR, description: 'путь массива строк: aspects, sessions[<_id>].scenes' }, item: { type: 'object', description: 'строка; _id ставится сам' }, id: { ...STR, description: '_id новой строки (адрес из файла); занятый — ошибка; нет — свой' }, before: { ...STR, description: '_id строки, перед которой; нет — в конец' } },
      required: ['path'],
    },
    describe: 'добавить строку в массив объектов',
  },
  'object.remove': {
    schema: { type: 'object', properties: { path: STR, id: { ...STR, description: '_id строки' } }, required: ['path', 'id'] },
    describe: 'удалить строку массива по _id',
  },
  'object.move': {
    schema: { type: 'object', properties: { path: STR, id: STR, before: { ...STR, description: '_id строки, перед которой; нет — в конец' } }, required: ['path', 'id'] },
    describe: 'переставить строку массива',
  },
}

function argErrors(spec: CommandSpec, args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['E_ARGS: аргументы — объект']
  const a = args as Record<string, unknown>
  const out: string[] = []
  for (const k of spec.schema.required ?? []) if (!(k in a)) out.push(`E_ARGS: нет "${k}"`)
  for (const [k, s] of Object.entries(spec.schema.properties ?? {})) {
    if (a[k] === undefined || !s.type) continue
    const t = s.type
    const ok = t === 'string' ? typeof a[k] === 'string' : t === 'object' ? !!a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) : true
    if (!ok) out.push(`E_ARGS: "${k}" — не ${t}`)
  }
  return out
}

// ---------- данные против описания ----------

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)

/** Подходит ли значение типу схемы (`integer`, `string[]`…). */
export function valueMatches(type: string | undefined, v: unknown): boolean {
  if (!type || v === undefined || v === null) return true
  if (type.endsWith('[]')) return Array.isArray(v) && v.every((x) => valueMatches(type.slice(0, -2), x))
  switch (type) {
    case 'array':
      return Array.isArray(v)
    case 'object':
      return typeof v === 'object' && !Array.isArray(v)
    case 'string':
      return typeof v === 'string'
    case 'boolean':
      return typeof v === 'boolean'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'integer':
      return Number.isInteger(v)
    default:
      return true
  }
}

/** Ошибки данных: required видимых полей, тип, enum, границы, выражения, циклы. */
export function dataErrors(def: EditorDef, schema: JSONSchema, object: unknown, exprs: Expressions, exprErrors: Record<string, Error>): Issue[] {
  const out: Issue[] = []
  const walk = (nodes: AnyNode[], scope: unknown, scopeSchema: JSONSchema | undefined, prefix: string, visible: boolean): void => {
    for (const n of nodes) {
      if (!isKnown(n)) continue
      const vis = visible && shown(n, scope)
      if (n.kind === 'section') walk(n.children, scope, scopeSchema, prefix, vis)
      else if (n.kind === 'group') walk(n.children, scope, scopeSchema, prefix, vis)
      else if (n.kind === 'repeat') {
        const rows = get(scope, n.path)
        if (rows !== undefined && !Array.isArray(rows)) {
          out.push({ code: 'E_VALUE', where: prefix + n.path, message: 'ждали список строк' })
          continue
        }
        const itemSchema = schemaAt(scopeSchema, '/' + n.path.split('.').join('/'))?.items
        ;(rows ?? []).forEach((row, i) => walk(n.children, row, itemSchema, `${prefix}${n.path}[${rowId(row) ?? i}].`, vis))
      } else if (n.kind === 'field') fieldErrors(n, scope, scopeSchema, prefix, vis, out)
    }
  }
  walk(def.nodes, object, schema, '', true)
  for (const [key, e] of Object.entries(exprErrors)) out.push({ code: 'E_EXPR', where: key, message: e.message, ...((e as { hint?: string }).hint ? { hint: (e as { hint?: string }).hint! } : {}) })
  for (const c of exprs.cycles) out.push({ code: 'E_CYCLE', where: c[0]!, message: `цикл вычислений: ${c.join(' → ')}` })
  return out
}

function fieldErrors(n: FieldNode, scope: unknown, scopeSchema: JSONSchema | undefined, prefix: string, visible: boolean, out: Issue[]): void {
  const v = get(scope, n.path)
  const where = prefix + n.path
  const s = schemaAt(scopeSchema, '/' + n.path.split('.').join('/'))
  const type = n.type ?? typeOf(s)
  if (n.required && visible && isEmpty(v)) out.push({ code: 'E_REQUIRED', where, message: `${n.label ?? n.path}: обязательное поле пусто` })
  if (v === undefined || v === null) return
  if (!valueMatches(type, v)) {
    out.push({ code: 'E_VALUE', where, message: `ждали ${type}, а ${Array.isArray(v) ? 'array' : typeof v}` })
    return
  }
  const en = n.enum ?? s?.enum
  if (Array.isArray(en) && en.length && !en.includes(v)) out.push({ code: 'E_ENUM', where, message: `«${String(v)}» нет в списке: ${en.map((x) => String(x)).join(', ')}` })
  const min = n.min ?? s?.minimum
  const max = n.max ?? s?.maximum
  if (typeof v === 'number' && ((min !== undefined && v < min) || (max !== undefined && v > max)))
    out.push({ code: 'E_RANGE', where, message: `${v} вне ${min ?? '−∞'}…${max ?? '∞'}` })
}

// ---------- документ ----------

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

interface Step {
  object: unknown
  patches: PatchOp[]
  inverse: PatchOp[]
  paths: string[]
  id?: string
}

export function createDocument<T = unknown>(object: T, def: EditorDef, opts: DocumentOptions = {}): ObjectDocument<T> {
  const schema = schemaFor(def, opts.schema)
  const gen = opts.id ?? randomId
  const now = opts.now ?? Date.now
  const expressions = createExpressions(def)
  const listeners = new Set<(e: ChangeEvent) => void>()

  let cur: unknown = ensureIds(object, schema, { id: gen })
  let computed: Record<string, unknown> = {}
  let exprErrors: Record<string, Error> = {}
  let errors: Issue[] = []
  const undoStack: HistoryEntry[] = []
  const redoStack: HistoryEntry[] = []
  let savedTop: HistoryEntry | null = null
  let group: { label: string; patches: PatchOp[]; inverse: PatchOp[]; depth: number } | null = null

  const recompute = (paths?: string[]): void => {
    const only = paths ? expressions.affected(paths) : undefined
    if (!only || only.length) {
      const r = expressions.evaluate(cur, only ? { only, prev: computed } : {})
      computed = r.values
      exprErrors = r.errors
    }
    errors = dataErrors(def, schema, cur, expressions, exprErrors)
  }
  recompute()

  const emit = (e: ChangeEvent): void => {
    for (const fn of listeners) fn(e)
  }

  /** Применить ops к state, собрать обратные. Ошибка — PatchError. */
  const applyAll = (state: unknown, ops: PatchOp[]): Step => {
    const inverse: PatchOp[] = []
    let s = state
    for (const op of ops) {
      inverse.unshift(invertOp(s, op))
      s = applyOp(s, op)
    }
    const paths = ops.flatMap((o) => (o.op === 'move' ? [o.from, o.path] : [o.path])).map((p) => pointerToPath(p.replace(/\/-$/, '')))
    return { object: s, patches: ops, inverse, paths: [...new Set(paths)] }
  }

  /** Команда над state: ops или ошибки. */
  const build = (state: unknown, name: string, args: unknown): { ops: PatchOp[]; id?: string } | string[] => {
    const spec = COMMANDS[name]
    if (!spec) return [`E_COMMAND: нет команды ${name} (есть: ${Object.keys(COMMANDS).join(', ')})`]
    const bad = argErrors(spec, args)
    if (bad.length) return bad.map((e) => `${e} (${name})`)
    const a = { ...(args as Record<string, unknown>) } as Record<string, unknown> & { path: string }
    try {
      const ptr = toPointer(state, a.path)
      if (name === 'object.set') {
        const old = getAt(state, ptr)
        // Строки внутри нового значения получают `_id` (агент ставит список целиком).
        const vs = schemaAt(schema, ptr)
        if (vs) a.value = ensureIds(a.value, vs, { id: gen })
        if (old !== undefined && deepEqual(old, a.value)) return { ops: [] }
        // Недостающие объекты по пути — одной операцией add на первом отсутствующем уровне.
        const segs = parsePointer(ptr)
        let node = state
        for (let i = 0; i < segs.length - 1; i++) {
          const seg = segs[i]!
          const next = Array.isArray(node) ? getAt(node, '/' + seg) : node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined
          if (next === undefined) {
            if (Array.isArray(node)) throw new PatchError('E_PATH', `${a.path}: нет элемента ${seg}`)
            if (!node || typeof node !== 'object') break
            let value: unknown = a.value
            for (let j = segs.length - 1; j > i; j--) value = { [segs[j]!]: value }
            return { ops: [{ op: 'add', path: formatPointer(segs.slice(0, i + 1)), value }] }
          }
          node = next
        }
        const container = getAt(state, parentOf(ptr).parent)
        const exists = Array.isArray(container) ? old !== undefined : container && typeof container === 'object' && parentOf(ptr).last in (container as object)
        return { ops: [{ op: exists ? 'replace' : 'add', path: ptr, value: a.value }] }
      }
      if (name === 'object.unset') return getAt(state, ptr) === undefined ? { ops: [] } : { ops: [{ op: 'remove', path: ptr }] }
      const arr = getAt(state, ptr)
      if (arr !== undefined && !Array.isArray(arr)) return [`E_PATH: ${a.path} — не массив (${name})`]
      const rows = (arr ?? []) as unknown[]
      const has = (id: unknown, what: string): string | undefined =>
        typeof id === 'string' && rows.some((r) => rowId(r) === id) ? undefined : `E_ROW: ${a.path}: нет строки с _id ${String(id)} (${what})`
      if (name === 'object.insert') {
        if (a.before !== undefined) {
          const e = has(a.before, 'before')
          if (e) return [e]
        }
        const itemSchema = schemaAt(schema, ptr)?.items
        if (a.id !== undefined && (typeof a.id !== 'string' || !a.id)) return ['E_ARGS: id — непустая строка']
        if (typeof a.id === 'string' && rows.some((r) => rowId(r) === a.id)) return [`E_ID: строка ${a.id} уже есть (${name})`]
        let id = typeof a.id === 'string' ? a.id : gen()
        while (!a.id && rows.some((r) => rowId(r) === id)) id = gen()
        const { _id: _drop, ...rest } = (a.item ?? {}) as Record<string, unknown>
        const item = itemSchema ? ensureIds({ _id: id, ...rest }, itemSchema, { id: gen }) : { _id: id, ...rest }
        if (arr === undefined) return { ops: [{ op: 'add', path: ptr, value: [item] }], id }
        return { ops: [{ op: 'add', path: `${ptr}/${a.before !== undefined ? '@' + a.before : '-'}`, value: item }], id }
      }
      if (name === 'object.remove') {
        const e = has(a.id, 'id')
        return e ? [e] : { ops: [{ op: 'remove', path: `${ptr}/@${a.id}` }] }
      }
      // object.move
      const e = has(a.id, 'id') ?? (a.before !== undefined ? has(a.before, 'before') : undefined)
      if (e) return [e]
      const k = rows.findIndex((r) => rowId(r) === a.id)
      const next = rowId(rows[k + 1])
      if (a.before === a.id || (a.before === undefined ? k === rows.length - 1 : next === a.before)) return { ops: [] }
      return { ops: [{ op: 'move', from: `${ptr}/@${a.id}`, path: `${ptr}/${a.before !== undefined ? '@' + a.before : '-'}` }] }
    } catch (err) {
      if (err instanceof PatchError) return [`${err.message} (${name})`]
      throw err
    }
  }

  const run = (state: unknown, name: string, args: unknown): Step | string[] => {
    const b = build(state, name, args)
    if (Array.isArray(b)) return b
    let step: Step
    try {
      step = applyAll(state, b.ops)
    } catch (e) {
      if (e instanceof PatchError) return [`${e.message} (${name})`]
      throw e
    }
    if (b.id) step.id = b.id
    return step
  }

  const commit = (step: Step, label: string, type: ChangeEvent['type']): CommandResult => {
    const res: CommandResult = { ok: true, changed: step.paths, patches: step.patches }
    if (step.id) res.id = step.id
    if (!step.patches.length) return res
    cur = step.object
    if (group) {
      group.patches.push(...step.patches)
      group.inverse.unshift(...step.inverse)
    } else {
      undoStack.push({ label, at: now(), patches: step.patches, inverse: step.inverse })
      redoStack.length = 0
    }
    recompute(step.paths)
    emit({ type, label, paths: step.paths })
    return res
  }

  const doc: ObjectDocument<T> = {
    def,
    schema,
    catalog: opts.catalog,
    get object() {
      return cur as T
    },
    expressions,
    get computed() {
      return computed
    },
    get errors() {
      return errors
    },
    get dirty() {
      if (group?.patches.length) return true
      return (undoStack.at(-1) ?? null) !== savedTop
    },
    get history() {
      return undoStack.slice()
    },
    get canUndo() {
      return !group && undoStack.length > 0
    },
    get canRedo() {
      return !group && redoStack.length > 0
    },
    get grouping() {
      return group !== null
    },
    commands: COMMANDS,
    get(path) {
      try {
        return getAt(cur, toPointer(cur, path))
      } catch {
        return undefined
      }
    },
    calc(id, row) {
      return computed[row ? `${row}.${id}` : id]
    },
    exec(name, args = {}) {
      const step = run(cur, name, args)
      if (Array.isArray(step)) return { ok: false, errors: step, changed: [] }
      return commit(step, name, 'exec')
    },
    batch(label, calls) {
      let state = cur
      const all: Step = { object: cur, patches: [], inverse: [], paths: [] }
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i]!
        const step = run(state, c.name, c.args ?? {})
        if (Array.isArray(step)) return { ok: false, errors: step.map((e) => `[${i}] ${c.name}: ${e}`), changed: [] }
        state = step.object
        all.patches.push(...step.patches)
        all.inverse.unshift(...step.inverse)
        all.paths.push(...step.paths)
      }
      all.object = state
      all.paths = [...new Set(all.paths)]
      return commit(all, label, 'batch')
    },
    apply(patches, label = 'patch') {
      try {
        return commit(applyAll(cur, patches), label, 'apply')
      } catch (e) {
        if (e instanceof PatchError) return { ok: false, errors: [e.message], changed: [] }
        throw e
      }
    },
    begin(label) {
      if (group) group.depth++
      else group = { label, patches: [], inverse: [], depth: 1 }
    },
    end() {
      const g = group
      if (!g) throw new Error('E_EDITOR_API: end() без begin()')
      if (--g.depth > 0) return
      group = null
      if (!g.patches.length) return
      undoStack.push({ label: g.label, at: now(), patches: g.patches, inverse: g.inverse })
      redoStack.length = 0
      emit({ type: 'batch', label: g.label, paths: pathsOf(g.patches) })
    },
    abort() {
      const g = group
      if (!g) throw new Error('E_EDITOR_API: abort() без begin()')
      group = null
      if (!g.patches.length) return
      const paths = pathsOf(g.inverse)
      for (const op of g.inverse) cur = applyOp(cur, op)
      recompute(paths)
      emit({ type: 'rollback', label: g.label, paths })
    },
    undo() {
      if (group) return false
      const e = undoStack.pop()
      if (!e) return false
      for (const op of e.inverse) cur = applyOp(cur, op)
      redoStack.push(e)
      const paths = pathsOf(e.inverse)
      recompute(paths)
      emit({ type: 'undo', label: e.label, paths })
      return true
    },
    redo() {
      if (group) return false
      const e = redoStack.pop()
      if (!e) return false
      for (const op of e.patches) cur = applyOp(cur, op)
      undoStack.push(e)
      const paths = pathsOf(e.patches)
      recompute(paths)
      emit({ type: 'redo', label: e.label, paths })
      return true
    },
    markClean() {
      savedTop = undoStack.at(-1) ?? null
    },
    reload(object, label = 'внешняя правка') {
      cur = ensureIds(object, schema, { id: gen })
      undoStack.length = 0
      redoStack.length = 0
      savedTop = null
      group = null
      recompute()
      emit({ type: 'reload', label, paths: [''] })
    },
    on(event, fn) {
      if (event !== 'change') throw new Error(`E_EDITOR_API: нет события "${event}" (есть: change)`)
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return doc
}

const pathsOf = (ops: PatchOp[]): string[] => [...new Set(ops.flatMap((o) => (o.op === 'move' ? [o.from, o.path] : [o.path])).map((p) => pointerToPath(p.replace(/\/-$/, ''))))]
