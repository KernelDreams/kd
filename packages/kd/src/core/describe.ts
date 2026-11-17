/**
 * Из одного объявления: справка `--help`, схема для модели (`ToolDef`, без объединений типов —
 * §9.3), общий тул `kd {tool, action, params}` и `kd_describe`, пункт палитры.
 */

import type { FormSchema } from '@kerneldreams/forms'
import { appliesTo, defaultAction, type ToolDecl, type ToolField } from './decl.js'

const typeName = (f: ToolField): string => {
  const s = f.schema
  const ui = s['x-ui']
  if (s.enum) return s.enum.join('|')
  const base = ui.kind ?? (s.type === 'boolean' ? '' : ui.widget === 'textarea' ? 'текст' : s.type === 'number' ? 'число' : 'строка')
  return s.type === 'array' ? `${base || 'строка'}[]` : base
}

/** Справка тула. */
export function helpOf(d: ToolDecl): string {
  const lines: string[] = []
  lines.push(d.description ? `${d.name} — ${d.description}` : d.name)
  if (d.legacy) {
    lines.push('', `Использование: kd ${d.name} [слова] [--флаги]  (объявления нет: слова — в $_, флаги как есть)`)
    if (d.fields.length) lines.push('', 'Флаги:', ...d.fields.map((f) => `  --${f.name}${f.schema.title ? `  ${f.schema.title}` : ''}`))
    return lines.join('\n')
  }
  const posOf = (action: string | undefined): string =>
    d.fields
      .filter((f) => appliesTo(f, action) && (f.schema['x-ui'].pos !== undefined || f.schema['x-ui'].rest))
      .sort((a, b) => (a.schema['x-ui'].rest ? 1e9 : a.schema['x-ui'].pos!) - (b.schema['x-ui'].rest ? 1e9 : b.schema['x-ui'].pos!))
      .map((f) => (f.schema['x-ui'].rest ? `<${f.name}…>` : f.required && f.schema.default === undefined ? `<${f.name}>` : `[${f.name}]`))
      .join(' ')
  lines.push('', 'Использование:')
  if (d.actions.length) {
    const w = Math.max(...d.actions.map((a) => a.name.length))
    for (const a of d.actions) lines.push(`  kd ${d.name} ${a.name.padEnd(w)} ${posOf(a.name)}${a.title ? `   # ${a.title}${a.default ? ' (по умолчанию)' : ''}` : a.default ? '   # по умолчанию' : ''}`.trimEnd())
  } else lines.push(`  kd ${d.name} ${posOf(undefined)}`.trimEnd())
  if (d.fields.length) {
    lines.push('', 'Поля:')
    const w = Math.max(...d.fields.map((f) => f.name.length + typeName(f).length)) + 4
    for (const f of d.fields) {
      const ui = f.schema['x-ui']
      const head = `--${f.name}${typeName(f) ? `=${typeName(f)}` : ''}`
      const extra = [
        f.schema.default !== undefined && f.schema.default !== '' && f.schema.default !== false ? `по умолчанию ${Array.isArray(f.schema.default) ? f.schema.default.join(',') : String(f.schema.default)}` : '',
        f.required && f.schema.default === undefined ? 'обязательно' : '',
        ui.for?.length ? `для ${ui.for.join(', ')}` : '',
        ui.pos !== undefined ? `слово ${ui.pos}` : '',
        ui.rest ? 'весь оставшийся текст' : '',
      ].filter(Boolean)
      lines.push(`  ${head.padEnd(w + 4)}${f.schema.title ?? ''}${extra.length ? ` (${extra.join('; ')})` : ''}`.trimEnd())
    }
  }
  if (d.needs.length) lines.push('', `Нужно: ${d.needs.join(', ')}`)
  const ex = [...d.examples, ...d.actions.flatMap((a) => a.examples ?? [])]
  if (ex.length) lines.push('', 'Примеры:', ...ex.map((e) => `  ${e}`))
  return lines.join('\n')
}

/** JSON Schema одного поля для модели — без объединений типов. */
function fieldJson(f: ToolField): Record<string, unknown> {
  const s = f.schema
  const out: Record<string, unknown> = {}
  if (s.type === 'array') {
    out.type = 'array'
    out.items = { type: 'string' }
  } else out.type = s.type
  const desc = [s.title, s['x-ui'].kind ? `вид: ${s['x-ui'].kind}` : ''].filter(Boolean).join('; ')
  if (desc) out.description = desc
  if (s.enum) out.enum = s.enum
  if (s.default !== undefined) out.default = s.default
  if (s.minimum !== undefined) out.minimum = s.minimum
  if (s.maximum !== undefined) out.maximum = s.maximum
  return out
}

/** Схема входа тула (или одного действия) — тот же `ToolDef.parameters`. */
export function inputSchema(d: ToolDecl, action?: string): { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } {
  const act = action ?? defaultAction(d)
  const fields = d.fields.filter((f) => (action === undefined && d.actions.length > 1 ? true : appliesTo(f, act)))
  const properties: Record<string, unknown> = {}
  for (const f of fields) properties[f.name] = fieldJson(f)
  return {
    type: 'object',
    properties,
    required: fields.filter((f) => f.required && f.schema.default === undefined && (action !== undefined || !f.schema['x-ui'].for)).map((f) => f.name),
    additionalProperties: d.legacy,
  }
}

/** Описание тула для модели (`ToolDef` без исполнителя). */
export interface ToolDefJson {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Типизированный тул: у тула с действиями — поле `action` (enum) и все поля. */
export function toolDefOf(d: ToolDecl): ToolDefJson {
  const schema = inputSchema(d)
  if (d.actions.length) {
    const def = defaultAction(d)
    schema.properties = { action: { type: 'string', enum: d.actions.map((a) => a.name), description: d.actions.map((a) => `${a.name}${a.title ? ` — ${a.title}` : ''}`).join('; '), ...(def ? { default: def } : {}) }, ...schema.properties }
    if (!def) schema.required = ['action', ...schema.required]
  }
  return { name: d.name.replace(/[^A-Za-z0-9_-]/g, '_'), description: d.description || d.name, parameters: schema }
}

/** Общий тул `kd` (§9.5.1): модель зовёт любой тул каталога структурно. */
export function kdToolDef(catalog: ReadonlyArray<{ name: string; description: string }>): ToolDefJson {
  return {
    name: 'kd',
    description:
      'Запустить тул kd структурно: {tool, action, params}. Схему и примеры тула — kd_describe. Ошибка возвращает исправленный вызов целиком.\nТулы: ' +
      catalog.map((t) => `${t.name}${t.description ? ` — ${t.description}` : ''}`).join('; '),
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'имя тула', enum: catalog.map((t) => t.name) },
        action: { type: 'string', description: 'действие тула; пусто — по умолчанию' },
        params: { type: 'object', description: 'поля тула по схеме kd_describe', additionalProperties: true },
      },
      required: ['tool'],
      additionalProperties: false,
    },
  }
}

/** `kd_describe`: схема и примеры тула (или одного действия) по запросу. */
export const KD_DESCRIBE_DEF: ToolDefJson = {
  name: 'kd_describe',
  description: 'Схема полей и примеры тула kd (или одного его действия) — перед вызовом kd.',
  parameters: {
    type: 'object',
    properties: { tool: { type: 'string', description: 'имя тула' }, action: { type: 'string', description: 'действие; пусто — все' } },
    required: ['tool'],
    additionalProperties: false,
  },
}

export function describeFor(d: ToolDecl, action?: string): Record<string, unknown> {
  return {
    tool: d.name,
    description: d.description,
    actions: d.actions.map((a) => ({ name: a.name, ...(a.title ? { title: a.title } : {}), ...(a.default ? { default: true } : {}) })),
    params: inputSchema(d, action),
    examples: [...d.examples, ...d.actions.filter((a) => !action || a.name === action).flatMap((a) => a.examples ?? [])],
  }
}

/** Пункт палитры (⌘K чата и помощника): тул и его действия. */
export interface PaletteItem {
  id: string
  title: string
  hint: string
  tool: string
  action?: string
}

export function paletteItems(d: ToolDecl): PaletteItem[] {
  if (!d.actions.length) return [{ id: `kd.${d.name}`, title: d.name, hint: d.description, tool: d.name }]
  return d.actions.map((a) => ({ id: `kd.${d.name}.${a.name}`, title: `${d.name} ${a.name}`, hint: a.title ?? d.description, tool: d.name, action: a.name }))
}

/**
 * Форма одного действия (§2): из схемы объявления — только поля, которые относятся к действию (`$for`);
 * обязательные — из них же. Форма в чате, палитры и вопрос о недостающем рисуют её, а не всю схему.
 */
export function formFor(schema: FormSchema, action: string | undefined): FormSchema {
  const properties: FormSchema['properties'] = {}
  for (const [name, f] of Object.entries(schema.properties)) {
    const list = f['x-ui'].for
    if (!list || list.length === 0 || (action !== undefined && list.includes(action))) properties[name] = f
  }
  return { ...schema, properties, required: schema.required.filter((n) => n in properties) }
}
