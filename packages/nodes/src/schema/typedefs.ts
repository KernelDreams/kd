// Типы пинов, полей и сообщений — проекция схемы форм (JSON Schema `## $form`, `*.editor.mdz`), не вторая
// система типов (node-canvas-spec §3).

import type { JSONSchema } from '@kerneldreams/forms/editor'
import type { FieldDefinition, TypeDefinition } from './types.js'

const CONSTRAINTS = ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'format'] as const

function typeName(s: JSONSchema | undefined): string {
  if (!s) return 'any'
  if (s.$ref) return String(s.$ref).replace(/^#\/(\$defs|definitions)\//, '')
  if (s.enum) return 'enum'
  const t = Array.isArray(s.type) ? s.type.join('|') : s.type
  if (t === 'array') return typeName(s.items) + '[]'
  return t ?? (s.anyOf || s.oneOf ? 'union' : 'any')
}

/** Схема объекта / перечисления / union → определение типа. */
export function typeFromJsonSchema(id: string, s: JSONSchema): TypeDefinition {
  if (s.enum) return { id, kind: 'enum', title: s.title, values: s.enum as unknown[] }
  const alts = (s.anyOf ?? s.oneOf) as JSONSchema[] | undefined
  if (alts) return { id, kind: 'union', title: s.title, of: alts.map(typeName) }
  if (s.type === 'object' || s.properties) {
    const req = new Set((s.required as string[] | undefined) ?? [])
    const fields: FieldDefinition[] = Object.entries((s.properties ?? {}) as Record<string, JSONSchema>).map(([name, p]) => {
      const constraints: Record<string, unknown> = {}
      for (const c of CONSTRAINTS) if (p[c] !== undefined) constraints[c] = p[c]
      if (p.enum) constraints.enum = p.enum
      return {
        name,
        type: typeName(p),
        ...(req.has(name) ? { required: true } : {}),
        ...(p.description ? { description: p.description as string } : {}),
        ...(Object.keys(constraints).length ? { constraints } : {}),
      }
    })
    return { id, kind: 'object', title: s.title, fields }
  }
  return { id, kind: 'scalar', title: s.title, of: [typeName(s)] }
}

/** Обратно: определение → JSON Schema (запись типов в форму). */
export function typeToJsonSchema(t: TypeDefinition): JSONSchema {
  if (t.kind === 'enum') return { title: t.title, enum: t.values }
  if (t.kind === 'union') return { title: t.title, anyOf: (t.of ?? []).map((x) => ({ type: x })) }
  if (t.kind === 'scalar') return { title: t.title, type: t.of?.[0] }
  const properties: Record<string, JSONSchema> = {}
  for (const f of t.fields ?? []) {
    const arr = f.type.endsWith('[]')
    const base = arr ? f.type.slice(0, -2) : f.type
    const one: JSONSchema = { type: base, ...(f.description ? { description: f.description } : {}), ...(f.constraints ?? {}) }
    properties[f.name] = arr ? { type: 'array', items: one } : one
  }
  const required = (t.fields ?? []).filter((f) => f.required).map((f) => f.name)
  return { title: t.title, type: 'object', properties, ...(required.length ? { required } : {}) }
}
