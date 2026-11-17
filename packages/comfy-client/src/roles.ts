/**
 * Роли входов шаблона — то, что генератор показывает пользователю:
 * рефы, маска, промпт, негатив, размер, seed, steps, denoise, чекпойнт. Сначала титулы нод
 * (`ref1..ref10`, `mask`, `Positive`, `Negative`, `Image`, `Sampler`, регистр не важен),
 * потом эвристика по графу от сэмплера. Вход-ссылка ролью не считается.
 */

import { isLink } from './inputs.js'
import type { ObjectInfo, Prompt, PromptNode } from './types.js'

export interface RoleRef {
  nodeId: string
  input: string
}

export interface RefSlot extends RoleRef {
  /** Номер слота: из титула `refN`, иначе порядковый с 1. */
  index: number
  /** Подпись: хвост титула после номера (`ref2 поза` → `поза`) или нестандартный титул. */
  label?: string
}

export interface Roles {
  refs: RefSlot[]
  prompt: RoleRef | null
  negative: RoleRef | null
  /** Нода с `width`/`height`; `input` — `width`. */
  size: RoleRef | null
  seed: RoleRef | null
  steps: RoleRef | null
  /** Только img2img: `latent_image` сэмплера ведёт к `VAEEncode`. */
  denoise: RoleRef | null
  /**
   * Маска инпейнта: `LoadImage`/`LoadImageMask` с титулом `mask` —
   * в рефы не входит; PNG того же размера, что `ref1`, белое = править.
   */
  mask: RoleRef | null
  /** Чекпойнт: `ckpt_name` загрузчика (титул `Checkpoint`, иначе первый `CheckpointLoaderSimple`). */
  ckpt: RoleRef | null
}

const SAMPLERS = new Set(['KSampler', 'KSamplerAdvanced'])
const TEXT_INPUTS = ['text', 'prompt']
const DEFAULT_LOADER_TITLES = new Set(['loadimage', 'load image'])

const titleOf = (n: PromptNode): string => String(n._meta?.title ?? '').trim()
const byTitle = (p: Prompt, t: string): string | undefined => Object.keys(p).find((id) => titleOf(p[id]!).toLowerCase() === t)
const literal = (n: PromptNode | undefined, input: string): boolean => !!n && input in n.inputs && !isLink(n.inputs[input]) && n.inputs[input] !== null
const linkSrc = (v: unknown): [string, number] | null => (isLink(v) ? [String((v as unknown[])[0]), (v as number[])[1]!] : null)

/** id в естественном порядке: числа по значению, затем строки. */
function idOrder(a: string, b: string): number {
  const na = Number(a), nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  if (Number.isFinite(na)) return -1
  if (Number.isFinite(nb)) return 1
  return a.localeCompare(b, undefined, { numeric: true })
}

/** Текстовый вход ноды: multiline STRING по схеме, без схемы — `text`/`prompt` строкой. */
function textInput(node: PromptNode | undefined, info: ObjectInfo | undefined, names = TEXT_INPUTS): string | null {
  if (!node) return null
  const schema = info?.[node.class_type]?.input
  for (const name of names) {
    if (!literal(node, name) || typeof node.inputs[name] !== 'string') continue
    const spec = schema?.required?.[name] ?? schema?.optional?.[name]
    if (!spec) return name
    if (spec[0] === 'STRING' && (spec[1] as Record<string, unknown> | undefined)?.multiline === true) return name
  }
  return null
}

/**
 * Назад по ссылке условия до ноды с текстом. На каждой ноде — вход того же
 * типа, что выход (по схеме; одноимённый выходу — первым), без схемы —
 * одноимённый роли, затем `conditioning`, затем первая ссылка.
 */
function walkToText(p: Prompt, info: ObjectInfo | undefined, start: unknown, role: string): string | null {
  let cur = linkSrc(start)
  const seen = new Set<string>()
  while (cur && !seen.has(cur[0])) {
    const [id, out] = cur
    seen.add(id)
    const node = p[id]
    if (!node) return null
    if (textInput(node, info)) return id
    const schema = info?.[node.class_type]
    const links = Object.entries(node.inputs).filter(([, v]) => isLink(v))
    let next: [string, unknown] | undefined
    const outType = schema?.output?.[out]
    if (outType !== undefined) {
      const inType = (k: string): unknown => (schema!.input.required?.[k] ?? schema!.input.optional?.[k])?.[0]
      const same = links.filter(([k]) => inType(k) === outType)
      const outName = (schema!.output_name as string[] | undefined)?.[out]
      next = same.find(([k]) => k === outName) ?? same.find(([k]) => k === role) ?? same[0]
    }
    next ??= links.find(([k]) => k === role) ?? links.find(([k]) => k === 'conditioning') ?? links[0]
    cur = next ? linkSrc(next[1]) : null
  }
  return null
}

/** Ведёт ли ссылка (через любые ноды) к ноде класса `cls`. */
function reaches(p: Prompt, start: unknown, cls: string): boolean {
  const queue = [linkSrc(start)?.[0]].filter((x): x is string => !!x)
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = p[id]
    if (!node) continue
    if (node.class_type === cls) return true
    for (const v of Object.values(node.inputs)) {
      const s = linkSrc(v)
      if (s) queue.push(s[0])
    }
  }
  return false
}

const isMaskLoader = (n: PromptNode): boolean => (n.class_type === 'LoadImage' || n.class_type === 'LoadImageMask') && titleOf(n).toLowerCase() === 'mask'

function refSlots(p: Prompt): RefSlot[] {
  const loaders = Object.keys(p).filter((id) => p[id]!.class_type === 'LoadImage' && !isLink(p[id]!.inputs.image) && !isMaskLoader(p[id]!)).sort(idOrder)
  const titled: RefSlot[] = []
  for (const id of loaders) {
    const m = /^ref(\d{1,2})(?:\s+(.*))?$/i.exec(titleOf(p[id]!))
    if (!m) continue
    const index = Number(m[1])
    if (index < 1 || index > 10) continue
    const label = m[2]?.trim()
    titled.push({ nodeId: id, input: 'image', index, ...(label ? { label } : {}) })
  }
  if (titled.length > 0) return titled.sort((a, b) => a.index - b.index)
  return loaders.map((id, i) => {
    const t = titleOf(p[id]!)
    return { nodeId: id, input: 'image', index: i + 1, ...(t && !DEFAULT_LOADER_TITLES.has(t.toLowerCase()) ? { label: t } : {}) }
  })
}

export function roles(prompt: Prompt, objectInfo?: ObjectInfo | null): Roles {
  const p = prompt ?? {}
  const info = objectInfo ?? undefined
  const role = (nodeId: string | undefined | null, input: string | null | undefined): RoleRef | null =>
    nodeId && input && literal(p[nodeId], input) ? { nodeId, input } : null

  const samplerId = byTitle(p, 'sampler') ?? Object.keys(p).sort(idOrder).find((id) => SAMPLERS.has(p[id]!.class_type))
  const sampler = samplerId ? p[samplerId] : undefined

  // Промпт: титул Positive, иначе от positive сэмплера назад.
  const posTitled = byTitle(p, 'positive')
  const posId = posTitled ?? walkToText(p, info, sampler?.inputs.positive, 'positive')
  const prompt_ = role(posId, textInput(p[posId ?? ''], info))

  // Негатив: титул Negative; иначе от negative сэмплера назад; та же нода, что промпт, — `negative_prompt`.
  let negative: RoleRef | null = null
  const negTitled = byTitle(p, 'negative')
  if (negTitled) negative = role(negTitled, textInput(p[negTitled], info))
  else {
    const negId = walkToText(p, info, sampler?.inputs.negative, 'negative')
    if (negId && negId !== prompt_?.nodeId) negative = role(negId, textInput(p[negId], info))
    else if (prompt_) negative = role(prompt_.nodeId, textInput(p[prompt_.nodeId], info, ['negative_prompt']))
  }

  // Размер: титул Image, иначе источник latent_image сэмплера.
  const sizeId = byTitle(p, 'image') ?? linkSrc(sampler?.inputs.latent_image)?.[0]
  const size = sizeId && literal(p[sizeId], 'width') && literal(p[sizeId], 'height') ? { nodeId: sizeId, input: 'width' } : null

  const seed = role(samplerId, sampler && literal(sampler, 'noise_seed') ? 'noise_seed' : 'seed')
  const steps = role(samplerId, 'steps')
  const denoise = sampler && reaches(p, sampler.inputs.latent_image, 'VAEEncode') ? role(samplerId, 'denoise') : null

  const maskId = Object.keys(p).sort(idOrder).find((id) => isMaskLoader(p[id]!))
  const mask = role(maskId, 'image')
  const ckptId = byTitle(p, 'checkpoint') ?? Object.keys(p).sort(idOrder).find((id) => p[id]!.class_type === 'CheckpointLoaderSimple')
  const ckpt = role(ckptId, 'ckpt_name')

  return { refs: refSlots(p), prompt: prompt_, negative, size, seed, steps, denoise, mask, ckpt }
}
