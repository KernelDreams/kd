/**
 * UI-граф ComfyUI (nodes/links, подграфы) → API-формат prompt по схемам
 * `/object_info` (перенос из `envs/comfy/lib/ui2api.js`, там же —
 * обратная запись правок в UI-граф, это дело редактора). Граф UI нетипизирован —
 * JSON фронта, отсюда `any`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ObjectInfo, Prompt, UiWorkflow } from './types.js'

export interface WidgetSlot {
  name: string
  kind: string
  spec: any
}

/** Где значение входа `<apiId>.<input>` живёт в UI-графе. */
export interface Bind {
  sg: string | null
  node: unknown
  index?: number
  key?: string
}

/** Второе значение виджета-сида в widgets_values (control_after_generate). */
export const CONTROL = new Set(['fixed', 'increment', 'decrement', 'randomize'])

/** Ноды только фронта ComfyUI: в prompt не идут. */
const VIRTUAL = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote', 'SetNode', 'GetNode'])

const PRIMITIVE = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])
const DYNAMIC_COMBO = 'COMFY_DYNAMICCOMBO_V3'

/** Вход подграфа (-10) и выход (-20) — псевдоноды связей внутри определения. */
const SUBGRAPH_IN = -10

export const isApiPrompt = (j: any): j is Prompt =>
  !!j && typeof j === 'object' && !Array.isArray(j) && Object.keys(j).length > 0 && Object.values(j).every((n: any) => n && typeof n === 'object' && typeof n.class_type === 'string')

export const isUiWorkflow = (j: any): j is UiWorkflow => !!j && typeof j === 'object' && Array.isArray(j.nodes)

/** JSON файла → {prompt?, workflow?}. Незнакомое — throw. */
export function detect(json: any): { prompt?: Prompt; workflow?: UiWorkflow } {
  if (isApiPrompt(json)) return { prompt: json }
  if (json && isApiPrompt(json.prompt)) return { prompt: json.prompt, ...(isUiWorkflow(json.workflow) ? { workflow: json.workflow } : {}) }
  if (isUiWorkflow(json)) return { workflow: json }
  if (json && isUiWorkflow(json.workflow)) return { workflow: json.workflow }
  throw new Error('это не воркфлоу ComfyUI: нет ни API-формата ({id: {class_type, inputs}}), ни UI-графа (nodes/links)')
}

/** Классы нод UI-графа (с подграфами), которые нужны серверу — для objectInfo(classes). */
export function classesOf(workflow: any): string[] {
  const subs = workflow.definitions?.subgraphs ?? []
  const ids = new Set(subs.map((s: any) => s.id))
  const all = [workflow, ...subs].flatMap((g: any) => (g.nodes ?? []).map((n: any) => n.type))
  return [...new Set(all.filter((t: any) => typeof t === 'string' && !VIRTUAL.has(t) && !ids.has(t)))]
}

function isWidgetSpec(spec: any): boolean {
  if (!Array.isArray(spec)) return false
  const [kind, o] = spec
  if (o && typeof o === 'object' && o.forceInput) return false
  return Array.isArray(kind) || PRIMITIVE.has(kind) || kind === DYNAMIC_COMBO
}

/** Виджеты схемы (или `inputs` опции динамического комбо) в порядке фронта: [{name, kind, spec}]. */
export function widgetSlots(info: any): WidgetSlot[] {
  const req = info?.input?.required ?? {}
  const opt = info?.input?.optional ?? {}
  const order = [...(info?.input_order?.required ?? Object.keys(req)), ...(info?.input_order?.optional ?? Object.keys(opt))]
  const out: WidgetSlot[] = []
  for (const name of order) {
    const spec = req[name] ?? opt[name]
    if (isWidgetSpec(spec)) out.push({ name, kind: Array.isArray(spec[0]) ? 'COMBO' : spec[0], spec })
  }
  return out
}

const optionsOf = (slot: any): unknown[] | null => {
  const s = slot?.spec
  if (!s) return null
  if (Array.isArray(s[0])) return s[0]
  const o = s[1]?.options
  return Array.isArray(o) ? o.map((x: any) => (x && typeof x === 'object' ? x.key : x)) : null
}

/**
 * Имя виджета → индекс в widgets_values. Фронт вставляет лишние значения —
 * `control_after_generate` после сида (fixed/randomize…) и кнопку `upload` ("image")
 * после картинки: пропускаем по значению и только если значений больше, чем
 * осталось виджетов. Динамическое комбо (V3) раскрывает вложенные виджеты
 * выбранной опции сразу за собой: `format` → `format.bit_depth`…
 */
export function mapWidgets(slots: WidgetSlot[], values: unknown[]): Map<string, number> {
  const map = new Map<string, number>()
  const queue = [...slots]
  let i = 0
  while (queue.length > 0 && i < values.length) {
    const slot = queue.shift()!
    map.set(slot.name, i)
    const value = values[i++]
    if (slot.kind === DYNAMIC_COMBO) {
      const opt = (slot.spec?.[1]?.options ?? []).find((o: any) => o && o.key === value)
      if (opt) queue.unshift(...widgetSlots({ input: opt.inputs }).map((s) => ({ ...s, name: `${slot.name}.${s.name}` })))
    }
    const next = values[i]
    if (typeof next !== 'string' || values.length - i <= queue.length) continue
    if ((optionsOf(queue[0]) ?? []).includes(next)) continue
    const control = (slot.kind === 'INT' || slot.spec?.[1]?.control_after_generate) && CONTROL.has(next)
    const upload = slot.spec?.[1]?.image_upload && next === 'image'
    if (control || upload) i++
  }
  return map
}

function linkTable(graph: any): Map<unknown, { from: unknown; slot: number; type: unknown }> {
  const map = new Map<unknown, { from: unknown; slot: number; type: unknown }>()
  for (const l of graph.links ?? []) {
    if (Array.isArray(l)) map.set(l[0], { from: l[1], slot: l[2], type: l[5] })
    else if (l && typeof l === 'object') map.set(l.id, { from: l.origin_id, slot: l.origin_slot, type: l.type })
  }
  return map
}

/** Узел вообще подключён (ноды UI без схемы и без связей — надписи, панели — пропускаем). */
const connected = (node: any): boolean => (node.inputs ?? []).some((i: any) => i.link != null) || (node.outputs ?? []).some((o: any) => (o.links ?? []).length > 0)

const unknownNode = (node: any): Error => new Error(`нода «${node.title || node.type}» (${node.type}) неизвестна серверу ComfyUI — не установлен custom node?`)

/**
 * UI-граф → {prompt, bind}. Подграфы раскрываются: ноды внутри инстанса `459` —
 * `459:451` (как у фронта ComfyUI). `bind["<apiId>.<input>"]` — где значение входа
 * живёт в UI-графе: `{sg, node, index}` (`sg` — id определения подграфа или null)
 * или `{sg, node, key}` для dict-виджетов. По нему {@link syncWorkflow} пишет правки
 * назад — в виджет ноды, в PrimitiveNode или в виджет-вход инстанса подграфа.
 */
export function uiToApi(workflow: any, info: ObjectInfo): { prompt: Prompt; bind: Record<string, Bind> } {
  const defs = new Map<unknown, any>((workflow.definitions?.subgraphs ?? []).map((s: any) => [s.id, s]))
  const prompt: Prompt = {}
  const bind: Record<string, Bind> = {}

  const scopeOf = (graph: any, prefix: string, sgId: any, instance: any, parent: any): any => ({
    nodes: graph.nodes ?? [],
    byId: new Map((graph.nodes ?? []).map((n: any) => [String(n.id), n])),
    links: linkTable(graph),
    prefix,
    sgId,
    sg: sgId ? graph : null,
    instance,
    parent,
    widgetIndex: instance ? instanceWidgets(graph, instance) : null,
  })

  const inner = (inst: any, scope: any, depth: number): any => {
    if (depth > 16) throw new Error('подграфы вложены слишком глубоко (цикл?)')
    const sg = defs.get(inst.type)
    return scopeOf(sg, `${scope.prefix}${inst.id}:`, sg.id, inst, scope)
  }

  const resolve = (scope: any, linkId: unknown, depth = 0): any => {
    if (depth > 256) throw new Error('цикл связей в графе')
    const l = scope.links.get(linkId)
    if (!l) return null
    const follow = (s: any, id: unknown): any => (id == null ? null : resolve(s, id, depth + 1))
    if (l.from === SUBGRAPH_IN && scope.instance) {
      const sgInput = scope.sg.inputs?.[l.slot]
      if (!sgInput) return null
      const outer = (scope.instance.inputs ?? []).find((i: any) => i.name === sgInput.name)
      if (outer?.link != null) return follow(scope.parent, outer.link)
      const index = scope.widgetIndex.get(sgInput.name)
      if (index === undefined) return null
      return { value: scope.instance.widgets_values[index], bind: { sg: scope.parent.sgId, node: scope.instance.id, index } }
    }
    const src = scope.byId.get(String(l.from))
    if (!src || src.mode === 2) return null
    if (src.type === 'Reroute' || src.type === 'SetNode') return follow(scope, src.inputs?.[0]?.link)
    if (src.type === 'PrimitiveNode') return { value: src.widgets_values?.[0], bind: { sg: scope.sgId, node: src.id, index: 0 } }
    if (src.type === 'GetNode') {
      const set = scope.nodes.find((n: any) => n.type === 'SetNode' && n.widgets_values?.[0] === src.widgets_values?.[0])
      return set ? follow(scope, set.inputs?.[0]?.link) : null
    }
    if (src.mode === 4) {
      // bypass: выход берёт вход того же типа (сначала тот же индекс).
      const type = src.outputs?.[l.slot]?.type ?? l.type
      const same = src.inputs?.[l.slot]
      const pick = same && same.type === type && same.link != null ? same : (src.inputs ?? []).find((i: any) => i.type === type && i.link != null)
      return pick ? follow(scope, pick.link) : null
    }
    if (defs.has(src.type)) {
      const s = inner(src, scope, depth)
      const out = s.sg.outputs?.[l.slot]
      return follow(s, out?.linkIds?.[0])
    }
    if (!info[src.type]) throw unknownNode(src)
    return { link: [`${scope.prefix}${src.id}`, l.slot] }
  }

  const emit = (scope: any, depth = 0): void => {
    for (const node of scope.nodes) {
      if (node.mode === 2 || node.mode === 4 || VIRTUAL.has(node.type)) continue
      if (defs.has(node.type)) {
        emit(inner(node, scope, depth), depth + 1)
        continue
      }
      const schema = info[node.type]
      if (!schema) {
        if (!connected(node)) continue
        throw unknownNode(node)
      }
      const id = `${scope.prefix}${node.id}`
      const inputs: Record<string, unknown> = {}
      const values = node.widgets_values
      const slots = widgetSlots(schema)
      if (Array.isArray(values)) {
        for (const [name, index] of mapWidgets(slots, values)) {
          inputs[name] = values[index]
          bind[`${id}.${name}`] = { sg: scope.sgId, node: node.id, index }
        }
      } else if (values && typeof values === 'object') {
        for (const { name } of slots) {
          if (!(name in values)) continue
          inputs[name] = values[name]
          bind[`${id}.${name}`] = { sg: scope.sgId, node: node.id, key: name }
        }
      }
      for (const input of node.inputs ?? []) {
        if (input.link == null) continue
        const name = input.widget?.name ?? input.name
        const r = resolve(scope, input.link)
        if (!r) continue
        if (r.link) {
          inputs[name] = r.link
          delete bind[`${id}.${name}`]
        } else {
          inputs[name] = r.value
          bind[`${id}.${name}`] = r.bind
        }
      }
      // Socketless-входы (ImageCompare.compare_view…) фронт заполняет своим состоянием;
      // сервер требует их наличия — пустой объект валидацию проходит.
      for (const [name, spec] of Object.entries(schema.input?.required ?? {}) as Array<[string, any]>) {
        if (!(name in inputs) && spec?.[1]?.socketless && !isWidgetSpec(spec)) inputs[name] = {}
      }
      prompt[id] = { class_type: node.type, inputs, ...(node.title ? { _meta: { title: node.title } } : {}) }
    }
  }

  emit(scopeOf(workflow, '', null, null, null))
  if (Object.keys(prompt).length === 0) throw new Error('в графе нет исполняемых нод')
  return { prompt, bind }
}

/** Виджет-входы инстанса подграфа: по значению на каждый вход определения виджетного типа, по порядку. */
function instanceWidgets(sg: any, instance: any): Map<string, number> {
  const values = Array.isArray(instance.widgets_values) ? instance.widgets_values : []
  const slots = (sg.inputs ?? []).filter((i: any) => PRIMITIVE.has(i.type)).map((i: any) => ({ name: i.name, kind: i.type, spec: [i.type, {}] }))
  return mapWidgets(slots, values)
}

