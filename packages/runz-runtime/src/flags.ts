/**
 * Справка и известные флаги скрипта — один механизм рантайма на все скрипты.
 *
 * `--help` / `-h` у любого скрипта печатают его шапку и ничего не исполняют: `.ts` — первый
 * док-комментарий (или `export const usage`), документ — `$description` / первый абзац; к ним —
 * объявленные флаги. Скрипт объявляет флаги сам: `.ts` — `export const flags = ['dry', …]` или
 * `{ dry: 'что войдёт', … }`, документ — `$flags` (список или объект). Объявил — неизвестный флаг
 * командной строки отказ до запуска (опечатка `runz release --dyr` больше не катит prod).
 * Не объявил — флаги не проверяются, как раньше. `help` в своих флагах — скрипт отвечает на
 * `--help` сам, рантайм не вмешивается.
 *
 * Проверяются только аргументы командной строки: ключи конфигов и документа — не флаги.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { asText, isArray, isContext } from '@kerneldreams/nrd'
import type { Value } from '@kerneldreams/nrd'

/** Флаг → описание (пустое — без описания). */
export type FlagSpec = Map<string, string>

/** Ключи командной строки, которые читает сам рантайм, а не скрипт. */
export const RUNTIME_ARGS: readonly string[] = ['_', 'paths', 'type', 'as', 'dataDir']

/** Разбор объявления флагов: массив имён, объект «имя → описание» или IContext документа. */
export function parseFlags(raw: unknown): FlagSpec | null {
  if (raw === undefined || raw === null) return null
  const out: FlagSpec = new Map()
  const name = (s: string): string => s.trim().replace(/^--?/, '')
  if (typeof raw === 'string') {
    for (const s of raw.split(/[,\s]+/)) if (s.trim()) out.set(name(s), '')
    return out
  }
  if (Array.isArray(raw)) {
    for (const x of raw) if (typeof x === 'string' && x.trim()) out.set(name(x), '')
    return out
  }
  if (isArray(raw as Value)) {
    for (const x of (raw as { iterate(): Iterable<Value> }).iterate()) {
      const s = asText(x)
      if (s) out.set(name(s), '')
    }
    return out
  }
  if (isContext(raw as Value)) {
    // объект документа: имена — ключи; у IContext перечисления нет — только если реализация его даёт
    const ctx = raw as { keys?: () => Iterable<string>; get(p: string[]): Value | undefined }
    if (typeof ctx.keys !== 'function') throw new Error('$flags: объект без перечисления ключей — задай списком $[dry, force]')
    for (const k of ctx.keys()) out.set(name(k), asText(ctx.get([k]) as Value) ?? '')
    return out
  }
  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out.set(name(k), typeof v === 'string' ? v : '')
    return out
  }
  return null
}

const on = (v: unknown): boolean => v === true || v === 'true' || v === ''

/** Просит ли вызов справку: `--help` / `--h` флагом или `-h` / `--help` позиционным (`runz x -h`). */
export function wantsHelp(args: Record<string, Value>): boolean {
  if (on(args.help) || on(args.h)) return true
  const pos = args._
  const list = Array.isArray(pos) ? pos : pos === undefined ? [] : [pos]
  return list.some((p) => p === '-h' || p === '--help')
}

/** Ключи командной строки, которых скрипт не объявил. */
export function unknownFlags(args: Record<string, Value>, known: FlagSpec): string[] {
  return Object.keys(args).filter((k) => !known.has(k) && !RUNTIME_ARGS.includes(k) && k !== 'help' && k !== 'h')
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      // перестановка соседних (`dyr` ↔ `dry`)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  return d[a.length]![b.length]!
}

/** Текст отказа: какие флаги не знает скрипт, на что похожи, полный список. */
export function unknownFlagsError(script: string, bad: string[], known: FlagSpec): string {
  const names = [...known.keys()]
  const parts = bad.map((b) => {
    const near = names.filter((n) => distance(b, n) <= Math.max(1, Math.floor(n.length / 4))).sort((x, y) => distance(b, x) - distance(b, y))
    return `--${b}${near.length ? ` (может, --${near[0]}?)` : ''}`
  })
  return (
    `runz: ${script}: неизвестный флаг ${parts.join(', ')} — ничего не запущено\n` +
    `известные: ${names.map((n) => `--${n}`).join(' ')}\n` +
    `справка: runz ${script} --help`
  )
}

/** Первый `/** … *\/` текста без звёздочек. */
export function docComment(source: string): string {
  const m = /\/\*\*([\s\S]*?)\*\//.exec(source)
  if (!m) return ''
  return m[1]!
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim()
}

/** Начало markdown до первого заголовка второго уровня, без фронтматтера. */
function mdHead(md: string): string {
  const body = md.replace(/^---[\s\S]*?\n---\n/, '')
  const cut = body.search(/^##\s/m)
  return (cut > 0 ? body.slice(0, cut) : body).trim()
}

export interface HelpSource {
  /** Имя, как его набрали (`release`, `./x.ts`). */
  script: string
  /** Найденный файл скрипта; `null` — виртуальный прогон. */
  file: string | null
  /** `export const usage` модуля — свой текст справки. */
  usage?: string
  /** Текст документа (для `$description` и первого абзаца). */
  docText?: string
  /** `$description` документа. */
  description?: string
  flags: FlagSpec | null
}

/** Справка скрипта: шапка + объявленные флаги. */
export function helpText(src: HelpSource): string {
  let head = src.usage?.trim() ?? ''
  if (!head && src.file) {
    if (src.file.endsWith('.ts') || src.file.endsWith('.mjs')) {
      head = docComment(fs.readFileSync(src.file, 'utf8'))
      if (!head && path.basename(src.file) === 'index.ts') {
        for (const f of ['README.md', 'readme.md']) {
          const p = path.join(path.dirname(src.file), f)
          if (fs.existsSync(p)) {
            head = mdHead(fs.readFileSync(p, 'utf8'))
            break
          }
        }
      }
    } else {
      head = src.description?.trim() || mdHead(src.docText ?? fs.readFileSync(src.file, 'utf8'))
    }
  }
  if (!head) head = `${src.script}: описания нет (ни док-комментария, ни $description)`
  const lines = [head]
  if (src.flags?.size) {
    const described = [...src.flags].filter(([, d]) => d)
    if (described.length === src.flags.size) {
      const w = Math.max(...[...src.flags.keys()].map((k) => k.length)) + 2
      lines.push('', 'Флаги:', ...described.map(([k, d]) => `  --${k.padEnd(w)}${d}`))
    } else lines.push('', `Флаги: ${[...src.flags.keys()].map((k) => `--${k}`).join(' ')}`)
  }
  return lines.join('\n')
}
