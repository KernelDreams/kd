/**
 * Слой плагинов пользователя (plugin-registry-spec §5): папка `<данные>/plugins` (у Pix `~/.nr-pics/plugins`, у стенда —
 * `$plugins_user`). В ней:
 *
 *   plugins.mdz          `$plugins` — установленные плагины (id = папка), `$choose` — выбор источника одинакового id
 *   plugins.lock.json    замок: ссылка, тег, закреплённый коммит, реестр-источник, история (откат — прошлая запись)
 *   registries.json      подключённые реестры (порядок каскада) и их состояние: когда обновлён, коммит, ошибка
 *   .registries/<id>/    клоны реестров — только чтение
 *   <id>/                клон плагина по ссылке на git
 *   *.mdz, <папка>/      свои плагины и правки-копии плагинов реестра (их обновление реестра не трогает)
 *
 * `plugins.mdz` правится построчно: чужие строки и комментарии остаются.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { headerList, mdzHeader } from './mdz.js'
import type { PluginWeight } from './manifest.js'

export const LAYER_FILE = 'plugins.mdz'
export const LOCK_FILE = 'plugins.lock.json'
export const REGISTRIES_FILE = 'registries.json'
export const REGISTRIES_DIR = '.registries'

/** Запись замка: что стоит сейчас. */
export interface LockPoint {
  /** Тег; пусто — репа без тегов, закреплён коммит HEAD на момент установки. */
  tag: string
  commit: string
  /** ISO-время установки этой точки. */
  at: string
}

export interface LockEntry extends LockPoint {
  /** Ссылка на git (как дал человек, без `#тег`). */
  url: string
  weight: PluginWeight
  /** Реестр, из записи которого поставлен (`entries/<id>.mdz`); голая ссылка — нет. */
  registry?: string
  /** Прошлые точки, последняя — ближайшая: откат берёт её. */
  history: LockPoint[]
}

export interface LockFile {
  version: 1
  plugins: Record<string, LockEntry>
}

const atomicWrite = (file: string, text: string): void => {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

export function ensureLayer(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, LAYER_FILE)
  if (!existsSync(file)) {
    writeFileSync(
      file,
      [
        '$// Плагины пользователя (plugin-registry-spec §5). Пишут `runz plugins` и список плагинов (collection);',
        '$// правка руками не теряется. $plugins — установленные (папки здесь), $choose — выбор источника одинакового id.',
        '$plugins: $[]',
        '',
      ].join('\n'),
    )
  }
}

/** Похоже ли на слой плагинов: есть `plugins.mdz`, замок или реестры. */
export function isLayer(dir: string): boolean {
  return existsSync(join(dir, LAYER_FILE)) || existsSync(join(dir, LOCK_FILE)) || existsSync(join(dir, REGISTRIES_FILE))
}

export interface LayerFile {
  plugins: string[]
  /** id → источник (`registry:<id>`). */
  choose: Record<string, string>
}

export function readLayer(dir: string): LayerFile {
  let text = ''
  try {
    text = readFileSync(join(dir, LAYER_FILE), 'utf8')
  } catch {
    return { plugins: [], choose: {} }
  }
  const h = mdzHeader(text)
  const choose: Record<string, string> = {}
  for (const pair of headerList(h.choose)) {
    const at = pair.indexOf('=')
    if (at > 0) choose[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return { plugins: headerList(h.plugins), choose }
}

/** Поставить строку `$<key>: …` (нет — дописать в конец шапки). */
function setLine(text: string, key: string, value: string): string {
  const lines = text.split('\n')
  const re = new RegExp('^\\$' + key + '\\s*:')
  const at = lines.findIndex((l) => re.test(l))
  const line = '$' + key + ': ' + value
  if (at >= 0) lines[at] = line
  else {
    const head = lines.findIndex((l) => l.startsWith('## '))
    let end = head >= 0 ? head : lines.length
    while (end > 0 && lines[end - 1]!.trim() === '') end--
    lines.splice(end, 0, line)
  }
  return lines.join('\n')
}

export function writeLayer(dir: string, next: Partial<LayerFile>): void {
  ensureLayer(dir)
  const file = join(dir, LAYER_FILE)
  let text = readFileSync(file, 'utf8')
  if (next.plugins) text = setLine(text, 'plugins', '$[' + [...new Set(next.plugins)].join(', ') + ']')
  if (next.choose) text = setLine(text, 'choose', '$[' + Object.entries(next.choose).map(([k, v]) => k + '=' + v).join(', ') + ']')
  atomicWrite(file, text.endsWith('\n') ? text : text + '\n')
}

export function readLock(dir: string): LockFile {
  try {
    const raw = JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')) as Partial<LockFile>
    if (raw && typeof raw.plugins === 'object' && raw.plugins) return { version: 1, plugins: raw.plugins as Record<string, LockEntry> }
  } catch {
    // нет замка — пусто
  }
  return { version: 1, plugins: {} }
}

export function writeLock(dir: string, lock: LockFile): void {
  ensureLayer(dir)
  atomicWrite(join(dir, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n')
}

/** Реестр в списке подключённых: id (папка клона), ссылка на git, необязательный снимок (комплект продукта). */
export interface RegistryRef {
  id: string
  url?: string
  /** Папка-снимок реестра (комплект Pix): реестр работает без сети, пока клона нет. */
  snapshot?: string
  /** Заголовок для списка (из настройки); нет — `registry.mdz`. */
  title?: string
}

export interface RegistryState {
  fetchedAt?: string
  commit?: string
  /** Последняя ошибка обновления (сети нет и т.п.) — словами. */
  error?: string
  /** Сейчас стоит снимок комплекта, не клон. */
  snapshot?: boolean
}

export interface RegistriesFile {
  registries: RegistryRef[]
  state: Record<string, RegistryState>
}

export function readRegistries(dir: string): RegistriesFile {
  try {
    const raw = JSON.parse(readFileSync(join(dir, REGISTRIES_FILE), 'utf8')) as Partial<RegistriesFile>
    return { registries: Array.isArray(raw.registries) ? raw.registries : [], state: raw.state && typeof raw.state === 'object' ? raw.state : {} }
  } catch {
    return { registries: [], state: {} }
  }
}

export function writeRegistries(dir: string, file: RegistriesFile): void {
  ensureLayer(dir)
  atomicWrite(join(dir, REGISTRIES_FILE), JSON.stringify(file, null, 2) + '\n')
}

export const registryDir = (dir: string, id: string): string => join(dir, REGISTRIES_DIR, id)
