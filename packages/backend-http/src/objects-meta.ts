/**
 * Тип `type` — список типов как обычная коллекция (objects-spec §18): записи — файлы типов
 * стенда (`<последний каталог типов>/<id>.mdz`, правятся) и встроенные типы плагинов (только чтение),
 * ошибки разбора — строками с бейджем «ошибка». Документ — поля типа (`$fields`) и его виды; новая
 * запись — новый тип: файловый источник `mdz`, записи в `objects/<id>` корня стенда, схема из полей.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ObjectDoc, ObjectListResult, ObjectQuery, ObjectRow, ObjectSaveResult, ObjectTypeError, ObjectTypeInfo } from '@kerneldreams/ui-protocol'
import type { ObjectTypeDef, TypeField } from './objects.js'
import { fold, formatFields, parseFields } from './objects.js'

export const TYPE_TYPE = 'type'
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/

const TYPE_EDITOR = `$editor: 1
$id: type
$title: Тип

## $section type
$title: Тип

### $field id
$type: string
$label: Имя (id)
$required: true

### $field title
$type: string
$label: Название

### $field icon
$type: string
$label: Иконка (lucide)

## $section fields
$title: Поля

### $repeat fields
$label: Поля
$item-title: name

#### $field name
$row: f
$type: string
$label: Поле
$required: true

#### $field type
$row: f
$type: string
$label: Тип
$enum: $[string, text, number, integer, boolean]
$widget: select

#### $field title
$type: string
$label: Подпись

## $section about
$title: Источник и виды
$collapsed: true

### $field source
$type: string
$label: Источник

### $field paths
$type: string
$label: Где записи

### $field views
$type: string[]
$label: Виды
`

export const TYPE_TYPE_INFO: ObjectTypeInfo = {
  id: TYPE_TYPE,
  title: 'Типы',
  icon: 'shapes',
  source: 'files',
  format: 'mdz',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', title: 'Имя (id)' },
      title: { type: 'string', title: 'Название' },
      icon: { type: 'string', title: 'Иконка (lucide)' },
      fields: {
        type: 'array',
        title: 'Поля',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Поле' },
            type: { type: 'string', title: 'Тип', enum: ['string', 'text', 'number', 'integer', 'boolean'] },
            title: { type: 'string', title: 'Подпись' },
          },
          required: ['name'],
        },
      },
      paths: { type: 'string', title: 'Где записи', readOnly: true },
      source: { type: 'string', title: 'Источник', readOnly: true },
      views: { type: 'array', title: 'Виды', items: { type: 'string' }, readOnly: true },
    },
    required: ['id'],
  },
  idField: 'id',
  titleField: 'title',
  search: [{ field: 'title', weight: 2 }, { field: 'id', weight: 1 }],
  filters: ['source'],
  sort: ['title'],
  actions: ['create', 'delete'],
  links: [],
  // Документ типа — инспектор (поля) первым, потом файл как текст.
  views: ['inspector', 'text'],
  // Поля — повторителем (массив объектов из голой схемы инспектор не выводит).
  editors: [{ id: 'type', view: 'inspector', title: 'Тип', format: 'mdz', text: TYPE_EDITOR }],
  templates: [],
  columns: ['source'],
}

const err = (message: string, code: string): Error => Object.assign(new Error(message), { code })
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export interface TypeTypeHost {
  types(): { types: Map<string, ObjectTypeDef>; errors: ObjectTypeError[] }
  /** Каталоги типов, младший → старший; пишет последний. */
  typeDirs(): string[]
  reload(): void
}

export function createTypeType(host: TypeTypeHost) {
  const own = (): string | null => host.typeDirs().at(-1) ?? null
  const editable = (t: ObjectTypeDef): boolean => !!t.file && !!own() && dirname(t.file) === own()
  /** Поля типа: свои `$fields` или свойства схемы (кроме id-поля). */
  const fieldsOf = (t: ObjectTypeDef): TypeField[] => {
    if (t.fields) return t.fields
    const props = isRecord(t.schema?.properties) ? (t.schema!.properties as Record<string, Record<string, unknown>>) : {}
    return Object.entries(props)
      .filter(([k]) => k !== t.idField)
      .map(([name, p]) => ({ name, type: (['number', 'integer', 'boolean'].includes(String(p.type)) ? p.type : 'string') as TypeField['type'], ...(typeof p.title === 'string' ? { title: p.title } : {}) }))
  }
  const dataOf = (t: ObjectTypeDef): Record<string, unknown> => ({
    id: t.id,
    title: t.title,
    ...(t.icon ? { icon: t.icon } : {}),
    fields: fieldsOf(t),
    source: t.source,
    paths: t.dirs.join(', '),
    views: [...t.views, ...t.templates.map((v) => v.id)],
  })
  const rowOf = (t: ObjectTypeDef): ObjectRow => ({
    type: TYPE_TYPE,
    id: t.id,
    title: t.title,
    subtitle: t.id,
    badges: [t.source, ...(editable(t) ? [] : ['встроенный'])],
    fields: { source: t.source },
    group: editable(t) ? 'own' : 'builtin',
    groupTitle: editable(t) ? 'Свои' : 'Встроенные',
  })
  const errorRow = (e: ObjectTypeError): ObjectRow => ({
    type: TYPE_TYPE,
    id: `error-${basename(e.file, '.mdz')}`,
    title: e.id ?? basename(e.file),
    subtitle: e.message,
    badges: ['ошибка'],
    group: 'errors',
    groupTitle: 'С ошибкой',
  })
  const docOf = (t: ObjectTypeDef): ObjectDoc => {
    const data = dataOf(t)
    const text = t.file && existsSync(t.file) ? readFileSync(t.file, 'utf-8') : ''
    return {
      type: TYPE_TYPE,
      id: t.id,
      data,
      ...(text ? { raw: text } : {}),
      hash: createHash('sha1').update(text || JSON.stringify(data)).digest('hex').slice(0, 16),
      row: rowOf(t),
      ...(t.file ? { path: t.file } : {}),
    }
  }
  const fieldsIn = (raw: unknown): TypeField[] | string => {
    if (!Array.isArray(raw)) return []
    const text = formatFields(
      raw.filter(isRecord).filter((f) => str(f.name)).map((f) => ({ name: str(f.name), type: (str(f.type) || 'string') as TypeField['type'], ...(str(f.title) ? { title: str(f.title) } : {}) })),
    )
    return text ? parseFields(text) : []
  }
  const titleFieldOf = (fields: TypeField[]): string =>
    fields.find((f) => f.name === 'title' || f.name === 'name')?.name ?? fields.find((f) => f.type === 'string')?.name ?? 'id'
  /** Строки `$ключ:` текста файла: заменить или дописать после `$id`. */
  const setKeys = (text: string, keys: Record<string, string | null>): string => {
    let lines = text.split('\n')
    for (const [k, v] of Object.entries(keys)) {
      const re = new RegExp(`^\\$${k}:`)
      const at = lines.findIndex((l) => re.test(l))
      if (v === null) {
        if (at >= 0) lines.splice(at, 1)
        continue
      }
      const line = `$${k}: ${v}`
      if (at >= 0) lines[at] = line
      else {
        const idAt = lines.findIndex((l) => /^\$id:/.test(l))
        lines = [...lines.slice(0, idAt + 1), line, ...lines.slice(idAt + 1)]
      }
    }
    return lines.join('\n')
  }

  return {
    info: TYPE_TYPE_INFO,
    list(q: ObjectQuery): ObjectListResult {
      const { types, errors } = host.types()
      let rows = [...types.values()].map(rowOf)
      rows.push(...errors.map(errorRow))
      const allowed = q.filters?.source ?? []
      if (allowed.length) rows = rows.filter((r) => allowed.includes(r.fields?.source ?? ''))
      if (q.q?.trim()) {
        const n = fold(q.q.trim())
        rows = rows.filter((r) => fold(`${r.title} ${r.id}`).includes(n))
      }
      const order = { own: 0, builtin: 1, errors: 2 } as Record<string, number>
      rows.sort((a, b) => (order[a.group ?? ''] ?? 9) - (order[b.group ?? ''] ?? 9) || a.title.localeCompare(b.title))
      const counts = new Map<string, number>()
      for (const t of types.values()) counts.set(t.source, (counts.get(t.source) ?? 0) + 1)
      return { rows, total: rows.length, facets: { source: [...counts.entries()] } }
    },
    get(id: string): ObjectDoc {
      const t = host.types().types.get(id)
      if (!t) throw err(`objects: нет типа ${id}`, 'not_found')
      return docOf(t)
    },
    create(data: Record<string, unknown>): ObjectSaveResult {
      const id = str(data.id)
      if (!id) return { invalid: { id: 'обязательное поле' }, message: 'обязательное поле' }
      if (!ID_RE.test(id) || id === TYPE_TYPE) return { invalid: { id: 'только a-z, 0-9, _ и -' }, message: 'только a-z, 0-9, _ и -' }
      if (host.types().types.has(id)) return { invalid: { id: `«${id}» уже есть` }, message: `«${id}» уже есть` }
      const dir = own()
      if (!dir) throw err('objects: у стенда нет каталога типов', 'not_supported')
      const fields = fieldsIn(data.fields)
      if (typeof fields === 'string') return { invalid: { fields }, message: fields }
      const lines = [
        '$type: object-type',
        `$id: ${id}`,
        `$title: ${str(data.title) || id}`,
        ...(str(data.icon) ? [`$icon: ${str(data.icon)}`] : []),
        '$source: files',
        '$format: mdz',
        `$paths: objects/${id}`,
        '$id_field: id',
        `$title_field: ${titleFieldOf(fields)}`,
        ...(fields.length ? [`$fields: ${formatFields(fields)}`] : []),
        // Запись своего типа — стандартный инспектор первым (вид «Карточка» — у md-карточек со своим текстом).
        '$views: inspector, text, links, history',
        '$actions: create, duplicate, delete',
        '',
      ]
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.mdz`), lines.join('\n'))
      host.reload()
      return { doc: this.get(id) }
    },
    save(id: string, data: Record<string, unknown>): ObjectSaveResult {
      const t = host.types().types.get(id)
      if (!t) throw err(`objects: нет типа ${id}`, 'not_found')
      if (!editable(t) || !t.file) return { invalid: { id: 'встроенный тип — только чтение' }, message: 'встроенный тип — только чтение' }
      const fields = fieldsIn(data.fields)
      if (typeof fields === 'string') return { invalid: { fields }, message: fields }
      const keys: Record<string, string | null> = { title: str(data.title) || id, icon: str(data.icon) || null }
      // Схема файлом — поля не правятся отсюда.
      if (!/^\$schema:/m.test(readFileSync(t.file, 'utf-8'))) {
        keys.fields = fields.length ? formatFields(fields) : null
        keys.title_field = titleFieldOf(fields)
      }
      writeFileSync(t.file, setKeys(readFileSync(t.file, 'utf-8'), keys))
      host.reload()
      return { doc: this.get(id) }
    },
  }
}
