/**
 * Пустые слоты картинок (перенос из `appz/comfy/generate.ts`).
 *
 * LoadImage с пустым `image` удаляется каскадом: нода, у которой все
 * входы-ссылки вели в удалённое, удаляется тоже (Scale между лоадером и
 * энкодером). У остальных потребителей вход отрезается. С `objectInfo`
 * отрезается только необязательный вход; потребитель с обязательным входом
 * обходится насквозь (bypass): ссылки на его выход `[id, n]` переводятся на
 * его же вход того же типа — ControlNetApply без картинки пропускает
 * conditioning, IPAdapter без картинки — model. Обойти нельзя → `PruneError`.
 */

import { isLink } from './inputs.js'
import type { ObjectInfo, Prompt } from './types.js'

export class PruneError extends Error {
  /** Ноды, которые нельзя ни отрезать, ни обойти. */
  readonly nodes: string[]
  constructor(message: string, nodes: string[]) {
    super(message)
    this.name = 'PruneError'
    this.nodes = nodes
  }
}

const emptyImage = (v: unknown): boolean => v === undefined || v === null || String(v).trim() === ''

/** Тип входа по схеме; `undefined` — схемы нет (вход незнаком). */
function inputSpec(info: ObjectInfo | undefined, classType: string, name: string): { type: unknown; required: boolean } | undefined {
  const schema = info?.[classType]?.input
  const req = schema?.required?.[name]
  if (req) return { type: req[0], required: true }
  const opt = schema?.optional?.[name]
  if (opt) return { type: opt[0], required: false }
  return undefined
}

/**
 * Удаляет пустые LoadImage (и то, что держалось только на них), отрезает или
 * обходит потребителей. Меняет `workflow` на месте, возвращает id удалённых нод.
 * Без `objectInfo` — прежнее поведение: любой вход в удалённое просто отрезается.
 */
export function pruneEmptyLoaders(workflow: Prompt, objectInfo?: ObjectInfo | null): string[] {
  const info = objectInfo ?? undefined
  const dead = new Set<string>()
  for (const [id, node] of Object.entries(workflow)) {
    if (node.class_type === 'LoadImage' && emptyImage(node.inputs.image)) dead.add(id)
  }
  if (dead.size === 0) return []

  const linksOf = (id: string): Array<[string, [string, number]]> =>
    Object.entries(workflow[id]!.inputs).filter(([, v]) => isLink(v)).map(([k, v]) => [k, [String((v as unknown[])[0]), (v as number[])[1]!]])

  // Каскад: нода, все ссылки которой ведут в удалённое, удаляется.
  const cascade = (): boolean => {
    let any = false
    let changed = true
    while (changed) {
      changed = false
      for (const id of Object.keys(workflow)) {
        if (dead.has(id)) continue
        const links = linksOf(id)
        if (links.length > 0 && links.every(([, [src]]) => dead.has(src))) (dead.add(id), (changed = true), (any = true))
      }
    }
    return any
  }

  // Обход ноды: каждая ссылка на её выход n — на её вход того же типа.
  const bypass = (id: string): string | null => {
    const node = workflow[id]!
    const schema = info?.[node.class_type]
    const outputs = schema?.output ?? []
    const outNames = (schema?.output_name as string[] | undefined) ?? []
    const live = linksOf(id).filter(([, [src]]) => !dead.has(src))
    const typed = live.map(([k, link]) => ({ name: k, link, type: inputSpec(info, node.class_type, k)?.type }))
    const target = (n: number): [string, number] | null => {
      const type = outputs[n]
      if (type === undefined) return null
      const same = typed.filter((t) => t.type === type)
      if (same.length === 0) return null
      const byName = same.find((t) => t.name === outNames[n])
      if (byName) return byName.link
      // n-й выход своего типа ↔ n-й вход того же типа (positive/negative).
      const nth = outputs.slice(0, n).filter((t) => t === type).length
      return (same[nth] ?? same[0]!).link
    }
    const rewires: Array<[string, string, [string, number]]> = []
    for (const [otherId, other] of Object.entries(workflow)) {
      if (otherId === id || dead.has(otherId)) continue
      for (const [k, v] of Object.entries(other.inputs)) {
        if (!isLink(v) || String((v as unknown[])[0]) !== id) continue
        const t = target((v as number[])[1]!)
        if (!t) return `${node.class_type} ${id}: нет входа типа ${String(outputs[(v as number[])[1]!] ?? '?')} для обхода`
        rewires.push([otherId, k, t])
      }
    }
    for (const [otherId, k, t] of rewires) workflow[otherId]!.inputs[k] = [...t]
    dead.add(id)
    return null
  }

  let changed = true
  while (changed) {
    changed = false
    if (cascade()) changed = true
    for (const [id, node] of Object.entries(workflow)) {
      if (dead.has(id)) continue
      const deadInputs = linksOf(id).filter(([, [src]]) => dead.has(src))
      if (deadInputs.length === 0) continue
      const required = info ? deadInputs.filter(([k]) => inputSpec(info, node.class_type, k)?.required) : []
      if (required.length > 0) {
        const err = bypass(id)
        if (err) throw new PruneError(`нельзя обойти ${err} (обязателен вход ${required.map(([k]) => k).join(', ')})`, [id])
      } else {
        for (const [k] of deadInputs) delete node.inputs[k]
      }
      changed = true
    }
  }

  for (const id of dead) delete workflow[id]
  return [...dead]
}
