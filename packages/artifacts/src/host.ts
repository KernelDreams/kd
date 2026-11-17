/**
 * Хост моста v2 (artifacts-spec §3–5) — всё, что делает сервис плагина
 * `artifacts`, кроме провода: сервис — тонкий адаптер `meta.on/stream` → сюда.
 *
 *   - статика артефакта — свой HTTP на 127.0.0.1 (порт случайный): страница с
 *     инжектом prelude + import map + стартовой темы, `.jsx` компилируются на
 *     лету, `fileUrl` гостя — `/f/<key>/<папка>/<имя>` ({@link fileUrlPath}) с
 *     проверкой `$fs-read` (старый `/f/<key>?p=` принимается до мажора);
 *   - {@link ArtifactHost.bridge} — ЕДИНАЯ точка: `checkAccess`, затем операция;
 *     буфер обмена и смотрелку (`viewer.open`) исполняет фронт (Plugin API),
 *     ответ — `{delegate}`;
 *   - `run` — общим раннером `@kerneldreams/runz-run` (шаблон) или `runz <appz>`;
 *   - `job.*` — задачи `@kerneldreams/runz-run/jobs`: долгий прогон вне окна,
 *     цель — тем же `$run-allow`, лог — стримом {@link ArtifactHost.jobAttach};
 *   - `service.call/on` — процесс `service.ts` артефакта ({@link ServiceProc});
 *   - события коллекций: `$version` в `meta.mdz` вырос → `reload`; очередь
 *     `open.jsonl` (`artifact_open`) → `open`; состав коллекций → `list`.
 *
 * Ключ сессии `key` — sha1(id + секрет процесса): URL не угадать снаружи.
 *
 * Файл окна (open-spec §7, `$handles`): вкладка файла открывает артефакт с
 * `file` (абсолютный путь) и `kinds` — гость видит их в `getContext()`, файл
 * получает грант `{user-selected}` (чтение и запись по умолчанию скоупов).
 * `instance` отделяет вкладки одного артефакта в разных окнах одного бэкенда:
 * у каждой свой ключ и свой файл. Смена файла окна — {@link ArtifactHost.setFile},
 * гостю — событие `on('file')` (его шлёт фронт). Папка файла — скоуп `$file-dir`
 * и `getContext().dir`.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { watchTree, type TreeWatch } from './watch-tree.js'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseResult, runTemplate } from '@kerneldreams/runz-run'
import type { RunResult } from '@kerneldreams/runz-run'
import { attach as attachJob, cancel as cancelJob, get as getJob, list as listJobs, start as startJob } from '@kerneldreams/runz-run/jobs'
import type { JobFile, JobFrame, JobInfo } from '@kerneldreams/runz-run/jobs'
import type { ArtifactInfo, Collection, PluginCollection } from './collections.js'
import { MANIFEST, WORKSPACE_COLLECTION, expandHome, listArtifacts, listCollection, listCollections, readArtifact, resolveArtifact } from './collections.js'
import { ComfyBridge, COMFY_UNSET } from './comfy.js'
import { ImageBridge } from './image.js'
import type { ImageSource, ImageWireEvent } from './image.js'
import { llmRequestOf, sayOptsOf, transcribeOptsOf } from './assist.js'
import type { LlmSource, SpeakSource } from './assist.js'
import { viewerRequest } from './viewer.js'
import type { ComfyWireEvent } from './comfy.js'
import { CompileError, compileJsx, KIT_FILES, KIT_IMPORT, transformJsx, VENDORED } from './compile.js'
import { createFsSkins } from '@kerneldreams/skins/node'
import { artifactDataDir, finalizeArtifact, initArtifact, listForAgent, openQueueFile, revertArtifact } from './lifecycle.js'
import type { FinalizeResult, InitOpts, InitResult } from './lifecycle.js'
import type { AccessEnv } from './permissions.js'
import { checkAccess, isTemplateTarget, runAllowed } from './permissions.js'
import { runSkins } from './skins.js'
import type { RuntimeError } from './runtime.js'
import { ackCheck, appendRuntimeErrors, normalizeRuntimeError, writeCheckResult } from './runtime.js'
import { ServiceProc } from './service-proc.js'
import type { Result } from './service-proc.js'

export type { Result }
export type { ComfyWireEvent, WireImage } from './comfy.js'
export type { ImageProgressLike, ImageProviderLike, ImageSource, ImageWireEvent } from './image.js'
export type { LlmMessage, LlmRequest, LlmSource, SpeakSource } from './assist.js'
export type { ViewerImage, ViewerRequest } from './viewer.js'

export interface ThemeInfo {
  /** CSS-переменные токенов (`--nr-bg: …`). */
  vars: Record<string, string>
  mode?: 'light' | 'dark'
  skin?: string
  /**
   * Таблицы стилей веб-шрифтов темы (https): гость подключает их к себе, иначе
   * `--nr-font-body` хоста в iframe откатился бы на системный шрифт.
   */
  fonts?: string[]
  /**
   * Роли кита UI (plugin-registry-spec §3 «кит в кадре»): CSS классов `.nr-toolbtn`, `.nr-tab`, `.nr-field`…
   * из ядра хоста — гость рисует контролы ролями и выглядит в скине (`retroma`) без своей рамки.
   */
  kit?: string
}

export interface ArtifactHostOpts {
  /** Корень пространства бэкенда — рабочая область по умолчанию. */
  root: string
  /** Каталог данных плагина (`~/.runz/data/nrchat-artifacts`). */
  dataRoot: string
  demoDir?: string | null
  configFile?: string
  /**
   * Слой плагинов (plugin-registry-spec §5–6): коллекции артефактов подключённых реестров и папки пользователя,
   * папки, перекрытые каскадом, — скрыты. Зовётся на каждый список: установка и обновление реестра видны сразу.
   */
  plugins?: () => { collections: readonly PluginCollection[]; hidden: readonly string[] } | null
  /** Адрес HTTP статики; default 127.0.0.1. */
  bindHost?: string
  /** Команда runz; default `runz` (+ PATH для GUI-процесса). */
  runz?: string[]
  runTimeoutMs?: number
  /**
   * Адрес ComfyUI для capability `comfy` (`http://host:8188`): атрибут `$comfy`
   * окружения бэкенда (pi-nr.mdz), не артефакта. Default — `NR_COMFY`; нет — методы
   * `comfy.*` отвечают ошибкой.
   */
  comfy?: string | null
  /**
   * Провайдеры картинок для capability `image`: имена и провайдер
   * контракта по имени. Даёт встраивающий (сервис nrchat — `resolveImageProvider`
   * runz); нет — методы `image.*` отвечают ошибкой.
   */
  image?: ImageSource | null
  /** Голос для права `speak`: speak стенда. Нет — `speak.*` отвечают ошибкой. */
  speak?: SpeakSource | null
  /** Модель для права `llm`: провайдер стенда. Нет — `llm.*` отвечают ошибкой. */
  llm?: LlmSource | null
  /**
   * Приложения mdz: вид приложения (`__host.app`, право `app`) запускает рецепт и читает лог
   * через встраивающего; `dir` — папка артефакта-вида (в ней `app.json` с путём `.mdz`). Нет — `app.*` отвечают ошибкой.
   */
  app?: AppHandler | null
  /** Диалог выбора файла; default — нативный ОС (osascript / zenity). */
  dialog?: (filters: DialogFilter[] | null) => Promise<string | null>
  /**
   * Кит UI для артефактов: папка сборки кита встраивающего (`nr-kit.js`, `nr-kit.css`, `version.txt`) —
   * отдаётся по `__kit/…`, голый импорт `@kerneldreams/kit` гостя ведёт туда же (import map, JSX). Скины стенда —
   * `__kit/skins.json` и `__kit/skins/<имя>.css` (общие скины бэкенда, `skinsRoot`, иначе `root`). Нет — маршрута нет,
   * импорт `@kerneldreams/kit` — ошибка компиляции словами.
   */
  kit?: { dir: string; skinsRoot?: string } | null
  warn?: (message: string) => void
}

/** Кадр запуска приложения гостю: `started {runId}` → `status`/`output` … → итог в Result. */
export interface AppEvent {
  name: string
  payload?: unknown
}

export interface AppHandler {
  /** Запуск: события — `onEvent`, итог `{runId, status, outputs, error?}` — значением Result. */
  run(dir: string, values: Record<string, unknown>, signal: AbortSignal, onEvent: (e: AppEvent) => void): Promise<Result>
  /** Лог дня (`day` — `YYYY-MM-DD`, нет — сегодня): запуски и дни, где есть лог. */
  log(dir: string, day: string | null): Promise<unknown>
  /** Пин запуска (состояние вида: «взять в контекст»), `on` — включить/снять. */
  pin(dir: string, runId: string, on: boolean): Promise<unknown>
}

export interface DialogFilter {
  name?: string
  extensions: string[]
}

export interface OpenedArtifact {
  id: string
  key: string
  url: string
  /** Путь страницы от корня статики (`/a/<key>/`) — для адреса через бэкенд (`ServicesOps.url`). */
  path: string
  title: string
  version: number
  dir: string
  uses: string[] | null
  readonly: boolean
  hasService: boolean
  warnings: string[]
  error?: string
}

interface Session {
  key: string
  info: ArtifactInfo
  workspace: string | null
  /** Файл окна (вкладка файла, `$handles`); `null` — вкладка без файла. */
  file: string | null
  kinds: string[]
  dataDir: string
  selected: Set<string>
  theme: ThemeInfo | null
  locale: string | null
}

export interface OpenOpts {
  workspace?: string | null
  theme?: ThemeInfo | null
  locale?: string | null
  /** Файл окна — абсолютный путь (вкладка файла, open-spec §7). */
  file?: string | null
  /** kinds файла (`detect` плагина open). */
  kinds?: string[] | null
  /** Экземпляр вкладки: свой ключ сессии на окно, когда окон над бэкендом несколько. */
  instance?: string | null
}

export interface HttpRequest {
  method?: string
  path: string
  query?: string
  headers?: Record<string, string>
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string | { __b64: string }
}

export interface HostEvent {
  name: 'reload' | 'open' | 'list'
  payload: Record<string, unknown>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
}

/** `dist/assets` рядом с модулем; из исходников (тесты) — собранные в `../dist/assets`. */
const ASSETS = [new URL('./assets/', import.meta.url), new URL('../dist/assets/', import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((p) => existsSync(join(p, 'prelude.js'))) ?? fileURLToPath(new URL('./assets/', import.meta.url))
const MAX_READ = 50 * 1024 * 1024
/** Корень статики относительно страницы артефакта (`/a/<key>/`). */
const ROOT_REL = '../../'
const DEFAULT_RUN_TIMEOUT = 30 * 60 * 1000

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const escapeScript = (s: string): string => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')

/**
 * Базовый текст гостя от темы хоста: корневой кегль (размер текста
 * nrchat), шрифт и кегль тела. Через `:where()` — нулевая специфичность:
 * любое правило гостя сильнее, а гость без своих правил выглядит как чат.
 */
const BASE_TEXT_CSS =
  ':where(:root) { font-size: var(--nr-root-size, 100%); }\n' +
  ':where(body) { font-family: var(--nr-font-body, system-ui, sans-serif); font-size: var(--nr-text-body, 14px); }'

/** Стартовая тема → CSS. */
export function themeCss(theme: ThemeInfo | null): string {
  if (!theme?.vars) return ''
  const decls = Object.entries(theme.vars)
    .filter(([k]) => /^--[\w-]+$/.test(k))
    .map(([k, v]) => `${k}: ${String(v).replace(/[<>;{}]/g, '')};`)
    .join(' ')
  // color-scheme не навязываем: гость v1 со своей светлой вёрсткой получил бы белый текст кнопок.
  return `:root { ${decls} }\n${BASE_TEXT_CSS}`
}

/**
 * Роли кита → `<style id="nr-kit">`: слоем `nr-kit` — любое правило гостя без слоя сильнее. Текст от клиента: `<` в
 * CSS ролей не бывает — вырезается, чтобы не закрыть `<style>`.
 */
export function kitCss(theme: ThemeInfo | null): string {
  const kit = typeof theme?.kit === 'string' ? theme.kit.replace(/</g, '') : ''
  return kit.trim() ? `@layer nr-kit {\n${kit}\n}` : ''
}

/** Только https-таблицы шрифтов: тема приходит от клиента, в `<head>` — не что угодно. */
export function themeFonts(theme: ThemeInfo | null): string[] {
  return (theme?.fonts ?? []).filter((u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u))
}

/** Нативный диалог ОС: macOS — osascript, Linux — zenity. Отмена — null. */
function osDialog(filters: DialogFilter[] | null): Promise<string | null> {
  return new Promise((resolveP, reject) => {
    const exts = (filters ?? []).flatMap((f) => f.extensions ?? []).filter((e) => /^[\w.+-]+$/.test(e))
    let bin: string
    let args: string[]
    if (process.platform === 'darwin') {
      const type = exts.length ? ` of type {${exts.map((e) => JSON.stringify(e.replace(/^\./, ''))).join(', ')}}` : ''
      bin = 'osascript'
      args = ['-e', `POSIX path of (choose file with prompt "Выбери файл"${type})`]
    } else if (process.platform === 'linux') {
      bin = 'zenity'
      args = ['--file-selection', ...(exts.length ? [`--file-filter=${exts.map((e) => `*.${e.replace(/^\./, '')}`).join(' ')}`] : [])]
    } else {
      reject(new Error('openDialog: нет нативного диалога на этой ОС'))
      return
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c))
    child.on('error', (e) => reject(e))
    child.on('close', (code) => resolveP(code === 0 && out.trim() ? out.trim() : null))
  })
}

/** Байты по проводу — `{__b64}`: services едут JSON. */
export const b64 = (buf: Buffer): { __b64: string } => ({ __b64: buf.toString('base64') })
const fromWire = (v: unknown): string | Buffer =>
  v && typeof v === 'object' && typeof (v as { __b64?: unknown }).__b64 === 'string' ? Buffer.from((v as { __b64: string }).__b64, 'base64') : String(v ?? '')

export interface ArtifactHost {
  readonly origin: Promise<string>
  collections(workspace?: string | null): Collection[]
  list(workspace?: string | null): Array<ArtifactInfo & { dataDir: string }>
  open(ref: string, opts?: OpenOpts): Promise<OpenedArtifact>
  /**
   * Файл окна сменился (листание в смотрелке, open-spec §5): новый путь и kinds
   * сессии, грант `{user-selected}` новому файлу. Событие `on('file')` гостю шлёт фронт.
   */
  setFile(key: string, file: string | null, kinds?: string[]): Result
  bridge(key: string, method: string, args: unknown[]): Promise<Result | { ok: true; delegate: string; value?: unknown }>
  run(key: string, target: string, values: Record<string, unknown>, signal: AbortSignal): Promise<Result>
  /** Лог задачи (`__host.job.attach`): кадры с номера `from` до конца задачи или abort. */
  jobAttach(key: string, id: string, from: number, signal: AbortSignal, onFrame: (f: JobFrame) => void): Promise<Result>
  /** Запуск приложения из вида (`__host.app.run`): события до итога или abort. */
  appRun(key: string, values: Record<string, unknown>, signal: AbortSignal, onEvent: (e: AppEvent) => void): Promise<Result>
  watchPath(key: string, path: string, signal: AbortSignal, onChange: () => void): Result
  serviceEvents(key: string, event: string, signal: AbortSignal, onEvent: (payload: unknown) => void): Result
  /** События `comfy.queue` артефакта (канал `comfy` гостя) до abort. */
  comfyEvents(key: string, signal: AbortSignal, onEvent: (e: ComfyWireEvent) => void): Result
  /** События `image.generate` артефакта (канал `image` гостя) до abort. */
  imageEvents(key: string, signal: AbortSignal, onEvent: (e: ImageWireEvent) => void): Result
  /**
   * События коллекций до abort. `single` — окно одного артефакта (`exz --artifact`,
   * `NR_ARTIFACT`): чужие запросы очереди `open.jsonl` ему не адресованы — не
   * приходят и не подтверждаются (проверку finalize подтвердит nrchat), свой — `open`
   * (перезагрузка). Без `single` — все запросы (панель nrchat).
   */
  events(opts: { workspace?: string | null; single?: string | null }, signal: AbortSignal, emit: (e: HostEvent) => void): void
  /** HTTP статики через бэкенд (метод сервиса `http`, протокол v1.14). */
  http(req: HttpRequest): Promise<HttpResponse>
  /** Ошибки рантайма гостя из вкладки → журнал артефакта (`artifact_errors`). */
  reportErrors(key: string, errors: unknown[]): Result
  /** Результат проверки после finalize: вкладка загрузилась, окно прошло (`check` из очереди open). */
  checked(check: string, key: string, errors: unknown[]): Result
  init(opts: InitOpts): InitResult
  finalize(ref: string, expectedVersion: number | undefined, workspace?: string | null): Promise<FinalizeResult>
  revert(ref: string, version: number, workspace?: string | null): Promise<FinalizeResult>
  listForAgent(workspace?: string | null, collection?: string): ReturnType<typeof listForAgent>
  close(): Promise<void>
}

/**
 * Один диапазон `bytes=a-b` / `a-` / `-n` заголовка Range; нет или несколько —
 * undefined (отдать целиком), за пределами — `'bad'` (416).
 */
export function byteRange(h: string | undefined, size: number): { start: number; end: number } | 'bad' | undefined {
  const m = h ? /^bytes=(\d*)-(\d*)$/.exec(h.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return undefined
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'bad'
  return { start, end }
}

export function createArtifactHost(opts: ArtifactHostOpts): ArtifactHost {
  const warn = opts.warn ?? ((m: string) => void process.stderr.write(`artifacts: ${m}\n`))
  const secret = randomBytes(16).toString('hex')
  const sessions = new Map<string, Session>()
  const services = new Map<string, ServiceProc>()
  const warnedLegacy = new Set<string>()
  const comfy = new ComfyBridge(opts.comfy ?? process.env.NR_COMFY ?? null, warn)
  const image = new ImageBridge(opts.image ?? null, warn)
  const registry = (workspace?: string | null) => {
    const plugins = opts.plugins?.() ?? null
    return {
      workspace: workspace ?? opts.root,
      demoDir: opts.demoDir ?? null,
      ...(opts.configFile ? { configFile: opts.configFile } : {}),
      ...(plugins ? { plugins } : {}),
    }
  }
  const keyOf = (id: string, workspace: string | null, instance: string | null = null): string =>
    createHash('sha1')
      .update(`${secret}\0${id}\0${workspace ?? ''}${instance ? `\0${instance}` : ''}`)
      .digest('hex')
      .slice(0, 20)

  const runzCmd = opts.runz ?? [process.env.NR_ARTIFACTS_RUNZ || 'runz']
  const runEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    // GUI-процесс (exz из Finder) не видит PATH шелла: runz и node — явно.
    PATH: [dirname(process.execPath), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '']
      .filter(Boolean)
      .join(delimiter),
  })

  // ── HTTP статики ────────────────────────────────────────────────────────────
  const server: Server = createServer((req, res) => void serve(req, res).catch((e) => fail(res, 500, (e as Error).message)))
  const origin = new Promise<string>((resolveP, reject) => {
    server.once('error', reject)
    server.listen(0, opts.bindHost ?? '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolveP(`http://${opts.bindHost ?? '127.0.0.1'}:${addr.port}`)
    })
  })
  server.unref()

  function fail(res: ServerResponse, code: number, message: string): void {
    if (res.headersSent) return void res.end()
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
    res.end(message)
  }

  function send(res: ServerResponse, type: string, body: string | Buffer): void {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    res.end(body)
  }

  /**
   * Байты с поддержкой `Range` (media-gen-spec §6): WebKit (окно exz) не играет
   * `<video>`/`<audio>` без ответа 206 на `bytes=…`; Chrome без него не перематывает.
   */
  function sendRange(req: IncomingMessage, res: ServerResponse, type: string, body: Buffer): void {
    const r = byteRange(req.headers.range, body.length)
    const head = { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' }
    if (r === 'bad') {
      res.writeHead(416, { ...head, 'content-range': `bytes */${body.length}` })
      return void res.end()
    }
    if (!r) {
      res.writeHead(200, { ...head, 'content-length': String(body.length) })
      return void res.end(body)
    }
    res.writeHead(206, { ...head, 'content-length': String(r.end - r.start + 1), 'content-range': `bytes ${r.start}-${r.end}/${body.length}` })
    res.end(body.subarray(r.start, r.end + 1))
  }

  const importMap = (base: string): string =>
    JSON.stringify({
      imports: {
        ...Object.fromEntries(Object.entries(VENDORED).map(([k, f]) => [k, `${base}__vendor/${f}`])),
        ...(opts.kit ? { [KIT_IMPORT]: `${base}__kit/${KIT_FILES.js}` } : {}),
      },
    })

  /** Файл кита (`__kit/<файл>`) либо скины стенда; кита у встраивающего нет — 404 словами. */
  async function serveKit(res: ServerResponse, rest: string[]): Promise<void> {
    if (!opts.kit) return fail(res, 404, 'кита нет: встраивающий хост не передал kit (сборка nrchat: npm run build:kit)')
    const file = rest.join('/')
    const skinsRoot = opts.kit.skinsRoot ?? opts.root
    if (file === 'skins.json') {
      const list = await createFsSkins({ root: skinsRoot }).list()
      return send(
        res,
        'application/json; charset=utf-8',
        JSON.stringify(list.filter((s) => !s.error).map((s) => ({ name: s.name, mode: s.mode, ...(s.description ? { description: s.description } : {}) }))),
      )
    }
    if (rest[0] === 'skins' && rest.length === 2 && /^[a-z][\w-]*\.css$/.test(rest[1]!)) {
      const name = rest[1]!.slice(0, -4)
      try {
        const d = await createFsSkins({ root: skinsRoot }).get(name)
        return send(res, 'text/css; charset=utf-8', d.css)
      } catch (e) {
        return fail(res, 404, `скин ${name}: ${(e as Error).message}`)
      }
    }
    if (!(Object.values(KIT_FILES) as string[]).includes(file)) return fail(res, 404, `в ките нет ${file}`)
    const path = join(opts.kit.dir, file)
    if (!existsSync(path)) return fail(res, 404, `кит не собран: нет ${path} (npm run build:kit в nrchat)`)
    const type = file.endsWith('.js') ? MIME['.js']! : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/plain; charset=utf-8'
    return send(res, type, readFileSync(path))
  }

  /**
   * Прямая ссылка на артефакт: `open/?ref=<id|путь>` — сессия без темы окна (скин задаёт сам артефакт,
   * стенд макета) и переход на её страницу; прочие параметры адреса едут дальше (`?skin=retroma`). Тот же адрес
   * через бэкенд (`/services/artifacts/http/open/?ref=…`) — окно без оболочки в браузере из tailnet.
   */
  async function serveOpen(res: ServerResponse, url: URL): Promise<void> {
    const ref = url.searchParams.get('ref')
    if (!ref) return fail(res, 400, 'open: нет ?ref=<id|путь>')
    let opened: OpenedArtifact
    try {
      opened = await host.open(ref, { workspace: url.searchParams.get('workspace') || null, theme: null })
    } catch (e) {
      return fail(res, 404, `open ${ref}: ${(e as Error).message}`)
    }
    const q = new URLSearchParams(url.searchParams)
    q.delete('ref')
    q.delete('workspace')
    const qs = q.toString()
    res.writeHead(302, { location: `../a/${opened.key}/${qs ? `?${qs}` : ''}`, 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    res.end()
  }

  /**
   * Инжект в `<head>`: конфиг моста, prelude, import map, стартовая тема.
   * Адреса — относительно страницы (`/a/<key>/` → `../../`): та же страница
   * живёт и на своём origin, и за бэкендом (`/services/artifacts/http/…`,
   *); origin для `fileUrl` prelude вычисляет из `location` сам.
   */
  function pageHead(s: Session, root = ROOT_REL): string {
    const cfg = {
      id: s.info.id,
      key: s.key,
      version: s.info.version,
      // Роли кита — стилем страницы, не конфигом моста: в `__NR_ARTIFACT__` они бы ехали второй копией.
      theme: s.theme ? { ...s.theme, kit: undefined } : s.theme,
    }
    const css = themeCss(s.theme)
    const kit = kitCss(s.theme)
    return [
      `<script>window.__NR_ARTIFACT__ = ${escapeScript(JSON.stringify(cfg))}</script>`,
      `<script src="${root}__prelude.js"></script>`,
      `<script type="importmap">${escapeScript(importMap(root))}</script>`,
      ...themeFonts(s.theme).map((u) => `<link rel="stylesheet" data-nr-font href="${u.replace(/&/g, '&amp;')}">`),
      css ? `<style id="nr-theme">${css}</style>` : '',
      kit ? `<style id="nr-kit">${kit}</style>` : '',
    ].join('\n')
  }

  /** Страница артефакта: `index.html` (или обёртка jsx) — либо соседний `.html` папки `rel` (тема и мост те же). */
  function page(s: Session, rel = 'index.html'): string {
    const depth = rel.split('/').length - 1
    const head = pageHead(s, ROOT_REL + '../'.repeat(depth))
    if (rel === 'index.html' && s.info.entry === 'jsx') {
      return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${head}
</head>
<body>
<div id="root"></div>
<script type="module" src="./__entry.js"></script>
</body>
</html>`
    }
    const html = readFileSync(join(s.info.dir, rel), 'utf8')
    const m = /<head\b[^>]*>/i.exec(html)
    if (m) return html.slice(0, m.index + m[0].length) + '\n' + head + html.slice(m.index + m[0].length)
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
    if (doctype) return html.slice(0, doctype[0].length) + '\n' + head + html.slice(doctype[0].length)
    return head + '\n' + html
  }

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': '*' })
      return void res.end()
    }
    if (parts[0] === '__prelude.js') return send(res, MIME['.js']!, readFileSync(join(ASSETS, 'prelude.js')))
    if (parts[0] === '__kit') return serveKit(res, parts.slice(1))
    if (parts[0] === 'open' && parts.length === 1) return serveOpen(res, url)
    if (parts[0] === '__vendor' && parts[1] && /^[\w.-]+\.js$/.test(parts[1])) {
      const file = join(ASSETS, 'vendor', parts[1])
      if (!existsSync(file)) return fail(res, 404, 'no vendor module')
      res.writeHead(200, { 'content-type': MIME['.js']!, 'cache-control': 'max-age=3600', 'access-control-allow-origin': '*' })
      return void createReadStream(file).pipe(res)
    }
    if (parts[0] === 'f' && parts[1]) {
      const s = sessions.get(parts[1])
      if (!s) return fail(res, 404, 'unknown artifact')
      // `?p=` — старая форма (до мажора); иначе `/f/<key>/<папка>/<путь от неё>`.
      const p = url.searchParams.get('p') ?? (parts.length >= 4 ? fileUrlGuestPath(parts[2]!, parts.slice(3)) : '')
      const gate = check(s, 'fileUrl', [p])
      if (!gate.ok) return fail(res, 403, gate.error)
      return streamFile(res, gate.path!, req)
    }
    if (parts[0] === 'c' && parts[1]) {
      // comfy: картинки и превью генерации — байты с ComfyUI через хост (гость сервера не видит).
      const s = sessions.get(parts[1])
      if (!s) return fail(res, 404, 'unknown artifact')
      refresh(s)
      const gate = check(s, 'comfy.view', [])
      if (!gate.ok) return fail(res, 403, gate.error)
      if (!comfy.configured) return fail(res, 503, COMFY_UNSET)
      if (parts[2] === 'view') {
        const img = await comfy.fetchView(url.searchParams)
        return send(res, img.mime, Buffer.from(img.bytes))
      }
      if (parts[2] === 'p' && parts[3]) {
        const p = comfy.preview(s.key, parts[3])
        return p ? send(res, p.mime, Buffer.from(p.bytes)) : fail(res, 404, 'нет превью')
      }
      return fail(res, 404, 'not found')
    }
    if (parts[0] === 'i' && parts[1] && parts[2] && parts[3]) {
      // image: превью и результаты генерации — из памяти хоста (`/i/<key>/<id>/<n|p>`).
      const s = sessions.get(parts[1])
      if (!s) return fail(res, 404, 'unknown artifact')
      refresh(s)
      const gate = check(s, 'image.bytes', [])
      if (!gate.ok) return fail(res, 403, gate.error)
      if (parts[3] === 'p') {
        const p = image.preview(s.key, parts[2])
        return p ? send(res, p.mime, Buffer.from(p.bytes)) : fail(res, 404, 'нет превью')
      }
      try {
        const r = image.bytes(s.key, parts[2], parts[3])
        return sendRange(req, res, r.mime, Buffer.from(r.bytes))
      } catch (e) {
        return fail(res, 404, (e as Error).message)
      }
    }
    if (parts[0] === 'a' && parts[1]) {
      const s = sessions.get(parts[1])
      if (!s) return fail(res, 404, 'unknown artifact (открой заново)')
      refresh(s)
      const rel = parts.slice(2).join('/')
      if (rel === '' || rel === 'index.html') {
        if (s.info.error && !s.info.entry) return send(res, MIME['.html']!, `<pre>${s.info.error}</pre>`)
        return send(res, MIME['.html']!, page(s))
      }
      if (rel === '__entry.js') {
        try {
          return send(res, MIME['.js']!, await compileJsx(s.info.dir))
        } catch (e) {
          const msg = e instanceof CompileError ? e.message : (e as Error).message
          return send(res, MIME['.js']!, `document.body.innerHTML = '<pre style="color:#b42318;white-space:pre-wrap">' + ${JSON.stringify(escapeHtml(msg))} + '</pre>'\nconsole.error(${JSON.stringify(msg)})`)
        }
      }
      const file = resolve(s.info.dir, rel)
      if (!within(file, s.info.dir) || rel.split('/').some((p) => p.startsWith('.'))) return fail(res, 403, 'outside artifact')
      if (!existsSync(file) || !statSync(file).isFile()) return fail(res, 404, `not found: ${rel}`)
      if (extname(file) === '.jsx') return send(res, MIME['.js']!, await transformJsx(readFileSync(file, 'utf8'), rel))
      // Соседние страницы папки — с темой и мостом, как вход (раньше — сырой файл без темы).
      if (/\.html?$/i.test(file)) return send(res, MIME['.html']!, page(s, rel))
      return streamFile(res, file, req)
    }
    fail(res, 404, 'not found')
  }

  function streamFile(res: ServerResponse, file: string, req?: IncomingMessage): void {
    let st
    try {
      st = statSync(file)
    } catch {
      return fail(res, 404, 'not found')
    }
    if (!st.isFile()) return fail(res, 404, 'not a file')
    const head = {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'accept-ranges': 'bytes',
    }
    const r = byteRange(req?.headers.range, st.size)
    if (r === 'bad') {
      res.writeHead(416, { ...head, 'content-range': `bytes */${st.size}` })
      return void res.end()
    }
    if (r) {
      res.writeHead(206, { ...head, 'content-length': String(r.end - r.start + 1), 'content-range': `bytes ${r.start}-${r.end}/${st.size}` })
      return void createReadStream(file, { start: r.start, end: r.end }).pipe(res)
    }
    res.writeHead(200, { ...head, 'content-length': String(st.size) })
    createReadStream(file).pipe(res)
  }

  // ── сессии и проверка ──────────────────────────────────────────────────────

  function refresh(s: Session): void {
    s.info = readArtifact(s.info.dir, collectionOf(s))
  }

  function collectionOf(s: Session): Collection | null {
    return listCollections(registry(s.workspace)).find((c) => c.id === s.info.collection) ?? null
  }

  function env(s: Session): AccessEnv {
    return { artifactDir: s.info.dir, dataDir: s.dataDir, workspace: s.workspace, selected: s.selected, fileDir: s.file ? dirname(s.file) : null, artifactId: s.info.id }
  }

  /** ЕДИНСТВЕННАЯ проверка прав моста: все методы и `fileUrl` идут через неё. */
  function check(s: Session, method: string, args: readonly unknown[]): ReturnType<typeof checkAccess> {
    return checkAccess(s.info.manifest, method, args, env(s))
  }

  function sessionOf(key: string): Session {
    const s = sessions.get(key)
    if (!s) throw new Error('артефакт не открыт (устаревший ключ — перезагрузи вкладку)')
    return s
  }

  function serviceOf(s: Session): ServiceProc {
    let proc = services.get(s.info.dir)
    if (!proc) {
      const m = s.info.manifest
      proc = new ServiceProc({
        dir: s.info.dir,
        dataDir: s.dataDir,
        workspace: s.workspace,
        mode: m?.service ?? 'lazy',
        idleSeconds: m?.serviceIdle ?? 300,
        env: runEnv(),
        warn,
      })
      services.set(s.info.dir, proc)
    }
    return proc
  }

  const storageFile = (s: Session): string => join(s.dataDir, 'storage.json')
  const readStorage = (s: Session): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(storageFile(s), 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  async function op(s: Session, method: string, args: unknown[], path: string | undefined, checked?: unknown): Promise<Result | { ok: true; delegate: string; value?: unknown }> {
    // Сессия чата: данные — у клиента протокола; здесь право, скоуп и форма аргументов.
    if (method.startsWith('session.')) return { ok: true, delegate: method, value: checked ?? null }
    // Скины: файлы — здесь (корень бэкенда + рабочая область), превью и выбор — у фронта.
    if (method.startsWith('skins.')) {
      const r = await runSkins(method, (checked ?? {}) as Record<string, unknown>, { root: opts.root, workspace: s.workspace })
      return r.ok && r.delegate ? { ok: true, delegate: r.delegate, value: r.value ?? null } : r.ok ? { ok: true, value: r.value } : r
    }
    switch (method) {
      case 'readFile': {
        const st = statSync(path!)
        if (st.size > MAX_READ) throw new Error(`файл больше ${MAX_READ >> 20} МБ: ${path}`)
        return { ok: true, value: readFileSync(path!, 'utf8') }
      }
      case 'readFileBinary': {
        const st = statSync(path!)
        if (st.size > MAX_READ) throw new Error(`файл больше ${MAX_READ >> 20} МБ: ${path}`)
        return { ok: true, value: b64(readFileSync(path!)) }
      }
      case 'writeFile':
        mkdirSync(dirname(path!), { recursive: true })
        writeFileSync(path!, fromWire(args[1]))
        return { ok: true, value: null }
      case 'listDir':
        return {
          ok: true,
          value: readdirSync(path!, { withFileTypes: true }).map((d) => {
            let size = 0
            try {
              size = d.isFile() ? statSync(join(path!, d.name)).size : 0
            } catch {
              // битая ссылка
            }
            return { name: d.name, isDir: d.isDirectory(), size }
          }),
        }
      case 'fileUrl':
        return { ok: true, value: `${await origin}${fileUrlPath(s.key, path!)}` }
      case 'openDialog': {
        const picked = await (opts.dialog ?? osDialog)((args[0] as DialogFilter[] | null) ?? null)
        if (picked) s.selected.add(resolve(picked))
        return { ok: true, value: picked }
      }
      case 'service.call': {
        const o = (args[2] as { timeout?: number } | null) ?? null
        return serviceOf(s).call(String(args[0] ?? ''), args[1] ?? null, typeof o?.timeout === 'number' ? o.timeout : undefined)
      }
      case 'clipboardRead':
      case 'clipboardWrite':
      case 'clipboardReadImage':
      case 'clipboardWriteImage':
        // Буфер — у оболочки (Plugin API ui.clipboard); право проверено здесь.
        return { ok: true, delegate: method }
      case 'viewer.open':
        // Смотрелка — у оболочки (Plugin API ui.viewImages); здесь право и разбор списка.
        return { ok: true, delegate: method, value: viewerRequest(args) }
      case 'storage.get': {
        const all = readStorage(s)
        const k = args[0]
        return { ok: true, value: typeof k === 'string' ? (all[k] ?? null) : all }
      }
      case 'storage.set': {
        const k = args[0]
        if (typeof k !== 'string' || !k) throw new Error('storage.set: нет ключа')
        const all = readStorage(s)
        if (args[1] === undefined || args[1] === null) delete all[k]
        else all[k] = args[1]
        mkdirSync(s.dataDir, { recursive: true })
        writeFileSync(storageFile(s), `${JSON.stringify(all, null, 2)}\n`)
        return { ok: true, value: null }
      }
      case 'getContext':
        return {
          ok: true,
          value: {
            file: s.file,
            /** Папка файла окна (`$file-dir`), абсолютная; `file` лежит в ней. */
            dir: s.file ? dirname(s.file) : null,
            kinds: s.kinds,
            extName: s.info.folder,
            artifactId: s.info.id,
            title: s.info.title,
            dataDir: s.dataDir,
            artifactDir: s.info.dir,
            workspace: s.workspace,
            version: s.info.version,
            theme: s.theme,
            locale: s.locale,
            comfy: comfy.configured,
            image: image.configured,
            speak: !!opts.speak,
            llm: !!opts.llm,
            /** Право `session` есть (или легаси): фронт дополнит контекст `session {id, title, personas}`. */
            sessionAccess: s.info.manifest?.uses == null || s.info.manifest.uses.includes('session'),
          },
        }
      case 'job.start': {
        const target = path ?? String(args[0]).trim()
        const o = (args[2] ?? {}) as { title?: unknown; keys?: unknown; files?: unknown; now?: unknown }
        const files: JobFile[] = []
        for (const f of Array.isArray(o.files) ? (o.files as Array<Record<string, unknown>>) : []) {
          const name = String(f.name ?? '')
          if (f.text !== undefined) files.push({ name, text: String(f.text) })
          else if (f.bytes !== undefined) files.push({ name, bytes: Buffer.from(bytesOf(f.bytes, 'job.start files')) })
          else if (typeof f.path === 'string') {
            // Вход путём — с правом чтения гостя ($fs-read), как readFileBinary.
            const read = check(s, 'readFileBinary', [f.path])
            if (!read.ok) return read
            files.push({ name, path: read.path! })
          }
        }
        const job = await startJob({
          target,
          values: (args[1] ?? {}) as JobInfo['values'],
          ...(path ? {} : { cwd: s.workspace ?? opts.root }),
          ...(typeof o.title === 'string' ? { title: o.title } : {}),
          ...(Array.isArray(o.keys) ? { keys: o.keys.map(String) } : {}),
          files,
          now: o.now === true,
          runz: runzCmd,
        })
        return { ok: true, value: job }
      }
      case 'job.list': {
        const o = (args[0] ?? {}) as { status?: unknown; target?: unknown; limit?: unknown }
        const target = typeof o.target === 'string' && o.target ? (isTemplateTarget(o.target) ? resolve(s.info.dir, expandHome(o.target)) : o.target) : undefined
        const jobs = listJobs({
          ...(target ? { target } : {}),
          ...(typeof o.status === 'string' || Array.isArray(o.status) ? { status: o.status as never } : {}),
        }).filter((j) => jobVisible(s, j))
        return { ok: true, value: typeof o.limit === 'number' ? jobs.slice(0, o.limit) : jobs }
      }
      case 'job.get':
      case 'job.cancel': {
        const j = getJob(String(args[0] ?? ''))
        if (!j || !jobVisible(s, j)) return { ok: false, error: `нет задачи ${String(args[0])}` }
        return { ok: true, value: method === 'job.get' ? j : await cancelJob(j.id) }
      }
      case 'job.attach':
        return { ok: false, error: 'job.attach: стримом, не вызовом' }
      case 'app.run':
        return { ok: false, error: 'app.run: стримом, не вызовом' }
      case 'app.log': {
        if (!opts.app) return { ok: false, error: 'app: приложений нет в этом хосте' }
        const day = typeof args[0] === 'string' && args[0] !== '' ? args[0] : null
        return { ok: true, value: await opts.app.log(s.info.dir, day) }
      }
      case 'app.pin': {
        if (!opts.app) return { ok: false, error: 'app: приложений нет в этом хосте' }
        if (typeof args[0] !== 'string' || args[0] === '') return { ok: false, error: 'app.pin: нет id запуска' }
        return { ok: true, value: await opts.app.pin(s.info.dir, args[0], args[1] !== false) }
      }
      case 'run.cancel':
        // Отмена — закрытие стрима run у фронта; здесь только проверка права.
        return { ok: true, value: null }
      case 'comfy.parse':
        return { ok: true, value: comfy.parse(bytesOf(args[0], 'comfy.parse')) }
      case 'comfy.objectInfo':
        return { ok: true, value: await comfy.objectInfo(args[0]) }
      case 'comfy.inputs':
        return { ok: true, value: await comfy.inputs(args[0]) }
      case 'comfy.upload':
        return { ok: true, value: await comfy.upload(bytesOf(args[0], 'comfy.upload'), args[1]) }
      case 'comfy.queue':
        return { ok: true, value: await comfy.queue(s.key, args[0], (args[1] as { workflow?: unknown } | null) ?? null) }
      case 'comfy.interrupt':
        return { ok: true, value: await comfy.interrupt(s.key, args[0]) }
      case 'comfy.view':
        return { ok: true, value: comfy.viewPath(s.key, args[0] as never) }
      case 'comfy.save': {
        const bytes = await comfy.saveBytes(args[0], (args[1] as { prompt?: unknown; workflow?: unknown } | null) ?? null)
        mkdirSync(dirname(path!), { recursive: true })
        writeFileSync(path!, bytes)
        // Сохранённое — гостю на чтение (fileUrl, readFileBinary), как файлы-результаты run.
        s.selected.add(path!)
        return { ok: true, value: { path: path!, bytes: bytes.length } }
      }
      case 'comfy.events':
        return { ok: false, error: 'comfy.events: стримом, не вызовом' }
      case 'image.providers':
        return { ok: true, value: await image.providers() }
      case 'image.models':
        return { ok: true, value: await image.models(args[0]) }
      case 'image.schema':
        return { ok: true, value: await image.schema(args[0], args[1]) }
      case 'image.generate': {
        // Рефы — третьим аргументом-массивом: провод фронта (`toWire`) кодирует байты в массивах, не в объектах.
        const refs = Array.isArray(args[2]) ? args[2].map((r, i) => new Uint8Array(bytesOf(r, `image.generate refs[${i}]`))) : []
        // Рефы персонажа (Veo) — четвёртым массивом, по той же причине.
        const subjects = Array.isArray(args[3]) ? args[3].map((r, i) => new Uint8Array(bytesOf(r, `image.generate subjects[${i}]`))) : []
        return { ok: true, value: await image.generate(s.key, args[0], args[1], refs, subjects) }
      }
      case 'image.cancel':
        return { ok: true, value: image.cancel(s.key, args[0]) }
      case 'image.bytes':
        return { ok: true, value: b64(Buffer.from(image.bytes(s.key, args[0], args[1]).bytes)) }
      case 'image.save': {
        const { bytes } = image.bytes(s.key, args[0], args[1])
        mkdirSync(dirname(path!), { recursive: true })
        writeFileSync(path!, bytes)
        s.selected.add(path!)
        return { ok: true, value: { path: path!, bytes: bytes.length } }
      }
      case 'image.events':
        return { ok: false, error: 'image.events: стримом, не вызовом' }
      case 'speak.say':
      case 'speak.voices':
      case 'speak.transcribe': {
        if (!opts.speak) return { ok: false, error: `${method}: голос на этом стенде не настроен (нет ## $speak)` }
        if (method === 'speak.voices') return { ok: true, value: await opts.speak.voices() }
        if (method === 'speak.transcribe') return { ok: true, value: await opts.speak.transcribe(new Uint8Array(bytesOf(args[0], method)), transcribeOptsOf(args[1])) }
        const text = typeof args[0] === 'string' ? args[0].trim() : ''
        if (!text) return { ok: false, error: 'speak.say: пустой текст' }
        const r = await opts.speak.say(text, sayOptsOf(args[1]))
        return { ok: true, value: { bytes: b64(Buffer.from(r.bytes)), mime: r.mime } }
      }
      case 'llm.complete':
      case 'llm.models': {
        if (!opts.llm) return { ok: false, error: `${method}: модель на этом стенде не настроена` }
        if (method === 'llm.models') return { ok: true, value: await opts.llm.models() }
        return { ok: true, value: await opts.llm.complete(llmRequestOf(args[0])) }
      }
      case 'run':
      case 'watch':
      case 'service.on':
        return { ok: false, error: `${method}: стримом, не вызовом` }
      default:
        return { ok: false, error: `unknown bridge method: ${method}` }
    }
  }

  /** Задача видна артефакту: легаси без `$uses`, пустой `$run-allow` или цель в нём. */
  function jobVisible(s: Session, j: JobInfo): boolean {
    const m = s.info.manifest
    if (!m || m.uses === null || m.runAllow.length === 0) return true
    return runAllowed(j.target, m.runAllow, s.info.dir)
  }

  async function runTarget(s: Session, target: string, values: Record<string, unknown>, signal: AbortSignal, templatePath: string | undefined): Promise<Result> {
    const timeoutMs = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT
    let r: RunResult
    if (templatePath) {
      if (!existsSync(templatePath)) return { ok: false, error: `шаблона нет: ${templatePath}` }
      r = await runTemplate({ template: templatePath, values: values as never, runz: runzCmd, env: runEnv(), signal, timeoutMs })
    } else {
      r = await runAppz(target, values, signal, timeoutMs, s.workspace ?? opts.root)
    }
    if (r.aborted) return { ok: false, error: 'cancelled' }
    // Файлы-результаты — гостю на чтение ({user-selected}): их отдал хост.
    for (const o of r.outputs) if ('path' in o && typeof o.path === 'string') s.selected.add(resolve(o.path))
    if (!r.ok) {
      const reason = r.timedOut ? `таймаут ${timeoutMs / 60000} мин` : r.output || `runz exit ${String(r.exitCode)}`
      return { ok: false, error: reason }
    }
    return { ok: true, value: { output: r.output, outputs: r.outputs, exitCode: r.exitCode ?? 0, stderr: r.stderr, ms: r.ms } }
  }

  /** `runz <appz> --k=v --runz-json` — appz по имени (v1 `host.run`). */
  function runAppz(name: string, values: Record<string, unknown>, signal: AbortSignal, timeoutMs: number, cwd: string): Promise<RunResult> {
    const started = Date.now()
    const args: string[] = [name]
    for (const [k, v] of Object.entries(values ?? {})) {
      if (v === null || v === undefined || v === false) continue
      args.push(v === true ? `--${k}` : `--${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }
    args.push('--runz-json')
    const [bin, ...pre] = runzCmd
    return new Promise((resolveP) => {
      let stdout = ''
      let stderr = ''
      let aborted = false
      let timedOut = false
      const child = spawn(bin!, [...pre, ...args], { cwd, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      const kill = (): void => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000).unref()
      }
      const onAbort = (): void => {
        aborted = true
        kill()
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c))
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr = (stderr + c).slice(-8000)))
      const done = (p: ReturnType<typeof parseResult>): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolveP({ ...p, ms: Date.now() - started, aborted, timedOut, stderr: stderr.slice(-4000) })
      }
      child.on('error', (e) => done({ ok: false, outputs: [], output: `runz не запустился: ${e.message}`, exitCode: null }))
      child.on('close', (code) => done(parseResult(stdout, code)))
    })
  }

  // ── события коллекций ───────────────────────────────────────────────────────

  function versionOf(dir: string): number {
    try {
      return Number(/^\s*\$version\s*:\s*(\d+)/m.exec(readFileSync(join(dir, MANIFEST), 'utf8'))?.[1] ?? 0)
    } catch {
      return -1
    }
  }

  const host: ArtifactHost = {
    origin,

    collections: (workspace) => listCollections(registry(workspace)),

    list(workspace) {
      return listArtifacts(listCollections(registry(workspace))).map((a) => ({ ...a, dataDir: artifactDataDir(a, opts.dataRoot) }))
    },

    async open(ref, o = {}) {
      const workspace = o.workspace ?? opts.root
      const info = resolveArtifact(ref, listCollections(registry(workspace)), workspace)
      if (!info) throw new Error(`артефакт не найден: ${ref}`)
      const key = keyOf(info.id, workspace, o.instance ?? null)
      const prev = sessions.get(key)
      const file = o.file === undefined ? (prev?.file ?? null) : o.file ? resolve(o.file) : null
      const s: Session = {
        key,
        info,
        workspace,
        file,
        kinds: o.kinds ?? (o.file === undefined ? (prev?.kinds ?? []) : []),
        dataDir: artifactDataDir(info, opts.dataRoot),
        selected: prev?.selected ?? new Set(),
        theme: o.theme ?? prev?.theme ?? null,
        locale: o.locale ?? prev?.locale ?? null,
      }
      if (file) s.selected.add(file)
      sessions.set(key, s)
      const warnings: string[] = []
      if (info.manifest && info.manifest.uses === null) {
        warnings.push('нет $uses — легаси-доступ ко всему; finalize такой артефакт не пропустит')
        if (!warnedLegacy.has(info.id)) {
          warnedLegacy.add(info.id)
          warn(`${info.id}: нет $uses — легаси-доступ`)
        }
      }
      if (info.manifest?.service === 'eager' && info.hasService) serviceOf(s)
      return {
        id: info.id,
        key,
        url: `${await origin}/a/${key}/`,
        path: `/a/${key}/`,
        title: info.title,
        version: info.version,
        dir: info.dir,
        uses: info.uses,
        readonly: info.readonly,
        hasService: info.hasService,
        warnings,
        ...(info.error ? { error: info.error } : {}),
      }
    },

    setFile(key, file, kinds) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      s.file = file ? resolve(file) : null
      s.kinds = kinds ?? []
      if (s.file) s.selected.add(s.file)
      return { ok: true, value: { file: s.file, dir: s.file ? dirname(s.file) : null, kinds: s.kinds } }
    },

    async bridge(key, method, args) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      refresh(s)
      const gate = check(s, method, args)
      if (!gate.ok) return gate
      try {
        return await op(s, method, args, gate.path, gate.args)
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    async run(key, target, values, signal) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      refresh(s)
      const gate = check(s, 'run', [target, values])
      if (!gate.ok) return gate
      try {
        return await runTarget(s, target, values ?? {}, signal, isTemplateTarget(target) ? gate.path : undefined)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    async appRun(key, values, signal, onEvent) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      const gate = check(s, 'app.run', [values])
      if (!gate.ok) return gate
      if (!opts.app) return { ok: false, error: 'app: приложений нет в этом хосте' }
      try {
        return await opts.app.run(s.info.dir, values, signal, onEvent)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    async jobAttach(key, id, from, signal, onFrame) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      const gate = check(s, 'job.attach', [id])
      if (!gate.ok) return gate
      const j = getJob(id)
      if (!j || !jobVisible(s, j)) return { ok: false, error: `нет задачи ${id}` }
      try {
        for await (const f of attachJob(id, { signal, from })) {
          if (signal.aborted) break
          // Файлы-результаты — гостю на чтение ({user-selected}), как у run.
          if (f.kind === 'end' && Array.isArray(f.outputs)) {
            for (const o of f.outputs as Array<{ path?: unknown }>) if (typeof o.path === 'string') s.selected.add(resolve(o.path))
          }
          onFrame(f)
        }
        return { ok: true, value: null }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    watchPath(key, path, signal, onChange) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      const gate = check(s, 'watch', [path])
      if (!gate.ok) return gate
      let timer: NodeJS.Timeout | null = null
      let w: TreeWatch | FSWatcher
      try {
        const target = gate.path!
        const isDirTarget = statSync(target).isDirectory()
        const bump = (): void => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(onChange, 100)
        }
        w = isDirTarget
          ? watchTree(target, bump)
          : watch(dirname(target), (_e, name) => {
              if (name && basename(String(name)) !== basename(target)) return
              bump()
            })
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      signal.addEventListener('abort', () => {
        if (timer) clearTimeout(timer)
        w.close()
      })
      return { ok: true, value: null }
    },

    serviceEvents(key, event, signal, onEvent) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      const gate = check(s, 'service.on', [event])
      if (!gate.ok) return gate
      if (!s.info.hasService) {
        onEvent({ state: 'down' })
        return { ok: true, value: null }
      }
      const off = serviceOf(s).on(event, onEvent)
      signal.addEventListener('abort', off)
      return { ok: true, value: null }
    },

    comfyEvents(key, signal, onEvent) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      const gate = check(s, 'comfy.events', [])
      if (!gate.ok) return gate
      const off = comfy.subscribe(s.key, onEvent)
      signal.addEventListener('abort', off, { once: true })
      return { ok: true, value: null }
    },

    imageEvents(key, signal, onEvent) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      const gate = check(s, 'image.events', [])
      if (!gate.ok) return gate
      const off = image.subscribe(s.key, onEvent)
      signal.addEventListener('abort', off, { once: true })
      return { ok: true, value: null }
    },

    events(o, signal, emit) {
      const workspace = o.workspace ?? opts.root
      const watchers: Array<TreeWatch | FSWatcher> = []
      const versions = new Map<string, number>()
      const timers = new Map<string, NodeJS.Timeout>()
      const collections = listCollections(registry(workspace))
      for (const a of listArtifacts(collections)) versions.set(a.dir, a.version)
      // Окно одного артефакта: его id/папка — фильтр очереди open. Не нашёлся —
      // окну не адресовано ничего: лучше не перезагрузить своё, чем угнать чужое.
      const own = o.single ? (resolveArtifact(o.single, collections) ?? { id: null, dir: null }) : null
      const addressed = (req: { id?: string; dir?: string }): boolean =>
        !own || (own.id !== null && req.id === own.id) || (own.dir !== null && typeof req.dir === 'string' && resolve(req.dir) === own.dir)
      // Открытые ad-hoc папки — вне коллекций, следим за ними отдельно.
      const adhoc = [...sessions.values()].filter((s) => !s.info.collection).map((s) => s.info.dir)
      for (const dir of adhoc) versions.set(dir, versionOf(dir))

      const onManifest = (dir: string): void => {
        const prev = timers.get(dir)
        if (prev) clearTimeout(prev)
        timers.set(
          dir,
          setTimeout(() => {
            timers.delete(dir)
            const v = versionOf(dir)
            const was = versions.get(dir)
            versions.set(dir, v)
            if (was === undefined) return emit({ name: 'list', payload: {} })
            if (v > was) {
              const info = readArtifact(dir, collections.find((c) => within(dir, c.dir) && dirname(dir) === c.dir) ?? null)
              emit({ name: 'reload', payload: { id: info.id, dir, version: v } })
              emit({ name: 'list', payload: {} })
            }
          }, 150),
        )
      }

      const watched = new Set<string>()
      const watchCollection = (c: Collection): void => {
        if (watched.has(c.dir)) return
        watched.add(c.dir)
        try {
          const w = watchTree(c.dir, (name) => {
            if (!name) return
            const rel = name.split(sep)
            if (rel.length === 1) return emit({ name: 'list', payload: {} })
            if (rel.length === 2 && rel[1] === MANIFEST) onManifest(join(c.dir, rel[0]!))
          })
          watchers.push(w)
        } catch (e) {
          warn(`watch ${c.dir}: ${(e as Error).message}`)
        }
      }
      for (const c of collections) watchCollection(c)
      for (const dir of adhoc) {
        try {
          watchers.push(watch(dir, (_e, name) => name && String(name) === MANIFEST && onManifest(dir)))
        } catch {
          // папку унесли
        }
      }
      // Рабочая область без `.nr/artifacts` — ждём, когда init её создаст, и
      // подключаем на лету: иначе finalize в новой коллекции не перезагрузил бы вкладку.
      const wsDir = join(workspace, WORKSPACE_COLLECTION)
      if (!collections.some((c) => c.kind === 'workspace') && existsSync(workspace)) {
        const adopt = (): void => {
          if (!existsSync(wsDir) || watched.has(resolve(wsDir))) return
          const c = listCollections(registry(workspace)).find((x) => x.kind === 'workspace')
          if (!c) return
          collections.push(c)
          watchCollection(c)
          for (const a of listCollection(c)) if (!versions.has(a.dir)) versions.set(a.dir, a.version)
          emit({ name: 'list', payload: {} })
        }
        try {
          watchers.push(watchTree(workspace, (name) => name.startsWith('.nr') && adopt()))
        } catch {
          // не следим
        }
      }

      // Очередь `artifact_open`: читаем только то, что дописано после подписки.
      const queue = openQueueFile(opts.dataRoot)
      mkdirSync(dirname(queue), { recursive: true })
      let offset = existsSync(queue) ? statSync(queue).size : 0
      const readQueue = (): void => {
        let size: number
        try {
          size = statSync(queue).size
        } catch {
          return
        }
        if (size < offset) offset = 0
        if (size === offset) return
        const buf = readFileSync(queue).subarray(offset, size).toString('utf8')
        offset = size
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue
          try {
            const req = JSON.parse(line) as { id?: string; dir?: string; check?: string }
            if (!req.id || !addressed(req)) continue
            // Проверка рантайма: запрос дошёл до живого клиента — pi перестаёт ждать «нет nrchat».
            if (typeof req.check === 'string') {
              try {
                ackCheck(req.check, opts.dataRoot)
              } catch (e) {
                warn(`check ${req.check}: ${(e as Error).message}`)
              }
            }
            emit({ name: 'open', payload: { id: req.id, ...(req.dir ? { dir: req.dir } : {}), ...(typeof req.check === 'string' ? { check: req.check } : {}) } })
          } catch {
            // битая строка
          }
        }
      }
      try {
        watchers.push(watch(dirname(queue), (_e, name) => name && String(name) === basename(queue) && readQueue()))
      } catch (e) {
        warn(`watch ${queue}: ${(e as Error).message}`)
      }
      // Страховка к watch: FSEvents на macOS теряет изменения первых секунд после
      // подписки — а finalize агента с проверкой ждёт ответа именно сейчас. stat раз в полсекунды дёшев.
      const poll = setInterval(readQueue, 500)
      poll.unref()

      signal.addEventListener('abort', () => {
        clearInterval(poll)
        for (const w of watchers) w.close()
        for (const t of timers.values()) clearTimeout(t)
      })
    },

    async http(req) {
      // Тот же сервер статики (права, JSX, prelude), без второго кода: петля на свой origin.
      const path = req.path.startsWith('/') ? req.path : `/${req.path}`
      const r = await fetch(`${await origin}${path.split('/').map(encodeURIComponent).join('/')}${req.query ?? ''}`, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        // Переход (прямая ссылка `open/`) — браузеру как есть: относительный адрес страницы считается от его URL.
        redirect: 'manual',
        headers: Object.fromEntries(Object.entries(req.headers ?? {}).filter(([k]) => /^(accept|accept-language|range|if-none-match)$/i.test(k))),
      })
      const headers: Record<string, string> = {}
      for (const k of ['content-type', 'cache-control', 'content-range', 'accept-ranges', 'etag', 'location']) {
        const v = r.headers.get(k)
        if (v) headers[k] = v
      }
      const len = Number(r.headers.get('content-length') ?? 0)
      if (len > MAX_READ) {
        await r.body?.cancel()
        return { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `больше ${MAX_READ >> 20} МБ — через бэкенд не отдаётся` }
      }
      const buf = Buffer.from(await r.arrayBuffer())
      const text = /^(text\/|application\/(json|javascript))/.test(headers['content-type'] ?? '')
      return { status: r.status, headers, body: text ? buf.toString('utf8') : b64(buf) }
    },

    reportErrors(key, errors) {
      let s: Session
      try {
        s = sessionOf(key)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      const list = errors.map(normalizeRuntimeError).filter((e): e is RuntimeError => e !== null)
      if (list.length) appendRuntimeErrors(s.info, list, opts.dataRoot)
      return { ok: true, value: list.length }
    },

    checked(check, key, errors) {
      const list = errors.map(normalizeRuntimeError).filter((e): e is RuntimeError => e !== null)
      const s = sessions.get(key)
      if (s && list.length) appendRuntimeErrors(s.info, list, opts.dataRoot)
      try {
        return { ok: true, value: writeCheckResult(check, list, opts.dataRoot) }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    init: (o) => initArtifact({ ...registry(o.workspace ?? null), ...o }),
    finalize: (ref, expectedVersion, workspace) =>
      finalizeArtifact(ref, { ...registry(workspace), ...(expectedVersion === undefined ? {} : { expectedVersion }) }),
    revert: (ref, version, workspace) => revertArtifact(ref, version, registry(workspace)),
    listForAgent: (workspace, collection) => listForAgent({ ...registry(workspace), ...(collection ? { collection } : {}) }),

    async close() {
      comfy.close()
      image.close()
      await Promise.all([...services.values()].map((p) => p.stop()))
      services.clear()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
  return host
}

/** Байты гостя: `{__b64}` провода, Uint8Array (тесты, in-process). */
function bytesOf(v: unknown, method: string): Buffer {
  if (v instanceof Uint8Array) return Buffer.from(v)
  const w = fromWire(v)
  if (typeof w !== 'string') return w
  throw new Error(`${method}: нужны байты (Uint8Array)`)
}

const escapeHtml = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

/**
 * Путь `fileUrl`: `/f/<key>/<папка base64url>/<имя>` — оканчивается
 * именем файла с расширением (загрузчики по расширению: Pixi `Assets`, шрифты),
 * а относительные ссылки от него резолвятся в той же папке. Папка — как её дал
 * гость (абсолютная, `~` или от папки артефакта); пустая — `.`. Тот же код — в
 * prelude (`__host.fileUrl`), проверка `$fs-read` — на запросе.
 */
export function fileUrlPath(key: string, path: string): string {
  const p = path.startsWith('file://') ? decodeURIComponent(new URL(path).pathname) : path
  const at = p.lastIndexOf('/')
  const dir = at < 0 ? '.' : at === 0 ? '/' : p.slice(0, at)
  const name = at < 0 ? p : p.slice(at + 1)
  return `/f/${key}/${Buffer.from(dir, 'utf8').toString('base64url')}/${encodeURIComponent(name)}`
}

/** Обратное {@link fileUrlPath}: токен папки + сегменты пути после него → путь гостя. */
export function fileUrlGuestPath(token: string, rest: readonly string[]): string {
  const dir = Buffer.from(token, 'base64url').toString('utf8')
  const tail = rest.join('/')
  return dir === '.' ? tail : `${dir.replace(/\/+$/, '')}/${tail}`
}
