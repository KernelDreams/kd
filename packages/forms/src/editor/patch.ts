// История — данными (spec §5): свой диалект JSON Patch. Операции `add/remove/replace/move` как в
// RFC 6902, но сегмент `@<_id>` адресует строку массива объектов по `_id`, а не по индексу
// (`/aspects/@a7f3/text`). Индекс — только у массивов скаляров (`/stress/physical/2`). `-` — конец
// массива. `add` и `move` в строку `@b` — вставка перед строкой `b`.
//
// Применение — без мутации: новые объекты только по пути правки (структурное разделение).

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }

/** Операция RFC 6902 (индексы вместо `@id`). */
export type Rfc6902Op = PatchOp | { op: 'copy'; from: string; path: string } | { op: 'test'; path: string; value: unknown }

export class PatchError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

/** Сегмент указателя: ключ объекта, `_id` строки, индекс скаляра, конец массива. */
export type Seg = { key: string } | { id: string } | { index: number } | { end: true }

const unesc = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~')
const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1')

/** Разобрать указатель `/a/@id/0/-` в сегменты (без знания данных: число — индекс или ключ — решает массив). */
export function parsePointer(p: string): string[] {
  if (p === '') return []
  if (!p.startsWith('/')) throw new PatchError('E_PATH', `указатель "${p}" должен начинаться с /`)
  return p.slice(1).split('/').map(unesc)
}

export function formatPointer(segs: string[]): string {
  return segs.map((s) => '/' + esc(s)).join('')
}

const isRow = (v: unknown): v is Record<string, unknown> & { _id?: unknown } => !!v && typeof v === 'object' && !Array.isArray(v)

export const rowId = (v: unknown): string | undefined => (isRow(v) && typeof v._id === 'string' ? v._id : undefined)

/** Индекс элемента массива по сегменту указателя; `-` — длина. Нет — `PatchError`. */
export function indexOf(arr: unknown[], seg: string, at: string, allowEnd: boolean): number {
  if (seg === '-') {
    if (!allowEnd) throw new PatchError('E_PATH', `${at}: "-" здесь нельзя`)
    return arr.length
  }
  if (seg.startsWith('@')) {
    const id = seg.slice(1)
    const i = arr.findIndex((r) => rowId(r) === id)
    if (i < 0) throw new PatchError('E_ROW', `${at}: нет строки с _id ${id}`)
    return i
  }
  if (/^(0|[1-9]\d*)$/.test(seg)) {
    const i = Number(seg)
    if (i > arr.length || (i === arr.length && !allowEnd)) throw new PatchError('E_PATH', `${at}: индекс ${i} за концом (${arr.length})`)
    return i
  }
  throw new PatchError('E_PATH', `${at}: "${seg}" — не индекс, не @_id и не -`)
}

/** Значение по указателю; мимо — `undefined`. */
export function getAt(root: unknown, pointer: string): unknown {
  let cur = root
  for (const seg of parsePointer(pointer)) {
    if (Array.isArray(cur)) {
      if (seg.startsWith('@')) cur = cur.find((r) => rowId(r) === seg.slice(1))
      else if (/^\d+$/.test(seg)) cur = cur[Number(seg)]
      else return undefined
    } else if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg]
    else return undefined
  }
  return cur
}

/** Изменить контейнер по пути (без мутации исходного): `fn` получает копию родителя последнего сегмента. */
function update(root: unknown, segs: string[], pointer: string, fn: (parent: unknown, last: string) => unknown): unknown {
  if (!segs.length) throw new PatchError('E_PATH', 'корень документа правится только целиком')
  const rec = (node: unknown, i: number): unknown => {
    if (i === segs.length - 1) return fn(node, segs[i]!)
    const seg = segs[i]!
    if (Array.isArray(node)) {
      const k = indexOf(node, seg, pointer, false)
      const copy = node.slice()
      copy[k] = rec(node[k], i + 1)
      return copy
    }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>
      if (!(seg in o)) throw new PatchError('E_PATH', `${pointer}: нет "${seg}"`)
      return { ...o, [seg]: rec(o[seg], i + 1) }
    }
    throw new PatchError('E_PATH', `${pointer}: "${segs.slice(0, i).join('/')}" — не объект и не массив`)
  }
  return rec(root, 0)
}

/** Применить одну операцию; вернуть новый корень. */
export function applyOp(root: unknown, op: PatchOp): unknown {
  switch (op.op) {
    case 'add':
    case 'replace': {
      const segs = parsePointer(op.path)
      if (!segs.length) return op.value
      return update(root, segs, op.path, (parent, last) => {
        if (Array.isArray(parent)) {
          const copy = parent.slice()
          if (op.op === 'add') copy.splice(indexOf(parent, last, op.path, true), 0, op.value)
          else copy[indexOf(parent, last, op.path, false)] = op.value
          return copy
        }
        if (parent && typeof parent === 'object') {
          if (op.op === 'replace' && !(last in (parent as object))) throw new PatchError('E_PATH', `${op.path}: нечего заменять`)
          return { ...(parent as object), [last]: op.value }
        }
        throw new PatchError('E_PATH', `${op.path}: родитель — не объект`)
      })
    }
    case 'remove': {
      const segs = parsePointer(op.path)
      return update(root, segs, op.path, (parent, last) => {
        if (Array.isArray(parent)) {
          const copy = parent.slice()
          copy.splice(indexOf(parent, last, op.path, false), 1)
          return copy
        }
        if (parent && typeof parent === 'object') {
          if (!(last in (parent as object))) throw new PatchError('E_PATH', `${op.path}: нечего удалять`)
          const { [last]: _gone, ...rest } = parent as Record<string, unknown>
          return rest
        }
        throw new PatchError('E_PATH', `${op.path}: родитель — не объект`)
      })
    }
    case 'move': {
      const value = getAt(root, op.from)
      if (value === undefined) throw new PatchError('E_PATH', `${op.from}: нечего переносить`)
      const removed = applyOp(root, { op: 'remove', path: op.from })
      return applyOp(removed, { op: 'add', path: op.path, value })
    }
    default:
      throw new PatchError('E_OP', `операция ${(op as { op: string }).op} не из диалекта (add, remove, replace, move)`)
  }
}

/** Применить патчи по порядку. Ошибка любого — `PatchError`, исходный объект цел. */
export function applyPatches<T>(root: T, patches: readonly PatchOp[]): T {
  let cur: unknown = root
  for (const p of patches) cur = applyOp(cur, p)
  return cur as T
}

// ---------- RFC 6902 ----------

/** Перевести указатель с `@id` в индексы на состоянии `root`. */
function toIndexPointer(root: unknown, pointer: string, allowEnd: boolean): string {
  const segs = parsePointer(pointer)
  const out: string[] = []
  let cur = root
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1
    if (Array.isArray(cur)) {
      const k = indexOf(cur, seg, pointer, last && allowEnd)
      out.push(seg === '-' ? '-' : String(k))
      cur = cur[k]
    } else {
      out.push(seg)
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined
    }
  })
  return formatPointer(out)
}

/** Перевести указатель с индексами в `@id` (строки массивов объектов) на состоянии `root`. */
function toIdPointer(root: unknown, pointer: string, insert: boolean): string {
  const segs = parsePointer(pointer)
  const out: string[] = []
  let cur = root
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1
    if (Array.isArray(cur)) {
      if (seg === '-' || seg.startsWith('@')) {
        out.push(seg)
        cur = seg === '-' ? undefined : cur.find((r) => rowId(r) === seg.slice(1))
        return
      }
      const k = indexOf(cur, seg, pointer, last && insert)
      const rows = cur.length ? cur.every(isRow) : true
      const id = rowId(cur[k])
      if (rows && k === cur.length && insert) out.push('-')
      else if (id !== undefined) out.push('@' + id)
      else out.push(String(k))
      cur = cur[k]
    } else {
      out.push(seg)
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined
    }
  })
  return formatPointer(out)
}

/**
 * Патчи диалекта → RFC 6902: `@id` переводится в текущий индекс по ходу применения (каждый патч —
 * на состоянии после предыдущих). Для записи в чужой JSON и сравнения сторонними библиотеками.
 */
export function toRfc6902(patches: readonly PatchOp[], object: unknown): Rfc6902Op[] {
  const out: Rfc6902Op[] = []
  let cur = object
  for (const p of patches) {
    if (p.op === 'move') {
      const from = toIndexPointer(cur, p.from, false)
      const removed = applyOp(cur, { op: 'remove', path: p.from })
      out.push({ op: 'move', from, path: toIndexPointer(removed, p.path, true) })
    } else if (p.op === 'add') out.push({ op: 'add', path: toIndexPointer(cur, p.path, true), value: p.value })
    else if (p.op === 'remove') out.push({ op: 'remove', path: toIndexPointer(cur, p.path, false) })
    else out.push({ op: 'replace', path: toIndexPointer(cur, p.path, false), value: p.value })
    cur = applyOp(cur, p)
  }
  return out
}

/**
 * RFC 6902 → диалект: индекс строки массива объектов → `@<_id>` строки на этом индексе (на
 * состоянии перед патчем). `copy`/`test` не переводятся — ошибка.
 */
export function fromRfc6902(ops: readonly Rfc6902Op[], object: unknown): PatchOp[] {
  const out: PatchOp[] = []
  let cur = object
  for (const o of ops) {
    let p: PatchOp
    if (o.op === 'move') {
      const from = toIdPointer(cur, o.from, false)
      const removed = applyOp(cur, { op: 'remove', path: from })
      p = { op: 'move', from, path: toIdPointer(removed, o.path, true) }
    } else if (o.op === 'add') p = { op: 'add', path: toIdPointer(cur, o.path, true), value: o.value }
    else if (o.op === 'remove') p = { op: 'remove', path: toIdPointer(cur, o.path, false) }
    else if (o.op === 'replace') p = { op: 'replace', path: toIdPointer(cur, o.path, false), value: o.value }
    else throw new PatchError('E_OP', `${o.op}: в диалекте нет (add, remove, replace, move)`)
    out.push(p)
    cur = applyOp(cur, p)
  }
  return out
}
