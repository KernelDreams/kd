/**
 * Схема ComfyUI → граф полотна (часть Б): только чтение, без запуска (запуск — `ComfyQueue` этого пакета).
 * Понимает оба формата: UI-граф (`nodes` / `links` / `groups`, позиции и размеры нод из фронта ComfyUI) и API-формат
 * (`{id: {class_type, inputs}}` — позиций нет, раскладка слоями по потоку данных).
 *
 * Нода: заголовок, входы и выходы с типами (пины), значения виджетов строками. Провод — поток данных выход → вход.
 * Граф UI нетипизирован — JSON фронта, отсюда `any`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { detect } from './ui2api.js'

export interface ComfyPin {
  name: string
  type: string
  /** Вход подключён проводом. */
  linked?: boolean
}

export interface ComfyNode {
  id: string
  type: string
  title: string
  x: number
  y: number
  w: number
  h: number
  color?: string
  inputs: ComfyPin[]
  outputs: ComfyPin[]
  /** Значения виджетов строками: имя известно — `name`, иначе только значение. */
  widgets: { name?: string; value: string }[]
  /** Нода только фронта (заметка, reroute, примитив) или выключенная (`mode` 2 / 4). */
  muted?: boolean
}

export interface ComfyLink {
  id: string
  from: { node: string; slot: number }
  to: { node: string; slot: number }
  type: string
}

export interface ComfyGroup {
  title: string
  x: number
  y: number
  w: number
  h: number
  color?: string
}

export interface ComfyGraph {
  format: 'ui' | 'api'
  nodes: ComfyNode[]
  links: ComfyLink[]
  groups: ComfyGroup[]
}

const str = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.length > 160 ? v.slice(0, 160) + '…' : v
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 120)
  return String(v)
}

const MUTED_TYPES = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'])

/** UI-граф: позиции, размеры, цвета и группы — как во фронте ComfyUI. */
function fromUi(wf: any): ComfyGraph {
  const nodes: ComfyNode[] = []
  for (const n of wf.nodes ?? []) {
    const pos = Array.isArray(n.pos) ? n.pos : [n.pos?.[0] ?? 0, n.pos?.[1] ?? 0]
    const size = Array.isArray(n.size) ? n.size : [n.size?.[0] ?? 240, n.size?.[1] ?? 80]
    const inputs: ComfyPin[] = (n.inputs ?? []).map((i: any) => ({ name: String(i.label ?? i.name ?? ''), type: String(i.type ?? '*'), ...(i.link !== null && i.link !== undefined ? { linked: true } : {}) }))
    const outputs: ComfyPin[] = (n.outputs ?? []).map((o: any) => ({ name: String(o.label ?? o.name ?? o.type ?? ''), type: String(o.type ?? '*') }))
    // имена виджетов: входы с `widget` (новый фронт перечисляет все виджеты) — по порядку значений
    const wNames: string[] = (n.inputs ?? []).filter((i: any) => i.widget).map((i: any) => String(i.widget.name ?? i.name))
    const values: unknown[] = Array.isArray(n.widgets_values) ? n.widgets_values : n.widgets_values && typeof n.widgets_values === 'object' ? Object.values(n.widgets_values) : []
    const widgets: ComfyNode['widgets'] = []
    let k = 0
    for (const v of values) {
      // второе значение сида (control_after_generate) — служебное, не показываем отдельной строкой
      if (typeof v === 'string' && ['fixed', 'increment', 'decrement', 'randomize'].includes(v) && widgets.length && /^\d+$/.test(widgets[widgets.length - 1]!.value)) continue
      const name = wNames[k++]
      widgets.push({ ...(name ? { name } : {}), value: str(v) })
    }
    const node: ComfyNode = { id: String(n.id), type: String(n.type ?? ''), title: String(n.title ?? n.type ?? n.id), x: Number(pos[0]) || 0, y: Number(pos[1]) || 0, w: Number(size[0]) || 240, h: Number(size[1]) || 80, inputs, outputs, widgets }
    if (n.color) node.color = String(n.color)
    if (MUTED_TYPES.has(node.type) || n.mode === 2 || n.mode === 4) node.muted = true
    nodes.push(node)
  }
  const links: ComfyLink[] = []
  for (const l of wf.links ?? []) {
    // [id, fromNode, fromSlot, toNode, toSlot, type] или объект нового фронта
    const a = Array.isArray(l) ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] } : l
    if (a?.origin_id === undefined || a.target_id === undefined) continue
    links.push({ id: String(a.id), from: { node: String(a.origin_id), slot: Number(a.origin_slot) || 0 }, to: { node: String(a.target_id), slot: Number(a.target_slot) || 0 }, type: String(a.type ?? '*') })
  }
  const groups: ComfyGroup[] = (wf.groups ?? []).map((g: any) => {
    const b = g.bounding ?? [0, 0, 300, 200]
    return { title: String(g.title ?? ''), x: Number(b[0]) || 0, y: Number(b[1]) || 0, w: Number(b[2]) || 300, h: Number(b[3]) || 200, ...(g.color ? { color: String(g.color) } : {}) }
  })
  return { format: 'ui', nodes, links, groups }
}

/** API-формат: входы-ссылки `[id, slot]` — провода, остальное — виджеты; раскладка слоями по глубине потока. */
function fromApi(prompt: Record<string, any>): ComfyGraph {
  const ids = Object.keys(prompt)
  const outSlots = new Map<string, Map<number, string>>()
  const links: ComfyLink[] = []
  for (const id of ids) {
    for (const [name, v] of Object.entries(prompt[id].inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number' && String(v[0]) in prompt) {
        const from = String(v[0])
        const slots = outSlots.get(from) ?? new Map<number, string>()
        if (!slots.has(v[1])) slots.set(v[1], name.toUpperCase())
        outSlots.set(from, slots)
        links.push({ id: `${from}:${v[1]}->${id}:${name}`, from: { node: from, slot: v[1] }, to: { node: id, slot: -1 }, type: name.toUpperCase() })
      }
    }
  }
  // глубина: самый длинный путь от источника
  const depth = new Map<string, number>()
  const dep = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const ins = links.filter((l) => l.to.node === id)
    const d = ins.length ? Math.max(...ins.map((l) => dep(l.from.node, seen) + 1)) : 0
    depth.set(id, d)
    return d
  }
  for (const id of ids) dep(id)
  const rowOf = new Map<number, number>()
  const nodes: ComfyNode[] = ids.map((id) => {
    const n = prompt[id]
    const inputs: ComfyPin[] = []
    const widgets: ComfyNode['widgets'] = []
    for (const [name, v] of Object.entries(n.inputs ?? {})) {
      const isLink = Array.isArray(v) && v.length === 2 && typeof v[1] === 'number' && String(v[0]) in prompt
      if (isLink) inputs.push({ name, type: name.toUpperCase(), linked: true })
      else widgets.push({ name, value: str(v) })
    }
    const slots = outSlots.get(id) ?? new Map<number, string>()
    const max = slots.size ? Math.max(...slots.keys()) : -1
    const outputs: ComfyPin[] = Array.from({ length: max + 1 }, (_, i) => ({ name: slots.get(i) ?? `#${i}`, type: slots.get(i) ?? '*' }))
    const d = depth.get(id) ?? 0
    const row = rowOf.get(d) ?? 0
    const h = 60 + 22 * (inputs.length + Math.max(outputs.length, 0)) + 22 * widgets.length
    rowOf.set(d, row + h + 40)
    return { id, type: String(n.class_type), title: String(n._meta?.title ?? n.class_type), x: d * 360, y: row, w: 300, h, inputs, outputs, widgets }
  })
  // слот входа в проводе API — по порядку входов-ссылок ноды
  for (const l of links) {
    const to = nodes.find((n) => n.id === l.to.node)!
    const name = l.id.split(':').pop()!
    l.to.slot = to.inputs.findIndex((i) => i.name === name)
    const from = nodes.find((n) => n.id === l.from.node)
    if (from?.outputs[l.from.slot]) l.type = from.outputs[l.from.slot]!.type
  }
  return { format: 'api', nodes, links, groups: [] }
}

/** JSON файла ComfyUI (UI-граф, API, или PNG-обёртка `{prompt, workflow}`) → граф полотна. UI-граф главнее API. */
export function comfyGraph(json: unknown): ComfyGraph {
  const { prompt, workflow } = detect(json)
  if (workflow) return fromUi(workflow)
  return fromApi(prompt as Record<string, any>)
}
