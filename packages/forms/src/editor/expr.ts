// Выражения описания (spec §3): ntpl из `@kerneldreams/nrd/template`, исполнение без кодогенерации
// (обход AST — CSP чужих страниц), зависимости — из AST, граф вычислений, цикл — ошибка с цепочкой.
//
// Переменные: поля от корня (`skills.physique`), `item` — текущий элемент повторителя,
// `calc.<id>` — другие вычисления. Результат приводится к типу вычисления.

import nunjucks from 'nunjucks'
import { createEnvWith, noEvalTemplate, type Nunjucks } from '@kerneldreams/nrd/template'
import { get } from './get.js'
import { isKnown, type AnyNode, type ComputedNode, type ComputedType, type EditorDef } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const nj = nunjucks as unknown as Nunjucks & { parser: Any; nodes: Any }
let envCache: Any
function env(): Any {
  return (envCache ??= createEnvWith(nunjucks as never))
}

/** Имена фильтров среды (nunjucks + nrd) — для каталога и подсказок. */
export function exprFilters(): string[] {
  return Object.keys(env().filters ?? {}).sort()
}

export class ExprError extends Error {
  hint: string | undefined
  constructor(message: string, hint?: string) {
    super(message)
    this.hint = hint
  }
}

export interface CompiledExpr {
  src: string
  /**
   * Пути, которые читает выражение: `skills.physique`, `item.clues`, `calc.physicalBoxes`.
   * Индекс не литералом (`xs[i]`) обрезает путь до известного префикса.
   */
  deps: string[]
  /** Отрендерить: строка как её отдал шаблон. */
  render(ctx: object): string
}

const typeName = (n: Any): string => n?.typename ?? n?.constructor?.name ?? ''

/** Путь цепочки `a.b["c"]` или `undefined`, если корень — не переменная. */
function chainOf(n: Any): string[] | undefined {
  const t = typeName(n)
  if (t === 'Symbol') return [n.value]
  if (t === 'LookupVal') {
    const base = chainOf(n.target)
    if (!base) return undefined
    return typeName(n.val) === 'Literal' && (typeof n.val.value === 'string' || typeof n.val.value === 'number') ? [...base, String(n.val.value)] : base
  }
  return undefined
}

/** Зависимости из AST: переменные (кроме связанных `for`/`set`), без имён фильтров и функций. */
function depsOf(ast: Any): string[] {
  const bound = new Set<string>()
  const found = new Set<string>()
  const bind = (n: Any): void => {
    const t = typeName(n)
    if (t === 'Symbol') bound.add(n.value)
    else for (const c of n?.children ?? []) bind(c)
  }
  const pre = (n: Any): void => {
    if (!n || typeof n !== 'object') return
    const t = typeName(n)
    if (t === 'For' || t === 'AsyncEach' || t === 'AsyncAll') bind(n.name)
    if (t === 'Set') for (const x of n.targets ?? []) bind(x)
    for (const f of fieldsOf(n)) {
      const v = n[f]
      if (Array.isArray(v)) v.forEach(pre)
      else pre(v)
    }
  }
  const walk = (n: Any): void => {
    if (!n || typeof n !== 'object') return
    const t = typeName(n)
    if (t === 'Symbol' || t === 'LookupVal') {
      const chain = chainOf(n)
      if (chain) {
        if (!bound.has(chain[0]!) && chain[0] !== 'loop') {
          // `x.split(…)` — метод: последний сегмент цепочки вызова не путь (см. FunCall ниже).
          found.add(chain.join('.'))
        }
        if (t === 'LookupVal') walk(n.val)
        return
      }
      if (t === 'LookupVal') {
        walk(n.target)
        walk(n.val)
      }
      return
    }
    if (t === 'Filter' || t === 'FilterAsync') return walk(n.args)
    if (t === 'FunCall') {
      const name = n.name
      if (typeName(name) === 'LookupVal') {
        const chain = chainOf(name)
        if (chain && chain.length > 1 && !bound.has(chain[0]!)) found.add(chain.slice(0, -1).join('.'))
        else if (!chain) walk(name.target)
      } else if (typeName(name) !== 'Symbol') walk(name)
      return walk(n.args)
    }
    if (t === 'Is') return walk(n.left)
    if (t === 'Pair' && typeName(n.key) === 'Symbol') return walk(n.value)
    if (t === 'For' || t === 'AsyncEach' || t === 'AsyncAll') {
      walk(n.arr)
      walk(n.body)
      walk(n.else_)
      return
    }
    if (t === 'Set') return walk(n.value ?? n.body)
    for (const f of fieldsOf(n)) {
      const v = n[f]
      if (Array.isArray(v)) v.forEach(walk)
      else walk(v)
    }
  }
  pre(ast)
  walk(ast)
  // Объединить: `a.b` и `a.b.c` — оставить оба (префикс ловит и правку целого `a.b`).
  return [...found].sort()
}

function fieldsOf(n: Any): string[] {
  const f: string[] = [...(n.fields ?? [])]
  if (n.body !== undefined && !f.includes('body')) f.push('body')
  return f
}

const cache = new Map<string, CompiledExpr>()

/** Разобрать выражение ntpl. Ошибка синтаксиса или `{% %}` вместо `<{ }>` — `ExprError` с подсказкой. */
export function compileExpr(src: string): CompiledExpr {
  const hit = cache.get(src)
  if (hit) return hit
  if (/\{%|\{\{/.test(src)) {
    const which = src.includes('{%') ? '{% … %}' : '{{ … }}'
    throw new ExprError(`${which} — не ntpl`, src.includes('{%') ? 'блоки — <{ … }>, значения — << … >>' : 'значения — << … >>')
  }
  let ast: Any
  try {
    const e = env()
    ast = nj.parser.parse(src, e.extensionsList, e.opts)
  } catch (e) {
    throw new ExprError(`синтаксис: ${firstLine(e)}`)
  }
  const tmpl = noEvalTemplate(nj, env(), src)
  const out: CompiledExpr = {
    src,
    deps: depsOf(ast),
    render(ctx) {
      try {
        return tmpl.render(ctx)
      } catch (e) {
        throw new ExprError(`не считается: ${firstLine(e)}`, /filter not found: (\w+)/.test(String(e)) ? `фильтры: ${exprFilters().join(', ')}` : undefined)
      }
    },
  }
  cache.set(src, out)
  return out
}

function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && s !== '(unknown path)')
    .join(' ')
    .replace(/^Template render error: /, '')
}

/** Привести вывод шаблона к типу вычисления; не приводится — `ExprError`. */
export function coerceResult(raw: string, type: ComputedType): number | string | boolean {
  const v = raw.trim()
  if (type === 'number') {
    const n = Number(v)
    if (v === '' || !Number.isFinite(n)) throw new ExprError(`не число: "${v.length > 80 ? v.slice(0, 80) + '…' : v}"`)
    return n
  }
  if (type === 'boolean') {
    if (v === 'true' || v === 'false') return v === 'true'
    throw new ExprError(`не флаг: "${v}"`, 'выражение должно дать true или false')
  }
  return v
}

/** Посчитать одно выражение над контекстом и привести к типу. */
export function evalExpr(src: string, ctx: object, type: ComputedType): number | string | boolean {
  return coerceResult(compileExpr(src).render(ctx), type)
}

// ---------- граф вычислений ----------

export interface ComputedInfo {
  node: ComputedNode
  /** Цепочка повторителей над вычислением (пути от своей области): `['sessions', 'scenes']`; корень — `[]`. */
  scope: string[]
  /** Разобранное выражение; ошибка разбора — в `error`. */
  compiled?: CompiledExpr
  error?: ExprError
  /** Зависимости от корня без индексов: `skills.physique`, `sessions.scenes.clues`, `calc.x`. */
  deps: string[]
}

export interface Expressions {
  computed: Map<string, ComputedInfo>
  /** Порядок счёта (топологический); вычисления в цикле — в конце. */
  order: string[]
  /** Циклы: цепочки id (`a → b → a`). */
  cycles: string[][]
  /**
   * Какие вычисления пересчитать после правки путей (`stress.physical`, `sessions[ab12].scenes`),
   * с транзитивными — в порядке счёта.
   */
  affected(paths: string[]): string[]
  /**
   * Посчитать всё: ключ корневого — `id`, в повторителе — `sessions[<_id>].id`
   * (`_id` строки, нет — индекс). Ошибки — по тем же ключам. `only` + `prev` — пересчитать
   * только эти вычисления (`affected(paths)`), прочие взять из прошлого счёта.
   */
  evaluate(object: unknown, opts?: { only?: readonly string[]; prev?: Record<string, unknown> }): { values: Record<string, unknown>; errors: Record<string, ExprError> }
}

/** Путь правки без индексов строк: `sessions[ab12].scenes[0].title` → `sessions.scenes.title`. */
export function normPath(p: string): string {
  // Патч истории (`/aspects/@a7f3/text`) или путь команды (`aspects[a7f3].text`).
  if (p.startsWith('/')) return p.split('/').filter((s) => s && !s.startsWith('@') && !/^\d+$/.test(s)).join('.')
  return p.replace(/\[[^\]]*\]/g, '')
}

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + '.') || b.startsWith(a + '.')

export function createExpressions(def: EditorDef): Expressions {
  const computed = new Map<string, ComputedInfo>()
  const walk = (nodes: AnyNode[], scope: string[]): void => {
    for (const n of nodes) {
      if (!isKnown(n)) {
        walk((n as { children?: AnyNode[] }).children ?? [], scope)
        continue
      }
      if (n.kind === 'computed' && n.id && !computed.has(n.id)) {
        const info: ComputedInfo = { node: n, scope, deps: [] }
        try {
          info.compiled = compileExpr(n.expr)
          const base = scope.join('.')
          info.deps = info.compiled.deps.map((d) => (d === 'item' || d.startsWith('item.') ? [base, d.slice(5)].filter(Boolean).join('.') : d))
        } catch (e) {
          info.error = e instanceof ExprError ? e : new ExprError(String(e))
        }
        computed.set(n.id, info)
      }
      if (n.kind === 'repeat') walk(n.children, [...scope, n.path])
      else if ('children' in n) walk(n.children, scope)
    }
  }
  walk(def.nodes, [])

  const calcDeps = (id: string): string[] =>
    (computed.get(id)?.deps ?? []).filter((d) => d.startsWith('calc.')).map((d) => d.slice(5).split('.')[0]!)

  // Топологический порядок + циклы (DFS с цветами).
  const order: string[] = []
  const cycles: string[][] = []
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): void => {
    const s = state.get(id)
    if (s === 2) return
    if (s === 1) {
      const from = stack.indexOf(id)
      cycles.push([...stack.slice(from), id])
      return
    }
    state.set(id, 1)
    stack.push(id)
    for (const d of calcDeps(id)) if (computed.has(d)) visit(d)
    stack.pop()
    state.set(id, 2)
    order.push(id)
  }
  for (const id of computed.keys()) visit(id)

  const affected = (paths: string[]): string[] => {
    const changed = paths.map(normPath)
    const hit = new Set<string>()
    for (const [id, info] of computed) if (info.deps.some((d) => !d.startsWith('calc.') && changed.some((p) => overlaps(d, p)))) hit.add(id)
    // Транзитивно: кто читает calc.<задетого>.
    let grew = true
    while (grew) {
      grew = false
      for (const id of computed.keys()) if (!hit.has(id) && calcDeps(id).some((d) => hit.has(d))) hit.add(id), (grew = true)
    }
    return order.filter((id) => hit.has(id))
  }

  const evaluate = (object: unknown, opts: { only?: readonly string[]; prev?: Record<string, unknown> } = {}): { values: Record<string, unknown>; errors: Record<string, ExprError> } => {
    const only = opts.only && opts.prev ? new Set(opts.only) : undefined
    const prev = opts.prev ?? {}
    const values: Record<string, unknown> = {}
    const errors: Record<string, ExprError> = {}
    const root = (object && typeof object === 'object' ? object : {}) as Record<string, unknown>
    const calcRoot: Record<string, unknown> = {}
    const run = (info: ComputedInfo, ctx: object, key: string, calc: Record<string, unknown>): void => {
      if (only && !only.has(info.node.id) && key in prev) {
        calc[info.node.id] = prev[key]
        values[key] = prev[key]
        return
      }
      if (info.error) {
        errors[key] = info.error
        return
      }
      try {
        const v = coerceResult(info.compiled!.render(ctx), info.node.type)
        calc[info.node.id] = v
        values[key] = v
      } catch (e) {
        errors[key] = e instanceof ExprError ? e : new ExprError(String(e))
      }
    }
    // Строки повторителя по цепочке областей: [{key, item, calc}] на каждом уровне.
    type Row = { key: string; item: unknown; calc: Record<string, unknown> }
    const rowsOf = (scope: string[]): Row[] => {
      let rows: Row[] = [{ key: '', item: undefined, calc: calcRoot }]
      for (const seg of scope) {
        const next: Row[] = []
        for (const r of rows) {
          const host = (r.item ?? root) as Record<string, unknown>
          const list = get(host, seg)
          if (!Array.isArray(list)) continue
          list.forEach((it, i) => {
            const id = it && typeof it === 'object' && typeof (it as { _id?: unknown })._id === 'string' ? (it as { _id: string })._id : String(i)
            next.push({ key: `${r.key ? r.key + '.' : ''}${seg}[${id}]`, item: it, calc: { ...calcRoot } })
          })
        }
        rows = next
      }
      return rows
    }
    const rowCache = new Map<string, Row[]>()
    for (const id of order) {
      const info = computed.get(id)!
      const scopeKey = info.scope.join('\u0000')
      if (!info.scope.length) {
        run(info, { ...root, calc: calcRoot }, id, calcRoot)
        continue
      }
      let rows = rowCache.get(scopeKey)
      if (!rows) rowCache.set(scopeKey, (rows = rowsOf(info.scope)))
      for (const r of rows) {
        Object.assign(r.calc, { ...calcRoot, ...r.calc })
        run(info, { ...root, item: r.item, calc: r.calc }, `${r.key}.${id}`, r.calc)
      }
    }
    return { values, errors }
  }

  return { computed, order, cycles, affected, evaluate }
}

export { get } from './get.js'
