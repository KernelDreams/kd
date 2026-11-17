// Resolver (§3 of engine-spec.md): resolve(text, ctx) → string.
// Substitutes ${...} via the context, with both kinds of recursion (§3.3) and
// the \${ opt-out contract (§3.1).

import type { IContext, ResolveOptions, Segment } from '../context.js'
import { isArray, isContext } from '../context.js'
import { toText } from '../text.js'
import type { Value } from '../value.js'
import type { PathSegment, PlaceholderArg, PlaceholderExpr } from './placeholder.js'
import { parseExpr, scanPlaceholders } from './placeholder.js'
import { walk } from './walk.js'
import { emptyContext, objectContext } from './contexts.js'

// ---------- Локальные структурные гварды (§0.3) ----------
// /eval не тащит nr-md: форма InterpolatedValue проверяется структурным
// duck-check у себя. Семантика бит-в-бит с nr-md (json5-value.ts:51) и прежним
// nrd-core/resolve.ts (isInterpolated).

/** InterpolatedValue-форма атрибута: сырой текст + индекс интерполяций. */
interface InterpolatedValue {
  raw: string
  placeholders: unknown[]
}

// ---------- Public API (§3, §8.1) ----------

/**
 * Resolve every `${expr}` in `text` against `ctx`.
 *
 * - `ctx` may be a plain Record (auto-wrapped via objectContext, §8.1).
 * - lenient (default): unresolved placeholder → left literal. strict → throws.
 * - Cycle detection throws in both modes.
 */
export function resolve(
  text: string,
  ctx: IContext | Record<string, Value>,
  opts?: ResolveOptions,
): string {
  const context = toContext(ctx)
  const o = normOpts(opts)
  const expanded = expand(text, context, o, new Set())
  // §3.1: unfold the opt-out escape exactly once, after all recursion settles —
  // unless the result goes back into a context (keepOptOut): then it is still
  // recursion, and the escape has to stay alive.
  return o.keepOptOut ? expanded : unescapeOptOut(expanded)
}

/**
 * Резолв ЗНАЧЕНИЯ, а не текста (resolve-fix §1.6).
 *
 * Отличие от {@link resolve} ровно одно: если плейсхолдер занимает значение
 * целиком (`$preset: ${loadJSON('x.json')}`) и результат — дерево (IContext /
 * IArray), возвращается само дерево, а не его текстовая проекция. Прецедент —
 * Json5Object в атрибуте (атомарен): значение целиком ≠ интерполяция
 * внутри строки.
 *
 * Во всех прочих случаях — прежняя строковая семантика бит-в-бит: интерполяция
 * в середине строки, скаляры, несколько плейсхолдеров, нерезолвнутое. Вызов
 * функции при этом происходит РОВНО ОДИН раз (у функций бывает IO).
 */
export function resolveValue(
  text: string,
  ctx: IContext | Record<string, Value>,
  opts?: ResolveOptions,
): Value {
  const context = toContext(ctx)
  const o = normOpts(opts)
  const fold = o.keepOptOut ? (s: string) => s : unescapeOptOut
  const phs = scanPlaceholders(text)
  if (phs.length !== 1 || phs[0].start !== 0 || phs[0].end !== text.length) {
    return resolve(text, context, o)
  }
  const ph = phs[0]
  const visited = new Set<string>([ph.raw.trim()])
  const value = evalExpr(ph.expr, context, o, visited)
  if (isContext(value) || isArray(value)) return value
  const txt = valueToText(value, context, o, visited)
  if (txt === undefined) {
    if (o.mode === 'strict') throw new Error(`unresolved placeholder: ${text}`)
    return fold(text)
  }
  return fold(txt)
}

/**
 * Convenience get (§8.1): parse a string path, wrap a Record, traverse via walk.
 *
 * An exit, like `resolve`: a string value comes out with the `\${` opt-out
 * unfolded (§3.1). Inside a context the value keeps the escape — that is what
 * recursion reads; `ctx.get` is the raw view.
 */
export function get(
  path: string | Segment[],
  ctx?: IContext | Record<string, Value>,
): Value | undefined {
  const segments = typeof path === 'string' ? parsePath(path) : path
  const context = ctx === undefined ? emptyContext : toContext(ctx)
  const v = walk(context, segments, { mode: 'lenient' })
  return typeof v === 'string' ? unescapeOptOut(v) : v
}

function toContext(ctx: IContext | Record<string, Value>): IContext {
  return isContext(ctx) ? ctx : objectContext(ctx as Record<string, Value>)
}

function normOpts(opts?: ResolveOptions): ResolveOptions {
  return { mode: opts?.mode === 'strict' ? 'strict' : 'lenient', keepOptOut: opts?.keepOptOut === true }
}

// ---------- Core expansion ----------

function expand(
  text: string,
  ctx: IContext,
  opts: ResolveOptions,
  visited: Set<string>,
): string {
  const phs = scanPlaceholders(text)
  if (phs.length === 0) return text
  let out = ''
  let last = 0
  for (const ph of phs) {
    out += text.slice(last, ph.start)
    const literal = text.slice(ph.start, ph.end)
    const key = ph.raw.trim()
    if (visited.has(key)) {
      throw new Error(`cyclic reference ${[...visited, key].join(' -> ')}`)
    }
    const branch = new Set(visited)
    branch.add(key)
    const value = evalExpr(ph.expr, ctx, opts, branch)
    const txt = valueToText(value, ctx, opts, branch)
    if (txt === undefined) {
      if (opts.mode === 'strict') throw new Error(`unresolved placeholder: ${literal}`)
      out += literal
    } else {
      out += txt
    }
    last = ph.end
  }
  out += text.slice(last)
  return out
}

function evalExpr(
  expr: PlaceholderExpr,
  ctx: IContext,
  opts: ResolveOptions,
  visited: Set<string>,
): Value {
  if (expr.kind === 'path') {
    const segs = resolveSegments(expr.segments, ctx, opts, visited)
    return walk(ctx, segs, opts)
  }
  // call (вид-2: result may itself contain ${...} → resolved in valueToText)
  const args = expr.args.map((a) => evalArg(a, ctx, opts, visited))
  const result = ctx.func(expr.name, args)
  // `fn(...).a.b` (§1.7): path-сегменты применяются к тому, ЧТО вернул вызов.
  if (!expr.path || expr.path.length === 0) return result
  const segs = resolveSegments(expr.path, ctx, opts, visited)
  return walk(result, segs, opts)
}

function evalArg(
  arg: PlaceholderArg,
  ctx: IContext,
  opts: ResolveOptions,
  visited: Set<string>,
): Value {
  if (arg.kind === 'literal') return arg.value === null ? undefined : arg.value
  if (arg.kind === 'path') {
    const segs = resolveSegments(arg.segments, ctx, opts, visited)
    return walk(ctx, segs, opts)
  }
  return evalExpr(arg.value.expr, ctx, opts, visited)
}

function resolveSegments(
  segments: PathSegment[],
  ctx: IContext,
  opts: ResolveOptions,
  visited: Set<string>,
): Segment[] {
  return segments.map((seg) => {
    if (seg.kind === 'name') return seg.value
    if (seg.kind === 'index') return seg.value
    // nested ${} segment → resolve, then coerce to a segment
    const v = evalExpr(seg.value.expr, ctx, opts, visited)
    return toSegment(v)
  })
}

function toSegment(v: Value): Segment {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  return String(v)
}

/**
 * §3.4 — convert a resolved Value to text. Returns undefined when the value has
 * no text form (→ caller treats as unresolved: literal in lenient, throw in
 * strict). String/interpolated/context-text values are recursively expanded
 * (§3.3 both recursion kinds).
 *
 * Деревья, коллекции и объекты уходят в ЕДИНОЕ правило приведения к тексту
 * (`toText`, text-cast-spec §2.1): текстовая проекция звена, иначе json5-дамп.
 * Прежние ветки (last-wins по массиву, `cast('text')` у контекста, `stringifyJson5`
 * у Json5Object) — частные случаи того же правила и живут теперь внутри него.
 * `expand` передаётся хуком: подстановка в строковые листья обязана случиться
 * ДО сериализации дампа.
 */
function valueToText(
  value: Value,
  ctx: IContext,
  opts: ResolveOptions,
  visited: Set<string>,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return expand(value, ctx, opts, visited)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isInterpolated(value)) return expand(value.raw, ctx, opts, visited)
  return toText(value, { expand: (s) => expand(s, ctx, opts, visited) })
}

function isInterpolated(v: unknown): v is InterpolatedValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { raw?: unknown }).raw === 'string' &&
    Array.isArray((v as { placeholders?: unknown }).placeholders)
  )
}

// ---------- \${ opt-out final pass (§3.1) ----------

/**
 * Unfold the opt-out escape `\${` → `${` once, mirroring scanPlaceholders'
 * escape handling so `\\${live}` (escaped backslash + a real placeholder) is
 * not misread. Other escapes are preserved verbatim.
 */
export function unescapeOptOut(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '\\' && s[i + 1] === '$' && s[i + 2] === '{') {
      out += '${'
      i += 3
      continue
    }
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i] + s[i + 1]
      i += 2
      continue
    }
    out += s[i]
    i++
  }
  return out
}

// ---------- string path parsing (§8.1 get) ----------

function parsePath(s: string): Segment[] {
  const expr = parseExpr(s)
  if (expr.kind !== 'path') {
    throw new Error(`get(): not a path expression: "${s}"`)
  }
  return expr.segments.map((seg) => {
    if (seg.kind === 'name') return seg.value
    if (seg.kind === 'index') return seg.value
    throw new Error(`get(): dynamic segment not supported in "${s}"`)
  })
}
