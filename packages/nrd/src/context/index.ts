// nrd/context — Context Assembly (бывший @kerneldreams/nrd).
//
// Ядро portable (зависит ТОЛЬКО от ./core): парс mdz-конфига, merge params,
// $required, plugin resolution, chain. Платформенные возможности (storage /
// executor / http) инъектируются через SourceContext — потребитель приносит их
// под платформу. Node-комплект — ступень `nrd/node` (nrd-merge §2.3).
//
// Spec: docs/specs/nrd-context-spec.md

import {
  parseDocument,
  objectContext,
  chainContext,
  funcContext,
  resolveValue,
  scanPlaceholders,
  emptyContext,
  asText,
  toText,
} from '../core/index.js'
import type { Placeholder, PlaceholderExpr } from '../core/index.js'
// Типы дерева — напрямую из кодека: nrd-core их лишь реэкспортирует ( §2.B).
import type { Block, AttributeValue } from '../md/index.js'
import type {
  Value,
  IContext,
  Segment,
  FuncFn,
  IStorage,
  Executor,
} from '../contracts/index.js'
import {
  noopLogger,
  ATTR_BODY,
  ATTR_NAME,
  type Logger,
  type HttpClient,
  type SourceContext,
  type SourcePlugin,
  type TransformPlugin,
} from './types.js'
import { resolveSourcePlugin, resolveTransformPlugin } from './resolution.js'
import { funcServiceContext } from './functions.js'
import { normalizeNrAttrs, nrKey } from './decl.js'

export type {
  Logger,
  HttpClient,
  SourceContext,
  SourcePlugin,
  TransformPlugin,
} from './types.js'
export { noopLogger } from './types.js'
export { builtinSources } from './builtins/index.js'
export { fileFunctions, funcServiceContext, FUNC_BASE_DIR } from './functions.js'
export type { SyncFileIO } from './functions.js'
export type { ParseMode } from './parse.js'
export { parseRaw, parseMode, PARSE_MODES } from './parse.js'
export { normalizeNrAttrs, nrKey, NR_PREFIX } from './decl.js'

// ---------- Параметры / резолв ----------

/** IContext-обёртка над process.env (одно строковое имя → значение). */
const envContext: IContext = {
  get(path: Segment[]): Value | undefined {
    if (path.length !== 1 || typeof path[0] !== 'string') return undefined
    if (typeof process === 'undefined' || !process.env) return undefined
    return process.env[path[0]]
  },
  func: () => undefined,
  cast: () => undefined,
  // Окружение себя не перечисляет — дампить нечего (§2.2).
  toString: () => '',
}

/** Слои цепочки хоста, разложенные по силе относительно атрибутов документа. */
interface HostLayers {
  /** Явные параметры вызова (`opts.params`) — сильнее всего. */
  explicit?: IContext
  /** Сильнее документа: CLI-аргументы. */
  strong?: IContext
  /** Слабее документа: app-конфиг, глобальный конфиг, окружение. */
  weak?: IContext
  /** Функции `${fn(...)}` — хвост цепочки, данных не поставляет. */
  functions?: IContext
}

/**
 * params-цепочка (resolve-fix §1.1). Каскад:
 *
 *   `opts.params > strong (CLI) > атрибуты документа > weak (конфиги) > env`
 *
 * `params` — слой САМОГО ДОКУМЕНТА (корневые атрибуты); явные параметры вызова
 * приходят отдельным слоем `explicit` и стоят выше CLI.
 *
 * Раньше сюда приходил ОДИН `external` = весь hostCtx, и он стоял первым: любой
 * слой хоста, включая постороннюю env-переменную, был сильнее собственного
 * атрибута документа (`$slug: from-doc` молча уезжал в другой файл — DEBT 08.08
 * №1). Разделение на strong/weak — и есть починка: `${}` в декларации по-прежнему
 * видит то же, что код (CLI впереди), но документ сильнее конфигов и окружения.
 *
 * При `trusted:false` env НЕ подмешивается (§.3): документ не должен
 * вытягивать секреты окружения через голые `${VAR}`.
 */
function paramsContext(
  params: Record<string, Value>,
  trusted = true,
  layers: HostLayers = {},
): IContext {
  const chain: IContext[] = []
  if (layers.explicit) chain.push(layers.explicit)
  if (layers.strong) chain.push(layers.strong)
  chain.push(objectContext(params))
  if (layers.weak) chain.push(layers.weak)
  if (trusted) chain.push(envContext)
  if (layers.functions) chain.push(layers.functions)
  return chain.length === 1 ? chain[0] : chainContext(...chain)
}

/**
 * Source-плагины с доступом к окружению / ФС / исполнению кода. При `trusted:false`
 * блоки этих типов пропускаются (warn) либо роняют сборку (strictUntrusted).
 */
const UNTRUSTED_SOURCES = new Set(['exec', 'script', 'file', 'env'])

/**
 * AttributeValue → плоское значение; InterpolatedValue резолвится против ctx.
 *
 * `resolveValue`, а не `resolve` (§1.6): если плейсхолдер занимает значение
 * целиком и вернул дерево (`$preset: ${loadJSON('preset.json')}`), значение
 * остаётся деревом. Прецедент — Json5Object в атрибуте (атомарен).
 * Интерполяция в середине строки — по-прежнему строка.
 *
 * `mode` — режим резолва деклараций (text-cast-spec §2.4). В `strict`
 * нерезолвленный плейсхолдер роняет сборку вместо того, чтобы уехать литералом
 * в промпт; дефолт `lenient` — прежнее поведение.
 */
function attrToValue(v: AttributeValue, ctx: IContext, mode?: ResolveMode): Value {
  if (v === null || typeof v !== 'object') return v // scalar
  if (Array.isArray(v)) return v.map((item) => attrToValue(item as AttributeValue, ctx, mode))
  // keepOptOut: значение ложится в контекст — `\${` жив до выхода (§3.1).
  if ('raw' in v) return resolveValue((v as { raw: string }).raw, ctx, { mode, keepOptOut: true })
  return v as Value
}

/**
 * Резолв значения ключа с указанием, ГДЕ рвануло (§2.4).
 *
 * Ошибка резолвера знает только сам плейсхолдер (`${card.system}`); автору нужны
 * ключ и звено — в декларации из десятка полей искать иначе нечего.
 */
function attrToValueAt(
  v: AttributeValue,
  ctx: IContext,
  mode: ResolveMode | undefined,
  where: string,
  key: string,
): Value {
  try {
    return attrToValue(v, ctx, mode)
  } catch (e) {
    throw new Error(`nrd-context: ${where}, ключ "${key}": ${(e as Error).message}`)
  }
}

/** Текст тела блока (raw, без раскрытия escape — как в nrd-core). */
function bodyText(b: Block['body']): string {
  if (b === undefined) return ''
  return typeof b === 'string' ? b : b.raw
}

/**
 * Атрибуты блока → Record (значения резолвятся против paramsCtx). Плюс
 * зарезервированные `$body` (сырое тело) и `$name` (id блока).
 */
function readBlockAttrs(
  block: Block,
  paramsCtx: IContext,
  mode?: ResolveMode,
  where = 'декларация',
): Record<string, Value> {
  const raw: Record<string, Value> = {}
  for (const a of block.attrs) {
    const key = a.key.join('.')
    raw[key] = attrToValueAt(a.value, paramsCtx, mode, where, key) // last-wins
  }
  // Все записи декларации (`$nr: {…}` / `$nr.X` / `$nr-X`) сводятся к плоской
  // `nr-*` ДО диспатча (§3.3) — дальше по коду только она.
  const out = normalizeNrAttrs(raw)
  out[ATTR_BODY] = bodyText(block.body)
  out[ATTR_NAME] = block.id ?? block.name
  return out
}

/** Имя source-плагина: `$nr-type` первым, fallback `$type` (§4.6). */
function pluginName(attrs: Record<string, Value>): string | undefined {
  const t = nrKey(attrs, 'type')
  return t === undefined || t === null ? undefined : String(t)
}

function asNameList(v: Value): string[] {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length > 0)
  return String(v)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

// ---------- Chain entries ----------

interface Entry {
  name: string
  raw: IContext // «голый» контекст источника (для transform $input)
  chainCtx: IContext // готовый к chain (источник — namespaced под именем)
}

/**
 * chain-вид источника: данные доступны И под именем (`bot.name`, §9.4), И на
 * верхнем уровне для merge-first-wins между источниками (`name`, §3.3).
 */
function sourceChainCtx(name: string, raw: IContext): IContext {
  return chainContext(objectContext({ [name]: raw }), raw)
}

function buildExternal(entries: Entry[], paramsCtx: IContext): IContext {
  return chainContext(...entries.map((e) => e.chainCtx), paramsCtx)
}

// ---------- Ссылка вперёд (§1.2) ----------

/** Корневые имена всех путей выражения (включая вложенные `${}` и аргументы). */
function exprRoots(expr: PlaceholderExpr, out: Set<string>): void {
  const fromSegments = (segments: { kind: string; value: unknown }[]): void => {
    const first = segments[0]
    if (first?.kind === 'name') out.add(String(first.value))
    for (const seg of segments) {
      if (seg.kind === 'placeholder') exprRoots((seg.value as Placeholder).expr, out)
    }
  }
  if (expr.kind === 'path') {
    fromSegments(expr.segments as never)
    return
  }
  if (expr.path) fromSegments(expr.path as never)
  for (const arg of expr.args) {
    if (arg.kind === 'path') fromSegments(arg.segments as never)
    else if (arg.kind === 'placeholder') exprRoots(arg.value.expr, out)
  }
}

/** Корневые имена всех `${}` в сыром тексте. */
function placeholderRoots(raw: string, out: Set<string>): void {
  for (const ph of scanPlaceholders(raw)) exprRoots(ph.expr, out)
}

/**
 * Громкая ошибка на ссылку вперёд (§1.2).
 *
 * Порядок звеньев декларативен (`$nr-chain` / порядок блоков): звено видит
 * только объявленные ДО него. Ссылка на объявленное НИЖЕ — не «пока undefined»,
 * а ошибка автора: раньше она проявлялась случайным симптомом («ресурс не
 * найден: ./bots/${registry.active}.md») или не проявлялась вовсе.
 */
function assertNoForwardRef(
  block: Block,
  sourceName: string,
  pending: Set<string>,
): void {
  if (pending.size === 0) return
  const roots = new Set<string>()
  for (const a of block.attrs) {
    const v = a.value
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'raw' in v) {
      placeholderRoots((v as { raw: string }).raw, roots)
    }
  }
  for (const name of roots) {
    if (pending.has(name)) {
      throw new Error(
        `nrd-context: source "${sourceName}" ссылается на "${name}", объявленный НИЖЕ — ` +
          `порядок звеньев декларативен, звено видит только объявленные до него ` +
          `(переставь блоки или задай $nr-chain)`,
      )
    }
  }
}

// ---------- buildContext ----------

export interface BuildContextOptions {
  params?: Record<string, Value>
  baseDir?: string
  storage?: IStorage
  executor?: Executor
  http?: HttpClient
  log?: Logger
  /** Дополнительные / переопределяющие source-плагины (приоритет над builtin). */
  plugins?: Record<string, SourcePlugin>
  /** Дополнительные / переопределяющие transform-плагины. */
  transforms?: Record<string, TransformPlugin>
  /** Функции для ${fn(args)} resolver. Подключаются независимо от `trusted`. */
  functions?: Record<string, FuncFn>
  /**
   * Привилегированные функции — те, что трогают платформу (fs/exec). При
   * `trusted:false` НЕ подключаются (§.3).
   *
   * До слияния корень импортил `builtinFunctions` (loadMDD/loadMDZ/loadJSON/
   * readFile) напрямую из `./functions.js`, а тот — `node:fs`. Теперь ядро
   * portable, а платформенные функции приносит node-ступень: `nrd/node`
   * экспортит те же `builtinFunctions` и кладёт их сюда (nrd-merge §2.5).
   */
  privilegedFunctions?: Record<string, FuncFn>
  /**
   * Доверенный контекст (default `true`). При `false` (untrusted, §.3):
   * - source-блоки `exec`/`script`/`file`/`env` пропускаются (warn);
   * - `privilegedFunctions` (loadMDD/… из `nrd/node`) НЕ подключаются;
   * - env не входит в params-цепочку (`${VAR}` не резолвится об окружение).
   */
  trusted?: boolean
  /**
   * При `trusted:false` — ронять сборку (err) на заблокированном source-блоке
   * вместо warn+skip. Default `false` (lenient).
   */
  strictUntrusted?: boolean
  /**
   * Слой цепочки хоста СИЛЬНЕЕ атрибутов документа — CLI-аргументы и явные
   * параметры вызова (§1.1). Данных звеньев не поставляет, только значения
   * выражений: `${}` в декларации обязан видеть то же, что увидит код
   * (`runz rz f.mds --slug=x` → `%source {path: './${slug}.md'}`).
   */
  strongChain?: IContext
  /**
   * Слой цепочки хоста СЛАБЕЕ атрибутов документа — app-конфиг, глобальный
   * конфиг, окружение (§1.1). Каскад целиком:
   * `opts.params > strongChain > атрибуты документа > weakChain > env`.
   */
  weakChain?: IContext
  /**
   * @deprecated Монолитная цепочка хоста. Трактуется как {@link strongChain} —
   * прежнее поведение (весь хост сильнее документа) сохранено для вызовов,
   * которые ещё не разделили слои. Новый код передаёт strong/weak.
   */
  paramsChain?: IContext
  /**
   * Режим резолва `${}` в ДЕКЛАРАЦИЯХ — корневых атрибутах и атрибутах звеньев
   * (text-cast-spec §2.4). Default `lenient`: нерезолвленный плейсхолдер
   * остаётся литералом (для конфигов это легально, `\${` — штатный opt-out).
   *
   * `strict` — ошибка с именем ключа и звена. Для деклараций источников и
   * промптов молчание опасно: `${card.system}` уехал бы в LLM как есть.
   * Дефолт НЕ меняется: существующие батчи опираются на lenient.
   *
   * На тела звеньев (payload) режим не распространяется — там своя граница.
   */
  mode?: ResolveMode
}

/** Режим резолва деклараций (§2.4). */
export type ResolveMode = 'lenient' | 'strict'

/**
 * Собрать IContext из mdz-конфига (§5.1).
 *
 * 1. parseDocument(sigil '$')
 * 2. merge params: opts.params > корневые атрибуты > env
 * 3. проверить `$required`
 * 4. собрать SourceContext (baseDir, params, log + capabilities)
 * 5. `## $source` → plugin по `$nr-type` → resolve → IContext (namespaced)
 * 6. `## $transform` → plugin → transform(...)
 * 7. chain(...) по `$chain` или порядку блоков
 */
export async function buildContext(
  config: string,
  opts: BuildContextOptions = {},
): Promise<IContext> {
  const doc = parseDocument(config, { sigil: '$' })
  return buildContextFromRoot(doc.doc.root, opts)
}

/**
 * То же, что `buildContext`, но вход — уже разобранное дерево (§5.1, шаги 2-7).
 *
 * Нужен хостам, у которых блоки приходят не из mdz-текста: мост mds → псевдо-
 * `Block[]` (rz §3.2) отдаёт корень напрямую, повторная сериализация в текст
 * потеряла бы спаны интерполяции.
 */
export async function buildContextFromRoot(
  root: Block,
  opts: BuildContextOptions = {},
): Promise<IContext> {
  const baseDir = opts.baseDir ?? (typeof process !== 'undefined' ? process.cwd() : '.')
  const log = opts.log ?? noopLogger
  const trusted = opts.trusted !== false
  const strictUntrusted = opts.strictUntrusted === true

  // --- functions (untrusted не получает FS-функции loadMDD/… — §.3) ---
  // Строятся ПЕРВЫМИ: `${loadJSON('x')}` легален и в корневом атрибуте, и в
  // декларации звена, значит функции обязаны быть в цепочке с самого начала.
  // baseDir доезжает до FuncFn служебным контекстом (§1.5), а не через
  // пользовательский неймспейс.
  const fns = trusted
    ? { ...(opts.privilegedFunctions ?? {}), ...(opts.functions ?? {}) }
    : { ...(opts.functions ?? {}) }
  const fnCtx = funcContext(fns, funcServiceContext(baseDir))

  // --- params ---
  const explicitParams = opts.params ?? {}
  const host: HostLayers = {
    explicit: objectContext(explicitParams),
    strong: opts.strongChain ?? opts.paramsChain,
    weak: opts.weakChain,
    functions: fnCtx,
  }
  // Корневые атрибуты резолвятся об цепочку без себя самих (слой документа пуст).
  const lvl0 = paramsContext({}, trusted, host)
  const rawRoot: Record<string, Value> = {}
  for (const a of root.attrs) {
    const key = a.key.join('.')
    rawRoot[key] = attrToValueAt(a.value, lvl0, opts.mode, 'корневой атрибут', key)
  }
  const resolvedRoot = normalizeNrAttrs(rawRoot)
  // `params` — плоский вид для плагинов, $required и `$nr-chain` (там нужен
  // именно слитый результат); цепочка резолва держит слои раздельно.
  const params: Record<string, Value> = { ...resolvedRoot, ...explicitParams }
  const paramsCtx = paramsContext(resolvedRoot, trusted, host)

  // --- required (при untrusted env не подглядываем — §.3) ---
  const required = asNameList(params['required'])
  const missing = required.filter((name) => {
    if (params[name] !== undefined && params[name] !== null) return false
    if (trusted && typeof process !== 'undefined' && process.env && process.env[name] !== undefined) return false
    return true
  })
  if (missing.length > 0) {
    throw new Error(`nrd-context: отсутствуют обязательные параметры ($required): ${missing.join(', ')}`)
  }

  // --- SourceContext (chain дополняется по ходу) ---
  const sctx: SourceContext = {
    baseDir,
    params,
    log,
    storage: opts.storage,
    executor: opts.executor,
    http: opts.http,
  }

  // --- sources ---
  const explicitPlugins = opts.plugins ?? {}
  const explicitTransforms = opts.transforms ?? {}
  const entries: Entry[] = []
  const byName = new Map<string, Entry>()

  // Имена всех source-блоков в порядке объявления — для детекта ссылки вперёд.
  const sourceBlocks = root.children.filter((b) => b.name === 'source')
  const declaredNames = sourceBlocks.map((b) => b.id ?? 'source')

  for (let i = 0; i < sourceBlocks.length; i++) {
    const block = sourceBlocks[i]
    const sourceName = declaredNames[i]
    // Цепочка СНАЧАЛА, атрибуты ПОТОМ (§1.2). Прежний порядок был обратным:
    // накопленные звенья строились строкой ниже и уезжали плагину, но атрибуты
    // (в т.ч. `$path: ./bots/${registry.active}.md`) были уже прочитаны об
    // params-цепочку, где предыдущего звена нет.
    sctx.chain = buildExternal(entries, paramsCtx)
    assertNoForwardRef(block, sourceName, new Set(declaredNames.slice(i + 1)))
    const attrs = readBlockAttrs(block, sctx.chain, opts.mode, `source "${sourceName}"`)
    const pname = pluginName(attrs)
    if (!pname) {
      throw new Error(`nrd-context: source "${sourceName}" без $nr-type/$type`)
    }
    if (!trusted && UNTRUSTED_SOURCES.has(pname)) {
      const msg = `nrd-context: source "${sourceName}" ($nr-type: ${pname}) пропущен — trusted:false`
      if (strictUntrusted) throw new Error(msg)
      log.warn(msg)
      continue
    }
    const plugin = await resolveSourcePlugin(pname, baseDir, explicitPlugins)
    if (!plugin) {
      throw new Error(`nrd-context: source-плагин "${pname}" не найден (source "${sourceName}")`)
    }
    const ctx = await plugin.resolve(attrs, sctx)
    const entry: Entry = { name: sourceName, raw: ctx, chainCtx: sourceChainCtx(sourceName, ctx) }
    entries.push(entry)
    byName.set(sourceName, entry)
  }

  // --- $nr-chain reorder (порядок = приоритет, first-wins; `$chain` — легаси) ---
  const chainOrder = asNameList(nrKey(params, 'chain'))
  if (chainOrder.length > 0) {
    const ordered: Entry[] = []
    const seen = new Set<string>()
    for (const name of chainOrder) {
      const e = byName.get(name)
      if (e) {
        ordered.push(e)
        seen.add(name)
      }
    }
    for (const e of entries) if (!seen.has(e.name)) ordered.push(e)
    entries.length = 0
    entries.push(...ordered)
  }

  // --- transforms ---
  for (const block of root.children) {
    if (block.name !== 'transform') continue
    const tName = block.id ?? 'transform'
    // Как и у источников (§1.2): цепочка сначала, атрибуты об неё.
    sctx.chain = buildExternal(entries, paramsCtx)
    const attrs = readBlockAttrs(block, sctx.chain, opts.mode, `transform "${tName}"`)
    const pname = pluginName(attrs)
    if (!pname) {
      throw new Error(`nrd-context: transform "${tName}" без $nr-type/$type`)
    }
    const plugin = await resolveTransformPlugin(pname, baseDir, explicitTransforms)
    if (!plugin) {
      throw new Error(`nrd-context: transform-плагин "${pname}" не найден (transform "${tName}")`)
    }

    // `$nr-input` — канон, `$input` — легаси-фолбэк (симметрично nr-type/type).
    const inputRaw = nrKey(attrs, 'input')
    const inputName = inputRaw === undefined ? undefined : String(inputRaw)
    let input: IContext
    if (inputName) {
      const target = byName.get(inputName)
      if (!target) {
        throw new Error(`nrd-context: transform "${tName}" — $input "${inputName}" не найден`)
      }
      input = target.raw
    } else {
      input = buildExternal(entries, paramsCtx)
    }

    const result = await plugin.transform(input, attrs, sctx)

    if (inputName) {
      const target = byName.get(inputName)!
      target.raw = result
      target.chainCtx = sourceChainCtx(inputName, result)
    } else {
      // без $input — результат становится глобальным звеном высшего приоритета
      const entry: Entry = { name: tName, raw: result, chainCtx: result }
      entries.unshift(entry)
      byName.set(tName, entry)
    }
  }

  // --- chain (функции — хвостом; собраны в начале, см. выше) ---
  if (entries.length === 0) return fnCtx
  return chainContext(...entries.map((e) => e.chainCtx), fnCtx)
}

// ---------- chainSources — программная сборка (§5.4) ----------

export interface SourceSpec {
  name: string
  plugin: SourcePlugin
  attrs: Record<string, Value>
}

/**
 * Собрать chain без mdz-конфига: плагины и attrs передаются кодом. Code-плагин —
 * «богатый in-process» путь (возвращает живой IContext напрямую).
 */
export async function chainSources(
  specs: SourceSpec[],
  opts: BuildContextOptions = {},
): Promise<IContext> {
  const baseDir = opts.baseDir ?? (typeof process !== 'undefined' ? process.cwd() : '.')
  const trusted = opts.trusted !== false
  const strictUntrusted = opts.strictUntrusted === true
  const params = opts.params ?? {}
  // functions (untrusted — без привилегированных); в цепочке с самого начала.
  const fns = trusted
    ? { ...(opts.privilegedFunctions ?? {}), ...(opts.functions ?? {}) }
    : { ...(opts.functions ?? {}) }
  const fnCtx = funcContext(fns, funcServiceContext(baseDir))
  const paramsCtx = paramsContext(params, trusted, {
    strong: opts.strongChain ?? opts.paramsChain,
    weak: opts.weakChain,
    functions: fnCtx,
  })
  // (chainSources: документа нет — `params` и есть явные параметры вызова.)
  const sctx: SourceContext = {
    baseDir,
    params,
    log: opts.log ?? noopLogger,
    storage: opts.storage,
    executor: opts.executor,
    http: opts.http,
  }

  const entries: Entry[] = []
  for (const spec of specs) {
    if (!trusted && UNTRUSTED_SOURCES.has(spec.plugin.name)) {
      const msg = `nrd-context: source "${spec.name}" (${spec.plugin.name}) пропущен — trusted:false`
      if (strictUntrusted) throw new Error(msg)
      ;(opts.log ?? noopLogger).warn(msg)
      continue
    }
    sctx.chain = buildExternal(entries, paramsCtx)
    const ctx = await spec.plugin.resolve(spec.attrs, sctx)
    entries.push({ name: spec.name, raw: ctx, chainCtx: sourceChainCtx(spec.name, ctx) })
  }

  if (entries.length === 0) return fnCtx
  return chainContext(...entries.map((e) => e.chainCtx), fnCtx)
}

// ---------- wrapContext — мост IContext → JS (§5.3, перенесено как есть) ----------

/** Рекурсивный Proxy: IContext → обычный JS-объект (для шаблонизаторов). */
export function wrapContext(ctx: IContext): object {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop !== 'string') return undefined
        if (prop === 'toString' || prop === 'valueOf') {
          // Правило §2.1, а не голый `cast('text')`: у звена без тела каст
          // отдаёт пустоту, и шаблон получал бы пустую строку вместо данных.
          const text = toText(ctx)
          return () => text ?? ''
        }
        const val = ctx.get([prop])
        if (val && typeof val === 'object' && typeof (val as { get?: unknown }).get === 'function') {
          return wrapContext(val as IContext)
        }
        if (
          val &&
          typeof val === 'object' &&
          typeof (val as { iterate?: unknown }).iterate === 'function'
        ) {
          return [...(val as { iterate(): Iterable<Value> }).iterate()].map((v) =>
            v && typeof v === 'object' && typeof (v as { get?: unknown }).get === 'function'
              ? wrapContext(v as IContext)
              : v,
          )
        }
        return val
      },
      has(_, prop) {
        if (typeof prop !== 'string') return false
        return ctx.get([prop]) !== undefined
      },
      ownKeys() {
        const keys = ctx.cast('keys') as string[] | undefined
        return keys ?? []
      },
      getOwnPropertyDescriptor(_, prop) {
        if (typeof prop === 'string' && ctx.get([prop]) !== undefined) {
          return { configurable: true, enumerable: true, value: ctx.get([prop]) }
        }
        return undefined
      },
    },
  )
}
