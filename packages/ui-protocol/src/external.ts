/**
 * Файл вне пространств и действия хоста (v1.41, file-links-spec §3).
 *
 * Агенты называют файлы абсолютными путями (`/Users/…`, `~/…`) — картинка из
 * другой сессии, вывод рецепта. Пространство такой путь не отдаёт, поэтому два
 * отдельных шва:
 *   • `files.external` — прочитать файл/каталог по абсолютному пути (только
 *     просмотр). `~` раскрывает бэкенд: домашний каталог — его, не браузера.
 *   • `host.open` — действия на машине бэкенда: показать в Finder, открыть
 *     приложением из словаря стенда (`$host_apps`, по умолчанию `zed: Zed`) или
 *     программой по умолчанию. Произвольное имя приложения не принимается.
 *
 * Доступ к обоим — владелец стенда; закрытые пути (`~/.ssh`, ключи, `.env*`) —
 * `forbidden`. На проводе — `GET /files/external/{stat,read,list,raw}?path=` и
 * `POST /host/{reveal,open}`.
 *
 * v1.42 (file-panel-spec §1–1a): адрес файла — `{host?, path}` (нет хоста —
 * хост хаба), у всех методов `opts.host`; запись (`write/mkdir/rename/delete/copy`),
 * поиск и слежение — под-флагами `files.{write,search,watch}`, как у `workspace.files`.
 * Хосты, которые бэкенд обслуживает, — `files.hosts`, свой — `files.host`.
 *
 * v1.45 (nr-far.dev/specs/hosts-spec.md): удалённые хосты реестра — `files.hostsInfo`
 * (ОС и связь: `ok / off / no-node / unknown`), место на томе — `files.external.disk`.
 * Хост без связи отвечает кодом {@link HOST_UNAVAILABLE_CODE} (503), адрес вкладки не теряется.
 *
 * v1.54 (link-resolver-spec §6): маски домашних каталогов хоста — `hostsInfo[].home`
 * (`$home` реестра); `files.external.locate(path)` — на каких хостах путь есть (`stat` всех
 * параллельно, `GET /files/external/locate?path=`); действия хоста на машине устройства —
 * `host.{reveal,open}(path, {host, on})`: `host` — где файл, `on` — где открыть (агент машины
 * `on` зовёт `open`); файл другой машины — по монтированию у `on`, иначе скачивается в
 * `~/Downloads/nr/<host>/` машины `on`. Машины, где хаб умеет действия, — `host.on`.
 */

import type { FileWriteOpts } from './backend.js'
import type { Capabilities, FileContent, FileEntry, FileSearchHit, FileSearchQuery } from './types.js'

/**
 * Адрес файла (v1.42, file-panel-spec §1a): хост + абсолютный путь. Без `host` — хост
 * хаба, как до v1.42; поле проходит насквозь — вкладки, ссылки, смотрелки.
 */
export interface FileAddress {
  host?: string
  path: string
}

/** Хост операции `files.external`: нет — хост хаба. Неизвестный хост — `not_found`. */
export interface ExternalOpts {
  host?: string
}

/**
 * Поиск в каталоге (`files.external.search`, v1.42): `glob` — маска имени (Far Alt+F7,
 * без `/` — по имени файла), `query` — текст в файле (правила {@link FileSearchQuery}).
 * Нужен хотя бы один. Найденное только по имени — хит с `line: 0`, `text: ''`.
 */
export interface ExternalSearchQuery {
  glob?: string
  query?: string
  regex?: boolean
  case?: boolean
  limit?: number
}

/** Событие слежения `files.external.watch`: абсолютные пути изменившегося. `['']` — перечитай всё. */
export interface ExternalUpdateEvent {
  type: 'external_update'
  host?: string
  paths: string[]
}

/** Подписчик `files.external.watch`. */
export type ExternalUpdateListener = (event: ExternalUpdateEvent) => void

/** Что заявляет бэкенд про файлы вне пространств (`Capabilities.files`). */
export interface ExternalFilesCapability {
  /** v1.41: `stat/read/list/raw`. */
  external?: boolean
  /** v1.42: `write/mkdir/rename/delete/copy`. */
  write?: boolean
  /** v1.42: `search`. */
  search?: boolean
  /** v1.42: `watch` (у хостов без слежения — нет, обновление по фокусу). */
  watch?: boolean
  /** v1.42: имя хоста хаба (`mini`) — что подписать у адреса без хоста. */
  host?: string
  /** v1.42: хосты, которые бэкенд обслуживает (свой — первым). */
  hosts?: string[]
  /** v1.45: те же хосты с ОС и связью — для списка «хосты» (Alt+F1) и «нет связи». */
  hostsInfo?: ExternalHostInfo[]
  /** v1.45: `disk` — место на томе под путём (Ctrl+L). */
  disk?: boolean
  /** v1.54: `locate` — на каких хостах путь есть. */
  locate?: boolean
  /**
   * v1.72: адреса `raw` подписываются — `GET /files/external/sign` отдаёт ключ
   * (`ExternalSignKey`), клиент дописывает к адресу `exp` и `sig`. Подписанный адрес сервер
   * принимает без куки и прочей авторизации (кадр без `allow-same-origin`, мимо Cloudflare Access).
   */
  sign?: boolean
}

/**
 * Ключ подписи адресов `raw` (v1.72): `sig = base64url(HMAC-SHA256(key, path + "\n" + host + "\n" + thumb))`,
 * пустые поля — пустой строкой, значения — как в query адреса. `exp` — секунды эпохи: до него
 * действуют и ключ, и подписанные им адреса (в адресе `exp` — этот же). Ключ выведен сервером из
 * секрета стенда и `exp` — подделать срок нельзя. Протух — 401 `expired`, не та подпись — 403.
 */
export interface ExternalSignKey {
  key: string
  exp: number
}

/** Связь с хостом (v1.45): есть; ssh не достучался; нет node; ещё не пробовали. */
export type ExternalHostState = 'ok' | 'off' | 'no-node' | 'unknown'

/** Хост `files.external` (v1.45). */
export interface ExternalHostInfo {
  name: string
  /** `darwin` / `linux` / `win32` (из реестра, после связи — от самого хоста). */
  os?: string
  /** Хост хаба — сам бэкенд. */
  hub?: boolean
  state: ExternalHostState
  /** Почему нет связи — строка ssh/node. */
  reason?: string
  /** v1.54: маски домашних каталогов (`$home` реестра): путь под ними — файл этой машины. */
  home?: string[]
}

/** Код ошибки «нет связи с хостом» (v1.45): HTTP 503, сообщение — причина. */
export const HOST_UNAVAILABLE_CODE = 'host_unavailable'

/** `files.external.stat`: есть ли файл и что это. `path` — абсолютный, `~` раскрыт. */
export interface ExternalFileStat {
  /** v1.42: хост ответа; нет — хост хаба. */
  host?: string
  path: string
  exists: boolean
  kind?: 'file' | 'dir'
  size?: number
  /** ISO-время последнего изменения. */
  mtime?: string
  mime?: string
}

/**
 * Файлы по абсолютному пути (capability `files.external`). Закрытые пути — `forbidden`
 * и на чтение, и на запись. `opts.host` (v1.42) — на каком хосте; нет — хост хаба.
 */
export interface ExternalFilesOps {
  /** Нет файла — `{exists: false}`, не ошибка. Закрытый путь — `forbidden`. */
  stat(path: string, opts?: ExternalOpts): Promise<ExternalFileStat>
  /** Как `workspace.files.read` (лимит `maxBytes`, бинарь — base64); `path` ответа — абсолютный. */
  read(path: string, opts?: { maxBytes?: number } & ExternalOpts): Promise<FileContent>
  /** Один уровень каталога; пути записей — абсолютные. */
  list(path: string, opts?: ExternalOpts): Promise<FileEntry[]>
  /**
   * Адрес сырого файла для `<img>`/pdf (`GET /files/external/raw?path=&host=`). Есть
   * только у транспорта, который сам ходит по HTTP. `thumb` (v1.42) — эскиз стороной
   * не больше `thumb` px (картинка, кадр видео), делает хост файла; не умеет — оригинал.
   */
  url?(path: string, opts?: ExternalOpts & { thumb?: number }): string
  /**
   * v1.72 (`files.sign`): дождаться ключа подписи — после него `url()` отдаёт подписанные адреса
   * (работают без куки). Ключа не дали (не owner, сеть) — промис всё равно завершается, `url()` без подписи.
   */
  ready?(): Promise<void>
  /** v1.42, `files.write`: записать текст/base64; родители создаются; `revision` — как у пространства. */
  write?(path: string, content: string, opts?: FileWriteOpts & ExternalOpts): Promise<{ revision: string }>
  /** v1.42, `files.write`: создать каталог (с родителями); уже есть — ничего. */
  mkdir?(path: string, opts?: ExternalOpts): Promise<void>
  /** v1.42, `files.write`: переименовать/перенести в пределах хоста; `to` занят — `conflict`. */
  rename?(from: string, to: string, opts?: ExternalOpts): Promise<void>
  /**
   * v1.42, `files.write`: удалить. По умолчанию — в корзину `~/.nr-trash/` хоста (ответ —
   * путь в корзине), `permanent` — насовсем.
   */
  delete?(path: string, opts?: ExternalOpts & { permanent?: boolean }): Promise<{ trashed?: string }>
  /** v1.42, `files.write`: копировать файл или каталог целиком; `to` занят — `conflict`, `overwrite` — заменить. */
  copy?(from: string, to: string, opts?: ExternalOpts & { overwrite?: boolean }): Promise<void>
  /** v1.42, `files.search`: поиск под каталогом `path` (рекурсивно; `.git`, `node_modules` мимо). */
  search?(path: string, query: ExternalSearchQuery, opts?: ExternalOpts): Promise<FileSearchHit[]>
  /**
   * v1.42, `files.watch`: изменения в каталоге `path` (прямые дети); `recursive` — и глубже
   * (дерево проекта; на `/` и `~` не просить — это весь диск). Возвращает отписку. Транспорт
   * переподключается сам и шлёт `paths: ['']` — «перечитай всё».
   */
  watch?(path: string, listener: ExternalUpdateListener, opts?: ExternalOpts & { recursive?: boolean }): () => void
  /** v1.45, `files.disk`: размер и свободное место тома, где лежит `path`, байт. */
  disk?(path: string, opts?: ExternalOpts): Promise<{ total: number; free: number }>
  /**
   * v1.54, `files.locate`: на каких хостах есть `path` (`stat` всех параллельно, недоступные —
   * мимо). Ответ — только существующие, хаб первым; ни одного — `[]`.
   */
  locate?(path: string): Promise<ExternalFileStat[]>
}

/**
 * Где выполнить действие хоста (v1.54): `host` — хост файла (нет — хаб), `on` — машина, где
 * открыть (нет — хаб); `dryRun` — не запускать, вернуть команду.
 */
export interface HostActionOpts {
  host?: string
  on?: string
  dryRun?: boolean
}

/** Что сделал (или сделал бы при `dryRun`) хост (v1.54). */
export interface HostActionResult {
  /** Машина, где запущено. */
  on?: string
  /** Путь, который открыт на ней: свой, через монтирование или скачанная копия. */
  path?: string
  /** `direct` — файл этой машины; `mount` — смонтирован; `download` — скачан. */
  via?: 'direct' | 'mount' | 'download'
  cmd?: string
  args?: string[]
}

/** Действия хоста (capability `host.open`). */
export interface HostOps {
  /** Показать в Finder (`open -R`). */
  reveal(path: string, opts?: HostActionOpts): Promise<HostActionResult | void>
  /** Открыть программой по умолчанию либо `app` из `HostCapability.apps`. */
  open(path: string, opts?: { app?: string } & HostActionOpts): Promise<HostActionResult | void>
}

/** Что заявляет бэкенд про действия хоста. */
export interface HostCapability {
  open?: boolean
  /** Ключи словаря приложений стенда (`zed`, …) — что можно передать в `open({app})`. */
  apps?: string[]
  /** v1.54: машины (кроме хаба), где хаб открывает через их агента (`on`). */
  on?: string[]
}

/** Гейт `files.external`. */
export function canExternalFiles(caps: Pick<Capabilities, 'files'> | null | undefined): boolean {
  return caps?.files?.external === true
}

/** Гейт записи `files.external` (v1.42). */
export function canExternalWrite(caps: Pick<Capabilities, 'files'> | null | undefined): boolean {
  return caps?.files?.external === true && caps.files.write === true
}

/** Гейт поиска `files.external` (v1.42). */
export function canExternalSearch(caps: Pick<Capabilities, 'files'> | null | undefined): boolean {
  return caps?.files?.external === true && caps.files.search === true
}

/** Гейт слежения `files.external` (v1.42). */
export function canExternalWatch(caps: Pick<Capabilities, 'files'> | null | undefined): boolean {
  return caps?.files?.external === true && caps.files.watch === true
}

/** Хосты `files.external` (v1.42): заявленные, иначе один — хаба (`''`, если имени нет). */
export function externalHosts(caps: Pick<Capabilities, 'files'> | null | undefined): string[] {
  const f = caps?.files
  if (!f?.external) return []
  if (f.hosts && f.hosts.length > 0) return [...f.hosts]
  return [f.host ?? '']
}

/**
 * Хосты с ОС и связью (v1.45): заявленные `hostsInfo`; бэкенд до v1.45 — из `hosts`,
 * связь `unknown`, хаб — `ok`.
 */
export function externalHostsInfo(caps: Pick<Capabilities, 'files'> | null | undefined): ExternalHostInfo[] {
  const f = caps?.files
  if (!f?.external) return []
  if (f.hostsInfo && f.hostsInfo.length > 0) return f.hostsInfo.map((h) => ({ ...h }))
  return externalHosts(caps).map((name) => (name === (f.host ?? '') ? { name, hub: true, state: 'ok' as const } : { name, state: 'unknown' as const }))
}

/** Гейт `files.external.disk` (v1.45). */
export function canExternalDisk(caps: Pick<Capabilities, 'files'> | null | undefined): boolean {
  return caps?.files?.external === true && caps.files.disk === true
}

/** Адрес — на хосте хаба (нет хоста или хост равен своему имени бэкенда). */
export function isHubHost(caps: Pick<Capabilities, 'files'> | null | undefined, host: string | undefined): boolean {
  return host === undefined || host === '' || host === caps?.files?.host
}

/** Событие → SSE-кадр (как у событий рана). */
export function serializeExternalEvent(event: ExternalUpdateEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** SSE-кадр → событие; чужой или битый — `null`. */
export function parseExternalEvent(frame: string): ExternalUpdateEvent | null {
  let data = ''
  for (const line of frame.split('\n')) if (line.startsWith('data:')) data += line.slice(5).trimStart()
  if (data === '') return null
  try {
    const v = JSON.parse(data) as Partial<ExternalUpdateEvent>
    if (v?.type !== 'external_update' || !Array.isArray(v.paths) || !v.paths.every((p) => typeof p === 'string')) return null
    return { type: 'external_update', ...(typeof v.host === 'string' ? { host: v.host } : {}), paths: [...v.paths] }
  } catch {
    return null
  }
}

/** Гейт `files.external.locate` (v1.54). */
export function canExternalLocate(caps: Pick<Capabilities, 'files'> | null | undefined): boolean {
  return caps?.files?.external === true && caps.files.locate === true
}

/** Гейт действий хоста на машине `on` (v1.54): хаб (`on` пусто или своё имя) — `canHostOpen`, иначе `host.on`. */
export function canHostOpenOn(caps: Pick<Capabilities, 'host' | 'files'> | null | undefined, on: string | undefined, app?: string): boolean {
  if (!canHostOpen(caps, app)) return false
  if (on === undefined || on === '' || on === caps?.files?.host) return true
  return (caps?.host?.on ?? []).includes(on)
}

/**
 * Машина пути по маскам домашних каталогов (v1.54, link-resolver-spec §6 п.3): хост, под чьим
 * `home` лежит `path` (длиннейшая маска; равные у нескольких — `null`, решает `locate`).
 * Сравнение без учёта регистра у Windows-путей (`C:\`).
 */
export function hostByHome(hosts: readonly ExternalHostInfo[], path: string): string | null {
  const norm = (p: string): string => (/^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, '/').toLowerCase() : p)
  const p = norm(path)
  let best: { name: string; len: number } | null = null
  let tie = false
  for (const h of hosts) {
    for (const raw of h.home ?? []) {
      const m = norm(raw).replace(/\/+$/, '')
      if (m === '' || !(p === m || p.startsWith(`${m}/`))) continue
      if (!best || m.length > best.len) {
        best = { name: h.name, len: m.length }
        tie = false
      } else if (m.length === best.len && best.name !== h.name) tie = true
    }
  }
  return best && !tie ? best.name : null
}

/** Гейт `host.open`; `app` — есть ли такое приложение в словаре стенда. */
export function canHostOpen(caps: Pick<Capabilities, 'host'> | null | undefined, app?: string): boolean {
  const h = caps?.host
  if (!h?.open) return false
  return app === undefined || (h.apps ?? []).includes(app)
}
