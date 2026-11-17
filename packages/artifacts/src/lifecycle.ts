/**
 * Жизненный цикл для агента (artifacts-spec §6): init → правки файлами → finalize.
 *
 * finalize:
 *   1. разбор манифеста (ошибка — с номером строки);
 *   2. статическая проверка ({@link checkArtifact});
 *   3. компиляция JSX / смок-сборка модулей html-входа;
 *   4. `$version` +1; снимок новой версии — `.history/<version>/` (последние 10):
 *      откат без git, репо коллекции не трогается;
 *   5. открытые вкладки перезагружает сервис плагина — он следит за `meta.mdz`.
 * `{changed, version, warnings, errors}`; при `errors` версия не растёт.
 * `expectedVersion` не совпал — отказ с текущей версией. Две параллельные
 * finalize сериализуются блокировкой каталога и не затирают друг друга.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { checkArtifact } from './check.js'
import type { ArtifactInfo, Collection, RegistryOpts } from './collections.js'
import { MANIFEST, WORKSPACE_COLLECTION, entryOf, expandHome, listArtifacts, listCollections, readArtifact, resolveArtifact } from './collections.js'
import { CompileError, compileJsx, isHostImport, KIT_IMPORT, VENDORED } from './compile.js'
import type { Capability } from './manifest.js'
import { parseManifest, setManifestVersion } from './manifest.js'
import { templateFiles, TEMPLATES } from './templates.js'
import type { TemplateName } from './templates.js'

export const HISTORY_DIR = '.history'
export const HISTORY_KEEP = 10
const LOCK_DIR = '.finalize.lock'
const LOCK_WAIT_MS = 15_000
const LOCK_STALE_MS = 60_000
/** Что не входит в снимок и в хэш содержимого. */
const SNAPSHOT_SKIP = new Set([HISTORY_DIR, LOCK_DIR, 'data', 'node_modules', '.git', '.DS_Store'])

/** Каталог данных плагина по конвенции runz (`nrchat-{pluginId}`). */
export function pluginDataRoot(): string {
  return process.env.NR_ARTIFACTS_DATA || join(homedir(), '.runz', 'data', 'nrchat-artifacts')
}

/** `{artifact}/data` гостя: вне папки артефакта — репо коллекции чистое, демо только для чтения. */
export function artifactDataDir(info: Pick<ArtifactInfo, 'collection' | 'folder' | 'dir'>, root = pluginDataRoot()): string {
  if (info.collection) return join(root, 'data', info.collection, info.folder)
  const h = createHash('sha1').update(resolve(info.dir)).digest('hex').slice(0, 10)
  return join(root, 'data', '_path', `${info.folder}-${h}`)
}

// ────────────────────────────────────────────────────────────────────────────
// init
// ────────────────────────────────────────────────────────────────────────────

export interface InitOpts extends RegistryOpts {
  name: string
  template?: TemplateName
  /** Id коллекции или путь к каталогу; без него — рабочая область, иначе `$default` реестра. */
  collection?: string
  /** Папка занята → `<slug>-2`, `-3`… вместо ошибки (повторное «сохранить как артефакт»). */
  unique?: boolean
}

export interface InitResult {
  id: string
  dir: string
  collection: string
  files: string[]
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

const TRANSLIT: Record<string, string> = Object.fromEntries(
  'а:a б:b в:v г:g д:d е:e ё:e ж:zh з:z и:i й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:h ц:c ч:ch ш:sh щ:sch ъ: ы:y ь: э:e ю:yu я:ya'
    .split(' ')
    .map((p) => p.split(':') as [string, string]),
)

/** Куда класть новое: явная → рабочая область (создаётся) → `$default` → первая реестровая. */
export function targetCollection(opts: InitOpts): Collection {
  const collections = listCollections(opts)
  if (opts.collection) {
    const byId = collections.find((c) => c.id === opts.collection)
    if (byId) {
      if (byId.readonly) throw new Error(`коллекция ${byId.id} только для чтения`)
      return byId
    }
    const dir = resolve(expandHome(opts.collection))
    mkdirSync(dir, { recursive: true })
    return listCollections({ ...opts, extra: [...(opts.extra ?? []), dir] }).find((c) => c.dir === dir)!
  }
  if (opts.workspace) {
    const dir = join(resolve(opts.workspace), WORKSPACE_COLLECTION)
    mkdirSync(dir, { recursive: true })
    return listCollections(opts).find((c) => c.kind === 'workspace')!
  }
  const registry = collections.filter((c) => c.kind === 'registry')
  const target = registry.find((c) => c.isDefault) ?? registry[0]
  if (!target) throw new Error('некуда положить артефакт: нет рабочей области, коллекций $artifacts в ~/.runz/config.md и явной collection')
  return target
}

export function initArtifact(opts: InitOpts): InitResult {
  const folder = slugify(opts.name)
  if (!folder) throw new Error(`имя "${opts.name}" не даёт имени папки`)
  const template = opts.template ?? 'html'
  if (!TEMPLATES.includes(template)) throw new Error(`шаблон "${template}" неизвестен: ${TEMPLATES.join(' | ')}`)
  const c = targetCollection(opts)
  let name = folder
  if (opts.unique) for (let n = 2; existsSync(join(c.dir, name)); n++) name = `${folder}-${n}`
  const dir = join(c.dir, name)
  if (existsSync(dir)) throw new Error(`артефакт уже есть: ${c.id}/${name} (${dir})`)
  mkdirSync(dir, { recursive: true })
  const files = templateFiles(template, opts.name.trim())
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return { id: `${c.id}/${name}`, dir, collection: c.id, files: Object.keys(files) }
}

// ────────────────────────────────────────────────────────────────────────────
// finalize
// ────────────────────────────────────────────────────────────────────────────

export interface FinalizeOpts extends RegistryOpts {
  expectedVersion?: number
}

export interface FinalizeResult {
  id: string
  dir: string
  changed: boolean
  version: number
  warnings: string[]
  errors: string[]
  uses?: Capability[] | null
}

function* walk(dir: string, base = dir): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    if (SNAPSHOT_SKIP.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p, base)
    else if (st.isFile()) yield relative(base, p)
  }
}

/** Хэш содержимого папки; строка `$version` манифеста не считается. */
export function contentHash(dir: string): string {
  const h = createHash('sha1')
  for (const rel of walk(dir)) {
    let data: Buffer | string = readFileSync(join(dir, rel))
    if (rel === MANIFEST) data = data.toString('utf8').replace(/^[ \t]*\$version[ \t]*:.*(?:\r?\n|$)/m, '')
    h.update(rel).update('\0').update(data).update('\0')
  }
  return h.digest('hex')
}

const HASH_FILE = '.content-hash'

function snapshot(dir: string, version: number, hash: string): void {
  const target = join(dir, HISTORY_DIR, String(version))
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const rel of walk(dir)) {
    const to = join(target, rel)
    mkdirSync(resolve(to, '..'), { recursive: true })
    cpSync(join(dir, rel), to)
  }
  writeFileSync(join(target, HASH_FILE), hash)
  // Последние HISTORY_KEEP версий.
  const versions = historyVersions(dir)
  for (const v of versions.slice(0, Math.max(0, versions.length - HISTORY_KEEP))) {
    rmSync(join(dir, HISTORY_DIR, String(v)), { recursive: true, force: true })
  }
}

export function historyVersions(dir: string): number[] {
  try {
    return readdirSync(join(dir, HISTORY_DIR))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, LOCK_DIR)
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`finalize занят: ${lock} (другая finalize идёт дольше ${LOCK_WAIT_MS / 1000} с)`)
      await sleep(50 + Math.random() * 50)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Локальные модули `<script type=module src=…>` html-входа. */
function htmlModules(dir: string): string[] {
  let html: string
  try {
    html = readFileSync(join(dir, 'index.html'), 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1]!
    if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) continue
    out.push(src.replace(/^\.\//, '').split(/[?#]/)[0]!)
  }
  return out
}

/** Смок-сборка: JSX-вход компилируется, модули html-входа собираются без записи. */
export async function smokeBuild(dir: string, entry: 'html' | 'jsx'): Promise<string[]> {
  if (entry === 'jsx') {
    try {
      await compileJsx(dir)
      return []
    } catch (e) {
      return e instanceof CompileError && e.errors.length ? e.errors : [(e as Error).message]
    }
  }
  const errors: string[] = []
  for (const src of htmlModules(dir)) {
    const file = join(dir, src)
    if (!existsSync(file)) {
      errors.push(`index.html: <script src="${src}"> — файла нет`)
      continue
    }
    try {
      await esbuild.build({
        entryPoints: [file],
        absWorkingDir: dir,
        bundle: true,
        write: false,
        format: 'esm',
        jsx: 'automatic',
        loader: { '.js': 'jsx', '.jsx': 'jsx', '.json': 'json', '.css': 'text' },
        external: [...Object.keys(VENDORED), KIT_IMPORT],
        logLevel: 'silent',
        plugins: [
          {
            name: 'bare-guard',
            setup(b) {
              b.onResolve({ filter: /^[^./]/ }, (a) => (isHostImport(a.path) || /^https?:/.test(a.path) ? { path: a.path, external: true } : { errors: [{ text: `голый импорт "${a.path}"` }] }))
            },
          },
        ],
      })
    } catch (e) {
      for (const m of (e as esbuild.BuildFailure).errors ?? [{ text: (e as Error).message }]) {
        const loc = m.location ? `${relative(dir, resolve(dir, m.location.file))}:${m.location.line}: ` : ''
        errors.push(`${loc}${m.text}`)
      }
    }
  }
  return errors
}

function locate(ref: string, opts: RegistryOpts): ArtifactInfo {
  const info = resolveArtifact(ref, listCollections(opts))
  if (!info) throw new Error(`артефакт не найден: ${ref}`)
  return info
}

export async function finalizeArtifact(ref: string, opts: FinalizeOpts = {}): Promise<FinalizeResult> {
  const found = locate(ref, opts)
  if (found.readonly) throw new Error(`${found.id}: коллекция только для чтения`)
  const dir = found.dir
  return withLock(dir, async () => {
    const base = { id: found.id, dir }
    const text = readFileSync(join(dir, MANIFEST), 'utf8')
    const parsed = parseManifest(text)
    const current = parsed.ok ? parsed.value.version : Number(/^\s*\$version\s*:\s*(\d+)/m.exec(text)?.[1] ?? 0)

    if (opts.expectedVersion !== undefined && opts.expectedVersion !== current) {
      return {
        ...base,
        changed: false,
        version: current,
        warnings: [],
        errors: [`expectedVersion ${opts.expectedVersion} устарела: текущая версия ${current} — перечитай файлы и повтори`],
      }
    }
    if (!parsed.ok) {
      return { ...base, changed: false, version: current, warnings: [], errors: [parsed.line ? `${parsed.error} (строка ${parsed.line})` : parsed.error] }
    }

    const check = checkArtifact(dir, parsed.value)
    const errors = [...check.errors]
    const { entry } = entryOf(dir)
    if (entry && errors.length === 0) errors.push(...(await smokeBuild(dir, entry)))
    if (errors.length > 0) return { ...base, changed: false, version: current, warnings: check.warnings, errors, uses: parsed.value.uses }

    const hash = contentHash(dir)
    let prevHash = ''
    try {
      prevHash = readFileSync(join(dir, HISTORY_DIR, String(current), HASH_FILE), 'utf8').trim()
    } catch {
      // снимка текущей версии нет — первая finalize
    }
    if (current > 0 && prevHash === hash) {
      return { ...base, changed: false, version: current, warnings: check.warnings, errors: [], uses: parsed.value.uses }
    }

    const next = current + 1
    writeFileSync(join(dir, MANIFEST), setManifestVersion(text, next))
    snapshot(dir, next, hash)
    return { ...base, changed: true, version: next, warnings: check.warnings, errors: [], uses: parsed.value.uses }
  })
}

// ────────────────────────────────────────────────────────────────────────────
// revert / list / open
// ────────────────────────────────────────────────────────────────────────────

/** Вернуть файлы версии из `.history/` и финализировать их как новую версию (номера монотонны). */
export async function revertArtifact(ref: string, version: number, opts: RegistryOpts = {}): Promise<FinalizeResult> {
  const found = locate(ref, opts)
  if (found.readonly) throw new Error(`${found.id}: коллекция только для чтения`)
  const dir = found.dir
  const from = join(dir, HISTORY_DIR, String(version))
  if (!existsSync(from)) throw new Error(`${found.id}: версии ${version} нет в ${HISTORY_DIR}/ (есть: ${historyVersions(dir).join(', ') || '—'})`)
  const current = found.version
  for (const rel of [...walk(dir)]) rmSync(join(dir, rel), { force: true })
  for (const rel of walk(from)) {
    if (rel === HASH_FILE) continue
    const to = join(dir, rel)
    mkdirSync(resolve(to, '..'), { recursive: true })
    cpSync(join(from, rel), to)
  }
  const manifest = join(dir, MANIFEST)
  writeFileSync(manifest, setManifestVersion(readFileSync(manifest, 'utf8'), current))
  return finalizeArtifact(dir, opts)
}

export interface ListedArtifact {
  id: string
  collection: string
  title: string
  description: string
  version: number
  uses: Capability[] | null
  dir: string
  error?: string
}

export function listForAgent(opts: RegistryOpts & { collection?: string } = {}): ListedArtifact[] {
  return listArtifacts(listCollections(opts), opts.collection).map((a) => ({
    id: a.id,
    collection: a.collection,
    title: a.title,
    description: a.description,
    version: a.version,
    uses: a.uses,
    dir: a.dir,
    ...(a.error ? { error: a.error } : {}),
  }))
}

/** Файл очереди «открыть вкладку» (`artifact_open` → сервис плагина следит). */
export function openQueueFile(root = pluginDataRoot()): string {
  return join(root, 'open.jsonl')
}

/**
 * Открыть вкладку в живом nrchat. `check` — id проверки рантайма (runtime.ts):
 * вкладка после загрузки и окна пришлёт ошибки гостя, сервис положит их в
 * `checks/<check>.json`.
 */
export function requestOpen(ref: string, opts: RegistryOpts & { root?: string; check?: string } = {}): ArtifactInfo {
  const info = locate(ref, opts)
  const file = openQueueFile(opts.root)
  mkdirSync(resolve(file, '..'), { recursive: true })
  const line = { id: info.id, dir: info.dir, at: Date.now(), ...(opts.check ? { check: opts.check, version: info.version } : {}) }
  appendFileSync(file, `${JSON.stringify(line)}\n`)
  return info
}

export { readArtifact }
