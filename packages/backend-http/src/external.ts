/**
 * Файл вне пространств и действия хоста (протокол v1.41, file-links-spec §3).
 *
 * Агент называет файл абсолютным путём — фронт открывает его здесь, показывает в
 * Finder или отдаёт Zed. Один слой на все бэкенды стенда (nr, хаб, ACP): опция
 * `external` у `serveBackend`, как скины и настройки.
 *
 * Безопасность:
 *   • доступ — только владелец стенда (гейт пользователей проверяет `serveBackend`);
 *   • закрытые пути ({@link DEFAULT_EXTERNAL_DENY} + `$external_deny` стенда) —
 *     `forbidden`, проверка по реальному пути (симлинк в `~/.ssh` не проходит);
 *     в списке каталога закрытое не показывается;
 *   • приложения — только из словаря стенда (`$host_apps`), команды —
 *     `execFile('open', [...])` массивом, без шелла.
 *
 * v1.42 (file-panel-spec §1): запись (`write/mkdir/rename/delete/copy`), поиск,
 * слежение и эскизы — для панели файлов. Закрытый список — и на запись. Удаление — в
 * корзину `~/.nr-trash/<абсолютный путь>` хоста. Хост в адресе: этот слой обслуживает
 * только свой (`hostName`); чужой — `not_found`. Удалённые хосты (v1.45) — роутер
 * `createHostsRouter` из `remote-host.ts` поверх этого слоя; `disk` — место на томе (Ctrl+L).
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { availableParallelism, homedir, platform } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { sharedWatchPool, type WatchHandle, type WatchPool } from './watch.js'
import type {
  ExternalFileStat,
  ExternalFilesCapability,
  ExternalFilesOps,
  ExternalOpts,
  ExternalSearchQuery,
  ExternalUpdateListener,
  FileContent,
  FileEntry,
  FileSearchHit,
  FileWriteOpts,
  HostCapability,
} from '@kerneldreams/ui-protocol'
import { checkFileReadSize, compileFileSearch, fileContent, fileGlobRegExp, fileMime } from '@kerneldreams/ui-protocol'

/** Закрыто всегда: ключи, облачные креды, связки ключей (file-links-spec §3). */
export const DEFAULT_EXTERNAL_DENY: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/Library/Keychains',
  '**/.env*',
  '**/*.pem',
  '**/*key*.json',
]

/** Словарь приложений по умолчанию: ключ → имя для `open -a`. */
export const DEFAULT_HOST_APPS: Readonly<Record<string, string>> = { zed: 'Zed' }

/** Команда хоста — что запущено (или запустилось бы при `dryRun`). */
export interface HostCommand {
  cmd: string
  args: string[]
  /** v1.54: где (машина `on`), какой путь открыт и как он туда попал. */
  on?: string
  path?: string
  via?: 'direct' | 'mount' | 'download'
}

export interface ExternalHostOptions {
  /** ОС хоста; default `os.platform()`. `win32` — адреса провода `/C:/…`, `/` — диски. */
  os?: string
  /** Дополнительные закрытые пути (`$external_deny` стенда): `~/x`, `/abs`, `**\/*.glob`. */
  deny?: string[]
  /** Словарь приложений (`$host_apps`); default {@link DEFAULT_HOST_APPS}. */
  apps?: Record<string, string>
  /** Домашний каталог для `~`; default `os.homedir()`. */
  home?: string
  /** Действия хоста; default — только на macOS. */
  hostOpen?: boolean
  /** Исполнитель команд (тесты); default — `execFile` без шелла. */
  exec?: (cmd: string, args: string[]) => Promise<void>
  /** v1.42: имя этого хоста (`mini`, из `envs/contours.mdz`) — `files.host`; адрес с ним — свой. */
  hostName?: string
  /** v1.42: запись (`write/mkdir/rename/delete/copy`). Default true. */
  write?: boolean
  /** v1.42: слежение `fs.watch` (рекурсивно). Default true; `false` — выключатель стенда. */
  watch?: boolean
  /** пул слежения (поток вне главного, таймаут, лимит); default — общий на процесс. */
  watchPool?: WatchPool
  /** v1.42: каталог кэша эскизов; default `~/.cache/nr-thumbs`. */
  thumbsDir?: string
  /** v1.42: генератор эскиза (тесты); default — {@link hostThumbnail}: sharp, ffmpeg, на macOS — `sips`/`qlmanage`. */
  thumbnail?: (src: string, out: string, px: number, kind: 'image' | 'video') => Promise<boolean>
  /** Сколько эскизов делается одновременно; default {@link DEFAULT_THUMB_CONCURRENCY}. Папка на тысячу PNG через h2 иначе
   *  поднимает сотни `sips` разом рядом с prod (FAR, ревью 22.10). */
  thumbConcurrency?: number
  /**
   * Удаление без `permanent` — в системную Корзину ОС: macOS, Windows; default — на них. `false` — всегда
   * `~/.nr-trash` (удалённые машины, тесты). Корзина не приняла — `~/.nr-trash` и строка в лог.
   */
  systemTrash?: boolean
  /** Исполнитель команд Корзины (тесты). */
  trashRun?: TrashRun
}

/** Слой для `serveBackend({external})`: чтение + действия хоста + что заявить. */
export interface ExternalHost extends ExternalFilesOps {
  capability(): { files: ExternalFilesCapability & { external: true }; host?: HostCapability }
  /** v1.42: эскиз файла (путь готового PNG в кэше) или `null` — не умеем, отдавать оригинал. */
  thumb(path: string, px: number, opts?: ExternalOpts): Promise<string | null>
  /** v1.45: файл чужого хоста потоком кусков (`raw`); свой — `null` или нет метода (`readExternalRaw`). */
  openRaw?(path: string, opts?: ExternalOpts & { range?: readonly [number, number] }): Promise<{ size: number; mime?: string; chunks: AsyncIterable<Uint8Array> } | null>
  /** `null` — действия хоста не заявлены (не macOS). */
  host: {
    /** v1.54: `host` — хост файла, `on` — машина, где открыть (роутер хостов); свой слой их не знает. */
    reveal(path: string, opts?: { dryRun?: boolean; host?: string; on?: string }): Promise<HostCommand>
    open(path: string, opts?: { app?: string; dryRun?: boolean; host?: string; on?: string }): Promise<HostCommand>
  } | null
  /** v1.54: на каких хостах есть путь (роутер хостов). */
  locate?(path: string): Promise<ExternalFileStat[]>
}

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

import { systemTrash, type TrashRun } from './system-trash.js'

const GLOB_CHARS = /[*?{[]/

/** Каталоги, куда поиск не спускается. */
const SEARCH_SKIP = new Set(['.git', 'node_modules', '.nr-trash', '.cache', 'dist'])
/** Больше — файл в поиске по тексту пропускается. */
const SEARCH_MAX_FILE_BYTES = 2_000_000
/** Дольше — отдать найденное. */
const SEARCH_TIMEOUT_MS = 15_000
/** Окно склейки событий слежения, мс. */
const WATCH_DEBOUNCE_MS = 200
/** Больше путей в окне — `['']` («перечитай всё»). */
const WATCH_MAX_PATHS = 500
/** Сторона эскиза: от и до, px. */
const THUMB_MIN = 32
const THUMB_MAX = 1024
/** Эскизов одновременно по умолчанию: sharp держит поток libvips на эскиз — половина ядер, 3…8. */
export const DEFAULT_THUMB_CONCURRENCY = Math.max(3, Math.min(8, Math.floor(availableParallelism() / 2)))
// PSD / PSB: сведённая картинка — ffmpeg (декодер psd; PSB «версии 2» он не читает), на macOS — sips / QuickLook.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.avif', '.psd', '.psb'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'])

/** Вид файла для эскиза по расширению: картинка, видео, ничего. */
/**
 * MIME медиа, которых нет в таблице протокола: без него `raw` уходит `application/octet-stream`, и WebKit
 * (Safari, NR Pics.app) видео и звук не играет — Chromium угадывает сам, поэтому в нём работало.
 */
const MEDIA_MIME: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
}

/** MIME файла для провода: медиа — своей таблицей, остальное — {@link fileMime} протокола. */
export function rawMime(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const media = dot > 0 ? MEDIA_MIME[base.slice(dot + 1).toLowerCase()] : undefined
  return media ?? fileMime(path)
}

export function thumbKind(path: string): 'image' | 'video' | null {
  const ext = extname(path).toLowerCase()
  return IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null
}

const run = (cmd: string, args: string[], timeout = 30_000): Promise<void> =>
  new Promise<void>((ok, bad) => execFile(cmd, args, { timeout }, (err) => (err ? bad(err) : ok())))

/** Формат эскиза по первым байтам файла (кэш хранит WebP, запасной путь macOS — PNG). */
export function thumbMime(head: Uint8Array): string {
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  return 'image/png'
}

/** Тип `sharp` без зависимости на его d.ts: только то, что зовём. */
type SharpFn = (src: string, opts?: Record<string, unknown>) => {
  rotate(): ReturnType<SharpFn>
  resize(w: number, h: number, o: Record<string, unknown>): ReturnType<SharpFn>
  webp(o: Record<string, unknown>): ReturnType<SharpFn>
  toFile(out: string): Promise<unknown>
}

let sharpLoad: Promise<SharpFn | null> | null = null
/** sharp (libvips) — необязательная зависимость: нет сборки под платформу — эскиз делает ffmpeg. */
function loadSharp(): Promise<SharpFn | null> {
  sharpLoad ??= import('sharp' as string).then(
    (m: { default?: SharpFn }) => m.default ?? (m as unknown as SharpFn),
    () => null,
  )
  return sharpLoad
}

let ffmpegHere: Promise<boolean> | null = null
const hasFfmpeg = (): Promise<boolean> => (ffmpegHere ??= run('ffmpeg', ['-version'], 5_000).then(() => true, () => false))

/** Кадр видео (или картинка, которую sharp не читает) — ffmpeg: представительный кадр из первых, вписан в `px`, WebP. */
async function ffmpegThumb(src: string, out: string, px: number, kind: 'image' | 'video'): Promise<boolean> {
  if (!(await hasFfmpeg())) return false
  const tmp = `${out}.${process.pid}.webp`
  const fit = `scale=${px}:${px}:force_original_aspect_ratio=decrease`
  const vf = kind === 'video' ? `thumbnail=30,${fit}` : fit
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', vf, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '78', tmp], 60_000)
    if (!existsSync(tmp)) return false
    await rename(tmp, out)
    return true
  } finally {
    await rm(tmp, { force: true })
  }
}

/** macOS без sharp и ffmpeg: картинка — `sips -Z` (PNG), видео — кадр QuickLook (`qlmanage -t`). */
async function macThumb(src: string, out: string, px: number, kind: 'image' | 'video'): Promise<boolean> {
  if (platform() !== 'darwin') return false
  if (kind === 'image') {
    // sips не взял (PSB) — дальше QuickLook, как кадр видео
    if (await run('sips', ['-s', 'format', 'png', '-Z', String(px), src, '--out', out]).then(() => existsSync(out), () => false)) return true
  }
  const dir = `${out}.ql`
  await mkdir(dir, { recursive: true })
  try {
    await run('qlmanage', ['-t', '-s', String(px), '-o', dir, src])
    const made = join(dir, `${basename(src)}.png`)
    if (!existsSync(made)) return false
    await rename(made, out)
    return true
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Эскиз на любом хосте (pics-spec §3): картинка — sharp (libvips: поворот по EXIF, первый кадр GIF,
 * вписать в `px`, WebP), видео и то, что sharp не прочёл, — ffmpeg (кадр, WebP); на macOS без них —
 * `sips` / `qlmanage`. Не вышло ничем — `false`: вызывающий отвечает «не читается», не оригиналом.
 */
export async function hostThumbnail(src: string, out: string, px: number, kind: 'image' | 'video'): Promise<boolean> {
  if (kind === 'image') {
    const sharp = await loadSharp()
    if (sharp) {
      const tmp = `${out}.${process.pid}.webp`
      try {
        await sharp(src, { failOn: 'error', limitInputPixels: 268_402_689 })
          .rotate()
          .resize(px, px, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 78, effort: 2 })
          .toFile(tmp)
        await rename(tmp, out)
        return true
      } catch {
        // формат не его (HEIC без кодека, битый) — дальше ffmpeg
      } finally {
        await rm(tmp, { force: true })
      }
    }
  }
  if (await ffmpegThumb(src, out, px, kind).catch(() => false)) return true
  return macThumb(src, out, px, kind).catch(() => false)
}

/**
 * Адрес провода Windows-хоста → путь ОС: `/E:/a/b` → `E:/a/b`, `/E:` → `E:/`. Тот же провод, что у
 * удалённых Windows-машин (`remote-host.ts`): панель режет путь по `/`, `..` с `/C:/` ведёт в `/` («Этот компьютер»).
 * Не провод (`C:\x`, `~/x`) — как есть.
 */
export function winFromWire(raw: string): string {
  const m = /^\/([A-Za-z]):(\/.*)?$/.exec(raw)
  return m ? `${m[1]!.toUpperCase()}:${m[2] ?? '/'}` : raw
}

/** Путь Windows → адрес провода: `E:\a\b` → `/E:/a/b`, `E:\` → `/E:/`. Не путь с буквой — как есть. */
export function winToWire(p: string): string {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p)
  return m ? `/${m[1]!.toUpperCase()}:/${m[2]!.replace(/\\/g, '/')}` : p
}

/** Буквы дисков из `fsutil fsinfo drives` (`Диски: C:\ D:\ …` на любом языке). */
export function parseWinDrives(out: string): string[] {
  return [...new Set([...out.matchAll(/\b([A-Za-z]):\\/g)].map((m) => m[1]!.toUpperCase()))].sort()
}

/** Не больше `n` задач одновременно, остальные ждут в порядке прихода. */
function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((go) => waiting.push(go))
    else active++
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

export function createExternalHost(opts: ExternalHostOptions = {}): ExternalHost {
  const home = opts.home ?? homedir()
  const apps = opts.apps ?? DEFAULT_HOST_APPS
  const hostOpen = opts.hostOpen ?? platform() === 'darwin'
  const exec =
    opts.exec ??
    ((cmd: string, args: string[]) =>
      new Promise<void>((ok, bad) => execFile(cmd, args, { timeout: 10_000 }, (err) => (err ? bad(err) : ok()))))

  const expand = (p: string, h = home): string => (p === '~' ? h : p.startsWith('~/') ? join(h, p.slice(2)) : p)
  const hostName = opts.hostName
  /** Windows: наружу — адреса провода `/C:/…`, правила и сравнения — по прямым слэшам. */
  const win = (opts.os ?? platform()) === 'win32'
  const wire = (p: string): string => (win ? winToWire(p) : p)
  const slash = (p: string): string => (win ? p.replace(/\\/g, '/') : p)
  /** «Этот компьютер» Windows: `/` — диски машины (буквы без проверки — отключённый сетевой диск вешает realpath). */
  async function winDrives(): Promise<FileEntry[]> {
    const out = await new Promise<string>((ok) => execFile('fsutil', ['fsinfo', 'drives'], { timeout: 10_000, windowsHide: true }, (err, stdout) => ok(err ? '' : String(stdout))))
    const letters = parseWinDrives(out)
    if (!letters.length) letters.push((/^([A-Za-z]):/.exec(home)?.[1] ?? 'C').toUpperCase())
    return letters.map((l) => ({ ...tag(), name: `${l}:`, path: `/${l}:/`, kind: 'dir' as const }))
  }
  const isRootWire = (raw: string): boolean => win && (raw ?? '').trim() === '/'
  const canWrite = opts.write !== false
  const canWatch = opts.watch !== false
  const watchPool = (): WatchPool => opts.watchPool ?? sharedWatchPool()
  const thumbsDir = opts.thumbsDir ?? join(home, '.cache', 'nr-thumbs')
  const thumbnail = opts.thumbnail ?? hostThumbnail
  const thumbSlots = limiter(Math.max(1, opts.thumbConcurrency ?? DEFAULT_THUMB_CONCURRENCY))
  /** Один и тот же эскиз, запрошенный дважды, делается один раз. */
  const thumbsMaking = new Map<string, Promise<boolean>>()
  const trashRoot = join(home, '.nr-trash')
  const hostOs = opts.os ?? platform()
  const osTrash = opts.systemTrash ?? (hostOs === 'darwin' || hostOs === 'win32')

  /** Адрес на этом хосте; чужой — `not_found` (удалённые хосты — этап 2 file-panel-spec). */
  function local(o?: ExternalOpts): void {
    const h = o?.host
    if (h === undefined || h === '' || h === hostName) return
    throw fail('not_found', `хост «${h}» этим бэкендом не обслуживается`)
  }
  /** Хост в ответе: только если он назван. */
  const tag = (): { host?: string } => (hostName ? { host: hostName } : {})

  // Правила — и для `home`, и для его реального пути: реальный путь симлинка
  // (`/var` → `/private/var`) иначе ушёл бы мимо префикса `~/.ssh`.
  let realHome = home
  try {
    realHome = realpathSync(home)
  } catch {
    // нет каталога — как есть
  }
  const patterns = [...DEFAULT_EXTERNAL_DENY, ...(opts.deny ?? [])].map((r) => r.trim()).filter((r) => r !== '')
  const homes = realHome === home ? [home] : [home, realHome]
  const rules = homes.flatMap((h) =>
    patterns.map((raw) => {
      const p = slash(expand(raw, h))
      if (!GLOB_CHARS.test(p)) {
        const prefix = p.replace(/\/+$/, '')
        return (abs: string) => abs === prefix || abs.startsWith(`${prefix}/`)
      }
      const re = fileGlobRegExp(p.replace(/^\/+/, ''))
      return (abs: string) => re.test(abs.replace(/^\/+/, ''))
    }),
  )
  const denied = (abs: string): boolean => {
    const a = slash(abs)
    return rules.some((r) => r(a))
  }

  /** Путь запроса → абсолютный, `~` раскрыт; относительный — `bad_request`. */
  function absOf(raw: string): string {
    const p = expand(win ? winFromWire((raw ?? '').trim()) : (raw ?? '').trim())
    if (p === '' || !isAbsolute(p)) throw fail('bad_request', `нужен абсолютный путь или ~/…: «${raw}»`)
    return resolve(p)
  }

  /** Абсолютный путь, проверенный по закрытому списку — и сам, и после симлинков. */
  async function allowed(raw: string): Promise<{ abs: string; real: string | null }> {
    const abs = absOf(raw)
    if (denied(abs)) throw fail('forbidden', `путь закрыт: ${abs}`)
    const real = await realpath(abs).catch(() => null)
    if (real && denied(real)) throw fail('forbidden', `путь закрыт: ${abs}`)
    return { abs, real }
  }

  async function existing(raw: string): Promise<{ abs: string; real: string }> {
    const { abs, real } = await allowed(raw)
    if (!real) throw fail('not_found', `файла нет: ${abs}`)
    return { abs, real }
  }


  /**
   * Путь под запись — абсолютный, сам путь (не цель симлинка: переименование и корзина
   * трогают ссылку). Закрытое — и по самому пути, и по цели, и по реальному родителю.
   * Корень и домашний каталог — не трогаем.
   */
  async function writable(raw: string): Promise<string> {
    const { abs } = await allowed(raw)
    if (abs === '/' || abs === home || abs === realHome || (win && /^[A-Za-z]:[\\/]?$/.test(abs))) throw fail('forbidden', `путь закрыт: ${wire(abs)}`)
    const parent = await realpath(dirname(abs)).catch(() => null)
    if (parent && denied(join(parent, basename(abs)))) throw fail('forbidden', `путь закрыт: ${abs}`)
    return abs
  }

  /** Реальный путь ещё не существующего: реальный ближайший существующий предок + хвост. */
  async function realOfNew(abs: string): Promise<string> {
    const tail: string[] = []
    for (let p = abs; ; p = dirname(p)) {
      const r = await realpath(p).catch(() => null)
      if (r) return tail.length ? join(r, ...tail.reverse()) : r
      if (p === dirname(p)) return abs
      tail.push(basename(p))
    }
  }

  const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false)

  /** Перенос между томами (`EXDEV`): копия + удаление. */
  async function move(from: string, to: string): Promise<void> {
    try {
      await rename(from, to)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
      await rm(from, { recursive: true, force: true })
    }
  }

  /** Место в корзине: `~/.nr-trash/<абсолютный путь>`; занято — с суффиксом времени. */
  async function trashTarget(abs: string): Promise<string> {
    // Windows: `C:\x` → `C\x` (двоеточие в имени каталога корзины нельзя).
    const rel = (win ? abs.replace(/^([A-Za-z]):/, '$1') : abs).replace(/^[\\/]+/, '')
    let dest = join(trashRoot, rel)
    if (await exists(dest)) dest = join(trashRoot, `${rel}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
    return dest
  }

  function writeOps(): Pick<Required<ExternalFilesOps>, 'write' | 'mkdir' | 'rename' | 'delete' | 'copy'> {
    return {
      async write(raw: string, content: string, o?: FileWriteOpts & ExternalOpts): Promise<{ revision: string }> {
        local(o)
        const abs = await writable(raw)
        const target = (await realpath(abs).catch(() => null)) ?? abs
        if (o?.revision !== undefined) {
          const st = await stat(target).catch(() => null)
          if (o.revision === null && st) throw fail('conflict', `файл уже есть: ${raw}`)
          if (o.revision !== null && (!st || `${st.mtimeMs}:${st.size}` !== o.revision)) throw fail('conflict', `файл изменился: ${raw}`)
        }
        await mkdir(dirname(target), { recursive: true })
        const data = o?.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
        const tmp = join(dirname(target), `.nr-tmp-${basename(target)}-${process.pid}-${Date.now()}`)
        await writeFile(tmp, data)
        await rename(tmp, target)
        const st = await stat(target)
        return { revision: `${st.mtimeMs}:${st.size}` }
      },
      async mkdir(raw: string, o?: ExternalOpts): Promise<void> {
        local(o)
        await mkdir(await writable(raw), { recursive: true })
      },
      async rename(fromRaw: string, toRaw: string, o?: ExternalOpts): Promise<void> {
        local(o)
        const from = await writable(fromRaw)
        if (!(await exists(from))) throw fail('not_found', `файла нет: ${fromRaw}`)
        const to = await writable(toRaw)
        if (to === from) return
        if (await exists(to)) throw fail('conflict', `уже есть: ${toRaw}`)
        const fromReal = await realOfNew(from)
        const toReal = await realOfNew(to)
        if (slash(toReal).startsWith(`${slash(fromReal)}/`)) throw fail('bad_request', `нельзя перенести каталог в самого себя: ${toRaw}`)
        await mkdir(dirname(to), { recursive: true })
        await move(from, to)
      },
      async delete(raw: string, o?: ExternalOpts & { permanent?: boolean }): Promise<{ trashed?: string }> {
        local(o)
        const target = await writable(raw)
        if (!(await exists(target))) throw fail('not_found', `файла нет: ${raw}`)
        if (o?.permanent || target === trashRoot || target.startsWith(`${trashRoot}/`)) {
          await rm(target, { recursive: true, force: true })
          return {}
        }
        if (osTrash) {
          try {
            const r = await systemTrash(target, { os: hostOs, home, ...(opts.trashRun ? { run: opts.trashRun } : {}) })
            if (r) return r.trashed ? { trashed: wire(r.trashed) } : {}
          } catch (err) {
            console.warn(`[files] системная Корзина не приняла ${raw}: ${(err as Error).message} — кладу в ~/.nr-trash`)
          }
        }
        const dest = await trashTarget(absOf(raw))
        await mkdir(dirname(dest), { recursive: true })
        await move(target, dest)
        return { trashed: wire(dest) }
      },
      async copy(fromRaw: string, toRaw: string, o?: ExternalOpts & { overwrite?: boolean }): Promise<void> {
        local(o)
        const { real: from } = await existing(fromRaw)
        const to = await writable(toRaw)
        const toReal = await realOfNew(to)
        if (toReal === from || slash(toReal).startsWith(`${slash(from)}/`)) throw fail('bad_request', `нельзя копировать в самого себя: ${toRaw}`)
        if ((await exists(to)) && !o?.overwrite) throw fail('conflict', `уже есть: ${toRaw}`)
        await mkdir(dirname(to), { recursive: true })
        await cp(from, to, { recursive: true, force: o?.overwrite === true, errorOnExist: o?.overwrite !== true, preserveTimestamps: true })
      },
    }
  }

  /** Поиск под каталогом: обход на node, маска имени и/или текст. */
  async function searchUnder(abs: string, real: string, q: ExternalSearchQuery): Promise<FileSearchHit[]> {
    const glob = typeof q?.glob === 'string' && q.glob.trim() !== '' ? q.glob.trim() : undefined
    const text = typeof q?.query === 'string' && q.query !== '' ? q.query : undefined
    if (!glob && !text) throw fail('bad_request', 'search: нужен glob или query')
    const m = text ? compileFileSearch({ query: text, ...(q.regex ? { regex: true } : {}), ...(q.case ? { case: true } : {}), ...(q.limit ? { limit: q.limit } : {}) }) : null
    const limit = m?.limit ?? Math.min(Math.max(1, q.limit ?? 500), 5000)
    const nameRe = glob ? fileGlobRegExp(glob.includes('/') ? glob : `**/${glob}`) : null
    const hits: FileSearchHit[] = []
    const deadline = Date.now() + SEARCH_TIMEOUT_MS
    async function walk(dirAbs: string, dirReal: string): Promise<void> {
      if (hits.length >= limit || Date.now() > deadline) return
      let dirents
      try {
        dirents = await readdir(dirReal, { withFileTypes: true })
      } catch {
        return
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name))
      for (const d of dirents) {
        if (hits.length >= limit || Date.now() > deadline) return
        const pa = join(dirAbs, d.name)
        const pr = join(dirReal, d.name)
        if (denied(pa) || d.name.startsWith('.nr-tmp-')) continue
        if (d.isDirectory()) {
          if (!SEARCH_SKIP.has(d.name)) await walk(pa, pr)
          continue
        }
        if (!d.isFile()) continue
        const rel = pa.slice(abs.length + 1)
        if (nameRe && !nameRe.test(rel)) continue
        if (!m) {
          hits.push({ path: wire(pa), line: 0, text: '' })
          continue
        }
        const st = await stat(pr).catch(() => null)
        if (!st || st.size > SEARCH_MAX_FILE_BYTES) continue
        const buf = await readFile(pr).catch(() => null)
        if (!buf || buf.includes(0)) continue
        const lines = buf.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          const at = m.match(lines[i]!)
          if (at >= 0) hits.push(m.hit(wire(pa), i + 1, lines[i]!, at))
        }
      }
    }
    await walk(abs, real)
    return hits
  }

  /**
   * Общий `fs.watch` на каталог (ключ — путь и глубина): подписчики делят один наблюдатель,
   * события склеиваются. Без `recursive` — только прямые дети: панель на `~` не следит за диском.
   * Сам `fs.watch` — в потоке пула (`watch.ts`): открытие асинхронное, не успел или упал —
   * запись уходит из карты (следующая подписка попробует снова), подписчик живёт без событий.
   */
  interface WatchEntry {
    h: WatchHandle | null
    listeners: Set<ExternalUpdateListener>
    pending: Set<string>
    timer: ReturnType<typeof setTimeout> | null
    closed: boolean
    /** Больше не следит: из карты (если ещё там), наблюдатель закрыть. */
    retire(): void
  }
  const watchers = new Map<string, WatchEntry>()
  function watchUnder(raw: string, listener: ExternalUpdateListener, o?: ExternalOpts & { recursive?: boolean }): () => void {
    local(o)
    const recursive = o?.recursive === true
    const abs = absOf(raw)
    const key = `${recursive ? 'r' : 'd'}:${abs}`
    if (denied(abs)) throw fail('forbidden', `путь закрыт: ${abs}`)
    let real: string
    try {
      real = realpathSync(abs)
    } catch {
      throw fail('not_found', `файла нет: ${abs}`)
    }
    let entry = watchers.get(key)
    if (!entry) {
      const e: WatchEntry = {
        h: null,
        listeners: new Set(),
        pending: new Set(),
        timer: null,
        closed: false,
        retire() {
          if (e.closed) return
          e.closed = true
          if (e.timer) clearTimeout(e.timer)
          e.h?.close()
          if (watchers.get(key) === e) watchers.delete(key)
        },
      }
      const emit = (paths: string[]): void => {
        for (const l of e.listeners) {
          try {
            l({ type: 'external_update', ...tag(), paths: paths.map((x) => (x ? wire(x) : x)) })
          } catch {
            // подписчик упал — остальным всё равно
          }
        }
      }
      const flush = (): void => {
        e.timer = null
        if (e.closed) return
        const paths = e.pending.size > WATCH_MAX_PATHS ? [''] : [...e.pending]
        e.pending.clear()
        if (paths.length) emit(paths)
      }
      e.h = watchPool().open(real, recursive, {
        onEvent: (n) => {
          if (e.closed) return
          if (n.split('/').some((p) => p.startsWith('.nr-tmp-'))) return
          const p = n === '' ? abs : join(abs, n)
          if (denied(p)) return
          e.pending.add(p)
          if (!e.timer) e.timer = setTimeout(flush, WATCH_DEBOUNCE_MS)
        },
        onError: () => {
          if (e.closed) return
          e.retire()
          emit([''])
        },
      })
      e.h.ready.catch(() => e.retire()) // строку в лог пишет пул
      entry = e
      watchers.set(key, e)
    }
    entry.listeners.add(listener)
    const e = entry
    return () => {
      e.listeners.delete(listener)
      if (e.listeners.size === 0) e.retire()
    }
  }

  async function command(raw: string, args: (abs: string) => string[], dryRun?: boolean): Promise<HostCommand> {
    const { abs } = await existing(raw)
    const c: HostCommand = { cmd: 'open', args: args(abs) }
    if (!dryRun) await exec(c.cmd, c.args)
    return c
  }

  return {
    capability: () => ({
      files: {
        external: true,
        ...(canWrite ? { write: true } : {}),
        search: true,
        ...(canWatch ? { watch: true } : {}),
        disk: true,
        ...(hostName ? { host: hostName, hosts: [hostName] } : {}),
      },
      ...(hostOpen ? { host: { open: true, apps: Object.keys(apps) } } : {}),
    }),

    async stat(raw, o): Promise<ExternalFileStat> {
      local(o)
      if (isRootWire(raw)) return { ...tag(), path: '/', exists: true, kind: 'dir' }
      const { abs, real } = await allowed(raw)
      if (!real) return { ...tag(), path: wire(abs), exists: false }
      const st = await stat(real)
      const kind = st.isDirectory() ? 'dir' : 'file'
      const mime = kind === 'file' ? rawMime(abs) : undefined
      return { ...tag(), path: wire(abs), exists: true, kind, mtime: st.mtime.toISOString(), ...(kind === 'file' ? { size: st.size } : {}), ...(mime ? { mime } : {}) }
    },

    async read(raw, o): Promise<FileContent> {
      local(o)
      const { abs, real } = await existing(raw)
      const st = await stat(real)
      if (st.isDirectory()) throw fail('bad_request', `это каталог: ${abs}`)
      checkFileReadSize(abs, st.size, o?.maxBytes)
      const data = await readFile(real)
      return fileContent({ path: wire(abs), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), revision: `${st.mtimeMs}:${st.size}` })
    },

    async list(raw, o): Promise<FileEntry[]> {
      local(o)
      if (isRootWire(raw)) return winDrives()
      const { abs, real } = await existing(raw)
      const dirents = await readdir(real, { withFileTypes: true })
      const out: FileEntry[] = []
      for (const d of dirents) {
        const path = join(abs, d.name)
        if (denied(path)) continue
        if (d.isSymbolicLink()) {
          const target = await realpath(path).catch(() => null)
          if (target && denied(target)) continue
        }
        let isDir = d.isDirectory()
        let size: number | undefined
        let mtime: string | undefined
        try {
          const st = await stat(path)
          isDir = st.isDirectory()
          if (!isDir) size = st.size
          mtime = st.mtime.toISOString()
        } catch {
          // битый симлинк — как есть
        }
        const mime = isDir ? undefined : rawMime(path)
        out.push({ ...tag(), name: d.name, path: wire(path), kind: isDir ? 'dir' : 'file', ...(size === undefined ? {} : { size }), ...(mtime ? { mtime } : {}), ...(mime ? { mime } : {}) })
      }
      out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
      return out
    },

    ...(canWrite ? writeOps() : {}),

    async search(raw, q, o): Promise<FileSearchHit[]> {
      local(o)
      const { abs, real } = await existing(raw)
      return searchUnder(abs, real, q)
    },

    ...(canWatch ? { watch: (raw: string, listener: ExternalUpdateListener, o?: ExternalOpts & { recursive?: boolean }) => watchUnder(raw, listener, o) } : {}),

    async disk(raw, o): Promise<{ total: number; free: number }> {
      local(o)
      const { real } = await existing(raw)
      const st = await statfs(real)
      return { total: st.blocks * st.bsize, free: st.bavail * st.bsize }
    },

    async thumb(raw, px, o): Promise<string | null> {
      local(o)
      const { real } = await existing(raw)
      const kind = thumbKind(real)
      if (!kind) return null
      const side = Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(px) || 256))
      const st = await stat(real)
      if (!st.isFile()) return null
      const key = createHash('sha1').update(`${real}\0${st.mtimeMs}\0${st.size}\0${side}`).digest('hex')
      const out = join(thumbsDir, key.slice(0, 2), `${key}.webp`)
      if (existsSync(out)) return out
      let making = thumbsMaking.get(key)
      if (!making) {
        making = thumbSlots(async () => {
          if (existsSync(out)) return true
          await mkdir(dirname(out), { recursive: true })
          return thumbnail(real, out, side, kind)
        })
          .catch(() => false)
          .finally(() => thumbsMaking.delete(key))
        thumbsMaking.set(key, making)
      }
      return (await making) && existsSync(out) ? out : null
    },

    host: hostOpen
      ? {
          reveal: (raw, o) => {
            local(o)
            local(o?.on !== undefined ? { host: o.on } : undefined)
            return command(raw, (abs) => ['-R', abs], o?.dryRun)
          },
          open: (raw, o) => {
            local(o)
            local(o?.on !== undefined ? { host: o.on } : undefined)
            const app = o?.app
            if (app !== undefined && !Object.hasOwn(apps, app)) return Promise.reject(fail('bad_request', `приложения «${app}» нет в $host_apps стенда`))
            return command(raw, (abs) => (app === undefined ? [abs] : ['-a', apps[app]!, abs]), o?.dryRun)
          },
        }
      : null,
  }
}

/** Байты файла для `GET /files/external/raw` (картинка, pdf): тот же доступ, лимит — 50 МБ. */
export async function readExternalRaw(
  host: ExternalHost,
  raw: string,
  o: ExternalOpts & { thumb?: number } = {},
): Promise<{ data: Uint8Array; mime?: string; mtime?: string; size?: number }> {
  const { thumb, ...where } = o
  // Эскиз картинки или видео не вышел — громко (pics-spec §3): панель рисует «не читается», а не тянет оригинал.
  if (thumb && thumbKind(raw)) {
    const file = await host.thumb(raw, thumb, where)
    if (!file) throw fail('unreadable', `эскиз не сделан, файл не читается: ${raw}`)
    const data = await readFile(file)
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mime: thumbMime(data.subarray(0, 12)) }
  }
  const st = await host.stat(raw, where)
  if (!st.exists) throw fail('not_found', `файла нет: ${st.path}`)
  if (st.kind !== 'file') throw fail('bad_request', `это каталог: ${st.path}`)
  checkFileReadSize(st.path, st.size ?? 0, 50_000_000)
  // Windows: путь ответа — адрес провода (`/E:/…`), файлу нужен путь ОС.
  const data = await readFile(await realpath(platform() === 'win32' ? winFromWire(st.path) : st.path))
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    ...(st.mime ? { mime: st.mime } : {}),
    ...(st.mtime ? { mtime: st.mtime } : {}),
    size: data.byteLength,
  }
}

