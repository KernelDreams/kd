/**
 * Плагин `template`: тело → рендер шаблонизатором.
 *
 * Результат — текст либо, при `nr.parse: chat`, распарсенные messages (рендер +
 * разбор чат-разметки → готовые сообщения для LLM). Имя `prompt` несёт `chat`
 * по словарю имён.
 *
 * Движок инъектируется хостом (`TemplateEnv`), а не импортируется здесь:
 * `nrd/template` тянет optional peer (nunjucks), а корень обязан оставаться
 * лёгким. Хост строит движок один раз — `nunjucksEngine()` из
 * `@kerneldreams/nrd/template` (он async с nrd-merge) — и передаёт сюда.
 *
 * Разбор чат-разметки — `@kerneldreams/nrd/chat` (канон формата `%role`).
 */

import { parse as parseChat } from '../chat/index.js'
import type { Decl } from './registry.js'
import { requireFs, type ProgramCapabilities } from './capability.js'
import { stripFence } from './blocks.js'

export type TemplateParse = 'text' | 'chat'

export const TEMPLATE_PARSE_MODES: readonly TemplateParse[] = ['text', 'chat']

/** Плагины-источники тела шаблона: инлайн-тело или внешний файл (`nr.src`). */
export const TEMPLATE_TYPES: readonly string[] = ['inline', 'file']

export interface RenderedMessage {
  role: string
  content: string
}

export function templateParse(v: string | undefined, who: string): TemplateParse {
  if (v === undefined) return 'text'
  const s = v.trim().toLowerCase()
  if ((TEMPLATE_PARSE_MODES as readonly string[]).includes(s)) return s as TemplateParse
  throw new Error(
    `nrd: неизвестный nr.parse "${v}" у template "${who}" — известные: ${TEMPLATE_PARSE_MODES.join(' | ')}`,
  )
}

/** Текст с чат-разметкой → сообщения (`%system` / `%user` / `%assistant`). */
export function chatMessages(text: string): RenderedMessage[] {
  return parseChat(text).map((m) => ({ role: m.role, content: m.body.trim() }))
}

/** Тело шаблона: инлайн или из файла по `nr.src`. */
export function templateBody(decl: Decl, caps: ProgramCapabilities): string {
  const type = decl.type ?? 'inline'
  if (!TEMPLATE_TYPES.includes(type)) {
    throw new Error(
      `nrd: неизвестный nr.type "${type}" у template "${decl.id}" — известные: ${TEMPLATE_TYPES.join(' | ')}`,
    )
  }
  if (type === 'file') {
    if (!decl.src) throw new Error(`nrd: template "${decl.id}" (nr.type: file) требует nr.src`)
    const text = requireFs(caps, `template "${decl.id}"`).read(decl.src)
    if (text === undefined) {
      throw new Error(`nrd: template "${decl.id}" — файл не найден: ${decl.src}`)
    }
    return stripFence(text.trim())
  }
  if (decl.body.trim() === '') throw new Error(`nrd: template "${decl.id}" пуст`)
  // Фенс вокруг тела — способ спрятать чат-разметку шаблона от сканера ленты.
  return stripFence(decl.body.trim())
}

/** Минимальное лицо шаблонизатора, которое нужно программному слою. */
export interface TemplateEnv {
  render(template: string, data: unknown): string
}

/** Рендер по декларации. `parse: chat` → messages, иначе текст. */
export function renderTemplate(
  decl: Decl,
  data: unknown,
  env: TemplateEnv,
  caps: ProgramCapabilities,
): string | RenderedMessage[] {
  const mode = templateParse(decl.parse, decl.id)
  const rendered = env.render(templateBody(decl, caps).trim(), data)
  return mode === 'chat' ? chatMessages(rendered) : rendered
}
