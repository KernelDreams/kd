/**
 * Редактируемые входы prompt (API-формат) по схемам `/object_info`: только
 * виджеты — литеральные значения, не ссылки `[nodeId, out]` на другие ноды.
 * Из этого списка артефакт строит форму: текст промпта, seed, steps, модели…
 */

import type { InputSpec, NodeInfo, ObjectInfo, Prompt } from './types.js'

export type InputType = 'STRING' | 'INT' | 'FLOAT' | 'BOOLEAN' | 'COMBO' | 'IMAGE'

export interface EditableInput {
  nodeId: string
  /** `_meta.title` ноды, иначе `display_name` схемы, иначе класс. */
  nodeTitle: string
  classType: string
  name: string
  type: InputType
  value: unknown
  /** COMBO (и IMAGE — файлы `input/` сервера). */
  options?: unknown[]
  default?: unknown
  min?: number
  max?: number
  step?: number
  /** STRING в несколько строк (промпт). */
  multiline?: boolean
  /** INT с `control_after_generate` — сид (фронт ComfyUI рандомизирует). */
  seed?: boolean
  /** Вход объявлен схемой как необязательный. */
  optional?: boolean
  /** Схемы для входа нет (нода или вход незнакомы серверу) — тип выведен из значения. */
  inferred?: boolean
}

/** Ссылка на выход другой ноды: `["nodeId", 0]`. */
export const isLink = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number'

const PRIMITIVES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN'])

/** Спека схемы → тип и ограничения; не виджет (MODEL, CONDITIONING…) — null. */
export function widgetOf(spec: InputSpec | undefined, classType: string, name: string): Omit<EditableInput, 'nodeId' | 'nodeTitle' | 'classType' | 'name' | 'value'> | null {
  if (!Array.isArray(spec)) return null
  const [kind, raw] = spec
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (k: string): Record<string, number> => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? { [k]: o[k] } : {})
  const def = 'default' in o ? { default: o.default } : {}
  const imageUpload = o.image_upload === true || (classType === 'LoadImage' && name === 'image')
  if (Array.isArray(kind)) {
    return { type: imageUpload ? 'IMAGE' : 'COMBO', options: kind, ...def }
  }
  if (kind === 'COMBO') {
    const options = Array.isArray(o.options) ? o.options : undefined
    return { type: imageUpload ? 'IMAGE' : 'COMBO', ...(options ? { options } : {}), ...def }
  }
  if (typeof kind === 'string' && PRIMITIVES.has(kind)) {
    const type = kind as 'STRING' | 'INT' | 'FLOAT' | 'BOOLEAN'
    return {
      type,
      ...def,
      ...num('min'),
      ...num('max'),
      ...num('step'),
      ...(type === 'STRING' && o.multiline === true ? { multiline: true } : {}),
      ...(type === 'INT' && o.control_after_generate ? { seed: true } : {}),
    }
  }
  return null
}

/** Тип по значению — для входов без схемы. */
function inferType(v: unknown): InputType | null {
  if (typeof v === 'string') return 'STRING'
  if (typeof v === 'boolean') return 'BOOLEAN'
  if (typeof v === 'number') return Number.isInteger(v) ? 'INT' : 'FLOAT'
  return null
}

function specOf(info: NodeInfo | undefined, name: string): { spec: InputSpec | undefined; optional: boolean } {
  const req = info?.input?.required?.[name]
  if (req) return { spec: req, optional: false }
  const opt = info?.input?.optional?.[name]
  return { spec: opt, optional: !!opt }
}

/** Порядок входов ноды: `input_order` схемы, затем остальное как в prompt. */
function orderedNames(inputs: Record<string, unknown>, info: NodeInfo | undefined): string[] {
  const order = [...(info?.input_order?.required ?? Object.keys(info?.input?.required ?? {})), ...(info?.input_order?.optional ?? Object.keys(info?.input?.optional ?? {}))]
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of order) if (n in inputs && !seen.has(n)) (seen.add(n), out.push(n))
  for (const n of Object.keys(inputs)) if (!seen.has(n)) (seen.add(n), out.push(n))
  return out
}

/**
 * Виджет-входы prompt по порядку нод и входов. Вход схемы не-виджетного типа
 * (MODEL, IMAGE-ссылка…) с литералом пропускается; вход без схемы — тип по
 * значению (`inferred`). `LoadImage.image` (и всё с `image_upload`) — IMAGE.
 */
export function editableInputs(prompt: Prompt, info: ObjectInfo | null | undefined): EditableInput[] {
  const out: EditableInput[] = []
  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') continue
    const classType = node.class_type
    const schema = info?.[classType]
    const nodeTitle = String(node._meta?.title || schema?.display_name || classType)
    const inputs = node.inputs ?? {}
    for (const name of orderedNames(inputs, schema)) {
      const value = inputs[name]
      if (isLink(value) || value === undefined || value === null) continue
      const { spec, optional } = specOf(schema, name)
      const base = { nodeId, nodeTitle, classType, name, value }
      if (spec) {
        const w = widgetOf(spec, classType, name)
        if (w) out.push({ ...base, ...w, ...(optional ? { optional: true } : {}) })
        continue
      }
      const type = classType === 'LoadImage' && name === 'image' ? 'IMAGE' : inferType(value)
      if (type) out.push({ ...base, type, inferred: true })
    }
  }
  return out
}

/** Копия prompt с новыми значениями входов: `{nodeId, name, value}`. */
export function setInputs(prompt: Prompt, values: Array<Pick<EditableInput, 'nodeId' | 'name' | 'value'>>): Prompt {
  const next = structuredClone(prompt)
  for (const v of values) {
    const node = next[v.nodeId]
    if (!node) throw new Error(`setInputs: нет ноды ${v.nodeId}`)
    node.inputs = { ...node.inputs, [v.name]: v.value }
  }
  return next
}
