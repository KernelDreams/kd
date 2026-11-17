/**
 * @kerneldreams/runz-runtime — orchestrator
 *
 * Resolves a script, composes the chain, builds ScriptMeta, runs the script
 * through a runner, and applies append-mode side effects. Shared by the CLI
 * and the web service.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { objectContext, emptyContext, get, asText } from '@kerneldreams/nrd'
import type { IContext, NRDocument, Program, Value } from '@kerneldreams/nrd'
import { loadProgram, PROGRAM_EXTENSIONS } from '@kerneldreams/nrd/node'
import type { HostChain } from '@kerneldreams/nrd/contracts'
import { importScriptFn, importScriptModule, parseDocFile } from './loader.ts'
import { helpText, parseFlags, unknownFlags, unknownFlagsError, wantsHelp } from './flags.ts'
import { documentHelpers, runDocument, traceOf } from './documents.ts'
import { registerResolveHook } from './hook.ts'
import {
  findScript,
  findProjectDir,
  globalRunzDir,
} from './registry.ts'
import { buildScopes, flattenChain, loadConfigFile } from './chain.ts'
import { parsePathList, resolvePath } from './paths.ts'
import { selectRunner } from './runners/index.ts'
import type {
  DocumentHandlerFn,
  ScriptMeta,
  ScriptOutput,
  ScriptResult,
  LoadedScript,
} from './types.ts'
import { isServiceResult } from './types.ts'

export interface ExecuteOptions {
  /** Script name or path. `null` for a virtual run (`--type=X` only). */
  script: string | null
  /** Script data arguments (the CLI chain layer). */
  args: Record<string, Value>
  /** Working directory. Default: `process.cwd()`. */
  cwd?: string
  /** --runz-debug */
  debug?: boolean
  /** --runz-dry */
  dry?: boolean
  /** Execution environment. Default `node`. */
  runtime?: string
  /** Explicit config file (`--runz-config`). */
  configPath?: string
  /** Pre-serialized chain file (`--runz-chain`). */
  chainFile?: string
  /** Environment variables for the chain. Default `process.env`. */
  env?: Record<string, string>
  /**
   * `--untrusted`: document-цепочка без sys-хвоста/маунтов/env. Документ также
   * может объявить недоверие сам через `$nr-trusted: false`.
   */
  untrusted?: boolean
}

export interface ExecuteResult {
  result: ScriptOutput
  meta: ScriptMeta
  scriptName: string
}

/** Файл, который runz исполняет как документ (`.mdz` / `.md` / `.mdd` / `.mds`). */
function isProgramFile(file: string): boolean {
  return PROGRAM_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))
}

/** Resolve the script config (`<name>.config.md`) next to a script file. */
function findScriptConfig(file: string, name: string): NRDocument | null {
  const candidate = path.join(path.dirname(file), `${name}.config.md`)
  return loadConfigFile(candidate)
}

export async function execute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const cwd = opts.cwd ?? process.cwd()
  const runtime = opts.runtime ?? 'node'
  const env = opts.env ?? (process.env as Record<string, string>)
  const projectDir = findProjectDir(cwd)

  // --- configs (project + global) ---
  const globalConfig = loadConfigFile(path.join(globalRunzDir(), 'config.md'))
  const projectConfig = projectDir
    ? loadConfigFile(path.join(projectDir, '.runz', 'config.md'))
    : null
  const explicitConfig = opts.configPath
    ? loadConfigFile(resolvePath(opts.configPath, cwd))
    : null

  // --- $paths (CLI > project config > global config) ---
  const paths = parsePathList(
    opts.args.paths ??
    projectConfig?.get(['paths']) ??
    globalConfig?.get(['paths']),
    cwd,
  )

  // --- resolve script file, doc and handler ---
  let file: string | null = null
  let doc: NRDocument | null = null
  let program: Program | null = null
  let scriptName: string
  let handlerName: string | null = null
  let fn: import('./types.ts').ScriptFn
  // Что скрипт объявил о себе: известные флаги и свой текст справки.
  let declaredFlags: unknown
  let usage: string | undefined

  if (opts.script === null) {
    // Virtual run: handler comes from `$type` in the chain.
    handlerName = asText(opts.args.type) ?? null
    if (!handlerName) {
      throw new Error('runz: no script given and no --type in arguments')
    }
    scriptName = handlerName
  } else {
    const resolved = findScript(opts.script, { cwd, projectDir, paths })
    if (!resolved) {
      throw new Error(`runz: script not found: ${opts.script}`)
    }
    file = resolved.file
    scriptName = resolved.name
    // Документ любого из четырёх форматов приводится к программе один раз
    // (rz-merge §2.4): и appz-хендлер, и внутренний `## $handler`, и блокнот
    // работают с одним и тем же разобранным деревом.
    if (isProgramFile(file) || opts.args.as !== undefined) {
      // Профили формы (`preset`): `--models=opus` разворачивается атрибутами профиля поверх документа.
      program = loadProgram(file, opts.args.as, { presets: opts.args })
      doc = program.doc
      handlerName = asText(opts.args.type) ?? asText(doc.get(['type'])) ?? null
    }
  }

  // Недоверие: CLI-флаг `--untrusted` ИЛИ самодекларация `$nr-trusted: false`.
  // Считается здесь — документ уже разобран, а решение нужно и цепочке, и
  // рантайму документа (флаг CLI в цепочку не попадает).
  const trusted = !(opts.untrusted === true || doc?.get(['nr-trusted']) === false)

  if (handlerName) {
    const handler = findScript(handlerName, { cwd, projectDir, paths }, { tsOnly: true })
    if (!handler) {
      throw new Error(`runz: handler not found for type "${handlerName}"`)
    }
    if (!handler.file.endsWith('.ts')) {
      throw new Error(`runz: handler "${handlerName}" must be a .ts script`)
    }
    const imported = await importScriptFn(handler.file)
    const handlerFn = imported as unknown as DocumentHandlerFn
    // Документ отдан appz через `$type` → третьим аргументом те же helpers, что
    // получает in-file `## $handler`. Виртуальный `--type` без
    // документа — без helpers: им не на чем стоять (нет baseDir и деклараций).
    // След прогона: хендлер — сам прогон, шаги — его `helpers.step`/`helpers.run`.
    fn = program
      ? async (ctx, m) => {
          const trace = traceOf(program!, ctx, m as ScriptMeta)
          try {
            const r = await handlerFn(ctx, m as ScriptMeta, await documentHelpers(program!, ctx, m as ScriptMeta, trusted, trace))
            trace.end(true)
            return r
          } catch (e) {
            trace.end(false, e)
            throw e
          }
        }
      : imported
  } else if (program) {
    // Ни `--type`, ни `$type` — документ исполняется собственным рантаймом:
    // `## $handler` / `$run` / блокнот. Тела `fn` импортируются временным
    // модулем рядом с документом — им нужен тот же хук, что и скриптам:
    // `@kerneldreams/*` из дистрибутива и `.runz/`-окружения.
    registerResolveHook()
    fn = (ctx, m) => runDocument(program!, ctx, m as ScriptMeta, trusted)
  } else {
    // `.ts` — скрипт; документные расширения ушли веткой выше. Всё прочее —
    // громкий отказ: молчаливая попытка импортировать .json/.txt даёт
    // «no default export function» вместо внятной причины.
    if (!/\.(ts|mjs)$/i.test(file!)) {
      throw new Error(
        `runz: не знаю, как исполнить "${file}" — ожидался .ts, бандл .mjs либо документ ` +
          `(${PROGRAM_EXTENSIONS.join(' | ')}); для нестандартного расширения укажи --as=mdz|mdd|mds`,
      )
    }
    const mod = await importScriptModule(file!)
    fn = mod.fn
    declaredFlags = mod.flags
    usage = mod.usage
  }
  if (doc) declaredFlags = doc.get(['flags'])

  // --- справка и известные флаги: до цепочки и до любого действия скрипта ---
  const flags = parseFlags(declaredFlags)
  const shown = opts.script ?? `--type=${scriptName}`
  if (!flags?.has('help') && wantsHelp(opts.args)) {
    const output = helpText({ script: shown, file, usage, description: doc ? asText(doc.get(['description'])) ?? undefined : undefined, flags })
    const meta: ScriptMeta = {
      file,
      doc,
      program,
      projectDir,
      dataDir: '',
      debug: opts.debug ?? false,
      dry: opts.dry ?? false,
      chain: { strong: emptyContext, weak: emptyContext },
    }
    return { result: { output }, meta, scriptName }
  }
  if (flags) {
    const bad = unknownFlags(opts.args, flags)
    if (bad.length) throw new Error(unknownFlagsError(shown, bad, flags))
  }

  // --- script config (<name>.config.md next to the script) ---
  const scriptConfig = file ? findScriptConfig(file, scriptName) : null

  // --- chain ---
  let ctx: IContext
  let flat: Record<string, Value>
  let hostChain: HostChain
  if (opts.chainFile) {
    const raw = fs.readFileSync(opts.chainFile, 'utf8')
    flat = JSON.parse(raw) as Record<string, Value>
    ctx = objectContext(flat)
    // Сериализованная цепочка — уже слитый монолит, слои в ней неразличимы:
    // отдаём как сильный слой (прежнее поведение), слабого нет.
    hostChain = { strong: ctx, weak: emptyContext }
  } else {
    const layers = {
      cliArgs: opts.args,
      doc,
      explicitConfig,
      scriptConfig,
      projectConfig,
      globalConfig,
      env,
    }
    const scopes = buildScopes(layers, { trusted })
    ctx = scopes.document
    hostChain = { strong: scopes.strong, weak: scopes.weak }
    flat = flattenChain(layers)
  }

  // --- ScriptMeta ---
  const dataDirRaw = asText(get(['dataDir'], ctx))
  const dataDir = dataDirRaw
    ? resolvePath(dataDirRaw, projectDir ?? cwd)
    : path.join(
        projectDir ? path.join(projectDir, '.runz') : globalRunzDir(),
        'data',
        scriptName,
      )

  const meta: ScriptMeta = {
    file,
    doc,
    program,
    projectDir,
    dataDir,
    debug: opts.debug ?? false,
    dry: opts.dry ?? false,
    // Разделённые слои — хендлерам, которые сами читают атрибуты документа и
    // обязаны поставить его В СЕРЕДИНУ каскада (resolve-fix §1.1).
    chain: hostChain,
  }

  // --- debug: dump chain + reproduction hint ---
  if (meta.debug) {
    const base = projectDir ?? cwd
    const debugDir = path.join(base, '.runz', 'debug')
    try {
      fs.mkdirSync(debugDir, { recursive: true })
      const chainFile = path.join(debugDir, 'last-chain.json')
      fs.writeFileSync(chainFile, JSON.stringify(flat, null, 2))
      process.stderr.write(`[runz:debug] chain → ${chainFile}\n`)
      process.stderr.write(`[runz:debug] script: ${file ?? `(virtual: ${scriptName})`}\n`)
      process.stderr.write(`[runz:debug] projectDir: ${projectDir ?? '(none)'}\n`)
      process.stderr.write(`[runz:debug] dataDir: ${dataDir}\n`)
      process.stderr.write(
        `[runz:debug] reproduce: runz ${opts.script ?? `--type=${scriptName}`} --runz-chain=${chainFile}\n`,
      )
    } catch {
      // debug dump is best-effort
    }
  }

  // --- dry run: resolve without executing ---
  if (meta.dry) {
    const info = {
      script: scriptName,
      file,
      handler: handlerName,
      runtime,
      projectDir,
      dataDir,
      chain: flat,
    }
    const result: ScriptResult = { output: JSON.stringify(info, null, 2) }
    return { result, meta, scriptName }
  }

  // --- run ---
  const runner = selectRunner(runtime)
  const loaded: LoadedScript = { name: scriptName, file, doc, fn, runtime }
  const result = await runner.run(loaded, ctx, meta)

  // --- append-mode side effect ---
  if (!isServiceResult(result) && result.append && file) {
    fs.appendFileSync(file, result.append)
  }

  return { result, meta, scriptName }
}
