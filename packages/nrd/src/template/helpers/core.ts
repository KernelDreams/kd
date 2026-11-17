// Встроенные core-фильтры (spec §5.1). Portable.
//
//   section(text, header) — извлечь markdown-секцию по заголовку
//   json(value)           — JSON.stringify(value, null, 2)
//   yaml(value)           — YAML-подобный вывод
//   trimEmpty(text)       — схлопнуть пустые строки
//   indent(text, n)       — отступ на n пробелов

import type nunjucks from 'nunjucks'
import type { HelperRegistrar } from '../engine.js'

/** Извлечь тело markdown-секции `## Header` до следующего заголовка того же/высшего уровня. */
export function section(content: unknown, header: unknown): string {
  if (typeof content !== 'string' || typeof header !== 'string') return ''
  const lines = content.split('\n')
  const hdr = /^(#+)\s+(.*)$/
  const start = lines.findIndex((l) => {
    const m = l.match(hdr)
    return m !== null && m[2].trim() === header.trim()
  })
  if (start < 0) return ''
  const levelMatch = lines[start].match(hdr)
  const level = levelMatch ? levelMatch[1].length : 2

  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(hdr)
    if (m && m[1].length <= level) break
    body.push(lines[i])
  }
  return body.join('\n').trim()
}

/** JSON.stringify с отступом 2. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Минималистичный YAML-подобный вывод (scalar / array / object, рекурсивно). */
export function yaml(value: unknown, indentLevel = 0): string {
  const pad = '  '.repeat(indentLevel)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return /[:#\n]/.test(value) ? JSON.stringify(value) : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value
      .map((item) => {
        const rendered = yaml(item, indentLevel + 1)
        return isContainer(item) ? `${pad}-\n${rendered}` : `${pad}- ${rendered}`
      })
      .join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return entries
      .map(([k, v]) => {
        const rendered = yaml(v, indentLevel + 1)
        return isContainer(v) ? `${pad}${k}:\n${rendered}` : `${pad}${k}: ${rendered}`
      })
      .join('\n')
  }
  return String(value)
}

function isContainer(v: unknown): boolean {
  return v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)
}

/** Схлопнуть 2+ подряд пустых строк в одну и обрезать края. */
export function trimEmpty(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Добавить отступ из n пробелов к каждой непустой строке. */
export function indent(text: unknown, n: unknown = 2): string {
  if (typeof text !== 'string') return ''
  const count = typeof n === 'number' ? n : Number(n) || 0
  const pad = ' '.repeat(Math.max(0, count))
  return text
    .split('\n')
    .map((l) => (l.length === 0 ? l : pad + l))
    .join('\n')
}

/** Зарегистрировать core-фильтры на Nunjucks env. */
export const registerCore: HelperRegistrar = (env: nunjucks.Environment) => {
  env.addFilter('section', section)
  env.addFilter('json', json)
  env.addFilter('yaml', (v: unknown) => yaml(v))
  env.addFilter('trimEmpty', trimEmpty)
  env.addFilter('indent', indent)
}
