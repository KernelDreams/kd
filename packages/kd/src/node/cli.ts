/**
 * Вход `kd` (kd-cli-spec §3–§7): служебные флаги до имени тула, каталог, первое слово
 * (тул → файл → объект по правилам ссылок → код 2), вызов тула через рантайм runz.
 *
 * stdout — только содержимое результата; stderr — ход и диагностика. Коды 0–4; на кодах 2 и 3
 * последняя строка stderr — исправленная команда целиком. `--json` — конверт одной строкой.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { execute, importScriptModule, isServiceResult, stateFileOf } from '@kerneldreams/runz-runtime'
import * as nrd from '@kerneldreams/nrd'
import type { LinkActionDef, LinkRules } from '@kerneldreams/ui-protocol'
import { defaultAction, type ToolDecl } from '../core/decl.js'
import { formatCommand, missingError, normalize, splitWords, tokenize, type KdValue, type Normalized, type RawCall, type ToolCall } from '../core/call.js'
import { helpOf } from '../core/describe.js'
import { EXIT, isKdError, KdError, type ExitCode, nearest } from '../core/errors.js'
import { mergeRaw, parseParamsText } from '../core/params.js'
import { assertNoConflicts, describeEntry, loadCatalog, loadDecl, type Catalog, type ToolEntry } from './catalog.js'
import { expandHome, KIT_ROOT, readAttrs, strList } from './home.js'
import { registerApp } from './apps.js'
import { loadLayers, type Layers } from './layers.js'
import { actionVars, actionVarsFor, actionWord, fileRule, isFile, loadRules, matchWord, objectActions, resolveTemplate, shellSplit, wordKinds } from './objects.js'
import { hasModelProvider, prepareProviderEnv, providersFile, PRESETS } from './providers.js'
import { writeCache } from './cache.js'
import { setHost } from './host.js'

export interface Io {
  stdout: (s: string) => void
  stderr: (s: string) => void
  /** Читать stdin целиком (`--params -`, `--поле=-`). */
  readStdin: () => Promise<string>
  /** Есть ли человек: stdin и stderr — терминал. */
  interactive: boolean
  /** Вопрос человеку (только при `interactive`). */
  ask?: (question: string) => Promise<string>
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface Service {
  dry: boolean
  json: boolean
  verbose: boolean
  help: boolean
  version: boolean
  /** `--ui` — прогон в окне (§9): лента сессии в `<nr-chat>`. */
  ui: boolean
  /** `--retry=<шаг>[,…]|*` — повторить оборванный шаг без `$repeatable` (§8). */
  retry?: string
}

/** Служебные флаги — до имени тула или объекта; всё после — тулу. */
export function splitService(argv: string[]): { service: Service; rest: string[] } {
  const service: Service = { dry: false, json: false, verbose: false, help: false, version: false, ui: false }
  let i = 0
  for (; i < argv.length; i++) {
    const t = argv[i]!
    if (t === '--dry') service.dry = true
    else if (t === '--json') service.json = true
    else if (t === '-v' || t === '--verbose') service.verbose = true
    else if (t === '--help' || t === '-h') service.help = true
    else if (t === '--version') service.version = true
    else if (t === '--ui') service.ui = true
    else if (t.startsWith('--retry=')) service.retry = t.slice(8)
    else break
  }
  return { service, rest: argv.slice(i) }
}

interface Ctx {
  io: Io
  service: Service
  layers: Layers
  catalog: Catalog
  rules?: LinkRules
  depth: number
}

/** Итог прогона для конверта `--json`. */
interface Outcome {
  code: ExitCode
  output?: string
  artifacts?: unknown[]
}

const rulesOf = (c: Ctx): LinkRules => (c.rules ??= loadRules(c.layers, c.catalog, (w) => c.io.stderr(`kd: ${w}\n`)))

/** Читать значение `@файл` / `-` (§9.4). */
async function readValue(v: string, io: Io): Promise<string> {
  if (v === '-') return io.readStdin()
  const p = resolvePath(io.cwd, expandHome(v.slice(1)))
  if (!existsSync(p)) throw new KdError(2, `kd: нет файла ${p}`, { hint: `файл значения ${v}` })
  return readFileSync(p, 'utf8')
}

/** Извлечь служебные поля вызова (`--params`), не трогая слов после `--`. */
function takeParams(argv: string[]): { argv: string[]; params?: string } {
  const out: string[] = []
  let params: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t === '--') {
      out.push(...argv.slice(i))
      break
    }
    if (t.startsWith('--params=')) params = t.slice(9)
    else if (t === '--params' && argv[i + 1] !== undefined) params = argv[++i]
    else out.push(t)
  }
  return { argv: out, ...(params !== undefined ? { params } : {}) }
}

/** Вопрос о недостающих полях в терминале — по объявлению: варианты, умолчание. */
async function askMissing(decl: ToolDecl, n: Normalized, io: Io): Promise<Normalized> {
  if (!io.ask) return n
  const params: Record<string, unknown> = { ...n.call.params }
  for (const name of n.missing) {
    const f = decl.fields.find((x) => x.name === name)!
    const choices = f.schema.enum ? ` [${f.schema.enum.join('/')}]` : ''
    const def = f.schema.default !== undefined && f.schema.default !== '' ? ` (${String(f.schema.default)})` : ''
    const answer = (await io.ask(`${f.schema.title ?? name}${choices}${def}: `)).trim()
    if (answer !== '') params[name] = answer
  }
  return normalize(decl, { tool: decl.name, ...(n.call.action ? { action: n.call.action } : {}), params })
}

/** `$needs` до старта (§7): нет нужного — код 3 с командой, как получить. */
function checkNeeds(c: Ctx, decl: ToolDecl): void {
  for (const need of decl.needs) {
    if (need === 'model' && !hasModelProvider(c.layers, c.io.env)) {
      throw new KdError(3, `kd ${decl.name}: нужна модель, а провайдер не настроен`, {
        field: 'model',
        hint: `провайдеры из коробки: ${Object.keys(PRESETS).join(', ')} или любой OpenAI-совместимый адрес`,
        fix: 'kd provider add anthropic --key=<ключ>',
      })
    }
  }
}

/** В терминале — один раз спросить провайдера и ключ и запомнить (§7). */
async function askProvider(c: Ctx): Promise<boolean> {
  if (!c.io.interactive || !c.io.ask) return false
  const name = (await c.io.ask(`Нужна модель. Провайдер [${Object.keys(PRESETS).join('/')}]: `)).trim() || 'anthropic'
  const key = (await c.io.ask(`Ключ ${name}: `)).trim()
  if (!key) return false
  await dispatch(c, ['provider', 'add', name, `--key=${key}`])
  return true
}

/** Окружение прогона: слой runz (студийный профиль или свой), корень CLI runz, ключи провайдеров. */
function prepareEnv(c: Ctx): void {
  const env = c.io.env
  env.RUNZ_GLOBAL_DIR ||= c.layers.runzDir
  // Копия kd исполняет своим рантаймом: унаследованный RUNZ_HOME (runz, релиз стенда) не берётся.
  try {
    env.RUNZ_HOME = dirname(createRequire(import.meta.url).resolve('@kerneldreams/runz/package.json'))
  } catch {
    // без CLI runz: встроенных скриптов runz нет, тулы kd и appz работают
  }
  if (c.layers.settings.wait_max !== undefined) env.RUNZ_WAIT_MAX ||= String(c.layers.settings.wait_max)
  prepareProviderEnv(c.layers, env)
  env.KD_DATA ||= c.layers.copy.dataDir
  // Состояние прогона документов с шагами (§8): продолжение той же командой.
  env.RUNZ_STATE = '1'
  // Задачи (kd job): реестр слоя runz копии — студийный ~/.runz/jobs или свой.
  env.RUNZ_JOBS_DIR ||= join(c.layers.runzDir, 'jobs')
  if (c.service.retry) env.RUNZ_RETRY = c.service.retry
}

/** Исполнить нормализованный вызов через рантайм runz. */
async function execTool(c: Ctx, t: ToolEntry, decl: ToolDecl, call: ToolCall): Promise<Outcome> {
  prepareEnv(c)
  const args: Record<string, unknown> = { ...call.params }
  c.io.env.RUNZ_STATE_ARGS = JSON.stringify(call)
  if (call.action && !decl.legacy) args[decl.actionArg] = call.action
  const own = providersFile(c.layers)
  const shared = join(c.layers.copy.sharedHome, 'providers.mdz')
  const configPath = existsSync(own) ? own : c.layers.copy.readsShared && existsSync(shared) ? shared : undefined
  const prevCwd = process.cwd()
  // Тул идёт в этом же процессе: его окружение — окружение вызова (в проде это и есть process.env).
  const prevEnv = process.env
  process.env = c.io.env
  setHost({ io: c.io, layers: c.layers })
  let result: Awaited<ReturnType<typeof execute>>['result']
  try {
    ;({ result } = await execute({ script: t.file, args: args as never, cwd: c.io.cwd, env: c.io.env as Record<string, string>, ...(configPath ? { configPath } : {}) }))
  } finally {
    process.env = prevEnv
    if (process.cwd() !== prevCwd) process.chdir(prevCwd)
  }
  if (isServiceResult(result)) {
    c.io.stderr(`kd: сервис запущен — pid ${result.pid}${result.url ? ` — ${result.url}` : ''}\n`)
    return { code: 0, output: result.url ?? '' }
  }
  const code = result.exitCode ?? 0
  return { code: (code >= 0 && code <= 4 ? code : 1) as ExitCode, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.outputs ? { artifacts: result.outputs } : {}) }
}

/** Запуск тула по слову каталога или файлу. */
async function runTool(c: Ctx, t: ToolEntry, argv: string[], pre: Partial<RawCall> = {}): Promise<Outcome> {
  const decl = await loadDecl(t)
  const beforeDash = argv.indexOf('--') < 0 ? argv : argv.slice(0, argv.indexOf('--'))
  if (c.service.help || beforeDash.includes('--help') || beforeDash.includes('-h')) {
    c.io.stdout(helpOf(decl) + '\n')
    return { code: 0 }
  }
  // Служебные флаги runz (`--runz-dry`, `--runz-debug`…) после имени ушли бы тулу и исполнили его всерьёз.
  const runzFlag = beforeDash.find((w) => /^--(no-)?runz-/.test(w))
  if (runzFlag) {
    const runz = beforeDash.filter((w) => /^--runz-/.test(w))
    const svc = [
      ...(c.service.dry || runz.some((w) => w.startsWith('--runz-dry')) ? ['--dry'] : []),
      ...(c.service.json ? ['--json'] : []),
      ...(c.service.verbose || runz.some((w) => /^--runz-(debug|verbose)/.test(w)) ? ['-v'] : []),
    ]
    const fixed = ['kd', ...svc, t.layerLabel === 'file' ? t.file : t.name, ...argv.filter((w) => !/^--(no-)?runz-/.test(w))]
    throw new KdError(2, `kd: «${runzFlag}» — служебный флаг runz; служебные флаги kd стоят до имени: kd --dry … (ничего не запущено)`, { fix: fixed.join(' ') })
  }
  // `--ui` у любого тула (§9): до имени — служебный; после имени — у объявленного тула без своего поля `ui`.
  const ownUi = decl.fields.some((f) => f.name === 'ui')
  let wantUi = c.service.ui
  if (!ownUi && !decl.legacy && beforeDash.includes('--ui')) {
    wantUi = true
    const i = argv.indexOf('--ui')
    argv = [...argv.slice(0, i), ...argv.slice(i + 1)]
  }
  const { argv: rest, params: paramsSrc } = takeParams(argv)
  const tokens = tokenize(rest, decl)
  if (!decl.legacy) {
    // `--поле=@файл` / `--поле=-` — значение из файла или stdin (§9.4).
    for (const fl of tokens.flags) {
      const f = decl.fields.find((x) => x.name === fl[0])
      if (f && f.schema.type === 'string' && typeof fl[1] === 'string' && (fl[1] === '-' || (fl[1].startsWith('@') && fl[1].length > 1))) fl[1] = await readValue(fl[1], c.io)
    }
  }
  let raw = splitWords(decl, tokens, { kindOf: (w) => wordKinds(w, rulesOf(c), c.io.cwd) })
  if (pre.action && !raw.action) raw = { ...raw, action: pre.action }
  if (pre.params) raw = { ...raw, params: { ...pre.params, ...raw.params } }
  if (paramsSrc !== undefined) {
    const text = paramsSrc === '-' ? await c.io.readStdin() : await readValue(paramsSrc.startsWith('@') ? paramsSrc : `@${paramsSrc}`, c.io)
    const extra = parseParamsText(nrd, text)
    if (extra.tool && extra.tool !== decl.name) throw new KdError(2, `kd: --params для тула «${extra.tool}», а вызван «${decl.name}»`)
    raw = mergeRaw(raw, extra)
  }
  let n = normalize(decl, raw)
  if (n.missing.length) {
    if (c.io.interactive) n = await askMissing(decl, n, c.io)
    if (n.missing.length) throw missingError(decl, n)
  }
  try {
    checkNeeds(c, decl)
  } catch (e) {
    if (!(isKdError(e) && e.code === 3 && (await askProvider(c)))) throw e
  }
  if (c.service.dry) {
    const act = decl.actions.find((a) => a.name === n.call.action)
    if (!(act?.dry || decl.dry)) {
      throw new KdError(2, `kd: «${decl.name}${n.call.action ? ` ${n.call.action}` : ''}» не заявил исполнение всухую ($dry) — ничего не запущено; вызов проверен: ${formatCommand(decl, n.call)}`, { fix: formatCommand(decl, n.call) })
    }
    // Тул заявил всухую — исполняется с `dry: true` (своё поле или флаг рантайма).
    n.call.params.dry = true
  }
  if (c.service.verbose) c.io.stderr(`kd: ${formatCommand(decl, n.call)}  (${t.file})\n`)
  if (wantUi && ownUi) n.call.params.ui = true
  if (wantUi && !ownUi) return execInWindow(c, t, decl, n.call)
  return execTool(c, t, decl, n.call)
}

/** Прогон в окне (§9): stderr тула и kd — ходом в ленте, вывод — ответом; сессия `.mds` остаётся. */
async function execInWindow(c: Ctx, t: ToolEntry, decl: ToolDecl, call: ToolCall): Promise<Outcome> {
  const { runInWindow, runTitle } = await import('./run-window.js')
  const l = c.layers
  const command = decl.legacy ? ['kd', t.layerLabel === 'file' ? t.file : t.name].join(' ') : formatCommand(decl, call)
  const realErr = process.stderr.write.bind(process.stderr)
  const ioErr = c.io.stderr
  const r = await runInWindow(
    {
      dataDir: l.copy.dataDir,
      home: l.copy.readsShared ? l.copy.sharedHome : l.copy.dataDir,
      cwd: c.io.cwd,
      command,
      title: runTitle(decl.name, c.io.cwd),
      ...(/\.(md|mdz|mdd)$/i.test(t.file) ? { stateFile: stateFileOf(t.file) } : {}),
      open: c.io.env.KD_NO_OPEN !== '1',
      ...(c.io.env.KD_UI_HOLD === '0' ? {} : { hold: untilSignal }),
      log: (m) => ioErr(`${m}\n`),
    },
    async (progress) => {
      // Ход тула — и в терминал, и в ленту.
      // io.stderr вызова может сам писать в process.stderr — строка попадает в ленту один раз.
      let viaIo = false
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        if (!viaIo) progress(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        return (realErr as (...a: unknown[]) => boolean)(chunk, ...rest)
      }) as typeof process.stderr.write
      c.io.stderr = (s) => {
        progress(s)
        viaIo = true
        try {
          ioErr(s)
        } finally {
          viaIo = false
        }
      }
      try {
        return await execTool(c, t, decl, call)
      } finally {
        process.stderr.write = realErr
        c.io.stderr = ioErr
      }
    },
  )
  ioErr(`kd: сессия ${r.session}\n`)
  return { code: r.code as ExitCode, ...(r.output !== undefined ? { output: r.output } : {}), ...(r.artifacts ? { artifacts: r.artifacts } : {}) }
}

/** Ждать Ctrl+C / SIGTERM. */
function untilSignal(): Promise<void> {
  return new Promise((r) => {
    const done = (): void => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      r()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}

/** Документ исполняемый: `$handler` / `$type` / `$app` / `$run`, шаги блокнота, `$shell`, или наследует базу (`$[[…]]`). */
const EXEC_DOC = /^(\$(handler|type|app|run)\s*:|## \$(step|handler|shell|zx)\b|\$\[\[)/m

/** Первое слово — существующий файл (§4.2). */
async function runFile(c: Ctx, path: string, word: string, argv: string[]): Promise<Outcome> {
  const lower = path.toLowerCase()
  if (lower.endsWith('.mds')) {
    const chat = c.catalog.tools.get('chat')
    if (!chat) throw new KdError(3, 'kd: сессия .mds открывается тулом chat, а его в каталоге нет')
    return runTool(c, chat, [path, ...argv])
  }
  if (/\.(md|mdz|mdd)$/.test(lower)) {
    const text = readFileSync(path, 'utf8')
    if (EXEC_DOC.test(text)) return runTool(c, { name: basename(path).replace(/\.(md|mdz|mdd)$/i, ''), file: path, layer: 'project', layerLabel: 'file' }, argv)
    if (!argv.length) {
      c.io.stdout(text.endsWith('\n') ? text : text + '\n')
      return { code: 0 }
    }
  }
  return runObject(c, word, argv, path)
}

/** Объект: файл по виду или слово по правилам ссылок (§4.2–4.4). */
async function runObject(c: Ctx, word: string, argv: string[], path?: string): Promise<Outcome> {
  const rules = rulesOf(c)
  const matches = path ? [] : matchWord(word, rules.links)
  if (!path && !matches.length) return unknownWord(c, word)
  // Равные по длине и слою, но разных видов — выбор (в терминале) или код 2.
  if (matches.length > 1 && matches[0]!.length === matches[1]!.length && matches[0]!.rule.layer === matches[1]!.rule.layer && matches[0]!.rule.kind !== matches[1]!.rule.kind) {
    const tied = matches.filter((m) => m.length === matches[0]!.length && m.rule.layer === matches[0]!.rule.layer)
    const pick = await choose(c, `«${word}» подходит нескольким правилам`, tied.map((m) => `${m.rule.id} (${m.rule.kind ?? '—'})`))
    matches.unshift(tied[pick]!)
  }
  const ruleList = path ? fileRule(path) : [matches[0]!.rule, ...matches.slice(1).map((m) => m.rule).filter((r) => r.kind && r.kind !== matches[0]!.rule.kind)]
  const actions = objectActions(rules, ruleList)
  if (!actions.length) throw new KdError(2, `kd: «${word}» — ${path ? `файл вида ${ruleList.map((r) => r.kind).join(', ')}` : `объект вида ${matches[0]!.rule.kind ?? matches[0]!.rule.id}`}, но действий для kd у него нет`)
  // Действие — первым или последним словом (§5).
  const words = argv.filter((a) => !a.startsWith('-'))
  const byWord = (w: string | undefined): LinkActionDef | undefined => (w === undefined ? undefined : actions.find((a) => actionWord(a) === w))
  let act = byWord(words[0])
  let rest = argv
  if (act) rest = argv.filter((a, i) => i !== argv.indexOf(words[0]!))
  else if ((act = byWord(words[words.length - 1]))) rest = argv.filter((a, i) => i !== argv.lastIndexOf(words[words.length - 1]!))
  if (!act) {
    // Слово без «--», не совпавшее с действием, молча действию по умолчанию не уходит (§5).
    const names = actions.map(actionWord)
    // значение флага в форме «--ключ значение» лишним словом не считается
    const stray = argv.find((w, i) => !w.startsWith('-') && !(i > 0 && /^--[^=]+$/.test(argv[i - 1]!)))
    if (stray !== undefined) {
      const near = nearest(stray, names)
      throw new KdError(2, 'kd: «' + stray + '» — не действие над «' + word + '»' + (near ? '; может быть «' + near + '»?' : ''), { hint: 'действия: ' + names.join(', '), choices: names })
    }
    const defaults = actions.filter((a) => a.default)
    if (defaults.length === 1) act = defaults[0]
    else if (actions.length === 1) act = actions[0]
    else {
      const pick = await choose(c, `что сделать с «${word}»`, actions.map((a) => `${actionWord(a)}${a.title ? ` — ${a.title}` : ''}`))
      act = actions[pick]!
    }
  }
  const vars = actionVarsFor(act!, actionVars(word, matches[0] ?? null, path))
  if (act!.run === 'kd') {
    if (!act!.cmd) throw new KdError(1, `kd: у действия ${act!.id} нет $cmd`)
    const cmd = shellSplit(resolveTemplate(act!.cmd, vars))
    if (c.depth > 3) throw new KdError(1, `kd: действие ${act!.id} зовёт само себя`)
    return dispatch({ ...c, depth: c.depth + 1 }, [...cmd, ...rest])
  }
  // Всухую действие-команда и действие-модуль не исполняются: они о `--dry` не знают (§3). Действие `kd` несёт флаг дальше, тулу.
  if (c.service.dry) {
    const what = act!.run === 'exec' ? resolveTemplate(act!.cmd ?? '', vars) : resolvePath(dirname(act!.source ?? KIT_ROOT), act!.path ?? '')
    return { code: 0, output: 'всухую: ' + actionWord(act!) + ' над «' + word + '» → ' + what + ' (ничего не запущено)' }
  }
  if (act!.run === 'exec') {
    const cmd = resolveTemplate(act!.cmd ?? '', vars)
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: c.io.cwd, encoding: 'utf8', env: c.io.env })
    if (r.stderr) c.io.stderr(r.stderr)
    return { code: r.status === 0 ? 0 : 1, output: r.stdout }
  }
  // `$run: script` — модуль рядом с правилами, default(vars); `.ts` — через хук рантайма runz.
  const file = resolvePath(dirname(act!.source ?? KIT_ROOT), act!.path ?? '')
  if (!existsSync(file)) throw new KdError(1, `kd: действие ${act!.id}: нет модуля ${file}`)
  prepareEnv(c)
  const prevEnv = process.env
  process.env = c.io.env
  try {
    const { fn } = await importScriptModule(file)
    const out = await (fn as unknown as (v: Record<string, unknown>) => unknown)(vars)
    return { code: 0, output: typeof out === 'string' ? out : JSON.stringify(out ?? null) }
  } finally {
    process.env = prevEnv
  }
}

/** Выбор в терминале; без терминала — код 2 со списком. */
async function choose(c: Ctx, what: string, items: string[]): Promise<number> {
  if (!c.io.interactive || !c.io.ask) throw new KdError(2, `kd: ${what} — ${items.join(' | ')}`, { choices: items })
  c.io.stderr(`${what}:\n${items.map((x, i) => `  ${i + 1}) ${x}`).join('\n')}\n`)
  const a = Number((await c.io.ask('номер: ')).trim())
  if (!Number.isInteger(a) || a < 1 || a > items.length) throw new KdError(2, `kd: выбор не сделан`)
  return a - 1
}

function unknownWord(c: Ctx, word: string): never {
  const names = [...c.catalog.tools.keys()]
  const near = names.find((n) => n.startsWith(word.slice(0, 3)) && Math.abs(n.length - word.length) <= 2)
  throw new KdError(2, `kd: «${word}» — не тул, не файл и не объект по правилам ссылок.\nkd умеет: тулы (${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}), файлы по виду, адреса и задачи по правилам links.mdz`, {
    hint: near ? `может быть «${near}»?` : 'kd — каталог тулов',
    ...(near ? { fix: `kd ${near}` } : { fix: 'kd' }),
  })
}

/** Разбор первого слова и запуск (§4). */
async function dispatch(c: Ctx, argv: string[]): Promise<Outcome> {
  const [word, ...rest] = argv
  if (word === undefined) return catalogOut(c)
  const tool = c.catalog.tools.get(word)
  if (tool) return runTool(c, tool, rest)
  const path = resolvePath(c.io.cwd, expandHome(word))
  if (isFile(path)) return runFile(c, path, word, rest)
  return runObject(c, word, rest)
}

function catalogOut(c: Ctx): Outcome {
  const tools = [...c.catalog.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  const w = Math.min(24, Math.max(4, ...tools.map((t) => t.name.length)))
  const lines = tools.map((t) => `${t.name.padEnd(w)}  ${describeEntry(t)}${c.service.verbose ? `  [${t.layerLabel}] ${t.file}` : ''}`.trimEnd())
  if (c.service.verbose) for (const s of c.catalog.shadowed) c.io.stderr(`kd: ${s.hidden.name}: ${s.hidden.file} [${s.hidden.layerLabel}] перекрыт ${s.kept.file} [${s.kept.layerLabel}]\n`)
  return { code: 0, output: lines.join('\n') }
}

const HELP = `kd — один вход для тулов, документов и действий над чем угодно

  kd                         каталог тулов с описаниями
  kd <тул> [слова] [--поля]  запустить тул
  kd <файл>                  по виду: документ с шагами — запуск, .mds — сессия, остальное — показать / действия
  kd <адрес|объект> [действие]
  kd <тул> --help
  kd completion zsh|bash|powershell

Служебные флаги (до имени тула): --dry  --json  -v  --help
Поля из текста: --params -  |  --params @файл  (mdz или JSON);  значение: --поле=@путь  |  --поле=-
Коды: 0 готово · 1 тул упал · 2 неверный вызов · 3 не хватает нужного · 4 прерван, продолжается той же командой
Слои: комплект → ~/.kd (KD_HOME) → проект .kd/ (добавляет, не перекрывает); студийный профиль — $layers в ~/.kd/settings.mdz`

/** Главный вход: argv без `node kd`. */
export async function main(argv: string[], io: Io): Promise<number> {
  const { service, rest } = splitService(argv)
  const envelope = (o: Outcome, err?: KdError): void => {
    if (!service.json) return
    io.stdout(JSON.stringify({ ok: o.code === 0, code: o.code, ...(err ? { error: { message: err.message, ...(err.info.field ? { field: err.info.field } : {}), ...(err.info.hint ? { hint: err.info.hint } : {}), ...(err.info.fix ? { fix: err.info.fix } : {}), ...(err.info.choices ? { choices: err.info.choices } : {}) } } : {}), artifacts: o.artifacts ?? [], output: o.output ?? '' }) + '\n')
  }
  try {
    if (service.version) {
      const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8')) as { version: string }
      io.stdout(pkg.version + '\n')
      return 0
    }
    if (service.help && rest.length === 0) {
      io.stdout(HELP + '\n')
      return 0
    }
    const layers = loadLayers(io.cwd, io.env)
    if (service.verbose) for (const w of layers.warnings) io.stderr(`kd: ${w}\n`)
    else for (const w of layers.warnings.filter((x) => /пропущен|не читается/.test(x))) io.stderr(`kd: ${w}\n`)
    // Установленная сборка регистрируется в общем слое сама (§10): её правила объектов и тулы.
    if (layers.copy.mode === 'installed' && layers.copy.registers && layers.copy.appId) {
      const own = readAttrs(join(layers.copy.root, 'kd-copy.mdz')) ?? {}
      const file = join(layers.copy.sharedHome, 'apps', `${layers.copy.appId}.mdz`)
      if (!existsSync(file)) {
        registerApp(layers.copy.sharedHome, { id: layers.copy.appId, path: layers.copy.root, tools: strList(own.tools), links: strList(own.links), ...(typeof own.name === 'string' ? { name: own.name } : {}) })
        Object.assign(layers, loadLayers(io.cwd, io.env))
      }
    }
    const catalog = loadCatalog(layers)
    assertNoConflicts(catalog)
    try {
      mkdirSync(join(layers.copy.dataDir, 'cache'), { recursive: true })
      await writeCache(layers, catalog)
    } catch {
      // кэш подсказок — необязателен
    }
    const ctx: Ctx = { io, service, layers, catalog, depth: 0 }
    // До первой загрузки модуля тула: хук рантайма встаёт с корнем этой копии (RUNZ_HOME).
    prepareEnv(ctx)
    const out = await dispatch(ctx, rest)
    if (service.json) envelope(out)
    else if (out.output !== undefined && out.output !== '') io.stdout(out.output.endsWith('\n') ? out.output : out.output + '\n')
    return out.code
  } catch (e) {
    const code: ExitCode = isKdError(e) ? e.code : typeof (e as { exitCode?: unknown })?.exitCode === 'number' && (e as { exitCode: number }).exitCode === 4 ? 4 : EXIT.failed
    const err = isKdError(e) ? e : new KdError(code, (e as Error)?.message ?? String(e))
    io.stderr(`${err.message.startsWith('kd') ? err.message : `kd: ${err.message}`}\n`)
    if (err.info.hint && !err.message.includes(err.info.hint)) io.stderr(`  ${err.info.hint}\n`)
    if (code === 4) io.stderr('  состояние сохранено — продолжение той же командой\n')
    if ((code === 2 || code === 3) && err.info.fix) io.stderr(`${err.info.fix}\n`)
    envelope({ code }, err)
    return code
  }
}

/** Io процесса. */
export function processIo(): Io {
  const interactive = !!process.stdin.isTTY && !!process.stderr.isTTY
  let rl: ReturnType<typeof createInterface> | null = null
  return {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const ch of process.stdin) chunks.push(ch as Buffer)
      return Buffer.concat(chunks).toString('utf8')
    },
    interactive,
    ...(interactive
      ? {
          ask: async (q: string) => {
            rl ??= createInterface({ input: process.stdin, output: process.stderr })
            return rl.question(q)
          },
        }
      : {}),
    cwd: process.cwd(),
    env: process.env,
  }
}

export type { KdValue }
export { defaultAction }
