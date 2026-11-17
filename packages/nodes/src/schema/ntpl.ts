// Строка композита ⇄ текст ntpl (node-canvas-spec §3: `Expression` = дерево разбора ntpl, не свой язык).
//
//   << имя >> << отец | отчество >> << фамилия | род('ж') >>
//
// Пилюля — `<< var | фильтры >>`, мета пилюли — фильтры морфологии nrd (`отчество`, `род`, `падеж`,
// `заглавная` / `прописные` / `строчные`), литерал — текст между ними. Разбор — родным парсером
// nunjucks с делимитерами ntpl; то, что строкой пилюль не показать (`<{ if }>`, выражения), — отказ
// с перечнем непоказуемого, а не тихая потеря.

import nunjucks from 'nunjucks'
import { createEnvWith } from '@kerneldreams/nrd/template'
import type { CompositeRow, PillMeta, PillRod, RowPart } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

let envCache: Any
const env = (): Any => (envCache ??= createEnvWith(nunjucks as never))
const tn = (n: Any): string => n?.typename ?? n?.constructor?.name ?? ''

const RODS: PillRod[] = ['м', 'ж', 'с', 'мн']
const PADEJ = ['и', 'р', 'д', 'в', 'т', 'п'] as const
const CASES: Record<string, NonNullable<PillMeta['case']>> = { заглавная: 'title', прописные: 'upper', строчные: 'lower' }
const CASE_FILTER: Record<NonNullable<PillMeta['case']>, string> = { title: 'заглавная', upper: 'прописные', lower: 'строчные' }

/** Строку пилюлями не показать: что именно мешает. */
export class RowProjectionError extends Error {
  constructor(public readonly unshowable: string[]) {
    super(`строкой пилюль не показать: ${unshowable.join('; ')}`)
    this.name = 'RowProjectionError'
  }
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** Пилюля → `<< var | … >>`. */
export function pillToNtpl(name: string, meta: PillMeta = {}): string {
  const f: string[] = []
  if (meta.patronymic) f.push(meta.rod ? `отчество(${q(meta.rod)})` : 'отчество')
  else if (meta.rod) f.push(`род(${q(meta.rod)})`)
  else if (meta.agree) f.push('род')
  if (meta.padej) f.push(`падеж(${q(meta.padej)})`)
  if (meta.case) f.push(CASE_FILTER[meta.case])
  return `<< ${[name, ...f].join(' | ')} >>`
}

/** Части строки → тело ntpl. */
export function partsToNtpl(parts: RowPart[]): string {
  return parts.map((p) => (p.kind === 'text' ? p.text.replace(/<</g, "<< '<<' >>").replace(/<\{/g, "<< '<{' >>") : pillToNtpl(p.var, p.meta))).join('')
}

function literalArg(n: Any, where: string, bad: string[]): string | undefined {
  if (!n) return undefined
  if (tn(n) === 'Literal' && typeof n.value === 'string') return n.value
  bad.push(`${where}: аргумент не строкой`)
  return undefined
}

function pillOf(node: Any, bad: string[]): RowPart | undefined {
  const meta: PillMeta = {}
  let cur = node
  const filters: Array<{ name: string; args: Any[] }> = []
  while (tn(cur) === 'Filter') {
    const args = cur.args?.children ?? []
    filters.unshift({ name: cur.name?.value, args: args.slice(1) })
    cur = args[0]
  }
  if (tn(cur) !== 'Symbol') {
    bad.push(`выражение вместо переменной (${tn(cur) || '?'})`)
    return undefined
  }
  for (const f of filters) {
    if (f.name === 'отчество') {
      meta.patronymic = true
      const r = literalArg(f.args[0], 'отчество', bad)
      if (r) {
        if (!RODS.includes(r as PillRod)) bad.push(`отчество: род «${r}» — один из ${RODS.join(' ')}`)
        else meta.rod = r as PillRod
      }
    } else if (f.name === 'род') {
      const r = literalArg(f.args[0], 'род', bad)
      if (r) {
        if (!RODS.includes(r as PillRod)) bad.push(`род «${r}» — один из ${RODS.join(' ')}`)
        else meta.rod = r as PillRod
      } else meta.agree = true
    } else if (f.name === 'падеж') {
      const p = literalArg(f.args[0], 'падеж', bad)
      if (!p || !(PADEJ as readonly string[]).includes(p)) bad.push(`падеж «${p ?? ''}» — один из ${PADEJ.join(' ')}`)
      else meta.padej = p as PillMeta['padej']
    } else if (f.name in CASES) meta.case = CASES[f.name]
    else bad.push(`фильтр ${f.name} — не мета пилюли`)
  }
  return Object.keys(meta).length ? { kind: 'pill', var: cur.value, meta } : { kind: 'pill', var: cur.value }
}

/** Тело ntpl → части строки. Непоказуемое — `RowProjectionError` с перечнем. */
export function partsFromNtpl(src: string): RowPart[] {
  let ast: Any
  try {
    const e = env()
    ast = (nunjucks as Any).parser.parse(src, e.extensionsList, e.opts)
  } catch (err) {
    throw new RowProjectionError([`разбор ntpl: ${(err as Error).message.split('\n')[0]}`])
  }
  const parts: RowPart[] = []
  const bad: string[] = []
  const pushText = (t: string) => {
    if (!t) return
    const last = parts[parts.length - 1]
    if (last?.kind === 'text') last.text += t
    else parts.push({ kind: 'text', text: t })
  }
  for (const child of ast.children ?? []) {
    if (tn(child) !== 'Output') {
      bad.push(`тег ${tn(child)}`)
      continue
    }
    for (const c of child.children ?? []) {
      if (tn(c) === 'TemplateData') pushText(String(c.value))
      else if (tn(c) === 'Literal' && typeof c.value === 'string') pushText(c.value)
      else {
        const p = pillOf(c, bad)
        if (p) parts.push(p)
      }
    }
  }
  if (bad.length) throw new RowProjectionError(bad)
  return parts
}

/** Строка композита одной строкой текста: `м: << имя >> …` (метка — если есть). */
export function rowToLine(row: CompositeRow): string {
  return `${row.label ? `${row.label}: ` : ''}${partsToNtpl(row.parts)}`
}

/** Текст композита (по строке на вариант) — для инспектора и вида «Текст». */
export function compositeToText(rows: CompositeRow[]): string {
  return rows.map(rowToLine).join('\n')
}

/** `м: << имя >>` → метка и части. Метка — слово до первого `:` перед `<<`. */
export function lineToRow(line: string): Pick<CompositeRow, 'label' | 'parts'> {
  const m = /^\s*([\p{L}\p{N}_]+)\s*:\s?(.*)$/su.exec(line)
  if (m && !m[1]!.includes('<')) return { label: m[1], parts: partsFromNtpl(m[2]!) }
  return { parts: partsFromNtpl(line) }
}
