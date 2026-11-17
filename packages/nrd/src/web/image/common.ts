/**
 * Общее для адаптеров картинок nrd/web: приведение параметра к полю схемы,
 * общий дедлайн с внешним `signal`, пауза с отменой.
 */

import type { ImageModelField } from '../../contracts/index.js'

export function describeField(name: string, f: ImageModelField): string {
  return f.enum ? `${name} (${f.enum.map(String).join('|')})` : `${name}: ${f.type}`
}

/** Привести значение параметра к типу поля схемы; `string` — текст ошибки. */
export function coerce(name: string, v: unknown, f: ImageModelField): { value: unknown } | string {
  if (v === null) return { value: null }
  const types = new Set(f.type.split('|'))
  let value = v
  if (typeof v === 'string' && types.has('string') && types.has('integer') && /^-?\d+$/.test(v.trim())) {
    // `integer|string` (BFL duration: 5…20 | "auto") — число строкой из формы/CLI значит число.
    value = Number(v.trim())
  } else if (typeof v === 'string' && !types.has('string')) {
    const s = v.trim()
    if (types.has('integer') && /^-?\d+$/.test(s)) value = Number(s)
    else if (types.has('number') && s !== '' && Number.isFinite(Number(s))) value = Number(s)
    else if (types.has('boolean') && (s === 'true' || s === 'false')) value = s === 'true'
    else return `параметр "${name}": ожидается ${f.type}, получено "${v}"`
  } else if (typeof v === 'number' && !types.has('number') && !types.has('integer') && types.has('string')) {
    value = String(v)
  } else if (typeof v === 'boolean' && !types.has('boolean')) {
    return `параметр "${name}": ожидается ${f.type}, получено ${v}`
  }
  if (typeof value === 'number' && types.has('integer') && !types.has('number') && !Number.isInteger(value)) {
    return `параметр "${name}": ожидается integer, получено ${value}`
  }
  if (f.enum && !f.enum.includes(value)) {
    return `параметр "${name}": "${String(value)}" не из списка ${f.enum.map(String).join(', ')}`
  }
  if (typeof value === 'number') {
    if (f.min !== undefined && value < f.min) return `параметр "${name}": ${value} меньше минимума ${f.min}`
    if (f.max !== undefined && value > f.max) return `параметр "${name}": ${value} больше максимума ${f.max}`
  }
  return { value }
}

export class Deadline {
  readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout>
  private onOuter?: () => void
  constructor(ms: number, private outer?: AbortSignal) {
    this.timer = setTimeout(() => this.controller.abort(new Error('timeout')), ms)
    if (outer) {
      this.onOuter = () => this.controller.abort(outer.reason)
      if (outer.aborted) this.onOuter()
      else outer.addEventListener('abort', this.onOuter, { once: true })
    }
  }
  get signal() {
    return this.controller.signal
  }
  dispose() {
    clearTimeout(this.timer)
    if (this.outer && this.onOuter) this.outer.removeEventListener('abort', this.onOuter)
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

