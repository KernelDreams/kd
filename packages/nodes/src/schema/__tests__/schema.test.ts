import { describe, expect, it } from 'vitest'
import { createSchemaDocument, compositeToText, lineToRow, partsFromNtpl, partsToNtpl, RowProjectionError, typeFromJsonSchema, typeToJsonSchema, type SchemaModel } from '../index.js'

let n = 0
const ids = () => `i${++n}`
const empty = (): SchemaModel => ({ kind: 'namegen', space: { mode: 'graph', entities: [], relations: [] } })

function setup() {
  n = 0
  const d = createSchemaDocument(empty(), { id: ids })
  d.exec('entity.add', { entity: { _id: 'names', role: 'node', typeId: 'namegen:list', name: 'Имена м', properties: { var: 'имя' } } })
  d.exec('entity.add', { entity: { _id: 'last', role: 'node', typeId: 'namegen:list', name: 'Фамилии', properties: { var: 'фамилия' } } })
  const c = d.exec('composite.create', { id: 'person', name: 'Персонаж' })
  expect(c.ok).toBe(true)
  return d
}

describe('документ схемы', () => {
  it('сущность и отношение — строки с _id, удаление сущности уносит её провода', () => {
    const d = setup()
    const r = d.exec('relation.add', { relation: { kind: 'data', from: { entity: 'names' }, to: { entity: 'person', port: 'x' } } })
    expect(r.ok).toBe(true)
    expect(d.model.space.relations).toHaveLength(1)
    expect(d.exec('relation.add', { relation: { kind: 'wire', from: { entity: 'names' }, to: { entity: 'person' } } }).ok).toBe(false)
    expect(d.exec('relation.add', { relation: { kind: 'data', from: { entity: 'nope' }, to: { entity: 'person' } } }).errors?.[0]).toMatch(/E_ENTITY/)
    d.exec('entity.remove', { id: 'names' })
    expect(d.model.space.relations).toHaveLength(0)
    expect(d.model.space.entities.map((e) => e._id)).toEqual(['last', 'person'])
    d.undo()
    expect(d.model.space.relations).toHaveLength(1)
  })

  it('жест: пустой композит → пилюля → провод из справочника → переменная появилась', () => {
    const d = setup()
    const row = d.model.space.entities[2]!.composite!.rows[0]!._id!
    const pill = d.exec('composite.part.add', { entity: 'person', row, part: { kind: 'pill' } })
    expect(pill.ok).toBe(true)
    const g = d.exec('composite.connect', { from: { entity: 'names' }, entity: 'person', row, part: pill.id })
    expect(g.ok).toBe(true)
    const c = d.model.space.entities[2]!.composite!
    expect(c.variables.map((v) => v.name)).toEqual(['имя'])
    expect(c.rows[0]!.parts[0]).toMatchObject({ kind: 'pill', var: 'имя' })
    expect(d.model.space.relations[0]).toMatchObject({ kind: 'data', from: { entity: 'names' }, to: { entity: 'person', port: 'var:имя' } })
    // одна запись истории на жест
    d.undo()
    expect(d.model.space.entities[2]!.composite!.variables).toHaveLength(0)
    expect(d.model.space.relations).toHaveLength(0)
    d.redo()
    expect(d.model.space.entities[2]!.composite!.variables).toHaveLength(1)
  })

  it('тот же справочник ещё раз — новая переменная; на существующую — тот же выбор', () => {
    const d = setup()
    const row = d.model.space.entities[2]!.composite!.rows[0]!._id!
    const p1 = d.exec('composite.part.add', { entity: 'person', row, part: { kind: 'pill' } }).id
    const p2 = d.exec('composite.part.add', { entity: 'person', row, part: { kind: 'pill' } }).id
    const p3 = d.exec('composite.part.add', { entity: 'person', row, part: { kind: 'pill' } }).id
    d.exec('composite.connect', { from: { entity: 'names' }, entity: 'person', row, part: p1 })
    d.exec('composite.connect', { from: { entity: 'names' }, entity: 'person', row, part: p2 })
    let c = d.model.space.entities[2]!.composite!
    expect(c.variables.map((v) => v.name)).toEqual(['имя', 'имя2'])
    expect(c.variables[0]!.color).not.toBe(c.variables[1]!.color)
    d.exec('composite.connect', { from: { entity: 'names' }, entity: 'person', row, part: p3, variable: 'имя' })
    c = d.model.space.entities[2]!.composite!
    expect(c.variables).toHaveLength(2)
    expect(c.rows[0]!.parts.map((p) => (p.kind === 'pill' ? p.var : ''))).toEqual(['имя', 'имя2', 'имя'])
    expect(d.model.space.relations.filter((r) => r.to.port === 'var:имя')).toHaveLength(1)
  })

  it('провод в пустое место — новая строка с пилюлей; вес и условие строки; переименование тянет пилюли и провод', () => {
    const d = setup()
    d.exec('composite.connect', { from: { entity: 'last' }, entity: 'person' })
    const c = d.model.space.entities[2]!.composite!
    expect(c.rows).toHaveLength(2)
    const r2 = c.rows[1]!
    expect(r2.parts[0]).toMatchObject({ kind: 'pill', var: 'фамилия' })
    expect(d.exec('composite.row.set', { entity: 'person', row: r2._id, label: 'ж', weight: 2, meta: { rod: 'ж' } }).ok).toBe(true)
    expect(d.model.space.entities[2]!.composite!.rows[1]).toMatchObject({ label: 'ж', weight: 2, meta: { rod: 'ж' } })
    expect(d.exec('composite.var.rename', { entity: 'person', from: 'фамилия', to: 'фам' }).ok).toBe(true)
    expect(d.model.space.entities[2]!.composite!.rows[1]!.parts[0]).toMatchObject({ var: 'фам' })
    expect(d.model.space.relations[0]!.to.port).toBe('var:фам')
    expect(d.exec('composite.var.rename', { entity: 'person', from: 'фам', to: 'два слова' }).ok).toBe(false)
  })

  it('незнакомая команда и чужой композит — ошибка, документ цел', () => {
    const d = setup()
    expect(d.exec('nope', {}).errors?.[0]).toMatch(/E_COMMAND/)
    expect(d.exec('composite.row.add', { entity: 'names' }).errors?.[0]).toMatch(/E_COMPOSITE/)
    expect(d.model.space.entities).toHaveLength(3)
  })
})

describe('строка композита ⇄ ntpl', () => {
  it('пилюли и мета — фильтрами морфологии, туда и обратно', () => {
    const src = "<< имя_ж >> << отец | отчество('ж') >> << фамилия | род('ж') >>"
    const parts = partsFromNtpl(src)
    expect(parts).toEqual([
      { kind: 'pill', var: 'имя_ж' },
      { kind: 'text', text: ' ' },
      { kind: 'pill', var: 'отец', meta: { patronymic: true, rod: 'ж' } },
      { kind: 'text', text: ' ' },
      { kind: 'pill', var: 'фамилия', meta: { rod: 'ж' } },
    ])
    expect(partsToNtpl(parts)).toBe(src)
    expect(partsFromNtpl('<< x | род | падеж(\'р\') | заглавная >>')[0]).toEqual({ kind: 'pill', var: 'x', meta: { agree: true, padej: 'р', case: 'title' } })
  })

  it('непоказуемое — отказ с перечнем, а не потеря', () => {
    expect(() => partsFromNtpl('<{ if a }>x<{ endif }>')).toThrow(RowProjectionError)
    try {
      partsFromNtpl('<< a + b >> << c | upper >>')
    } catch (e) {
      expect((e as RowProjectionError).unshowable).toHaveLength(2)
    }
  })

  it('текст композита с метками строк', () => {
    const t = compositeToText([
      { label: 'м', parts: partsFromNtpl('<< имя >> << фамилия >>') },
      { parts: partsFromNtpl('<< имя >>') },
    ])
    expect(t).toBe('м: << имя >> << фамилия >>\n<< имя >>')
    expect(lineToRow('ж: << имя_ж >>')).toEqual({ label: 'ж', parts: [{ kind: 'pill', var: 'имя_ж' }] })
  })
})

describe('типы — проекция JSON Schema', () => {
  it('объект туда и обратно', () => {
    const s = { type: 'object', properties: { name: { type: 'string', maxLength: 20 }, tags: { type: 'array', items: { type: 'string' } } }, required: ['name'] }
    const t = typeFromJsonSchema('Person', s)
    expect(t.fields).toEqual([
      { name: 'name', type: 'string', required: true, constraints: { maxLength: 20 } },
      { name: 'tags', type: 'string[]' },
    ])
    expect(typeToJsonSchema(t)).toMatchObject({ type: 'object', required: ['name'], properties: { tags: { type: 'array', items: { type: 'string' } } } })
    expect(typeFromJsonSchema('Rod', { enum: ['м', 'ж'] })).toEqual({ id: 'Rod', kind: 'enum', title: undefined, values: ['м', 'ж'] })
  })
})

describe('переменная без пилюль уходит', () => {
  it('пилюлю перевели на другую переменную — прежняя уходит вместе с проводом; строки нумеруются', () => {
    const d = setup()
    const row = d.model.space.entities[2]!.composite!.rows[0]!
    expect(row.label).toBe('1')
    const p1 = d.exec('composite.part.add', { entity: 'person', row: row._id, part: { kind: 'pill' } }).id
    const p2 = d.exec('composite.part.add', { entity: 'person', row: row._id, part: { kind: 'pill' } }).id
    d.exec('composite.connect', { from: { entity: 'names' }, entity: 'person', row: row._id, part: p1 })
    d.exec('composite.connect', { from: { entity: 'names' }, entity: 'person', row: row._id, part: p2 })
    expect(d.model.space.relations).toHaveLength(2)
    d.exec('composite.part.set', { entity: 'person', row: row._id, part: p2, var: 'имя' })
    expect(d.model.space.entities[2]!.composite!.variables.map((v) => v.name)).toEqual(['имя'])
    expect(d.model.space.relations).toHaveLength(1)
    d.exec('composite.part.remove', { entity: 'person', row: row._id, part: p2 })
    expect(d.model.space.entities[2]!.composite!.variables).toHaveLength(1)
    d.exec('composite.part.remove', { entity: 'person', row: row._id, part: p1 })
    expect(d.model.space.entities[2]!.composite!.variables).toHaveLength(0)
    expect(d.model.space.relations).toHaveLength(0)
    d.exec('composite.connect', { from: { entity: 'last' }, entity: 'person' })
    expect(d.model.space.entities[2]!.composite!.rows[1]!.label).toBe('2')
  })
})
