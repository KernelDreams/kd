/**
 * Права (artifacts-spec §5). Декларация, не безопасность: доверие «свой диск»,
 * задача — чтобы автор явно назвал, что трогает, а у хоста была одна точка
 * проверки. {@link checkAccess} — та самая точка: через неё проходят все
 * методы моста (сервис плагина) и раздача файлов гостю (`fileUrl`).
 *
 *   $uses:      $[file, run, clipboard, service, comfy, image, viewer, app]
 *   $fs-read:   {artifact}, {workspace}, {user-selected}
 *   $fs-write:  {artifact}
 *   $run-allow: comfy, vision, ./templates/*.md
 *   $session-read:  meta, personas, history     (право session; ./session.ts)
 *   $session-write: meta, personas
 *   skins — редактор тем (./skins.ts): skins.list/get/contract/check/save/preview/apply
 *
 * Плейсхолдеры: `{artifact}` (своя папка и каталог данных — всегда),
 * `{workspace}` (каталог сессии nrchat), `{user-selected}` (выбранное через
 * `openDialog` и файлы-результаты `run`), `$file-dir` (он же `{file-dir}`:
 * папка файла, на котором открыт артефакт вкладкой файла, с подпапками; без
 * файла — пусто), `{home}` (явно, высокий риск). Кроме
 * них — литеральные пути (`~/Studio/forms`). Без `$fs-read` — `{artifact},
 * {workspace}, {user-selected}`; без `$fs-write` — `{artifact}, {user-selected}`.
 * Без `$uses` — легаси: всё можно (+ предупреждение хоста), как в v1.
 *
 * `comfy.save` (результат генерации с воркфлоу в PNG) и `image.save` пишут туда,
 * куда пускает `$fs-write`, и ещё в `{workspace}`: сохранить картинку в рабочую
 * область — смысл прав `comfy`/`image`. Относительный путь — от рабочей области.
 */

import { homedir } from 'node:os'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { ArtifactManifest, Capability } from './manifest.js'
import { expandHome } from './collections.js'
import { SESSION_METHODS, checkSession } from './session.js'
import { SKINS_METHODS, checkSkinsArgs } from './skins.js'

/** Метод моста → право. Без записи — права не нужно (`getContext`, `storage.*`). */
export const METHOD_CAPABILITY: Readonly<Record<string, Capability>> = {
  readFile: 'file',
  readFileBinary: 'file',
  writeFile: 'file',
  listDir: 'file',
  fileUrl: 'file',
  watch: 'watch',
  openDialog: 'dialog',
  run: 'run',
  'run.cancel': 'run',
  'job.start': 'job',
  'job.list': 'job',
  'job.get': 'job',
  'job.attach': 'job',
  'job.cancel': 'job',
  'service.call': 'service',
  'service.on': 'service',
  clipboardRead: 'clipboard',
  clipboardWrite: 'clipboard',
  clipboardReadImage: 'clipboard',
  clipboardWriteImage: 'clipboard',
  'comfy.parse': 'comfy',
  'comfy.objectInfo': 'comfy',
  'comfy.inputs': 'comfy',
  'comfy.upload': 'comfy',
  'comfy.queue': 'comfy',
  'comfy.interrupt': 'comfy',
  'comfy.view': 'comfy',
  'comfy.save': 'comfy',
  'comfy.events': 'comfy',
  'image.providers': 'image',
  'image.models': 'image',
  'image.schema': 'image',
  'image.generate': 'image',
  'image.cancel': 'image',
  'image.bytes': 'image',
  'image.save': 'image',
  'image.events': 'image',
  'viewer.open': 'viewer',
  // Вид mdz-приложения (mdz-apps-spec §2): запуск, лог дня, пин запуска.
  'app.run': 'app',
  'app.log': 'app',
  'app.pin': 'app',
  // Голос и модель: без своего service.ts.
  'speak.say': 'speak',
  'speak.voices': 'speak',
  'speak.transcribe': 'speak',
  'llm.complete': 'llm',
  'llm.models': 'llm',
  ...Object.fromEntries(Object.keys(SESSION_METHODS).map((m) => [m, 'session' as const])),
  ...Object.fromEntries(SKINS_METHODS.map((m) => [m, 'skins' as const])),
}

/** Методы, которых право не требует. */
export const FREE_METHODS = ['getContext', 'storage.get', 'storage.set'] as const

export const KNOWN_METHODS: readonly string[] = [...Object.keys(METHOD_CAPABILITY), ...FREE_METHODS]

const READ_METHODS = new Set(['readFile', 'readFileBinary', 'listDir', 'fileUrl', 'watch'])
const WRITE_METHODS = new Set(['writeFile'])

export const DEFAULT_FS_READ = ['{artifact}', '{workspace}', '{user-selected}']
export const DEFAULT_FS_WRITE = ['{artifact}', '{user-selected}']

/** Где живёт артефакт в момент вызова — всё, от чего зависят плейсхолдеры. */
export interface AccessEnv {
  artifactDir: string
  dataDir: string
  workspace: string | null
  /** Выбранное пользователем (`openDialog`) и отданное хостом (`run` outputs). */
  selected: ReadonlySet<string>
  /** Папка файла окна (`$file-dir`); `null` — артефакт открыт без файла. */
  fileDir?: string | null
  home?: string
  /** Id артефакта — владелец тулов сессии (`session.tools.register`). */
  artifactId?: string
}

/** Скоуп «папка открытого файла»: каноническое имя и синоним в духе плейсхолдеров. */
export const FILE_DIR_SCOPES = ['$file-dir', '{file-dir}'] as const
const isFileDirScope = (s: string): boolean => (FILE_DIR_SCOPES as readonly string[]).includes(s)

/** `args` — нормализованные аргументы метода (`session.*`): их и исполняет фронт. */
export type AccessResult = { ok: true; path?: string; args?: unknown } | { ok: false; error: string }

const within = (child: string, parent: string): boolean => {
  if (child === parent) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Путь гостя → абсолютный: `~` раскрыт, относительный — от папки артефакта. */
export function resolveGuestPath(path: unknown, artifactDir: string): string | null {
  if (typeof path !== 'string' || path.trim() === '') return null
  let p = path.trim()
  if (p.startsWith('file://')) p = decodeURIComponent(new URL(p).pathname)
  return resolve(artifactDir, expandHome(p))
}

/** Скоупы → корни, внутри которых путь разрешён. */
export function scopeRoots(scopes: readonly string[], env: AccessEnv): string[] {
  const roots: string[] = []
  for (const raw of scopes) {
    const s = raw.trim()
    if (s === '{artifact}') roots.push(env.artifactDir, env.dataDir)
    else if (s === '{workspace}') {
      if (env.workspace) roots.push(env.workspace)
    } else if (s === '{user-selected}') roots.push(...env.selected)
    else if (isFileDirScope(s)) {
      if (env.fileDir) roots.push(env.fileDir)
    } else if (s === '{home}') roots.push(env.home ?? homedir())
    else if (s && !s.startsWith('{') && !s.startsWith('$')) roots.push(resolve(env.artifactDir, expandHome(s)))
  }
  return roots.map((r) => resolve(r))
}

/** Разрешён ли путь списком скоупов. */
export function pathAllowed(path: string, scopes: readonly string[], env: AccessEnv): boolean {
  return scopeRoots(scopes, env).some((root) => within(path, root))
}

/** Глоб `*` / `**` / `?` → RegExp по полному пути. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^${re}$`)
}

/** `run(target)`: имя appz (без `/` и расширения) либо путь к runz-шаблону. */
export function isTemplateTarget(target: string): boolean {
  return target.includes('/') || target.includes('\\') || target.startsWith('~') || ['.md', '.mdz'].includes(extname(target).toLowerCase())
}

/** Разрешён ли `run(target)` списком `$run-allow` (пусто — любой). */
export function runAllowed(target: string, allow: readonly string[], artifactDir: string): boolean {
  if (allow.length === 0) return true
  if (!isTemplateTarget(target)) return allow.includes(target)
  const abs = resolve(artifactDir, expandHome(target))
  return allow.some((entry) => {
    if (!isTemplateTarget(entry)) return false
    const pattern = resolve(artifactDir, expandHome(entry))
    return globToRegExp(pattern).test(abs)
  })
}

/**
 * Единая точка проверки: право метода, затем скоуп пути/цели. `args` — как у
 * метода моста (путь — первый аргумент; у `run` — цель). Для файловых методов
 * возвращает разрешённый абсолютный путь — исполнитель берёт его, а не сырой.
 */
export function checkAccess(
  manifest: (Pick<ArtifactManifest, 'uses' | 'fsRead' | 'fsWrite' | 'runAllow'> & Partial<Pick<ArtifactManifest, 'sessionRead' | 'sessionWrite'>>) | null,
  method: string,
  args: readonly unknown[],
  env: AccessEnv,
): AccessResult {
  if (!KNOWN_METHODS.includes(method)) return { ok: false, error: `unknown bridge method: ${method}` }
  // Сессия чата: право, скоуп $session-read/-write и форма аргументов — в одном месте.
  if (method in SESSION_METHODS) {
    const r = checkSession(manifest ? { uses: manifest.uses, sessionRead: manifest.sessionRead ?? null, sessionWrite: manifest.sessionWrite ?? null } : null, method, args, env.artifactId ?? '')
    return r.ok ? { ok: true, ...(r.value !== undefined ? { args: r.value } : {}) } : r
  }
  const uses = manifest?.uses ?? null
  const cap = METHOD_CAPABILITY[method]
  if (uses !== null && cap && !uses.includes(cap)) {
    return { ok: false, error: `capability not declared: ${cap}${cap === 'skins' ? ' — добавь skins в $uses (редактор тем)' : ''}` }
  }
  // Скины: форма аргументов — здесь, исполнение — хост и фронт.
  if (cap === 'skins') {
    const r = checkSkinsArgs(method, args)
    return r.ok ? { ok: true, args: r.value } : r
  }

  if (READ_METHODS.has(method) || WRITE_METHODS.has(method)) {
    const path = resolveGuestPath(args[0], env.artifactDir)
    if (!path) return { ok: false, error: `${method}: нет пути` }
    if (uses === null) return { ok: true, path }
    const write = WRITE_METHODS.has(method)
    const scopes = write ? (manifest?.fsWrite ?? DEFAULT_FS_WRITE) : (manifest?.fsRead ?? DEFAULT_FS_READ)
    if (!pathAllowed(path, scopes, env)) {
      // `$file-dir` в доке без файла пуст: путь пустого скоупа — не «за папкой», а «скоупа нет».
      if (!env.fileDir && scopes.some((x) => isFileDirScope(x.trim()))) {
        return { ok: false, error: `capability not declared: $file-dir (артефакт открыт без файла): ${path}` }
      }
      return { ok: false, error: `path not allowed by $fs-${write ? 'write' : 'read'}: ${path}` }
    }
    return { ok: true, path }
  }

  if (method === 'comfy.save' || method === 'image.save') {
    const path = resolveGuestPath(args[2], env.workspace ?? env.artifactDir)
    if (!path) return { ok: false, error: `${method}: нет пути` }
    if (uses === null) return { ok: true, path }
    const scopes = [...(manifest?.fsWrite ?? DEFAULT_FS_WRITE), '{workspace}']
    if (!pathAllowed(path, scopes, env)) return { ok: false, error: `path not allowed by $fs-write (+{workspace}): ${path}` }
    return { ok: true, path }
  }

  // Задачи (jobs-spec §6): цель — тем же $run-allow, что у run; путь — от папки артефакта.
  if (method === 'job.start') {
    const target = typeof args[0] === 'string' ? args[0].trim() : ''
    if (!target) return { ok: false, error: 'job.start: нет цели (имя appz или путь к шаблону)' }
    if (uses !== null && !runAllowed(target, manifest?.runAllow ?? [], env.artifactDir)) {
      return { ok: false, error: `job target not allowed by $run-allow: ${target}` }
    }
    return { ok: true, ...(isTemplateTarget(target) ? { path: resolve(env.artifactDir, expandHome(target)) } : {}) }
  }

  if (method === 'run') {
    const target = typeof args[0] === 'string' ? args[0].trim() : ''
    if (!target) return { ok: false, error: 'run: нет цели (имя appz или путь к шаблону)' }
    if (uses !== null && !runAllowed(target, manifest?.runAllow ?? [], env.artifactDir)) {
      return { ok: false, error: `run target not allowed by $run-allow: ${target}` }
    }
    return { ok: true, ...(isTemplateTarget(target) ? { path: resolve(env.artifactDir, expandHome(target)) } : {}) }
  }

  return { ok: true }
}
