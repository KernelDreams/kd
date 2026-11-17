/**
 * Раскладка кубиков в сессии (bot-graph-spec «Сборщики и раскладка»): платформа играет раскладку напрямую.
 *
 * Раскладку выдаёт сборщик (вне ядра): упорядоченные куски с местом и «когда». Сессия получает её
 * снимком при старте — `extensions.nrchat.layout` карты бота. Второго сборщика контекста нет: куски ложатся на блоки
 * бота `nr` той же сборки (bot-assembly-spec §2–§3, §7, §11):
 *
 * | кусок                                 | куда в сборке                                                        |
 * |---------------------------------------|---------------------------------------------------------------------|
 * | `top` · на старте                      | справочник бота `nr` — наверху, стабильно (кэш префикса цел)          |
 * | `tail` · на старте / каждый ход        | форма бота `nr` — в хвосте после истории, каждый ход                  |
 * | любое место · каждый N-й ход           | заметка «этот бот» в хвосте, `every: N`                               |
 * | любое место · событие (ключи) на N ходов | запись лорбука `once` по ключам, `hold` — срок, потом уходит; повтор ключа продлевает срок; где ключ — `scan`: реплика игрока (по умолчанию) / пост модели / оба (`scan_by`) |
 * | `lore` · на старте                     | запись лорбука по ключам (подача книги по умолчанию)                  |
 * | `greeting`                             | гритинги бота `nr` (первое сообщение и свайпы)                        |
 * | `persona`, `examples`                  | персону выбирает игрок — в бота не идёт; примеры — `examples` бота    |
 *
 * Всё ходовое — после истории: префикс промпта между ходами не меняется.
 */

import type { Lorebook } from './lorebook.js'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface LayoutWhen {
  kind: 'start' | 'turn' | 'every' | 'event'
  every?: number
  event?: string
  turns?: number
  keys?: string[]
  /** Событие: где искать ключ — `player` (по умолчанию, не пишется) | `model` | `both`; словарь `$tail_scan` стола. */
  scan?: 'model' | 'both'
}

export interface LayoutPiece {
  id: string
  text: string
  place: string
  when: LayoutWhen
  title?: string
  /** След: глобальные id нод схемы. */
  from?: string[]
}

export interface Layout {
  builder?: string
  bot?: string
  greeting?: string
  pieces: LayoutPiece[]
}

function whenOf(v: unknown): LayoutWhen {
  if (!isRecord(v)) return { kind: 'start' }
  const kind = v.kind === 'turn' || v.kind === 'every' || v.kind === 'event' ? v.kind : 'start'
  const w: LayoutWhen = { kind }
  const every = Number(v.every)
  if (kind === 'every') w.every = Number.isFinite(every) && every >= 1 ? Math.floor(every) : 1
  if (kind === 'event') {
    if (typeof v.event === 'string' && v.event) w.event = v.event
    const turns = Number(v.turns)
    if (Number.isFinite(turns) && turns > 0) w.turns = Math.floor(turns)
    if (Array.isArray(v.keys)) w.keys = v.keys.filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim())
    if (v.scan !== undefined && v.scan !== 'player') {
      if (v.scan !== 'model' && v.scan !== 'both') throw new Error(`раскладка: где искать ключ события — ${String(v.scan)}; ждём player | model | both`)
      w.scan = v.scan
    }
  }
  return w
}

/** Раскладка из карты бота (`extensions.nrchat.layout`); нет — `undefined`. */
export function layoutOf(card: unknown): Layout | undefined {
  const d = isRecord(card) ? (isRecord(card.data) ? card.data : card) : undefined
  const ext = d && isRecord(d.extensions) && isRecord(d.extensions.nrchat) ? d.extensions.nrchat : undefined
  const raw = ext?.layout
  if (!isRecord(raw) || !Array.isArray(raw.pieces)) return undefined
  const pieces: LayoutPiece[] = raw.pieces
    .filter(isRecord)
    .filter((p) => typeof p.text === 'string' && p.text.trim() !== '')
    .map((p, i) => ({
      id: typeof p.id === 'string' ? p.id : `piece-${i + 1}`,
      text: String(p.text).trim(),
      place: typeof p.place === 'string' ? p.place : 'top',
      when: whenOf(p.when),
      ...(typeof p.title === 'string' && p.title ? { title: p.title } : {}),
      ...(Array.isArray(p.from) ? { from: p.from.filter((x): x is string => typeof x === 'string') } : {}),
    }))
  const out: Layout = { pieces }
  for (const k of ['builder', 'bot', 'greeting'] as const) if (typeof raw[k] === 'string') out[k] = raw[k] as string
  return out
}

/** Срок события ходами → `hold` записи лорбука сообщениями: ход срабатывания + (N − 1) следующих ходов игрока. */
export function holdMessages(turns: number | undefined): number {
  const n = turns && turns > 0 ? turns : 1
  return 2 * (n - 1)
}

export interface LayoutParts {
  reference: string
  form: string
  greetings: { id: string; text: string }[]
  examples: string[]
  /** Заметки «этот бот» (§11): `{text, slot: 'tail', every}`. */
  notes: { text: string; slot: 'tail'; every: number }[]
  /** Книга кусков по ключам и событиям; пусто — `undefined`. */
  book?: Lorebook
}

/** Разложить раскладку по блокам бота `nr`. */
export function layoutParts(l: Layout): LayoutParts {
  const top: string[] = []
  const tail: string[] = []
  const greetings: { id: string; text: string }[] = []
  const examples: string[] = []
  const notes: LayoutParts['notes'] = []
  const entries: Record<string, unknown>[] = []
  for (const p of l.pieces) {
    if (p.place === 'persona') continue
    if (p.place === 'greeting') {
      greetings.push({ id: p.id, text: p.text })
      continue
    }
    if (p.when.kind === 'event' || p.place === 'lore') {
      const keys = p.when.keys?.length ? p.when.keys : [p.title ?? p.id]
      // событие: `once` со сроком, повтор ключа продлевает срок (`renew`), где искать ключ — `scan_by`
      const nr: Record<string, unknown> =
        p.when.kind === 'event' ? { delivery: 'once', hold: holdMessages(p.when.turns), renew: true, ...(p.when.scan ? { scan_by: p.when.scan } : {}) } : {}
      entries.push({ keys, content: p.text, name: p.title ?? p.id, enabled: true, insertion_order: entries.length, extensions: { nr, layout: { piece: p.id, ...(p.from ? { from: p.from } : {}) } } })
      continue
    }
    if (p.when.kind === 'every') {
      notes.push({ text: p.text, slot: 'tail', every: p.when.every ?? 1 })
      continue
    }
    if (p.place === 'examples') examples.push(p.text)
    else if (p.place === 'tail') tail.push(p.text)
    else top.push(p.text)
  }
  const out: LayoutParts = { reference: top.join('\n\n'), form: tail.join('\n\n'), greetings, examples, notes }
  // книга кусков: подача — по записи (событие — `once` со сроком), окно — последнее сообщение
  if (entries.length) out.book = { name: `Раскладка${l.builder ? ` · ${l.builder}` : ''}`, entries, extensions: { nr: { scan: [1], delivery: 'once' } } }
  return out
}
