/**
 * Что задаче нужно знать о рецепте и машине до запуска (jobs-spec §2–§3):
 * лимиты `$jobs` из конфига runz и атрибуты рецепта `$job_keys`/`$job_timeout`/`$out`
 * с учётом инклюдов `$[[base.mdz]]` (тонкий рецепт bot-fix наследует базу) и
 * профилей (`$models: preset …`,: `$job_keys` профиля — очередь задачи).
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { asText, isArray, parseDocument } from '@kerneldreams/nrd'
import { expandPresets, presetDirs, readTextWithIncludes } from '@kerneldreams/nrd/node'
import type { IArray } from '@kerneldreams/nrd'
import { parseNeeds, type Needs } from '../pool/types.js'

export interface JobsConfig {
  /** Общий лимит одновременно идущих задач. */
  max: number
  /** Лимит по ключу (`gemini: 3`); ключ без лимита ограничен только `max`. */
  limits: Record<string, number>
  /** `lost` сам встаёт в очередь заново (идемпотентные рецепты). */
  resumeLost: boolean
  /**
   * Задачи раздаёт пул машин (compute-pool-spec §2, `$jobs: {pool: true}`): машина
   * только ставит задачи и читает реестр, планировщик ничего не запускает сам.
   */
  pool: boolean
}

export const DEFAULT_MAX = 4

/** Конфиг runz: `NR_RUNZ_CONFIG` либо `~/.runz/config.md`. */
export const runzConfigFile = (): string => process.env.NR_RUNZ_CONFIG || join(homedir(), '.runz', 'config.md')

/** `$jobs: {max: 6, limits: {gemini: 3}, resume_lost: true}`; нет — дефолты. */
export function loadJobsConfig(file = runzConfigFile()): JobsConfig {
  const cfg: JobsConfig = { max: DEFAULT_MAX, limits: {}, resumeLost: false, pool: false }
  let raw: unknown
  try {
    raw = parseDocument(readFileSync(file, 'utf8'), { sigil: '$' }).get(['jobs'])
  } catch {
    return cfg
  }
  if (!raw || typeof raw !== 'object' || isArray(raw as never)) return cfg
  const o = raw as { max?: unknown; limits?: unknown; resume_lost?: unknown; pool?: unknown }
  if (typeof o.max === 'number' && o.max > 0) cfg.max = Math.floor(o.max)
  if (o.limits && typeof o.limits === 'object') {
    for (const [k, v] of Object.entries(o.limits as Record<string, unknown>)) {
      if (typeof v === 'number' && v >= 0) cfg.limits[k] = Math.floor(v)
    }
  }
  cfg.resumeLost = o.resume_lost === true
  cfg.pool = o.pool === true || process.env.RUNZ_JOBS_POOL === '1'
  return cfg
}

/** Цель — документ (путь существует и это файл), иначе — имя appz. */
export function isDocTarget(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

export interface RecipeAttrs {
  keys?: string[]
  timeoutMs?: number
  out?: string
  /** Пул машин (compute-pool-spec §4, §7, §8). */
  needs?: Needs
  retries?: number
  /** `$repeatable: true` — шаг можно повторить после обрыва: потерянная машина — следующему воркеру сам (kd-cli-spec §8, §11). */
  repeatable?: boolean
  shards?: number
  /** Рецепт склейки — абсолютный путь (относительный — от документа). */
  merge?: string
}

/**
 * Корневые атрибуты документа: инклюды раскрыты, профили (`preset`)
 * развёрнуты — значение поля-профиля из `values` задачи (`--models=opus`) или из
 * документа; last-wins. Профиль не нашёлся — throw (опечатка не уходит в очередь).
 */
function rootDoc(file: string, values: Record<string, unknown>) {
  const included: string[] = []
  const text = readTextWithIncludes(file, undefined, '[jobs]', { onRead: (f) => included.push(f) })
  return parseDocument(expandPresets(text, { dirs: presetDirs(file, included), values }), { sigil: '$' })
}

/** `90m`, `2h`, `45s`, `3600` (секунды) → мс; мусор — undefined. */
export function parseDuration(v: unknown): number | undefined {
  const s = (typeof v === 'number' ? String(v) : (asText(v as never) ?? '')).trim()
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s)
  if (!m) return undefined
  const n = Number(m[1])
  const mul = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h']
  return n > 0 ? Math.round(n * mul) : undefined
}

export function recipeAttrs(target: string, values: Record<string, unknown> = {}): RecipeAttrs {
  if (!isDocTarget(target)) return {}
  const doc = rootDoc(resolve(target), values)
  const attrs = new Map<string, unknown>()
  for (const key of ['job_keys', 'job_timeout', 'out', 'needs', 'retries', 'shards', 'merge', 'repeatable']) {
    const v = doc.get([key])
    if (v !== undefined) attrs.set(key, v)
  }
  const out: RecipeAttrs = {}
  const k = attrs.get('job_keys')
  if (k !== undefined) {
    const list: string[] = []
    if (isArray(k as never)) {
      for (const x of (k as IArray).iterate()) {
        const t = asText(x as never)?.trim()
        if (t) list.push(t)
      }
    } else {
      for (const t of (asText(k as never) ?? '').split(',')) if (t.trim()) list.push(t.trim())
    }
    out.keys = list
  }
  const t = parseDuration(attrs.get('job_timeout'))
  if (t !== undefined) out.timeoutMs = t
  const o = asText(attrs.get('out') as never)?.trim()
  if (o) out.out = o
  const needs = parseNeeds(attrs.get('needs'))
  if (needs) out.needs = needs
  const int = (k: string): number | undefined => {
    const v = attrs.get(k)
    const n = typeof v === 'number' ? v : Number(asText(v as never))
    return v !== undefined && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
  }
  const retries = int('retries')
  if (retries !== undefined) out.retries = retries
  const rep = attrs.get('repeatable')
  if (rep === true || asText(rep as never)?.trim() === 'true') out.repeatable = true
  const shards = int('shards')
  if (shards !== undefined && shards > 0) out.shards = shards
  const merge = asText(attrs.get('merge') as never)?.trim()
  if (merge) out.merge = resolve(dirname(resolve(target)), merge)
  return out
}

/** Ключ по умолчанию — имя рецепта (`fix-core`) или appz. */
export const recipeName = (target: string): string => basename(target, extname(target))

export const fileExists = existsSync
