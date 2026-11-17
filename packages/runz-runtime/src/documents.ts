/**
 * @kerneldreams/runz-runtime — документ как программа (rz-merge §2.4).
 *
 * runz понимает четыре формата одним механизмом: `.mdz` / `.md` / `.mdd` /
 * `.mds`. Что именно исполняется — объявлено в самом файле, три источника в
 * порядке:
 *
 *   (а) `--type` / `$type`      → appz-хендлер по имени (резолвится в execute);
 *   (б) `## $handler <id>`      → ts-тело внутри документа, через CodeLoader;
 *       или `$run: <id>` в корне
 *   (в) ни того, ни другого     → режим блокнота: `fn` с `auto` и `$shell`-блоки
 *                                 исполняются в порядке документа.
 *
 * Реестр деклараций (nrd) решает (б) и (в); строковый поиск appz — только (а).
 */

import { busyRetry, parseWait } from './busy.ts'
import { afterStep, beforeStep, clearState, loadState, runHash, stateEnabled } from './run-state.ts'
import { readFileSync } from 'node:fs'
import {
  asText,
  chainContext,
  execBlock,
  funcContext,
  isArray,
  isContext,
  isScalar,
  loadFn,
  objectContext,
  readDecls,
  renderTemplate,
  autoSteps,
  buildProgramContext,
  findDecl,
} from '@kerneldreams/nrd'
import type {
  Decl,
  FuncFn,
  IArray,
  IContext,
  NRDocument,
  Program,
  ProgramCapabilities,
  RenderedMessage,
  TemplateEnv,
  Value,
} from '@kerneldreams/nrd'
import { nodeProgramCaps, buildHelpers } from '@kerneldreams/nrd/node'
import type { ProgramHelpers } from '@kerneldreams/nrd/node'
import { isServiceResult } from '@kerneldreams/nrd/contracts'
import type { ScriptMeta, ScriptResult } from './types.ts'
import { resolveImageProvider, resolveProvider } from './provider.ts'
import { agentHelper, withAgentScope, type HelperAgent, type HelperAgentOptions } from './agent.ts'
import { RunTrace, traceStream, type StepEnd, type StepOptions } from './trace.ts'
import type { ProviderSetup } from '@kerneldreams/nrd/node'

/**
 * helpers runz: nrd-комплект + `agent` — агент backend-nr в `$action` — и `step`
 * — шаг следа прогона внутри одного тела: `const end = helpers.step('dossier', {part})`
 * … `end()`; третьим аргументом функция — шаг вокруг неё, вернёт её результат.
 */
export type RunzHelpers = ProgramHelpers & {
  agent(opts?: HelperAgentOptions): Promise<HelperAgent>
  step: {
    (id: string, opts?: StepOptions): StepEnd
    <T>(id: string, opts: StepOptions | undefined, fn: () => Promise<T>): Promise<T>
  }
  /** След прогона (`run.trace.jsonl`): путь, пока не начат — может не существовать. */
  trace: { file: string | null }
}

/** Провайдер со стримом, который отдаёт usage в след. Прочие методы (embed) — как были. */
function tracedProvider(setup: ProviderSetup, ctx?: IContext): ProviderSetup {
  const p = setup.provider as unknown as { stream: (req: never) => AsyncIterable<{ type: string }> }
  const wrapped = Object.create(p) as typeof p
  // «Занято» (429/503) — пауза и повтор до потолка `$wait_max`, дальше — код 4 (kd-cli-spec §7).
  const waitMaxMs = ctx ? parseWait(asText(ctx.get(['wait_max']) as never)) : undefined
  wrapped.stream = traceStream(
    busyRetry(p.stream.bind(p), {
      ...(waitMaxMs !== undefined ? { waitMaxMs } : {}),
      onWait: (ms, n, err) => process.stderr.write(`[runz] провайдер занят (${(err as Error)?.message ?? String(err)}) — повтор ${n} через ${Math.round(ms / 1000)} с\n`),
    }),
  )
  return { ...setup, provider: wrapped as unknown as ProviderSetup['provider'] }
}

/** Сессия агента: `run`/`swipe` — событием `llm` с usage рана. */
function tracedAgent(agent: HelperAgent, trace: RunTrace): HelperAgent {
  const session = agent.session.bind(agent)
  return Object.assign(Object.create(agent) as HelperAgent, {
    session: async (opts?: Parameters<HelperAgent['session']>[0]) => {
      const s = await session(opts)
      for (const m of ['run', 'swipe'] as const) {
        const orig = s?.[m]
        if (typeof orig !== 'function') continue
        s[m] = (...args: unknown[]) =>
          trace.llm(agent.model, () => orig.apply(s, args), (r: { usage?: { input?: number; output?: number } } | undefined) => r?.usage)
      }
      return s
    },
  })
}

/** nrd-helpers + `agent` + `step` над той же цепочкой; `llm` пишет след. */
function withAgent(helpers: ProgramHelpers, ctx: IContext, program: Program, trace: RunTrace): RunzHelpers {
  const llm = helpers.llm.bind(helpers)
  const agent = agentHelper(ctx, helpers.baseDir, (m) => helpers.log(m), program.root)
  const fallbackModel = asText(ctx.get(['model'])) ?? undefined
  function step(id: string, opts?: StepOptions): StepEnd
  function step<T>(id: string, opts: StepOptions | undefined, fn: () => Promise<T>): Promise<T>
  function step<T>(id: string, opts?: StepOptions, fn?: () => Promise<T>): StepEnd | Promise<T> {
    return fn ? trace.step(id, fn, opts) : trace.manual(id, opts)
  }
  return Object.assign(helpers, {
    llm: (messages: Parameters<ProgramHelpers['llm']>[0], opts?: Parameters<ProgramHelpers['llm']>[1]) =>
      trace.llm(opts?.model ?? fallbackModel, () => llm(messages, opts)),
    agent: async (opts?: HelperAgentOptions) => tracedAgent(await agent(opts), trace),
    step,
    trace: { file: trace.file },
  })
}

/** След прогона документа: `$out` цепочки (от cwd) или `.runz/runs/<id>/` у документа. */
export function traceOf(program: Program, ctx: IContext, meta: ScriptMeta): RunTrace {
  return new RunTrace({ doc: meta.file ?? null, baseDir: program.baseDir, out: asText(ctx.get(['out'])) || undefined })
}

/** Имена блоков, которые блокнот исполняет через executor. */
const EXEC_BLOCKS = new Set(['shell', 'zx'])

/** Имя блока-хендлера документа: `## $handler <id>`. */
const HANDLER_BLOCK = 'handler'

interface Host {
  program: Program
  ctx: IContext
  meta: ScriptMeta
  decls: Decl[]
  caps: ProgramCapabilities
  env: TemplateEnv
  helpers: RunzHelpers
  declaredFuncs: Record<string, FuncFn>
  trace: RunTrace
}

/** Доверие: самодекларация `$nr-trusted: false` либо `--untrusted`. */
function isTrusted(ctx: IContext): boolean {
  if (ctx.get(['nr-trusted']) === false) return false
  const u = ctx.get(['untrusted'])
  if (u === true || asText(u) === 'true') return false
  return true
}

/** Движок шаблонов — по требованию: nunjucks остаётся optional peer. */
async function templateEnv(): Promise<TemplateEnv> {
  const ntpl = await import('@kerneldreams/nrd/template')
  return await ntpl.nunjucksEngine()
}

/**
 * Собрать хост поверх готовой цепочки: декларации, шаблонизатор, helpers с
 * провайдером из этой же цепочки. Один путь для тел документа и для appz,
 * вызванного через `$type`.
 */
async function makeHost(
  program: Program,
  ctx: IContext,
  meta: ScriptMeta,
  caps: ProgramCapabilities,
  declaredFuncs: Record<string, FuncFn>,
  trace: RunTrace,
): Promise<Host> {
  const host: Host = {
    program,
    ctx,
    meta,
    decls: readDecls(program.root, ctx),
    caps,
    env: await templateEnv(),
    helpers: undefined as never,
    declaredFuncs,
    trace,
  }
  host.helpers = withAgent(
    buildHelpers({
      ctx,
      meta,
      decls: host.decls,
      caps,
      provider: tracedProvider(await resolveProvider(ctx), ctx),
      image: () => resolveImageProvider(ctx),
      media: (kind) => resolveImageProvider(ctx, undefined, kind),
      env: host.env,
      runFn: (id) => runFn(host, id, true),
    }),
    ctx,
    program,
    trace,
  )
  return host
}

/**
 * helpers хоста для appz, которому документ отдан через `$type`: те же
 * llm/embed/attr/list/render/run, что получает in-file `## $handler`, — с
 * провайдером и цепочкой, которые видит сам хендлер (`ctx` — цепочка runz с
 * атрибутами документа). Программная цепочка (`$source`-декларации) здесь не
 * собирается: документ читает хендлер, исполнять источники за него — значит
 * исполнить их дважды. `helpers.run(id)` грузит `fn` документа тем же
 * CodeLoader'ом.
 */
export async function documentHelpers(
  program: Program,
  ctx: IContext,
  meta: ScriptMeta,
  hostTrusted = true,
  trace: RunTrace = traceOf(program, ctx, meta),
): Promise<RunzHelpers> {
  const caps = nodeProgramCaps(program.baseDir, hostTrusted && isTrusted(ctx))
  return (await makeHost(program, ctx, meta, caps, {}, trace)).helpers
}

// ============================================================================
// Точка входа
// ============================================================================

/**
 * Исполнить документ. `hostCtx` — цепочка runz, `meta` — метаданные запуска
 * (в `meta.program` уже лежит разобранная программа).
 */
export async function runDocument(
  program: Program,
  hostCtx: IContext,
  meta: ScriptMeta,
  hostTrusted = true,
): Promise<ScriptResult> {
  // Хост уже мог снять доверие (`--untrusted` — флаг CLI, в цепочку он не
  // попадает). Самодекларация документа проверяется здесь же: программный
  // вызов без хоста тоже обязан её видеть.
  const trusted = hostTrusted && isTrusted(hostCtx)
  const caps = nodeProgramCaps(program.baseDir, trusted)
  const programCtx = await buildProgramContext({
    program,
    hostCtx,
    chain: meta.chain,
    caps,
    withRootAttrs: true,
    strictUntrusted: hostCtx.get(['strict_untrusted']) === true,
  })

  // Функции, объявленные телами `fn` (`export const fn`), регистрируются по
  // мере загрузки звена: FuncFn синхронна, а тело — модуль, который грузится
  // лениво. Запись по ссылке — funcContext держит объект, не копию.
  const declaredFuncs: Record<string, FuncFn> = {}
  const ctx = chainContext(funcContext(declaredFuncs), programCtx)
  const trace = traceOf(program, ctx, meta)
  const host = await makeHost(program, ctx, meta, caps, declaredFuncs, trace)
  try {
    const result = await dispatch(host)
    trace.end(!result.exitCode, result.exitCode ? `exit ${result.exitCode}` : undefined)
    return result
  } catch (e) {
    trace.end(false, e)
    throw e
  }
}

async function dispatch(host: Host): Promise<ScriptResult> {
  const { ctx, decls } = host

  const cmd = asText(ctx.get(['cmd']))
  if (cmd !== undefined && cmd !== '') return await command(host, cmd)

  // Порядок §2.4: явный `$run`/`--run` → `## $handler` → блокнот.
  const runId = asText(ctx.get(['run']))
  if (runId) return await runFn(host, runId)

  const handler = decls.find((d) => d.blockName === HANDLER_BLOCK && d.kind === 'fn')
  if (handler) return await runFn(host, handler.id)

  return await notebook(host)
}

async function command(host: Host, cmd: string): Promise<ScriptResult> {
  switch (cmd) {
    case 'action':
    case 'run':
    case 'custom': {
      const id = asText(host.ctx.get(['run']))
      if (!id) return { output: 'runz: укажи $run: <fn_id>', exitCode: 1 }
      return await runFn(host, id)
    }
    case 'debug':
      return handleDebug(host.program.doc)
    case 'tpl':
      return handleTpl(host)
    case 'tpl_inspect':
      return handleTplInspect(host.program.doc)
    default:
      return { output: `runz: неизвестная команда "${cmd}"`, exitCode: 1 }
  }
}

// ============================================================================
// fn — запуск тела документа
// ============================================================================

/**
 * `step` — тело как шаг следа: `helpers.run(id)` и шаги блокнота; верхний `fn`
 * (`$run`, `## $handler`) — сам прогон, шагом не пишется.
 */
async function runFn(host: Host, fnId: string, step = false): Promise<ScriptResult> {
  if (step) return host.trace.step(fnId, () => runFn(host, fnId), stepAttrs(host, fnId))
  const decl = findDecl(host.decls, 'fn', fnId)
  if (!decl) throw new Error(`runz: fn "${fnId}" не найден в документе`)
  const loaded = await loadFn(decl, host.caps)
  if (loaded.func) host.declaredFuncs[decl.id] = loaded.func
  // Контракт runz — `(ctx, meta)`; helpers идут третьим для тел, которые их
  // просят (capability-комплект: ФС, шаблоны, LLM, запуск соседнего шага).
  // Агенты (`helpers.agent`), созданные телом, закрываются по его концу.
  const result = await withAgentScope(async () => loaded.run(host.ctx, host.meta, host.helpers))
  return (result ?? {}) as ScriptResult
}

/** `$nr-icon` / `$nr-title` блока шага — в `step.start` (pipeline-run-spec §3.4). */
function stepAttrs(host: Host, id: string): StepOptions {
  // Тот же id бывает у `## $form <id>` (секция формы шага) — подписи берутся с блока-тела.
  const block = host.program.root.children.filter((b) => b.id === id && b.name !== 'form').pop()
  const attr = (k: string): string | undefined => {
    const a = block?.attrs.filter((x) => x.key.join('.') === k).pop()
    const v = a?.value
    return typeof v === 'string' && v.trim() ? v.trim().replace(/^"(.*)"$/, '$1') : undefined
  }
  return { icon: attr('nr-icon'), title: attr('nr-title') }
}

// ============================================================================
// Блокнот — шаги в порядке документа
// ============================================================================

/**
 * Исполнить документ как блокнот: `fn` с `auto` (имя `step` либо явный
 * `$nr-auto: true`) и `$shell`/`$zx`-блоки — в порядке файла. Результат шага
 * кладётся в цепочку под id блока и виден следующим как `${<id>}`.
 *
 * Декларации source/template/data уже зарегистрированы: цепочка собрана до
 * первого шага (`buildProgramContext`).
 */
async function notebook(host: Host): Promise<ScriptResult> {
  const steps = autoSteps(host.decls)
  const execBlocks = host.program.root.children.filter((b) => EXEC_BLOCKS.has(b.name))

  if (steps.length === 0 && execBlocks.length === 0) {
    return {
      output:
        `runz: в документе нечего исполнять — нет ни $type, ни ## $handler, ` +
        `ни шагов блокнота (## $step / $nr-auto / $shell)`,
      exitCode: 1,
    }
  }

  // Результаты шагов — отдельное звено ПЕРЕД цепочкой программы: шаг видит
  // то, что вернули предыдущие, под собственным id блока.
  const results: Record<string, Value> = {}
  const stepCtx = chainContext(objectContext(results), host.ctx)
  const stepHost: Host = { ...host, ctx: stepCtx }
  stepHost.helpers = withAgent(
    buildHelpers({
      ctx: stepCtx,
      meta: host.meta,
      decls: host.decls,
      caps: host.caps,
      provider: tracedProvider(await resolveProvider(stepCtx), stepCtx),
      image: () => resolveImageProvider(stepCtx),
      media: (kind) => resolveImageProvider(stepCtx, undefined, kind),
      env: host.env,
      runFn: (id) => runFn(stepHost, id, true),
    }),
    stepCtx,
    host.program,
    host.trace,
  )

  const outputs: string[] = []
  const autoIds = new Set(steps.map((s) => s.id))

  // Состояние прогона (kd-cli-spec §8): включает хост (`RUNZ_STATE=1`); шаги, сделанные в оборванном
  // прогоне, берутся из `.runz/state/<имя>.mds`, оборванный шаг повторяется по правилам `$repeatable`.
  const state =
    stateEnabled() && host.meta.file ? loadState(host.meta.file, runHash(readFileSync(host.meta.file, 'utf8'), process.env.RUNZ_STATE_ARGS ?? '')) : null
  const retry = new Set((process.env.RUNZ_RETRY ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  const rootRepeatable = host.program.root.attrs.some((a) => a.key.join('.') === 'repeatable' && String(a.value).trim() === 'true')
  const policyOf = (block: (typeof host.program.root.children)[number]) => {
    const attr = (k: string) => block.attrs.filter((a) => a.key.join('.') === k).pop()?.value
    const eff = attr('effects')
    return { repeatable: rootRepeatable || String(attr('repeatable') ?? '').trim() === 'true', effects: eff !== undefined && String(eff).replace(/[$[\]\s]/g, '') !== '' }
  }

  // `readDecls` мапит детей корня 1:1 — индекс блока = индекс декларации.
  const children = host.program.root.children
  for (let i = 0; i < children.length; i++) {
    const block = children[i]
    if (EXEC_BLOCKS.has(block.name)) {
      const sid = block.id ?? block.name
      if (state) {
        const b = beforeStep(state, sid, policyOf(block), retry)
        if (b.cached) {
          const text = String((b.result as { content?: unknown } | null)?.content ?? '')
          results[sid] = objectContext({ content: text }) as unknown as Value
          if (text) outputs.push(text.replace(/\n+$/, ''))
          continue
        }
      }
      const r = await host.trace.step(block.id ?? block.name, () =>
        execBlock(block, {
          executor: requireExecutor(host),
          external: stepCtx,
          baseDir: host.caps.baseDir,
        }),
      )
      if (!r.ok) return { output: `runz: $${block.name} — ${r.error.message}`, exitCode: 1 }
      const id = block.id ?? block.name
      results[id] = r.value as unknown as Value
      // `$nr-parse: text` (дефолт) кладёт stdout под `content`; у mdd/mdz/json
      // осмысленного плоского текста нет — там значение и есть результат.
      const text = asText(r.value.get(['content'])) ?? r.value.cast<string>('text')
      if (state) afterStep(state, sid, { content: text ?? '' })
      if (text !== undefined && text !== '') outputs.push(text.replace(/\n+$/, ''))
      continue
    }

    const decl = host.decls[i]
    if (!decl || decl.kind !== 'fn' || !decl.auto || !autoIds.has(decl.id)) continue

    if (decl.body.trim() === '' && !decl.src) {
      throw new Error(`runz: шаг "${decl.id}" объявлен, но пуст — нечего исполнять`)
    }
    if (state) {
      const b = beforeStep(state, decl.id, policyOf(block), retry)
      if (b.cached) {
        const saved = (b.result ?? {}) as ScriptResult
        results[decl.id] = saved as unknown as Value
        if (saved.output) outputs.push(saved.output)
        continue
      }
    }
    const result = await runFn(stepHost, decl.id, true)
    if (state && !result.exitCode) afterStep(state, decl.id, result)
    if (isServiceResult(result as never)) {
      throw new Error(
        `runz: шаг "${decl.id}" вернул ServiceResult — долгоживущие сервисы в блокноте не поддерживаются`,
      )
    }
    results[decl.id] = (result ?? {}) as unknown as Value
    if (result.output) outputs.push(result.output)
    if (result.exitCode) return { output: outputs.join('\n'), exitCode: result.exitCode }
  }

  if (state) clearState(state)
  const named = namedOutputs((stepHost.helpers.list('outputs') ?? []).flatMap((n) => String(n).split(',')).map((n) => n.trim()).filter(Boolean), results)
  return { output: outputs.join('\n'), ...(named.length ? { outputs: named } : {}) }
}

/**
 * `$outputs: lyrics, style` (mdz-приложение) → `ScriptResult.outputs` с именем выхода.
 * Имя = id шага: его `outputs` (картинки/файлы) получают это имя, иначе `output` шага — текстовый выход.
 * Шага с таким id нет — берутся артефакты с собственным `name` из любого шага (один шаг — несколько выходов,
 * агент отдаёт `lyrics` и `style` сразу). Нет и их — выхода нет (не ошибка: вид покажет произведённое).
 */
function namedOutputs(names: string[], results: Record<string, Value>): NonNullable<ScriptResult['outputs']> {
  const out: NonNullable<ScriptResult['outputs']> = []
  const all = Object.values(results) as unknown as Array<ScriptResult | undefined>
  for (const name of names) {
    const r = results[name] as unknown as ScriptResult | undefined
    if (r && typeof r === 'object') {
      if (Array.isArray(r.outputs) && r.outputs.length) for (const a of r.outputs) out.push({ ...a, name })
      else if (typeof r.output === 'string' && r.output !== '') out.push({ type: 'text', text: r.output, name })
      continue
    }
    for (const step of all) if (step && Array.isArray(step.outputs)) for (const a of step.outputs) if (a.name === name) out.push(a)
  }
  // Служебные выходы `_имя` (слой агента `_trace`) идут всегда — вид показывает их отдельно от `$outputs`.
  for (const step of all) if (step && Array.isArray(step.outputs)) for (const a of step.outputs) if (a.name?.startsWith('_') && !out.includes(a)) out.push(a)
  return out
}

function requireExecutor(host: Host) {
  if (!host.caps.executor) {
    throw new Error(
      'runz: $shell в блокноте требует capability `executor` — недоступна в недоверенном звене',
    )
  }
  return host.caps.executor
}

// ============================================================================
// tpl — рендер шаблона
// ============================================================================

function messagesToText(messages: RenderedMessage[]): string {
  return messages.map((m) => '%' + m.role + '\n' + m.content).join('\n\n')
}

function handleTpl(host: Host): ScriptResult {
  const id = asText(host.ctx.get(['template']))
  if (!id) return { output: 'runz tpl: укажи $template: <template_id>', exitCode: 1 }
  const decl = findDecl(host.decls, 'template', id)
  if (!decl) return { output: `runz tpl: шаблон "${id}" не найден`, exitCode: 1 }
  const out = renderTemplate(decl, host.ctx, host.env, host.caps)
  return { output: typeof out === 'string' ? out : messagesToText(out) }
}

// ============================================================================
// debug — дамп документа
// ============================================================================

function handleDebug(doc: NRDocument): ScriptResult {
  const lines: string[] = []

  const keys = doc.cast('keys') as string[] | undefined
  if (keys?.length) {
    lines.push('Root keys:')
    for (const key of keys) {
      const val = doc.get([key])
      if (isArray(val)) {
        lines.push('  $' + key + ': -> IArray (' + (val as IArray).length() + ')')
      } else if (isContext(val)) {
        const name = blockName(val as IContext)
        const id = blockId(val as IContext)
        const label = name ? 'block ' + name + (id ? ' ' + id : '') : 'IContext'
        lines.push('  $' + key + ': -> ' + label)
      } else {
        lines.push('  $' + key + ': ' + formatValue(val))
      }
    }
    lines.push('')
  }

  const body = doc.cast('text') as string | undefined
  if (body?.trim()) {
    lines.push('Root body:')
    lines.push(indentText(truncate(body.trim(), 500), '  '))
    lines.push('')
  }

  const records = doc.cast('records') as IArray | undefined
  if (records && records.length() > 0) {
    lines.push('Blocks:')
    for (const item of records.iterate()) {
      if (!isContext(item)) continue
      dumpBlock(item as IContext, lines, 1)
    }
  }

  return { output: lines.join('\n') }
}

function dumpBlock(block: IContext, lines: string[], depth: number): void {
  const pad = '  '.repeat(depth)
  const name = blockName(block) ?? '?'
  const id = blockId(block)
  lines.push(pad + (id ? '## $' + name + ' ' + id : '## $' + name))

  const keys = block.cast<string[]>('keys')
  if (keys?.length) {
    for (const key of keys) {
      const val = block.get([key])
      if (isArray(val)) {
        lines.push(pad + '  $' + key + ': -> IArray (' + (val as IArray).length() + ')')
      } else if (isContext(val)) {
        lines.push(pad + '  $' + key + ': -> IContext')
      } else {
        lines.push(pad + '  $' + key + ': ' + formatValue(val))
      }
    }
  }

  const body = block.cast<string>('text')
  if (body?.trim()) {
    lines.push(pad + '  body (' + body.trim().split('\n').length + ' lines):')
    lines.push(indentText(truncate(body.trim(), 200), pad + '    '))
  }

  const children = block.cast<IArray>('records')
  if (children && children.length() > 0) {
    for (const child of children.iterate()) {
      if (!isContext(child)) continue
      dumpBlock(child as IContext, lines, depth + 1)
    }
  }

  lines.push('')
}

// ============================================================================
// tpl_inspect — карта путей контекста
// ============================================================================

function ntplVar(p: string): string {
  return '<< ' + p + ' >>'
}

function handleTplInspect(doc: NRDocument): ScriptResult {
  const lines: string[] = ['Доступные пути (ntpl: << path >>):', '']
  const keys = doc.cast('keys') as string[] | undefined
  if (keys) {
    for (const key of keys) inspectValue(key, doc.get([key]), lines, 0, 3)
  }
  return { output: lines.join('\n') }
}

function inspectValue(
  path: string,
  val: Value,
  lines: string[],
  depth: number,
  maxDepth: number,
): void {
  const pad = '  '.repeat(depth)

  if (val === undefined || val === null) {
    lines.push(pad + ntplVar(path) + ' = null')
    return
  }

  if (isScalar(val)) {
    const display =
      typeof val === 'string' && val.length > 80
        ? '"' + val.slice(0, 77) + '..."'
        : JSON.stringify(val)
    lines.push(pad + ntplVar(path) + ' = ' + display)
    return
  }

  if (isArray(val)) {
    const arr = val as IArray
    const len = arr.length()
    lines.push(pad + ntplVar(path) + ' -> collection (' + len + ')')
    if (depth >= maxDepth) return
    for (let i = 0; i < Math.min(len, 5); i++) {
      const item = arr.at(i)
      if (isContext(item)) {
        const c = item as IContext
        const name = blockName(c)
        const id = blockId(c)
        const label = id ? path + '.' + id : path + '.' + i
        lines.push(pad + '  [' + i + '] ' + (name ?? 'block') + (id ? ' (id: ' + id + ')' : ''))
        const bKeys = c.cast<string[]>('keys')
        if (bKeys && depth + 1 < maxDepth) {
          for (const k of bKeys) {
            inspectValue(label + '.' + k, c.get([k]), lines, depth + 2, maxDepth)
          }
        }
        const body = c.cast<string>('text')
        if (body?.trim()) {
          lines.push(
            pad +
              '    ' +
              ntplVar(label + ' | text') +
              ' -> body (' +
              body.trim().split('\n').length +
              ' lines)',
          )
        }
      } else {
        inspectValue(path + '.' + i, item, lines, depth + 1, maxDepth)
      }
    }
    if (len > 5) lines.push(pad + '  ... и ещё ' + (len - 5))
    return
  }

  if (isContext(val)) {
    const c = val as IContext
    const name = blockName(c)
    const id = blockId(c)
    const extra = name ? ' (block: ' + name + (id ? ' ' + id : '') + ')' : ''
    lines.push(pad + ntplVar(path) + ' -> context' + extra)
    if (depth >= maxDepth) return
    const cKeys = c.cast<string[]>('keys')
    if (cKeys) {
      for (const k of cKeys) inspectValue(path + '.' + k, c.get([k]), lines, depth + 1, maxDepth)
    }
    return
  }

  lines.push(pad + ntplVar(path) + ' = ' + String(val))
}

// ============================================================================
// Утилиты
// ============================================================================

function blockName(ctx: IContext): string | undefined {
  return ctx.cast<string>('name') ?? undefined
}

function blockId(ctx: IContext): string | undefined {
  return ctx.cast<string>('id') ?? undefined
}

function formatValue(val: Value): string {
  if (val === undefined) return '(undefined)'
  if (val === null) return 'null'
  if (typeof val === 'string') return val.length > 100 ? '"' + val.slice(0, 97) + '..."' : val
  return String(val)
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '\n  ...'
}

function indentText(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n')
}
