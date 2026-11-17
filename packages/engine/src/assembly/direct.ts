// DirectAssembler — hardcoded layout: system → history → post.
// Ported from chat2 assembly/DirectAssembler.ts; after it consumes the
// store model's `Message[]` (parts, flags) instead of nrd-core blocks/attrs.

import { readFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { IArray } from '@kerneldreams/nrd'
import type { StoreMessage, Part } from '../types.js'
import type { IContext, LLMMessage, IAssembler } from '../types.js'
import { cardField } from '../context/card.js'
import type { TaggedInjection } from '../context/types.js'
import { mapRole } from './roles.js'
import { macroVars, resolveMacros, type MacroDefaults, type MacroVars } from './macros.js'

/**
 * Точечный разворот `${attach("path")}` в теле сообщения (§attach).
 * Спец-случай, НЕ общий ${}-резолвер: только attach, только здесь. Содержимое
 * файла оборачивается в <attached>-рамку и инертно (парсинг сообщений уже прошёл).
 * baseDir — из context['__basedir'] (кладёт chat3), иначе cwd.
 * Битый путь → рамка с error-атрибутом, не тихий пропуск.
 */
const ATTACH_RE = /\$\{attach\(\s*(["'])(.*?)\1\s*\)\}/g
function resolveAttach(text: string, baseDir: string): string {
  if (!text.includes('${attach(')) return text
  return text.replace(ATTACH_RE, (_m, _q, rel: string) => {
    const p = isAbsolute(rel) ? rel : join(baseDir, rel)
    const name = basename(rel)
    try {
      const raw = readFileSync(p, 'utf-8')
      return `<attached file="${name}">\n${raw}\n</attached>`
    } catch (e) {
      process.stderr.write(`[attach] failed: ${rel} (${p}) — ${(e as Error).message}\n`)
      return `<attached file="${name}" error="not found" />`
    }
  })
}

/**
 * Message body for the API: concatenation of text-parts, macros + attach applied.
 * thinking/tool parts are NOT rendered by the direct assembler (spec §3.2) — a
 * template (ntpl) is the place for richer layout.
 */
function mapParts(parts: Part[], vars: MacroVars, baseDir: string): string {
  const out: string[] = []
  for (const p of parts) {
    if (p.type !== 'text') continue
    out.push(resolveAttach(resolveMacros(p.text, vars), baseDir))
  }
  return out.join('\n').trim()
}

/**
 * Инъекции из ContextPackage (кладёт packageContext в цепочку рендера).
 * Движок решает ЧТО включить, ассемблер — КУДА положить. `tags` — подсказка.
 */
function readInjections(context: IContext): TaggedInjection[] {
  const v = context.get(['injections'])
  const arr = v as IArray | undefined
  if (!arr || typeof arr.iterate !== 'function') return []
  const out: TaggedInjection[] = []
  for (const item of arr.iterate()) {
    const i = item as Partial<TaggedInjection>
    if (typeof i?.content === 'string' && i.content.trim()) {
      out.push({
        id: String(i.id ?? ''),
        content: i.content,
        tags: Array.isArray(i.tags) ? i.tags.map(String) : [],
        source: String(i.source ?? ''),
        score: Number(i.score ?? 0),
        tokens: Number(i.tokens ?? 0),
        ...(typeof i.depth === 'number' ? { depth: i.depth } : {}),
      })
    }
  }
  return out
}

/**
 * Simple, hardcoded prompt assembly (Spec §3.2):
 *   1. system  — card fields + injections + %system messages
 *   2. history — everything except %system, с at_depth-инъекциями
 *   3. post    — card post_history_instructions + injections с тегом `post`
 *
 * `$post` per-message (nrd-core) не переезжает: post-раскладка теперь = карточка
 * + post-инъекции. Раскладка инъекций по тегам — дефолт «прямого» ассемблера.
 */
export class DirectAssembler implements IAssembler {
  constructor(private defaults: MacroDefaults = {}) {}

  async render(messages: StoreMessage[], context: IContext): Promise<LLMMessage[]> {
    const baseDir = (typeof context.get(['__basedir']) === 'string' ? context.get(['__basedir']) : process.cwd()) as string
    const vars = macroVars(context, this.defaults)
    const out: LLMMessage[] = []
    const visible = messages.filter((m) => !m.flags?.hidden)

    // 0. Card fields from context (mdd card loaded via $card).
    const cardSystemRaw = cardField(context, 'system_prompt') || cardField(context, 'personality', 'scenario')
    const cardPostRaw = cardField(context, 'post_history_instructions')

    // 0a. Инъекции: post → в хвост, at_depth → в ленту, остальные → в system.
    const injections = readInjections(context)
    const postInj = injections.filter((i) => i.tags.includes('post'))
    const depthInj = injections.filter((i) => !i.tags.includes('post') && i.tags.includes('at_depth'))
    const systemInj = injections.filter((i) => !i.tags.includes('post') && !i.tags.includes('at_depth'))

    // 1. System — card fields + injections + %system messages ($frozen wins).
    const systems = visible.filter((m) => m.role === 'system')
    const frozen = systems.filter((m) => m.flags?.frozen)
    const systemSource = frozen.length ? frozen : systems
    const sessionSystem = systemSource
      .map((m) => resolveMacros(mapParts(m.parts, vars, baseDir), vars))
      .filter(Boolean)
      .join('\n\n')
      .trim()
    const injText = systemInj.map((i) => resolveMacros(i.content, vars).trim()).filter(Boolean).join('\n\n')
    const systemText = [cardSystemRaw, injText, sessionSystem].filter(Boolean).map((t) => resolveMacros(t, vars)).join('\n\n').trim()
    if (systemText) out.push({ role: 'system', content: systemText })

    // 2. History — everything that is not a %system message.
    const history: LLMMessage[] = []
    for (const m of visible) {
      if (m.role === 'system') continue
      const content = mapParts(m.parts, vars, baseDir)
      if (content) history.push({ role: mapRole(m.role), content })
    }
    // at_depth: $depth — сколько сообщений остаётся ПОСЛЕ инъекции (0 = в самый конец).
    for (const i of depthInj) {
      const at = Math.max(0, history.length - Math.max(0, i.depth ?? 0))
      history.splice(at, 0, { role: 'system', content: resolveMacros(i.content, vars).trim() })
    }
    out.push(...history)

    // 3. Post-history — card post_history + `post`-инъекции.
    const postInjText = postInj.map((i) => resolveMacros(i.content, vars).trim()).filter(Boolean).join('\n\n')
    const postText = [cardPostRaw ? resolveMacros(cardPostRaw, vars) : '', postInjText]
      .filter(Boolean)
      .join('\n\n')
      .trim()
    if (postText) out.push({ role: 'system', content: postText })

    return out
  }
}
