/**
 * Статическая проверка артефакта (artifacts-spec §6, шаг 2 finalize; бывший
 * `exz check`). Всё, что делает агент, декларирует права:
 *
 *   - `$uses` есть и покрывает вызовы `__host.*` в коде; незнакомый `__host.x`
 *     — несуществующий API (профиль говорит, чем заменить);
 *   - голых импортов нет, кроме import map (React хоста);
 *   - абсолютных путей нет (`/Users/…`, `/home/…`, `C:\…`);
 *   - `navigator.clipboard` нет — буфер через `__host.clipboard`;
 *   - вход ровно один (`index.html` xor `index.jsx`).
 *
 * Возвращает ошибки и предупреждения с `файл:строка`; throw не бывает.
 */

import { checkIcon } from './icon.js'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { formatIssue, validateSkin } from '@kerneldreams/skins'
import { entryOf } from './collections.js'
import { isHostImport, KIT_IMPORT, VENDORED } from './compile.js'
import type { ArtifactManifest, Capability } from './manifest.js'
import { CAPABILITIES } from './manifest.js'
import { SESSION_METHODS, sessionManifestErrors, sessionScopes } from './session.js'

export interface CheckResult {
  errors: string[]
  warnings: string[]
  /** Права, которые код реально зовёт. */
  used: Capability[]
}

/** `__host.<путь>` → право. `null` — права не нужно. Нет ключа — API не существует. */
const HOST_API: Readonly<Record<string, Capability | null>> = {
  readFile: 'file',
  readFileBinary: 'file',
  writeFile: 'file',
  listDir: 'file',
  fileUrl: 'file',
  fileBlob: 'file',
  watch: 'watch',
  openDialog: 'dialog',
  run: 'run',
  'run.cancel': 'run',
  job: 'job',
  'job.start': 'job',
  'job.list': 'job',
  'job.get': 'job',
  'job.attach': 'job',
  'job.cancel': 'job',
  service: 'service',
  'service.call': 'service',
  'service.on': 'service',
  clipboard: 'clipboard',
  'clipboard.read': 'clipboard',
  'clipboard.write': 'clipboard',
  'clipboard.readImage': 'clipboard',
  'clipboard.writeImage': 'clipboard',
  comfy: 'comfy',
  'comfy.parse': 'comfy',
  'comfy.objectInfo': 'comfy',
  'comfy.inputs': 'comfy',
  'comfy.upload': 'comfy',
  'comfy.queue': 'comfy',
  'comfy.interrupt': 'comfy',
  'comfy.view': 'comfy',
  'comfy.save': 'comfy',
  'comfy.on': 'comfy',
  image: 'image',
  'image.providers': 'image',
  'image.models': 'image',
  'image.schema': 'image',
  'image.generate': 'image',
  'image.cancel': 'image',
  'image.bytes': 'image',
  'image.save': 'image',
  'image.url': 'image',
  'image.on': 'image',
  'image.wait': 'image',
  viewer: 'viewer',
  'viewer.open': 'viewer',
  app: 'app',
  'app.run': 'app',
  'app.log': 'app',
  'app.pin': 'app',
  speak: 'speak',
  'speak.say': 'speak',
  'speak.play': 'speak',
  'speak.stop': 'speak',
  'speak.voices': 'speak',
  'speak.transcribe': 'speak',
  'speak.record': 'speak',
  llm: 'llm',
  'llm.complete': 'llm',
  'llm.models': 'llm',
  skins: 'skins',
  'skins.list': 'skins',
  'skins.get': 'skins',
  'skins.contract': 'skins',
  'skins.check': 'skins',
  'skins.save': 'skins',
  'skins.preview': 'skins',
  'skins.apply': 'skins',
  session: 'session',
  'session.meta': 'session',
  'session.personas': 'session',
  'session.history': 'session',
  'session.tools': 'session',
  getContext: null,
  on: null,
  // Предпросмотр над файлом окна — без права: рисует владелец сцены в этом же окне.
  preview: null,
  'preview.show': null,
  'preview.clear': null,
  storage: null,
  'storage.get': null,
  'storage.set': null,
}

/** Чем заменить то, чего нет (дублирует список профиля). */
const MISSING_HINT: Readonly<Record<string, string>> = {
  exec: 'команды — через run(appz|шаблон) или свой service.ts',
  shell: 'команды — через run(appz|шаблон) или свой service.ts',
  fetch: 'сеть — через run или service.ts (fetch в Node); ComfyUI — __host.comfy ($uses: comfy)',
  git: 'git — через service.ts (child_process) или run',
  ai: 'модель — через run шаблона (runz) или service.ts',
  readDir: 'listDir',
  exists: 'listDir родителя или readFile с проверкой ok',
  deleteFile: 'нет удаления — writeFile в {artifact}/data или service.ts',
}

const NAMESPACES = new Set(['service', 'clipboard', 'storage', 'comfy', 'image', 'viewer', 'session', 'skins', 'job', 'app', 'speak', 'llm'])

/** `__host.session.<область>.<метод>` — третий уровень: скоуп $session-read/-write. */
const SESSION_RE = /__host\s*\.\s*session\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g

const CODE_EXT =new Set(['.html', '.htm', '.js', '.jsx', '.mjs'])
const SKIP_DIRS = new Set(['.history', 'data', 'node_modules', '.git'])
const MAX_FILE = 2 * 1024 * 1024

function* sourceFiles(dir: string, base = dir): Generator<string> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.') && name !== '.') {
      if (SKIP_DIRS.has(name)) continue
    }
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith('.')) yield* sourceFiles(p, base)
    } else if (st.size <= MAX_FILE && (CODE_EXT.has(extname(name).toLowerCase()) || name === 'service.ts')) {
      yield p
    }
  }
}

/** `*.skin.css` в папке артефакта (вне .history/data). */
function* skinFiles(dir: string): Generator<string> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) yield* skinFiles(p)
      else if (name.endsWith('.skin.css') && st.size <= MAX_FILE) yield p
    } catch {
      continue
    }
  }
}

/** Строка по смещению. */
const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length

/** Комментарии `//…` и `/* … *\/` → пробелы той же длины (строки не съезжают). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length))
}

const ABS_PATH = /(["'`])(\/(?:Users|home|Volumes|private|var\/folders)\/[^"'`\s]*|[A-Za-z]:\\{1,2}[^"'`\s]*)/g
const IMPORT_RE = /(?:^|[^\w$.])(?:import\s*(?:[\w$*{}\s,]+\s*from\s*)?|export\s*(?:[\w$*{}\s,]+)\s*from\s*|import\s*\(\s*)(["'])([^"']+)\1/g
const HOST_RE = /__host\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g

export function checkArtifact(dir: string, manifest: ArtifactManifest | null): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const used = new Set<Capability>()

  const { error: entryError } = entryOf(dir)
  if (entryError) errors.push(entryError)
  // Страница без единого скрипта при app.js рядом — артефакт «мёртвый», а рантайм-проверка молчит: падать нечему.
  try {
    const html = readFileSync(join(dir, 'index.html'), 'utf8')
    const scripts = /<script\b[^>]*\bsrc\s*=|<script\b[^>]*>\s*\S/i.test(html)
    const js = readdirSync(dir).filter((f) => /\.(m?js|jsx)$/.test(f))
    if (!scripts && js.length) errors.push(`index.html не подключает ни одного скрипта, а рядом ${js.join(', ')} — добавь <script type="module" src="./${js.includes('app.js') ? 'app.js' : js[0]}"></script>`)
  } catch {
    // нет index.html (вход index.jsx) — нечего сверять
  }

  if (!manifest) errors.push('нет разобранного meta.mdz')
  else {
    if (manifest.uses === null) errors.push('нет $uses: артефакт обязан декларировать права (§5), например $uses: $[file]')
    errors.push(...sessionManifestErrors({ uses: manifest.uses, sessionRead: manifest.sessionRead, sessionWrite: manifest.sessionWrite }))
    for (const u of manifest.unknownUses) errors.push(`$uses: неизвестное право "${u}" (есть: ${CAPABILITIES.join(', ')})`)
    const iconError = checkIcon(dir, manifest.icon)
    if (iconError) errors.push(iconError)
  }

  for (const file of sourceFiles(dir)) {
    const rel = relative(dir, file)
    const isService = rel === 'service.ts'
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const code = stripComments(text)

    for (const m of code.matchAll(ABS_PATH)) {
      errors.push(`${rel}:${lineAt(code, m.index!)}: абсолютный путь ${m[2]} — пути относительные, {workspace}/{user-selected} или ~ (через $fs-read/$run-allow)`)
    }
    if (isService) continue

    if (/navigator\s*\.\s*clipboard/.test(code)) {
      const i = code.search(/navigator\s*\.\s*clipboard/)
      errors.push(`${rel}:${lineAt(code, i)}: navigator.clipboard не работает в артефакте — __host.clipboard ($uses: clipboard)`)
    }

    for (const m of code.matchAll(IMPORT_RE)) {
      const spec = m[2]!
      if (spec.startsWith('./') || spec.startsWith('../') || /^https?:\/\//.test(spec)) continue
      if (isHostImport(spec)) continue
      errors.push(`${rel}:${lineAt(code, m.index!)}: голый импорт "${spec}" — доступны только ${[...Object.keys(VENDORED), KIT_IMPORT].join(', ')} и относительные файлы`)
    }

    for (const m of code.matchAll(HOST_RE)) {
      const head = m[1]!
      const full = m[2] ? `${head}.${m[2]}` : head
      // `__host.service.call` — метод пространства; `__host.service.xyz` — выдумка.
      let key: string | null = null
      if (m[2] && full in HOST_API) key = full
      else if (head in HOST_API && !(m[2] && NAMESPACES.has(head))) key = head
      const line = lineAt(code, m.index!)
      if (key === null) {
        const hint = MISSING_HINT[head] ? ` — ${MISSING_HINT[head]}` : ''
        errors.push(`${rel}:${line}: __host.${full} не существует${hint}`)
        continue
      }
      const cap = HOST_API[key]
      if (!cap) continue
      used.add(cap)
      if (manifest?.uses && !manifest.uses.includes(cap)) {
        const extra = cap === 'session' ? ' (и скоупы $session-read/$session-write: meta, personas, history)' : ''
        errors.push(`${rel}:${line}: __host.${full} требует право "${cap}" — добавь в $uses${extra}`)
      }
    }

    // Сессия: метод области существует и покрыт скоупом (запись — $session-write).
    for (const m of code.matchAll(SESSION_RE)) {
      const method = `session.${m[1]}.${m[2]}`
      const line = lineAt(code, m.index!)
      if (!(method in SESSION_METHODS)) {
        const known = Object.keys(SESSION_METHODS).filter((k) => k.startsWith(`session.${m[1]}.`))
        errors.push(`${rel}:${line}: __host.${method} не существует${known.length ? ` — есть ${known.map((k) => k.slice(8)).join(', ')}` : ''}`)
        continue
      }
      const rule = SESSION_METHODS[method]
      if (!rule || !manifest?.uses?.includes('session')) continue
      const { read, write } = sessionScopes(manifest)
      if (!(rule.write ? write : read).includes(rule.scope)) {
        errors.push(`${rel}:${line}: __host.${method} требует $session-${rule.write ? 'write' : 'read'}: ${rule.scope}`)
      }
    }
  }

  if (manifest?.uses) {
    for (const cap of manifest.uses) {
      if (!used.has(cap)) warnings.push(`$uses: право "${cap}" объявлено, но в коде не используется`)
    }
  }
  if (manifest?.uses?.includes('service') && !statSafe(join(dir, 'service.ts'))) {
    errors.push('$uses: service, но нет service.ts')
  }

  // Скины в папке артефакта — тем же валидатором, что бэкенд (контракт skin-spec).
  for (const file of skinFiles(dir)) {
    const rel = relative(dir, file)
    const v = validateSkin(readFileSync(file, 'utf8'), { name: basename(file).slice(0, -'.skin.css'.length) })
    for (const e of v.errors) errors.push(`${rel}: скин: ${formatIssue(e)}`)
    for (const w of v.warnings) warnings.push(`${rel}: скин: ${formatIssue(w)}`)
  }

  return { errors: dedupe(errors), warnings: dedupe(warnings), used: [...used] }
}

const statSafe = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)]
