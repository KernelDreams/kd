/**
 * Сообщение ленты → DOM. Текст ассистента — markdown-минимум (экранирован до
 * разметки), пользователя — как есть; рассуждение — свёрткой; тул — карточкой
 * (аргументы, результат); вопрос — карточкой с кнопками или полем ответа.
 */

import { argsSummary, type Block, type FeedMessage } from './feed.js'
import type { Strings } from './i18n.js'
import { renderMarkdown } from './markdown.js'

export interface RenderCtx {
  t: Strings
  /** Раскрытые свёртки (`<id>:<i>`) — переживают перерисовку. */
  open: Set<string>
  answer(askId: string, value: string, label: string): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function pretty(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Свёртка, чьё состояние «открыто» помнится по ключу. */
function details(cls: string, key: string, ctx: RenderCtx): HTMLDetailsElement {
  const d = el('details', cls)
  d.open = ctx.open.has(key)
  d.addEventListener('toggle', () => (d.open ? ctx.open.add(key) : ctx.open.delete(key)))
  return d
}

function renderBlock(m: FeedMessage, b: Block, i: number, ctx: RenderCtx): HTMLElement {
  const t = ctx.t
  const key = `${m.id}:${i}`
  if (b.kind === 'text') {
    if (m.role === 'user') {
      const d = el('div', 'text nr-text')
      d.style.whiteSpace = 'pre-wrap'
      d.textContent = b.text
      return d
    }
    const d = el('div', 'text nr-text')
    d.innerHTML = renderMarkdown(b.text)
    return d
  }
  if (b.kind === 'thinking') {
    const d = details('thinking nr-thinking', key, ctx)
    d.append(el('summary', undefined, t.thinking), el('div', 'body', b.text))
    return d
  }
  if (b.kind === 'tool') {
    const d = details('card tool nr-tool', key, ctx)
    d.dataset.call = b.callId
    d.dataset.status = b.status
    const s = el('summary')
    if (b.page) s.append(el('span', 'badge', t.pageTool))
    s.append(el('span', 'name', b.title && b.title !== b.name ? b.title : b.name), el('span', 'arg', b.title && b.title !== b.name ? '' : argsSummary(b.args)))
    s.append(el('span', `status ${b.status}`, b.status === 'running' ? t.running : b.status === 'done' ? t.done : t.failed))
    d.append(s)
    const body = el('div', 'body')
    if (b.args !== undefined) body.append(el('pre', 'args', pretty(b.args)))
    if (b.result !== undefined && b.result !== '') body.append(el('pre', 'result', b.result))
    d.append(body)
    return d
  }
  // ask
  const card = el('div', 'card ask')
  card.dataset.ask = b.ask
  card.dataset.askId = b.askId
  card.append(el('div', 'q', b.question || t.approval))
  if (b.preview) {
    const body = el('div', 'body')
    body.append(el('pre', 'preview', b.preview))
    card.append(body)
  }
  if (b.answered !== undefined) {
    card.append(el('div', 'answered', `${t.answered}: ${b.answered}`))
    return card
  }
  const actions = el('div', 'actions')
  if (b.ask === 'text') {
    const input = el('textarea')
    input.rows = 1
    const go = el('button', 'primary', t.answer)
    const submit = (): void => {
      const v = input.value.trim()
      if (v) ctx.answer(b.askId, v, v)
    }
    go.addEventListener('click', submit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    })
    actions.append(input, go)
  } else {
    for (const o of b.options ?? []) {
      const opt = typeof o === 'string' ? { value: o, label: o, tone: '' } : o
      const btn = el('button', opt.tone || undefined, opt.label)
      btn.dataset.value = opt.value
      btn.addEventListener('click', () => ctx.answer(b.askId, opt.value, opt.label))
      actions.append(btn)
    }
  }
  card.append(actions)
  return card
}

export function renderMessage(m: FeedMessage, ctx: RenderCtx): HTMLElement {
  const d = el('div', `msg nr-message ${m.role}${m.live ? ' live' : ''}`)
  d.dataset.id = m.id
  d.dataset.role = m.role
  m.blocks.forEach((b, i) => d.append(renderBlock(m, b, i, ctx)))
  return d
}
