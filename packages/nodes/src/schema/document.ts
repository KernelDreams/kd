// Документ схемы = документ ядра `@kerneldreams/forms/editor` (node-canvas-spec §3 «второго механизма не
// заводим»): объект — `SchemaModel`, история и undo — патчами ядра, `_id` строк ставит ядро по схеме
// ниже. Команды схемы (`entity.add`, `composite.connect`, …) раскладываются в команды данных ядра
// (`object.insert` / `object.set` / `object.remove`) одной пачкой — одна запись истории на жест.
//
// Проверки вида (типы портов, кратность, циклы) — у вида схемы, не здесь: модель хранит, вид судит.

import {
  createDocument,
  type CommandCall,
  type CommandResult,
  type CommandSpec,
  type ChangeEvent,
  type JSONSchema,
  type ObjectDocument,
} from '@kerneldreams/forms/editor'
import {
  RELATION_KINDS,
  portVar,
  varPort,
  type Composite,
  type CompositeRow,
  type CompositeVar,
  type Entity,
  type PillMeta,
  type Relation,
  type RelationEnd,
  type RowPart,
  type SchemaModel,
} from './types.js'

// ---------- схема данных (для `_id` строк и проверки ядром) ----------

const ROWS = (props: Record<string, JSONSchema> = {}): JSONSchema => ({ type: 'array', items: { type: 'object', properties: props } })
const PART = ROWS()
const ROW = ROWS({ parts: PART })
const COMPOSITE: JSONSchema = { type: 'object', properties: { variables: ROWS(), rows: ROW } }
const ENTITY = ROWS({ composite: COMPOSITE })
const RELATIONS = ROWS()

function spaceSchema(depth: number): JSONSchema {
  const props: Record<string, JSONSchema> = { entities: ENTITY, relations: RELATIONS, variables: ROWS() }
  if (depth > 0) props.spaces = { type: 'array', items: spaceSchema(depth - 1) }
  return { type: 'object', properties: props }
}

/** JSON Schema модели (глубина вложенных пространств — 3). */
export const SCHEMA_MODEL_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { kind: { type: 'string' }, name: { type: 'string' }, space: spaceSchema(3), types: ROWS() },
  required: ['kind', 'space'],
}

const DEF = { editor: 1 as const, id: 'schema', title: 'Схема', nodes: [] }

// ---------- команды ----------

const STR: JSONSchema = { type: 'string' }
const OBJ: JSONSchema = { type: 'object' }

export const SCHEMA_COMMANDS: Record<string, CommandSpec> = {
  'entity.add': { schema: { type: 'object', properties: { entity: OBJ }, required: ['entity'] }, describe: 'добавить сущность (узел, заметку, рамку…); `_id` можно задать' },
  'entity.set': { schema: { type: 'object', properties: { id: STR, path: STR, value: {} }, required: ['id', 'path', 'value'] }, describe: 'поставить поле сущности: name, properties.items, composite.rows[<_id>].weight' },
  'entity.remove': { schema: { type: 'object', properties: { id: STR }, required: ['id'] }, describe: 'удалить сущность вместе с её отношениями' },
  'relation.add': { schema: { type: 'object', properties: { relation: OBJ }, required: ['relation'] }, describe: 'добавить отношение (data, control, transition, choice, hierarchy, reference, visual)' },
  'relation.remove': { schema: { type: 'object', properties: { id: STR }, required: ['id'] }, describe: 'удалить отношение' },
  'composite.create': { schema: { type: 'object', properties: { id: STR, name: STR, typeId: STR }, required: ['name'] }, describe: 'пустой композит: одна пустая строка, переменных нет' },
  'composite.row.add': { schema: { type: 'object', properties: { entity: STR, row: OBJ }, required: ['entity'] }, describe: 'добавить строку-вариант' },
  'composite.row.set': { schema: { type: 'object', properties: { entity: STR, row: STR, label: STR, weight: { type: 'number' }, when: STR, meta: OBJ }, required: ['entity', 'row'] }, describe: 'метка, вес, условие, мета строки' },
  'composite.row.remove': { schema: { type: 'object', properties: { entity: STR, row: STR }, required: ['entity', 'row'] }, describe: 'удалить строку' },
  'composite.part.add': { schema: { type: 'object', properties: { entity: STR, row: STR, part: OBJ, before: STR }, required: ['entity', 'row', 'part'] }, describe: 'положить пилюлю или текст в строку' },
  'composite.part.set': { schema: { type: 'object', properties: { entity: STR, row: STR, part: STR, text: STR, var: STR, meta: OBJ }, required: ['entity', 'row', 'part'] }, describe: 'текст литерала, переменная или мета пилюли' },
  'composite.part.remove': { schema: { type: 'object', properties: { entity: STR, row: STR, part: STR }, required: ['entity', 'row', 'part'] }, describe: 'убрать часть строки' },
  'composite.connect': {
    schema: { type: 'object', properties: { from: OBJ, entity: STR, row: STR, part: STR, variable: STR, name: STR }, required: ['from', 'entity'] },
    describe: 'жест «провод в пилюлю»: в пилюлю — новая переменная и провод на неё; на переменную — тот же выбор; в пустое место — новая строка с пилюлей',
  },
  'composite.var.rename': { schema: { type: 'object', properties: { entity: STR, from: STR, to: STR }, required: ['entity', 'from', 'to'] }, describe: 'переименовать переменную композита (пилюли и провод — следом)' },
}

export interface SchemaDocumentOptions {
  id?: () => string
  now?: () => number
}

export interface SchemaDocument {
  readonly doc: ObjectDocument<SchemaModel>
  readonly model: SchemaModel
  readonly commands: Record<string, CommandSpec>
  exec(name: string, args?: unknown): CommandResult
  undo(): boolean
  redo(): boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly dirty: boolean
  markClean(): void
  reload(model: SchemaModel): void
  on(event: 'change', fn: (e: ChangeEvent) => void): () => void
}

const fail = (msg: string): CommandResult => ({ ok: false, errors: [msg], changed: [] })

export function entityOf(model: SchemaModel, id: string): Entity | undefined {
  return model.space.entities.find((e) => e._id === id)
}

/** Имя переменной из имени источника: «Имена м» → «имена_м»; занятое — с номером. */
export function freshVarName(base: string, taken: Iterable<string>): string {
  const slug = base.trim().toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '') || 'v'
  const set = new Set(taken)
  if (!set.has(slug)) return slug
  for (let i = 2; ; i++) if (!set.has(`${slug}${i}`)) return `${slug}${i}`
}

const colorFor = (vars: CompositeVar[]): number => ((vars.length % 8) + 1)

/** Метка новой строки — следующий свободный номер. */
const nextLabel = (c: Composite): string => {
  const taken = new Set(c.rows.map((r) => r.label))
  let i = c.rows.length + 1
  while (taken.has(String(i))) i++
  return String(i)
}

export function createSchemaDocument(model: SchemaModel, opts: SchemaDocumentOptions = {}): SchemaDocument {
  const gen = opts.id ?? (() => Math.random().toString(36).slice(2, 8).padEnd(6, '0'))
  const doc = createDocument<SchemaModel>(model, DEF, { schema: SCHEMA_MODEL_SCHEMA, id: gen, now: opts.now })

  const E = (id: string) => `space.entities[${id}]`
  const R = (e: string, r: string) => `${E(e)}.composite.rows[${r}]`

  const plan = (name: string, a: Record<string, unknown>): { label: string; calls: CommandCall[]; id?: string } | string => {
    const m = doc.object
    const ent = (id: unknown): Entity | undefined => (typeof id === 'string' ? entityOf(m, id) : undefined)
    const comp = (id: unknown): { e: Entity; c: Composite } | string => {
      const e = ent(id)
      if (!e) return `E_ENTITY: нет сущности ${String(id)}`
      if (!e.composite) return `E_COMPOSITE: ${String(id)} — не композит`
      return { e, c: e.composite }
    }
    const rowOf = (c: Composite, id: unknown): CompositeRow | undefined => c.rows.find((r) => r._id === id)

    switch (name) {
      case 'entity.add': {
        const e = a.entity as Entity
        if (!e || typeof e.role !== 'string') return 'E_ARGS: entity.role обязателен'
        if (e._id && ent(e._id)) return `E_ENTITY: ${e._id} уже есть`
        const id = e._id ?? gen()
        return { label: `добавить ${e.name ?? e.typeId ?? e.role}`, id, calls: [{ name: 'object.insert', args: { path: 'space.entities', id, item: { ...e, _id: undefined } } }] }
      }
      case 'entity.set': {
        if (!ent(a.id)) return `E_ENTITY: нет сущности ${String(a.id)}`
        return { label: `поле ${String(a.path)}`, calls: [{ name: 'object.set', args: { path: `${E(a.id as string)}.${String(a.path)}`, value: a.value } }] }
      }
      case 'entity.remove': {
        if (!ent(a.id)) return `E_ENTITY: нет сущности ${String(a.id)}`
        const rel = m.space.relations.filter((r) => r.from.entity === a.id || r.to.entity === a.id)
        return {
          label: 'удалить сущность',
          calls: [...rel.map((r) => ({ name: 'object.remove', args: { path: 'space.relations', id: r._id } })), { name: 'object.remove', args: { path: 'space.entities', id: a.id } }],
        }
      }
      case 'relation.add': {
        const r = a.relation as Relation
        if (!r || !RELATION_KINDS.includes(r.kind)) return `E_ARGS: род отношения — ${RELATION_KINDS.join(' | ')}`
        for (const end of [r.from, r.to]) if (!end || !ent(end.entity)) return `E_ENTITY: нет сущности ${String(end?.entity)}`
        const id = r._id ?? gen()
        return { label: 'провод', id, calls: [{ name: 'object.insert', args: { path: 'space.relations', id, item: { ...r, _id: undefined } } }] }
      }
      case 'relation.remove': {
        if (!m.space.relations.some((r) => r._id === a.id)) return `E_RELATION: нет отношения ${String(a.id)}`
        return { label: 'убрать провод', calls: [{ name: 'object.remove', args: { path: 'space.relations', id: a.id } }] }
      }
      case 'composite.create': {
        const id = (a.id as string) ?? gen()
        if (ent(id)) return `E_ENTITY: ${id} уже есть`
        const item: Entity = { _id: id, role: 'node', typeId: (a.typeId as string) ?? 'composite', name: a.name as string, composite: { variables: [], rows: [{ label: '1', parts: [] }] } }
        return { label: 'пустой композит', id, calls: [{ name: 'object.insert', args: { path: 'space.entities', id, item } }] }
      }
      case 'composite.row.add': {
        const x = comp(a.entity)
        if (typeof x === 'string') return x
        const id = gen()
        const row = { label: nextLabel(x.c), parts: [], ...((a.row as object) ?? {}), _id: undefined }
        return { label: 'строка', id, calls: [{ name: 'object.insert', args: { path: `${E(a.entity as string)}.composite.rows`, id, item: row } }] }
      }
      case 'composite.row.set': {
        const x = comp(a.entity)
        if (typeof x === 'string') return x
        if (!rowOf(x.c, a.row)) return `E_ROW: нет строки ${String(a.row)}`
        const calls: CommandCall[] = []
        for (const k of ['label', 'weight', 'when', 'meta'] as const) {
          if (!(k in a)) continue
          const v = a[k]
          const path = `${R(a.entity as string, a.row as string)}.${k}`
          calls.push(v === undefined || v === null || v === '' ? { name: 'object.unset', args: { path } } : { name: 'object.set', args: { path, value: v } })
        }
        return { label: 'строка: вес, условие, мета', calls }
      }
      case 'composite.row.remove': {
        const x = comp(a.entity)
        if (typeof x === 'string') return x
        if (!rowOf(x.c, a.row)) return `E_ROW: нет строки ${String(a.row)}`
        return { label: 'убрать строку', calls: [{ name: 'object.remove', args: { path: `${E(a.entity as string)}.composite.rows`, id: a.row } }] }
      }
      case 'composite.part.add': {
        const x = comp(a.entity)
        if (typeof x === 'string') return x
        if (!rowOf(x.c, a.row)) return `E_ROW: нет строки ${String(a.row)}`
        const part = a.part as RowPart
        if (part?.kind !== 'text' && part?.kind !== 'pill') return 'E_ARGS: part.kind — text | pill'
        if (part.kind === 'pill' && part.var && !x.c.variables.some((v) => v.name === part.var)) return `E_VAR: нет переменной ${part.var}`
        const id = gen()
        return { label: part.kind === 'pill' ? 'пилюля' : 'текст', id, calls: [{ name: 'object.insert', args: { path: `${R(a.entity as string, a.row as string)}.parts`, id, item: { ...part, _id: undefined }, before: a.before } }] }
      }
      case 'composite.part.set': {
        const x = comp(a.entity)
        if (typeof x === 'string') return x
        const row = rowOf(x.c, a.row)
        if (!row) return `E_ROW: нет строки ${String(a.row)}`
        if (!row.parts.some((p) => p._id === a.part)) return `E_PART: нет части ${String(a.part)}`
        if (typeof a.var === 'string' && !x.c.variables.some((v) => v.name === a.var)) return `E_VAR: нет переменной ${a.var}`
        const base = `${R(a.entity as string, a.row as string)}.parts[${a.part as string}]`
        const calls: CommandCall[] = []
        for (const k of ['text', 'var', 'meta'] as const) {
          if (!(k in a)) continue
          const v = a[k]
          const empty = v === undefined || v === null || (k === 'meta' && typeof v === 'object' && Object.keys(v as object).length === 0)
          calls.push(empty ? { name: 'object.unset', args: { path: `${base}.${k}` } } : { name: 'object.set', args: { path: `${base}.${k}`, value: v } })
        }
        const prevPart = row.parts.find((p) => p._id === a.part)
        if (typeof a.var === 'string' && prevPart?.kind === 'pill' && prevPart.var !== a.var) calls.push(...dropOrphan(m, a.entity as string, x.c, prevPart.var, a.part as string))
        return { label: 'мета пилюли', calls }
      }
      case 'composite.part.remove': {
        const x = comp(a.entity)
        if (typeof x === 'string') return x
        const rr = rowOf(x.c, a.row)
        if (!rr) return `E_ROW: нет строки ${String(a.row)}`
        const gone = rr.parts.find((p) => p._id === a.part)
        return {
          label: 'убрать часть',
          calls: [
            { name: 'object.remove', args: { path: `${R(a.entity as string, a.row as string)}.parts`, id: a.part } },
            ...dropOrphan(m, a.entity as string, x.c, gone?.kind === 'pill' ? gone.var : undefined, a.part as string),
          ],
        }
      }
      case 'composite.connect':
        return connect(m, a, comp, rowOf)
      case 'composite.var.rename': {
        const x = comp(a.entity)
        if (typeof x === 'string') return x
        const from = a.from as string
        const to = (a.to as string).trim()
        const v = x.c.variables.find((vv) => vv.name === from)
        if (!v) return `E_VAR: нет переменной ${from}`
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(to)) return `E_ARGS: имя переменной — буквы, цифры, _ (${to})`
        if (to !== from && x.c.variables.some((vv) => vv.name === to)) return `E_VAR: ${to} уже есть`
        const eid = a.entity as string
        const calls: CommandCall[] = [{ name: 'object.set', args: { path: `${E(eid)}.composite.variables[${v._id}].name`, value: to } }]
        for (const r of x.c.rows) for (const p of r.parts) if (p.kind === 'pill' && p.var === from) calls.push({ name: 'object.set', args: { path: `${R(eid, r._id!)}.parts[${p._id}].var`, value: to } })
        for (const rel of m.space.relations) if (rel.to.entity === eid && portVar(rel.to.port) === from) calls.push({ name: 'object.set', args: { path: `space.relations[${rel._id}].to.port`, value: varPort(to) } })
        return { label: `переменная ${from} → ${to}`, calls }
      }
    }
    return `E_COMMAND: нет команды ${name} (есть: ${Object.keys(SCHEMA_COMMANDS).join(', ')})`
  }

  /** Жест композита (§6): провод из источника — в пилюлю, на переменную или в пустую строку. */
  function connect(
    m: SchemaModel,
    a: Record<string, unknown>,
    comp: (id: unknown) => { e: Entity; c: Composite } | string,
    rowOf: (c: Composite, id: unknown) => CompositeRow | undefined,
  ): { label: string; calls: CommandCall[]; id?: string } | string {
    const x = comp(a.entity)
    if (typeof x === 'string') return x
    const eid = a.entity as string
    const from = a.from as RelationEnd
    const src = from && entityOf(m, from.entity)
    if (!src) return `E_ENTITY: нет источника ${String(from?.entity)}`
    if (from.entity === eid) return 'E_ARGS: провод из композита в себя'
    const calls: CommandCall[] = []
    const wire = (name: string) => {
      const exists = m.space.relations.some((r) => r.from.entity === from.entity && r.to.entity === eid && portVar(r.to.port) === name)
      if (!exists) calls.push({ name: 'object.insert', args: { path: 'space.relations', id: gen(), item: { kind: 'data', from: { entity: from.entity, ...(from.port ? { port: from.port } : {}) }, to: { entity: eid, port: varPort(name) } } } })
    }
    // на существующую переменную — тот же выбор: провод перепривязывается к ней
    if (typeof a.variable === 'string') {
      const v = x.c.variables.find((vv) => vv.name === a.variable)
      if (!v) return `E_VAR: нет переменной ${a.variable}`
      for (const r of m.space.relations) if (r.to.entity === eid && portVar(r.to.port) === v.name && r.from.entity !== from.entity) calls.push({ name: 'object.remove', args: { path: 'space.relations', id: r._id } })
      wire(v.name)
      if (typeof a.row === 'string' && typeof a.part === 'string') calls.push({ name: 'object.set', args: { path: `${R(eid, a.row)}.parts[${a.part}].var`, value: v.name } })
      return { label: `провод на ${v.name}`, calls }
    }
    // новая переменная: имя от источника (свойство `var` — подсказка вида), цвет — следующий
    const hint = typeof src.properties?.var === 'string' ? (src.properties.var as string) : src.name ?? src.typeId ?? 'v'
    const name = typeof a.name === 'string' && a.name ? a.name : freshVarName(hint, x.c.variables.map((v) => v.name))
    calls.push({ name: 'object.insert', args: { path: `${E(eid)}.composite.variables`, id: gen(), item: { name, color: colorFor(x.c.variables) } } })
    wire(name)
    const row = typeof a.row === 'string' ? rowOf(x.c, a.row) : undefined
    if (typeof a.row === 'string' && !row) return `E_ROW: нет строки ${a.row}`
    if (row && typeof a.part === 'string') {
      const part = row.parts.find((p) => p._id === a.part)
      if (!part || part.kind !== 'pill') return `E_PART: ${String(a.part)} — не пилюля`
      calls.push({ name: 'object.set', args: { path: `${R(eid, row._id!)}.parts[${part._id}].var`, value: name } })
    } else if (row) {
      calls.push({ name: 'object.insert', args: { path: `${R(eid, row._id!)}.parts`, id: gen(), item: { kind: 'pill', var: name } } })
    } else {
      // пустая строка внизу — «брось сюда провод»: новая строка с одной пилюлей
      calls.push({ name: 'object.insert', args: { path: `${E(eid)}.composite.rows`, id: gen(), item: { label: nextLabel(x.c), parts: [{ _id: gen(), kind: 'pill', var: name }] } } })
    }
    return { label: `провод в пилюлю → ${name}`, calls, id: name }
  }

  /** Переменная без единой пилюли (кроме `except`) — уходит вместе со своим проводом: переменных руками не заводят. */
  function dropOrphan(m: SchemaModel, eid: string, c: Composite, name: string | undefined, except: string): CommandCall[] {
    if (!name) return []
    if (c.rows.some((r) => r.parts.some((p) => p.kind === 'pill' && p.var === name && p._id !== except))) return []
    const v = c.variables.find((x) => x.name === name)
    if (!v) return []
    return [
      ...m.space.relations.filter((r) => r.to.entity === eid && portVar(r.to.port) === name).map((r) => ({ name: 'object.remove', args: { path: 'space.relations', id: r._id } })),
      { name: 'object.remove', args: { path: E(eid) + '.composite.variables', id: v._id } },
    ]
  }

  const api: SchemaDocument = {
    doc,
    get model() {
      return doc.object
    },
    commands: { ...SCHEMA_COMMANDS, ...doc.commands },
    exec(name, args = {}) {
      if (name.startsWith('object.')) return doc.exec(name, args)
      if (!args || typeof args !== 'object') return fail('E_ARGS: аргументы — объект')
      const p = plan(name, args as Record<string, unknown>)
      if (typeof p === 'string') return fail(p)
      if (p.calls.length === 0) return { ok: true, changed: [] }
      const r = doc.batch(p.label, p.calls)
      return r.ok && p.id ? { ...r, id: p.id } : r
    },
    undo: () => doc.undo(),
    redo: () => doc.redo(),
    get canUndo() {
      return doc.canUndo
    },
    get canRedo() {
      return doc.canRedo
    },
    get dirty() {
      return doc.dirty
    },
    markClean: () => doc.markClean(),
    reload: (mm) => doc.reload(mm),
    on: (ev, fn) => doc.on(ev, fn),
  }
  return api
}

export type { PillMeta }
