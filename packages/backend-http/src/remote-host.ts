/**
 * Удалённые хосты `files.external` (v1.45, nr-far.dev/specs/hosts-spec.md §2).
 *
 * Хост реестра (`$hosts` в `envs/contours.mdz`) — второй поставщик за тем же проводом:
 * на хост **один живой процесс** `ssh -T <alias> <node> -e <загрузчик>`, на вход ему — агент
 * `@kerneldreams/host-agent` (ничего не ставится на хост), дальше JSON-строки. Упал —
 * следующий вызов поднимает заново; пока не прошло `retryMs` после неудачи — сразу
 * `host_unavailable` с причиной (панель: «нет связи» и «повторить»). Простой без вызовов
 * и слежения дольше `idleMs` — процесс закрывается.
 *
 * Байты — кусками по 1 МБ тем же каналом: `raw` уходит в ответ HTTP по куску (хаб не держит
 * файл в памяти), перенос между хостами — {@link transferAcross} (`walk` → `read` → `put` →
 * `finish`). Эскизы: хост умеет (`sips`/`ffmpeg`/`magick`) — делает он, иначе хаб тянет
 * оригинал и делает сам; кэш хаба — по `host:path:mtime:size:side`.
 *
 * Закрытые пути — те же правила, что у своего хоста ({@link DEFAULT_EXTERNAL_DENY} +
 * `$external_deny`), раскрытые от дома хоста; проверяет агент, в том числе по реальному пути.
 *
 * Второй провод: хост с установленным агентом — `nr-mcp` (`spec.url` + bearer) — тот же агент
 * по HTTP: `GET <url>/agent` — SSE (`hello` с `session`, события слежения), `POST <url>/agent/<session>` —
 * запрос → ответ. Всё выше провода — общее; ssh остаётся путём «без установки».
 */

import { spawn as spawnProcess, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile, open as openFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ExternalFileStat,
  ExternalFilesCapability,
  ExternalFilesOps,
  ExternalHostInfo,
  ExternalOpts,
  ExternalSearchQuery,
  ExternalUpdateListener,
  FileContent,
  FileEntry,
  FileSearchHit,
  FileWriteOpts,
  HostActionResult,
  HostCapability,
} from '@kerneldreams/ui-protocol'
import { HOST_UNAVAILABLE_CODE, checkFileReadSize, compileFileSearch, fileContent, fileGlobRegExp } from '@kerneldreams/ui-protocol'
import { agentLine, bootstrapCode, type AgentDenyRule, type AgentHello } from '@kerneldreams/host-agent'
import { DEFAULT_EXTERNAL_DENY, hostThumbnail, rawMime, thumbKind, type ExternalHost, type HostCommand } from './external.js'

/** Хост реестра: секция `## $hosts <name>`. */
export interface RemoteHostSpec {
  name: string
  /** Алиас ssh (`$ssh`); default — `name`. */
  ssh?: string
  /** `$node` хоста; default `node`. */
  node?: string
  /** `$os` из реестра — до первой связи. */
  os?: string
  /**
   * Свой запуск node вместо ssh (`docker exec -i <ctr> node`, `wsl node`, фикстура e2e):
   * argv до `-e <загрузчик>`. Есть — `ssh`/`node` не нужны.
   */
  command?: string[]
  /** Окружение для `command` поверх своего. */
  env?: Record<string, string>
  /** Установленный агент (`nr-mcp`): базовый адрес, `<url>/agent`. Есть — ssh не нужен. */
  url?: string
  /** Bearer `nr-mcp` машины (`Authorization: Bearer`). */
  token?: string
  /** Заголовки поверх (Cloudflare Access service token: `CF-Access-Client-Id`/`-Secret`). */
  headers?: Record<string, string>
  /** v1.54: маски домашних каталогов (`$home` реестра) — `hostsInfo[].home`. */
  home?: string[]
  /** v1.54: другие имена машины (алиас ssh, `$match`, адрес) — узнать её в `mount` устройства. */
  aliases?: string[]
  /**
   * куда ведёт алиас `ssh` у источника реестра (`ssh -G` там: `$ssh_host`, `$ssh_user`, `$ssh_port`). Своего
   * алиаса на этой машине нет (`ssh -G <alias>` даёт `hostname <alias>`) — ssh идёт сюда; есть — свой алиас главнее.
   */
  sshTarget?: { host: string; user?: string; port?: number }
}

export interface RemoteHostOptions {
  /** `$external_deny` стенда — поверх встроенных. */
  deny?: string[]
  /** Процесс агента (тесты, локальный агент); default — `ssh -T <alias> <node> -e …`. */
  spawn?: () => ChildProcess
  /** Ждать `hello`, мс; default 15 000. */
  connectTimeoutMs?: number
  /** Ответ на вызов, мс; default 60 000. */
  callTimeoutMs?: number
  /** После неудачи столько мс — сразу `host_unavailable`, без нового ssh; default 3000. */
  retryMs?: number
  /** Закрыть процесс после простоя, мс; default 10 мин. */
  idleMs?: number
  /** Кэш эскизов хаба; default `~/.cache/nr-thumbs/hosts`. */
  thumbsDir?: string
  /** Эскиз на хабе (тесты); default — `hostThumbnail` (sharp, ffmpeg, macOS). */
  thumbnail?: (src: string, out: string, px: number, kind: 'image' | 'video') => Promise<boolean>
  /** Сколько эскизов одновременно; default 3. */
  thumbConcurrency?: number
}

/** Кусок байтов файла. */
export interface ByteChunk {
  data: Uint8Array
  size: number
  eof: boolean
}

/** Узел дерева для переноса: `rel` от корня, корень — `''`. */
export interface WalkEntry {
  rel: string
  kind: 'file' | 'dir'
  size?: number
  mtimeMs: number
}

/** Что умеет конец переноса {@link transferAcross} — любой хост с агентом. */
export interface ByteHost {
  readonly name: string
  stat(path: string): Promise<ExternalFileStat>
  walk(path: string): Promise<{ path: string; entries: WalkEntry[] }>
  readChunk(path: string, offset: number, length: number): Promise<ByteChunk>
  put(tmp: string, offset: number, data: Uint8Array): Promise<void>
  finish(tmp: string, to: string, opts?: { mtimeMs?: number; overwrite?: boolean }): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string, permanent?: boolean): Promise<void>
}

/** Удалённый хост: `files.external` одного хоста + перенос, эскизы, связь. */
export interface RemoteHost extends ByteHost {
  readonly name: string
  info(): ExternalHostInfo
  /** v1.54: имена машины для `mount` устройства (имя, алиас ssh, `aliases` реестра). */
  readonly aliases?: readonly string[]
  /** Поднять связь (или взять живую): что сообщил агент. */
  connect(): Promise<AgentHello>
  files: Required<Pick<ExternalFilesOps, 'stat' | 'read' | 'list' | 'write' | 'mkdir' | 'rename' | 'delete' | 'copy' | 'search' | 'watch' | 'disk'>>
  /** Эскиз — путь PNG в кэше хаба; не картинка / не вышло — `null`. */
  thumb(path: string, px: number): Promise<string | null>
  /** Файл потоком кусков (для `raw`); `range` — байты `[start, end]` включительно (Range медиа). */
  openRaw(path: string, range?: readonly [number, number]): Promise<RawStream>
  /** Команда на хосте без шелла (git этапа 3). */
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<{ code: number; stdout: string; stderr: string }>
  close(): void
}

/** Файл потоком: `size` — весь файл, `chunks` — запрошенный кусок (по умолчанию весь). */
export interface RawStream {
  size: number
  mime?: string
  chunks: AsyncIterable<Uint8Array>
}

const CHUNK = 1024 * 1024
const GLOB_CHARS = /[*?{[]/

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Правила закрытого для агента: от дома хоста и его реального пути. */
export function agentDenyRules(homes: readonly string[], extra: readonly string[] = []): AgentDenyRule[] {
  const patterns = [...DEFAULT_EXTERNAL_DENY, ...extra].map((r) => r.trim()).filter((r) => r !== '')
  const out: AgentDenyRule[] = []
  const seen = new Set<string>()
  for (const h of new Set(homes)) {
    for (const raw of patterns) {
      const p = raw === '~' ? h : raw.startsWith('~/') ? `${h.replace(/\/+$/, '')}/${raw.slice(2)}` : raw
      const rule: AgentDenyRule = GLOB_CHARS.test(p) ? { re: fileGlobRegExp(p.replace(/^\/+/, '')).source } : { prefix: p.replace(/\/+$/, '') }
      const key = JSON.stringify(rule)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(rule)
      }
    }
  }
  return out
}

/**
 * Строка ssh → причина по-человечески одной строкой (серая машина в «Местах» с причиной). Не узнали —
 * строка ssh как есть.
 */
export function sshReason(line: string, alias: string): string | null {
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|No address associated/i.test(line)) return `нет ssh-алиаса ${alias} на этой машине`
  if (/Permission denied|Too many authentication failures|publickey/i.test(line)) return `ключ не принят (${alias})`
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(line)) return `ключ хоста ${alias} не совпал (known_hosts)`
  if (/timed out|No route to host|Network is unreachable|Connection refused|Connection reset|Connection closed by|Operation timed out/i.test(line)) return 'не отвечает'
  return null
}

/** Почему процесс умер до `hello`: ssh не достучался (255) или нет node. */
function classify(code: number | null, stderr: string, alias = ''): { state: 'off' | 'no-node'; reason: string } {
  const last = stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  if (code === 255) return { state: 'off', reason: sshReason(last, alias) ?? (last || 'ssh: нет связи') }
  if (code === 127 || /not found|not recognized|No such file/i.test(stderr)) return { state: 'no-node', reason: last || 'нет node' }
  return { state: 'off', reason: last || `агент вышел с кодом ${code}` }
}

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

/** Связь с агентом: процесс (ssh/node) или HTTP (`nr-mcp`). */
interface Conn {
  /** Одна строка запроса `{id, op, args}` без `\n`. */
  write(line: string): void
  close(): void
  hello: AgentHello
  pending: Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>
  dead: boolean
}

interface WatchSub {
  path: string
  recursive: boolean
  listener: ExternalUpdateListener
  /** id слежения у агента текущего процесса. */
  wid: number | null
  conn: Conn | null
  closed: boolean
}

/** Есть ли у ssh этой машины свой алиас: `ssh -G` без него отдаёт `hostname <alias>` как есть. Кэш на процесс. */
const localAlias = new Map<string, boolean>()
export function hasLocalSshAlias(alias: string, run: (alias: string) => string | null = sshG): boolean {
  const known = localAlias.get(alias)
  if (known !== undefined) return known
  const out = run(alias)
  const host = out ? /^hostname\s+(\S+)/m.exec(out)?.[1] : undefined
  const has = host !== undefined && host.toLowerCase() !== alias.toLowerCase()
  localAlias.set(alias, has)
  return has
}

function sshG(alias: string): string | null {
  const r = spawnSync('ssh', ['-G', alias], { encoding: 'utf8', timeout: 5000 })
  return r.status === 0 ? r.stdout : null
}

/** Аргументы ssh под адрес источника реестра, если своего алиаса нет. */
export function sshTargetArgs(alias: string, target: RemoteHostSpec['sshTarget'], has: (alias: string) => boolean = hasLocalSshAlias): string[] {
  if (!target?.host || has(alias)) return []
  return ['-o', `HostName=${target.host}`, ...(target.user ? ['-o', `User=${target.user}`] : []), ...(target.port ? ['-o', `Port=${target.port}`] : [])]
}

/** Путь Windows как его пишет человек (`C:/x`, `C:\x`, `c:`) → путь провода агента `/C:/x`. */
export function wirePath(p: string): string {
  const m = /^([A-Za-z]):([\\/].*)?$/.exec(p.trim())
  return m ? `/${m[1]!.toUpperCase()}:${(m[2] ?? '/').replace(/\\/g, '/')}` : p
}

const PATH_ARGS = ['path', 'from', 'to', 'tmp'] as const

const regexEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Удалённый хост по ssh (или любым процессом агента — `opts.spawn`). */
export function createRemoteHost(spec: RemoteHostSpec, opts: RemoteHostOptions = {}): RemoteHost {
  const name = spec.name
  const alias = spec.ssh || name
  const connectTimeout = opts.connectTimeoutMs ?? 15_000
  const callTimeout = opts.callTimeoutMs ?? 60_000
  const retryMs = opts.retryMs ?? 3000
  const idleMs = opts.idleMs ?? 600_000
  const thumbsDir = opts.thumbsDir ?? join(homedir(), '.cache', 'nr-thumbs', 'hosts')
  const thumbnail = opts.thumbnail ?? hostThumbnail
  const thumbSlots = limiter(Math.max(1, opts.thumbConcurrency ?? 3))
  const thumbsMaking = new Map<string, Promise<string | null>>()
  const spawn =
    opts.spawn ??
    (spec.command && spec.command.length > 0
      ? () => spawnProcess(spec.command![0]!, [...spec.command!.slice(1), '-e', bootstrapCode()], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...spec.env } })
      : null) ??
    (() => {
      const node = spec.node || 'node'
      const nodeCmd = spec.os === 'win32' && /\s/.test(node) ? `"${node}"` : node
      return spawnProcess(
        'ssh',
        ['-T', ...sshTargetArgs(alias, spec.sshTarget), '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.ceil(connectTimeout / 1000)}`, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', alias, nodeCmd, '-e', `"${bootstrapCode()}"`],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
    })

  let info: ExternalHostInfo = { name, ...(spec.os ? { os: spec.os } : {}), state: 'unknown' }
  let conn: Conn | null = null
  let connecting: Promise<Conn> | null = null
  let lastFail: { at: number; error: Error } | null = null
  let nextId = 1
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const subs = new Set<WatchSub>()
  /** Подключения в полёте (ещё без hello): `close()` обрывает их, иначе процесс агента переживает хост. */
  const inflight = new Set<() => void>()
  /** Счётчик `close()`: связь, поднятая до закрытия и закончившая `init` после, сразу гасится. */
  let closes = 0

  const unavailable = (reason: string): Error => fail(HOST_UNAVAILABLE_CODE, `нет связи с ${name}: ${reason}`)

  function touch(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (conn && conn.pending.size === 0 && [...subs].every((s) => s.closed)) closeConn(conn)
    }, idleMs)
    idleTimer.unref?.()
  }

  function closeConn(c: Conn): void {
    if (c.dead) return
    c.dead = true
    c.close()
    if (conn === c) conn = null
  }

  function onDeath(c: Conn, why: string): void {
    const was = !c.dead
    c.dead = true
    if (conn === c) conn = null
    for (const [, p] of c.pending) {
      clearTimeout(p.timer)
      p.bad(unavailable(why))
    }
    c.pending.clear()
    if (!was) return
    // Слежение: перечитать всё и подписаться заново, когда связь вернётся.
    const live = [...subs].filter((s) => !s.closed && s.conn === c)
    for (const s of live) {
      s.wid = null
      s.conn = null
      try {
        s.listener({ type: 'external_update', host: name, paths: [''] })
      } catch {
        // подписчик упал
      }
    }
    if (live.length > 0) setTimeout(() => void resubscribe(), retryMs).unref?.()
  }

  type AgentMsg = { id?: number; ok?: boolean; result?: unknown; error?: string; code?: string; event?: string; watch?: number; paths?: string[]; session?: string } & Partial<Omit<AgentHello, 'event'>>

  /** Сообщение агента по живой связи: событие слежения или ответ на вызов. */
  function onMessage(c: Conn, msg: AgentMsg): void {
    if (msg.event === 'update') {
      for (const s of subs) {
        if (s.conn === c && s.wid === msg.watch && !s.closed) {
          try {
            s.listener({ type: 'external_update', host: name, paths: msg.paths ?? [''] })
          } catch {
            // подписчик упал
          }
        }
      }
      return
    }
    if (typeof msg.id === 'number') {
      const p = c.pending.get(msg.id)
      if (!p) return
      c.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.ok(msg.result)
      else p.bad(fail(msg.code ?? 'internal', msg.error ?? 'ошибка агента'))
    }
  }

  function start(): Promise<Conn> {
    return spec.url && !opts.spawn ? startHttp(spec.url) : startProc()
  }

  /** Установленный агент по HTTP: SSE `/agent` держит сессию, запросы — POST. */
  function startHttp(url: string): Promise<Conn> {
    const base = url.replace(/\/+$/, '')
    const headers: Record<string, string> = { ...(spec.headers ?? {}), ...(spec.token ? { authorization: `Bearer ${spec.token}` } : {}) }
    return new Promise<Conn>((resolve, reject) => {
      const ac = new AbortController()
      let c: Conn | null = null
      let settled = false
      const settleFail = (reason: string): void => {
        if (settled) return
        settled = true
        inflight.delete(abort)
        clearTimeout(timer)
        ac.abort()
        info = { ...info, state: 'off', reason }
        reject(unavailable(reason))
      }
      const timer = setTimeout(() => settleFail(`нет ответа за ${Math.round(connectTimeout / 1000)} с`), connectTimeout)
      const abort = (): void => settleFail('хост закрыт')
      inflight.add(abort)
      const lost = (why: string): void => {
        if (!c) return settleFail(why)
        if (!c.dead) info = { ...info, state: 'off', reason: why }
        onDeath(c, why)
      }
      void (async () => {
        const res = await fetch(`${base}/agent`, { headers: { ...headers, accept: 'text/event-stream' }, signal: ac.signal })
        if (!res.ok || !res.body) {
          const hint = res.status === 401 ? ' (токен nr-mcp)' : res.status === 403 ? ' (Cloudflare Access)' : ''
          return settleFail(`HTTP ${res.status}${hint}`)
        }
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return lost('агент закрыл поток')
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const ev = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = ev
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n')
            if (!data) continue
            let msg: AgentMsg
            try {
              msg = JSON.parse(data)
            } catch {
              continue
            }
            if (msg.event === 'hello' && !c) {
              const session = msg.session
              if (!session) return settleFail('агент без сессии (не nr-mcp?)')
              settled = true
              inflight.delete(abort)
              clearTimeout(timer)
              const cc: Conn = {
                hello: msg as AgentHello,
                pending: new Map(),
                dead: false,
                write(line) {
                  const id = (JSON.parse(line) as { id?: number }).id
                  void fetch(`${base}/agent/${session}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: line })
                    .then(async (r) => {
                      if (r.status === 404) return lost('сессия агента пропала')
                      onMessage(cc, (await r.json()) as AgentMsg)
                    })
                    .catch((err: Error) => {
                      const p = typeof id === 'number' ? cc.pending.get(id) : undefined
                      if (!p || id === undefined) return
                      cc.pending.delete(id)
                      clearTimeout(p.timer)
                      p.bad(unavailable(err.message))
                    })
                },
                close: () => ac.abort(),
              }
              c = cc
              resolve(cc)
              continue
            }
            if (c) onMessage(c, msg)
          }
        }
      })().catch((err: Error) => lost(err.name === 'AbortError' ? 'связь закрыта' : err.message))
    })
  }

  function startProc(): Promise<Conn> {
    return new Promise<Conn>((resolve, reject) => {
      let proc: ChildProcess
      try {
        proc = spawn()
      } catch (err) {
        reject(unavailable((err as Error).message))
        return
      }
      let stderr = ''
      let buf = ''
      let c: Conn | null = null
      const timer = setTimeout(() => {
        proc.kill()
        settleFail({ state: 'off', reason: `не отвечает (${Math.round(connectTimeout / 1000)} с)` })
      }, connectTimeout)
      const abort = (): void => {
        proc.kill()
        settleFail({ state: 'off', reason: 'хост закрыт' })
      }
      inflight.add(abort)
      const settleFail = (why: { state: 'off' | 'no-node'; reason: string }): void => {
        inflight.delete(abort)
        clearTimeout(timer)
        info = { ...info, state: why.state, reason: why.reason }
        reject(unavailable(why.reason))
      }
      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (d: string) => {
        stderr = (stderr + d).slice(-4000)
      })
      proc.stdin?.on('error', () => {
        // процесс умер — разберёт 'exit'
      })
      proc.on('error', (err) => {
        if (!c) settleFail({ state: 'off', reason: err.message })
        else onDeath(c, err.message)
      })
      proc.on('exit', (code) => {
        if (!c) settleFail(classify(code, stderr, alias))
        else {
          const why = classify(code, stderr, alias)
          if (!c.dead) info = { ...info, state: why.state, reason: why.reason }
          onDeath(c, why.reason)
        }
      })
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (d: string) => {
        buf += d
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line.trim()) continue
          let msg: AgentMsg
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg.event === 'hello' && !c) {
            clearTimeout(timer)
            inflight.delete(abort)
            c = {
              hello: msg as AgentHello,
              pending: new Map(),
              dead: false,
              write: (l) => void proc.stdin!.write(`${l}\n`),
              close() {
                try {
                  proc.stdin?.end()
                } catch {
                  // уже закрыт
                }
                setTimeout(() => proc.kill(), 2000).unref?.()
              },
            }
            resolve(c)
            continue
          }
          if (c) onMessage(c, msg)
        }
      })
      proc.stdin?.write(agentLine())
    })
  }

  function send<T>(c: Conn, op: string, args: unknown, timeout = callTimeout): Promise<T> {
    if (c.dead) return Promise.reject(unavailable('связь оборвалась'))
    const id = nextId++
    return new Promise<T>((ok, bad) => {
      const timer = setTimeout(() => {
        c.pending.delete(id)
        bad(fail(HOST_UNAVAILABLE_CODE, `${name}: ${op} — нет ответа за ${Math.round(timeout / 1000)} с`))
      }, timeout)
      c.pending.set(id, { ok: ok as (v: unknown) => void, bad, timer })
      c.write(JSON.stringify({ id, op, args }))
    })
  }

  async function ensure(): Promise<Conn> {
    touch()
    if (conn && !conn.dead) return conn
    if (connecting) return connecting
    if (lastFail && Date.now() - lastFail.at < retryMs) throw lastFail.error
    const epoch = closes
    connecting = (async () => {
      try {
        const c = await start()
        await send(c, 'init', { deny: agentDenyRules([c.hello.home, c.hello.realHome ?? c.hello.home], opts.deny) }, connectTimeout)
        if (epoch !== closes) {
          closeConn(c)
          throw unavailable('хост закрыт')
        }
        conn = c
        lastFail = null
        info = { name, os: c.hello.os, state: 'ok' }
        return c
      } catch (err) {
        const e = (err as { code?: string }).code === HOST_UNAVAILABLE_CODE ? (err as Error) : unavailable((err as Error).message)
        lastFail = { at: Date.now(), error: e }
        throw e
      } finally {
        connecting = null
      }
    })()
    return connecting
  }

  async function call<T>(op: string, args: unknown, timeout?: number): Promise<T> {
    if (args && typeof args === 'object') {
      const a = args as Record<string, unknown>
      for (const k of PATH_ARGS) if (typeof a[k] === 'string') a[k] = wirePath(a[k] as string)
    }
    const c = await ensure()
    try {
      return await send<T>(c, op, args, timeout)
    } finally {
      touch()
    }
  }

  async function resubscribe(): Promise<void> {
    const todo = [...subs].filter((s) => !s.closed && s.wid === null)
    if (todo.length === 0) return
    let c: Conn
    try {
      c = await ensure()
    } catch {
      setTimeout(() => void resubscribe(), Math.max(retryMs, 5000)).unref?.()
      return
    }
    for (const s of todo) await subscribe(s, c).catch(() => {})
  }

  async function subscribe(s: WatchSub, c: Conn): Promise<void> {
    const r = await send<{ watch: number }>(c, 'watch', { path: s.path, recursive: s.recursive })
    if (s.closed) {
      void send(c, 'unwatch', { watch: r.watch }).catch(() => {})
      return
    }
    s.wid = r.watch
    s.conn = c
  }

  type AgentStat = { path: string; exists: boolean; kind?: 'file' | 'dir'; size?: number; mtime?: string; mtimeMs?: number; revision?: string }
  const agentStat = (path: string): Promise<AgentStat> => call<AgentStat>('stat', { path })

  function toStat(s: AgentStat): ExternalFileStat {
    const mime = s.kind === 'file' ? rawMime(s.path) : undefined
    return {
      host: name,
      path: s.path,
      exists: s.exists,
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.size !== undefined ? { size: s.size } : {}),
      ...(s.mtime ? { mtime: s.mtime } : {}),
      ...(mime ? { mime } : {}),
    }
  }

  async function readChunk(path: string, offset: number, length: number): Promise<ByteChunk & { revision: string }> {
    const r = await call<{ data: string; size: number; eof: boolean; revision: string }>('read', { path, offset, length })
    const b = Buffer.from(r.data, 'base64')
    return { data: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), size: r.size, eof: r.eof, revision: r.revision }
  }

  /** Файл целиком кусками в память (до `max` байт). */
  async function readAll(path: string, max: number): Promise<{ data: Uint8Array; revision: string }> {
    const parts: Uint8Array[] = []
    let offset = 0
    let revision = ''
    for (;;) {
      const c = await readChunk(path, offset, CHUNK)
      checkFileReadSize(path, c.size, max)
      parts.push(c.data)
      offset += c.data.byteLength
      revision = c.revision
      if (c.eof || c.data.byteLength === 0) break
    }
    const data = Buffer.concat(parts)
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), revision }
  }

  /** Кусками в файл хаба (эскиз хоста, оригинал для эскиза хабом). */
  async function download(path: string, out: string, max = 200_000_000): Promise<void> {
    await mkdir(dirname(out), { recursive: true })
    const tmp = `${out}.part-${process.pid}-${Date.now()}`
    const fh = await openFile(tmp, 'w')
    try {
      let offset = 0
      for (;;) {
        const c = await readChunk(path, offset, CHUNK)
        if (c.size > max) throw fail('bad_request', `${path}: больше ${max} байт`)
        await fh.write(c.data, 0, c.data.byteLength, offset)
        offset += c.data.byteLength
        if (c.eof || c.data.byteLength === 0) break
      }
    } catch (err) {
      await fh.close().catch(() => {})
      await rm(tmp, { force: true })
      throw err
    }
    await fh.close()
    await rename(tmp, out)
  }

  async function thumb(path: string, px: number): Promise<string | null> {
    const kind = thumbKind(path)
    if (!kind) return null
    const side = Math.min(1024, Math.max(32, Math.round(px) || 256))
    const st = await agentStat(path)
    if (!st.exists || st.kind !== 'file') return null
    const key = createHash('sha1').update(`${name}\0${st.path}\0${st.mtimeMs}\0${st.size}\0${side}`).digest('hex')
    const out = join(thumbsDir, key.slice(0, 2), `${key}.png`)
    if (existsSync(out)) return out
    let making = thumbsMaking.get(key)
    if (!making) {
      making = thumbSlots(async (): Promise<string | null> => {
        if (existsSync(out)) return out
        const c = await ensure()
        const canHost = c.hello.caps.thumb !== null && (kind === 'image' || c.hello.caps.video)
        if (canHost) {
          const made = await send<{ path: string } | null>(c, 'thumb', { path, px: side }, 120_000).catch(() => null)
          if (made) {
            await download(made.path, out)
            return out
          }
        }
        // Хост не умеет — оригинал на хаб и эскиз здесь (`hostThumbnail`: sharp, ffmpeg, на macOS — sips).
        const src = `${out}.src`
        try {
          await download(path, src)
          await mkdir(dirname(out), { recursive: true })
          return (await thumbnail(src, out, side, kind)) && existsSync(out) ? out : null
        } finally {
          await rm(src, { force: true })
        }
      })
        .catch(() => null)
        .finally(() => thumbsMaking.delete(key))
      thumbsMaking.set(key, making)
    }
    return making
  }

  /**
   * Диски Windows-машины спросом у неё самой: корни установленного агента (`hello.roots`, nr-mcp), иначе
   * `fsutil fsinfo drives` (без прав администратора; буквы без проверки — отключённый сетевой диск вешает realpath).
   */
  async function winDrives(): Promise<FileEntry[]> {
    const c = await ensure()
    const fromRoots = ((c.hello as AgentHello & { roots?: string[] }).roots ?? []).map((r) => /^\/([A-Za-z]):\/?$/.exec(r)?.[1]).filter((x): x is string => !!x)
    let letters = fromRoots
    if (letters.length === 0) {
      const r = await call<{ code: number; stdout: string }>('exec', { cmd: 'fsutil', args: ['fsinfo', 'drives'], timeout: 10_000 }, 15_000).catch(() => null)
      letters = r && r.code === 0 ? [...r.stdout.matchAll(/\b([A-Za-z]):\\/g)].map((m) => m[1]!) : []
    }
    if (letters.length === 0) {
      const home = /^\/([A-Za-z]):/.exec(c.hello.home)?.[1]
      if (home) letters = [home]
    }
    const uniq = [...new Set(letters.map((l) => l.toUpperCase()))].sort()
    return uniq.map((l) => ({ host: name, name: `${l}:`, path: `/${l}:/`, kind: 'dir' as const }))
  }

  const files: RemoteHost['files'] = {
    async stat(path) {
      return toStat(await agentStat(path))
    },
    async read(path, o) {
      const st = await agentStat(path)
      if (!st.exists) throw fail('not_found', `файла нет: ${st.path}`)
      if (st.kind === 'dir') throw fail('bad_request', `это каталог: ${st.path}`)
      checkFileReadSize(st.path, st.size ?? 0, o?.maxBytes)
      const { data, revision } = await readAll(st.path, o?.maxBytes ?? Number.MAX_SAFE_INTEGER)
      return { ...fileContent({ path: st.path, data, revision }) } satisfies FileContent
    },
    async list(path) {
      // Windows: `/` — «Этот компьютер», диски машины: `..` с `/C:/` и корни в «Местах» / Alt+F1.
      if (wirePath(path) === '/' && (await ensure()).hello.os === 'win32') return winDrives()
      const rows = await call<Array<Omit<FileEntry, 'host' | 'mime'>>>('list', { path })
      return rows.map((e) => {
        const mime = e.kind === 'file' ? rawMime(e.path) : undefined
        return { host: name, ...e, ...(mime ? { mime } : {}) }
      })
    },
    async write(path, content, o?: FileWriteOpts & ExternalOpts) {
      const data = o?.encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64')
      return call<{ revision: string }>('write', { path, data, ...(o?.revision !== undefined ? { revision: o.revision } : {}) })
    },
    async mkdir(path) {
      await call('mkdir', { path })
    },
    async rename(from, to) {
      await call('rename', { from, to })
    },
    async delete(path, o) {
      return call<{ trashed?: string }>('delete', { path, ...(o?.permanent ? { permanent: true } : {}) })
    },
    async copy(from, to, o) {
      await call('copy', { from, to, ...(o?.overwrite ? { overwrite: true } : {}) }, 30 * 60_000)
    },
    async search(path, q: ExternalSearchQuery) {
      const glob = typeof q?.glob === 'string' && q.glob.trim() !== '' ? q.glob.trim() : undefined
      const text = typeof q?.query === 'string' && q.query !== '' ? q.query : undefined
      if (!glob && !text) throw fail('bad_request', 'search: нужен glob или query')
      const m = text ? compileFileSearch({ query: text, ...(q.regex ? { regex: true } : {}), ...(q.case ? { case: true } : {}), ...(q.limit ? { limit: q.limit } : {}) }) : null
      const limit = m?.limit ?? Math.min(Math.max(1, q.limit ?? 500), 5000)
      const nameRe = glob ? fileGlobRegExp(glob.includes('/') ? glob : `**/${glob}`).source : undefined
      const textRe = text ? (q.regex ? text : regexEscape(text)) : undefined
      const raw = await call<Array<{ path: string; line: number; text: string; at: number }>>(
        'search',
        { path, limit, ...(nameRe ? { nameRe } : {}), ...(textRe ? { textRe, textFlags: q.case ? 'u' : 'iu' } : {}) },
        30_000,
      )
      return raw.map((h): FileSearchHit => (m && h.at >= 0 ? m.hit(h.path, h.line, h.text, h.at) : { path: h.path, line: 0, text: '' }))
    },
    watch(path, listener, o) {
      const s: WatchSub = { path, recursive: o?.recursive === true, listener, wid: null, conn: null, closed: false }
      subs.add(s)
      void ensure()
        .then((c) => subscribe(s, c))
        .catch(() => {
          // нет связи — панель узнает из list; подписка поднимется с переподключением
          if (!s.closed) setTimeout(() => void resubscribe(), Math.max(retryMs, 5000)).unref?.()
        })
      return () => {
        s.closed = true
        subs.delete(s)
        if (s.conn && s.wid !== null && !s.conn.dead) void send(s.conn, 'unwatch', { watch: s.wid }).catch(() => {})
        touch()
      }
    },
    async disk(path) {
      return call<{ total: number; free: number }>('disk', { path })
    },
  }

  return {
    name,
    info: () => ({ ...info, ...(spec.home?.length ? { home: [...spec.home] } : {}) }),
    aliases: [name, ...(spec.ssh ? [spec.ssh] : []), ...(spec.aliases ?? [])],
    connect: async () => (await ensure()).hello,
    files,
    stat: files.stat,
    walk: (path) => call<{ path: string; entries: WalkEntry[] }>('walk', { path }, 5 * 60_000),
    readChunk,
    async put(tmp, offset, data) {
      await call('put', { path: tmp, offset, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') })
    },
    async finish(tmp, to, o) {
      await call('finish', { tmp, to, ...(o?.mtimeMs !== undefined ? { mtimeMs: o.mtimeMs } : {}), ...(o?.overwrite ? { overwrite: true } : {}) })
    },
    mkdir: (path) => files.mkdir(path),
    async remove(path, permanent) {
      await files.delete(path, permanent ? { permanent: true } : {})
    },
    thumb,
    async openRaw(path, range) {
      const st = await agentStat(path)
      if (!st.exists) throw fail('not_found', `файла нет: ${st.path}`)
      if (st.kind !== 'file') throw fail('bad_request', `это каталог: ${st.path}`)
      const mime = rawMime(st.path)
      const size = st.size ?? 0
      const [from, to] = range ?? [0, size - 1]
      async function* chunks(): AsyncIterable<Uint8Array> {
        let offset = from
        const want = (): number => Math.min(CHUNK, to - offset + 1)
        if (want() <= 0) return
        // следующий кусок просим, пока отдаём текущий
        let next = readChunk(st.path, offset, want())
        for (;;) {
          const c = await next
          offset += c.data.byteLength
          const done = c.eof || c.data.byteLength === 0 || offset > to
          if (!done) next = readChunk(st.path, offset, want())
          if (c.data.byteLength) yield c.data
          if (done) return
        }
      }
      return { size, ...(mime ? { mime } : {}), chunks: chunks() }
    },
    exec: (cmd, args, o) => call('exec', { cmd, args, ...(o?.cwd ? { cwd: o.cwd } : {}), ...(o?.timeout ? { timeout: o.timeout } : {}) }, (o?.timeout ?? 30_000) + 5000),
    close() {
      for (const s of subs) s.closed = true
      subs.clear()
      if (idleTimer) clearTimeout(idleTimer)
      closes++
      for (const abort of [...inflight]) abort()
      if (conn) closeConn(conn)
    },
  }
}

/** Агент на машине хаба — конец переноса {@link transferAcross} со стороны хаба (те же правила). */
export function createLocalAgentHost(name: string, opts: Omit<RemoteHostOptions, 'spawn'> = {}): RemoteHost {
  return createRemoteHost({ name }, { ...opts, spawn: () => spawnProcess(process.execPath, ['-e', bootstrapCode()], { stdio: ['pipe', 'pipe', 'pipe'] }) })
}

export interface TransferItem {
  from: string
  to: string
}

export interface TransferProgress {
  /** Текущий файл (путь источника). */
  file: string
  done: number
  total: number
}

/**
 * Копия/перенос между хостами кусками через хаб: дерево источника (`walk`), каталоги цели,
 * файлы — во временный `.nr-tmp-*` рядом с целью и на место с датой источника. Перенос —
 * источник насовсем после того, как все байты легли. Ошибки — по элементу, остальные идут.
 */
export async function transferAcross(
  src: ByteHost,
  dst: ByteHost,
  items: readonly TransferItem[],
  opts: { move?: boolean; overwrite?: boolean; onProgress?: (p: TransferProgress) => void } = {},
): Promise<{ done: number; failed: Array<{ from: string; error: string }> }> {
  const trees: Array<{ item: TransferItem; root: string; entries: WalkEntry[] }> = []
  const failed: Array<{ from: string; error: string }> = []
  for (const item of items) {
    try {
      const w = await src.walk(item.from)
      trees.push({ item, root: w.path, entries: w.entries })
    } catch (err) {
      failed.push({ from: item.from, error: (err as Error).message })
    }
  }
  const total = trees.reduce((n, t) => n + t.entries.reduce((m, e) => m + (e.size ?? 0), 0), 0)
  let done = 0
  let ok = 0
  const tick = (file: string): void => opts.onProgress?.({ file, done, total })
  for (const { item, root, entries } of trees) {
    try {
      const to = item.to.replace(/\/+$/, '')
      const target = await dst.stat(to)
      if (target.exists && !opts.overwrite) throw fail('conflict', `уже есть: ${to}`)
      if (target.exists && opts.overwrite) await dst.remove(to, true)
      for (const e of entries) {
        const from = e.rel ? `${root}/${e.rel}` : root
        const dest = e.rel ? `${to}/${e.rel}` : to
        if (e.kind === 'dir') {
          await dst.mkdir(dest)
          continue
        }
        const tmp = `${dest.slice(0, dest.lastIndexOf('/') + 1)}.nr-tmp-${dest.slice(dest.lastIndexOf('/') + 1)}-${process.pid}-${Date.now()}`
        let offset = 0
        tick(from)
        // следующий кусок читается, пока пишется текущий
        let next = src.readChunk(from, 0, CHUNK)
        for (;;) {
          const c = await next
          const last = c.eof || c.data.byteLength === 0
          if (!last) next = src.readChunk(from, offset + c.data.byteLength, CHUNK)
          await dst.put(tmp, offset, c.data)
          offset += c.data.byteLength
          done += c.data.byteLength
          tick(from)
          if (last) break
        }
        await dst.finish(tmp, dest, { mtimeMs: e.mtimeMs })
      }
      if (opts.move) await src.remove(root, true)
      ok++
    } catch (err) {
      failed.push({ from: item.from, error: (err as Error).message })
    }
  }
  return { done: ok, failed }
}

/** Слой `files.external` на несколько хостов: свой + удалённые из реестра. */
export interface HostsRouter extends ExternalHost {
  remotes: ReadonlyMap<string, RemoteHost>
  /** Поднять связь со всеми в фоне (состояние — в `capability().files.hostsInfo`). */
  probe(): Promise<void>
  close(): void
  /** Файл чужого хоста потоком (`range` — кусок для Range медиа); свой — `null` (как раньше, `readExternalRaw`). */
  openRaw(path: string, opts?: ExternalOpts & { range?: readonly [number, number] }): Promise<RawStream | null>
  /** v1.54: на каких хостах есть путь. */
  locate(path: string): Promise<ExternalFileStat[]>
}

export interface HostsRouterOptions {
  /** v1.54: маски домашних каталогов хаба (`$home` его секции реестра); default — `homedir()`. */
  hubHome?: string[]
  /** v1.54: другие имена хаба для `mount` устройства (алиас ssh, `$match`, адрес). */
  hubAliases?: string[]
  /** v1.54: словарь приложений «Открыть в …» (`$host_apps`) для машин устройства; default — `zed: Zed`. */
  apps?: Record<string, string>
  /** v1.54: агент на машине хаба — конец переноса «скачать на хаб» и `mount` хаба; default — {@link createLocalAgentHost}. */
  hubAgent?: () => RemoteHost
  /** v1.54: ответ хоста на `locate`, мс; default 4000 (молчит — мимо). */
  locateTimeoutMs?: number
}

/** Строка `mount` (macOS / Linux): источник и точка монтирования. */
export interface MountEntry {
  /** Сервер: `nas._smb._tcp.local`, `nas.local`, `192.0.2.10`. */
  server: string
  /** Шара или экспорт без ведущего `/`: `smith`, `Users/smith`. */
  share: string
  /** Где смонтировано у машины: `/Volumes/smith`. */
  at: string
}

/** Сетевые монтирования из вывода `mount` (`//user@server/share on /Volumes/x (smbfs, …)`, `server:/export on …`). */
export function parseMounts(out: string): MountEntry[] {
  const list: MountEntry[] = []
  for (const line of out.split('\n')) {
    const m = /^(\S+) on (.+?) (?:\(|type )/.exec(line.trim())
    if (!m) continue
    const src = m[1]!
    const at = m[2]!
    const smb = /^\/\/(?:[^@/]*@)?([^/]+)\/(.+)$/.exec(src)
    const nfs = /^([^:/]+):\/?(.*)$/.exec(src)
    const hit = smb ?? nfs
    if (!hit) continue
    let share = hit[2]!.replace(/\/+$/, '')
    try {
      share = decodeURIComponent(share)
    } catch {
      // как есть
    }
    list.push({ server: hit[1]!.toLowerCase(), share, at })
  }
  return list
}

/** Сервер монтирования — эта машина: имя до первой точки (`mini._smb._tcp.local` → `mini`) или целиком. */
function serverIs(server: string, names: readonly string[]): boolean {
  const s = server.toLowerCase()
  const head = s.split('.')[0]!
  return names.some((n) => {
    const x = n.toLowerCase()
    return x === s || x === head || x.split('.')[0] === head
  })
}

/**
 * Путь файла машины-источника — у машины-устройства через монтирование: шара `share` —
 * хвост каталога на источнике (`smith` ← `/Users/smith`), значит `/Users/smith/a/b`
 * у устройства — `<at>/a/b`. Кандидаты по всем подходящим монтированиям, длиннее шара — раньше.
 */
export function mountedPaths(path: string, mounts: readonly MountEntry[], names: readonly string[]): string[] {
  const out: Array<{ p: string; len: number }> = []
  const segs = path.split('/').filter(Boolean)
  for (const m of mounts) {
    if (!serverIs(m.server, names)) continue
    const share = m.share.split('/').filter(Boolean)
    if (!share.length) continue
    for (let i = 0; i + share.length <= segs.length; i++) {
      if (share.every((x, k) => segs[i + k] === x)) {
        const rest = segs.slice(i + share.length)
        out.push({ p: [m.at.replace(/\/+$/, ''), ...rest].join('/'), len: share.length })
        break
      }
    }
  }
  return out.sort((a, b) => b.len - a.len).map((x) => x.p)
}

/**
 * Роутинг по `host=`: нет хоста или свой (`local.capability().files.host`) — свой слой как
 * раньше; хост реестра — его {@link RemoteHost}; чужой — `not_found`.
 *
 * v1.54 (link-resolver-spec §6): `locate` — `stat` пути на всех хостах параллельно; действия
 * хоста `{host, on}` — открыть файл хоста `host` на машине `on` её агентом (`open`, macOS):
 * файл той же машины — на месте; смонтирован у `on` (`mount`) — по локальному пути; иначе —
 * копия в `~/Downloads/nr/<host>/` машины `on` и открыть её.
 */
export function createHostsRouter(local: ExternalHost, remotes: readonly RemoteHost[], ropts: HostsRouterOptions = {}): HostsRouter {
  const hub = local.capability().files.host
  const byName = new Map(remotes.filter((r) => r.name !== hub).map((r) => [r.name, r]))
  const hubHome = ropts.hubHome?.length ? ropts.hubHome : [homedir()]
  const apps = ropts.apps ?? { zed: 'Zed' }
  const locateTimeout = ropts.locateTimeoutMs ?? 4000
  let hubAgent: RemoteHost | null = null
  const agentOfHub = (): RemoteHost => (hubAgent ??= (ropts.hubAgent ?? (() => createLocalAgentHost(hub ?? 'hub')))())
  const isHub = (h: string | undefined): boolean => h === undefined || h === '' || h === hub
  const remoteOf = (o?: ExternalOpts): RemoteHost | null => {
    const h = o?.host
    if (h === undefined || h === '' || h === hub) return null
    const r = byName.get(h)
    if (!r) throw fail('not_found', `хост «${h}» этим бэкендом не обслуживается`)
    return r
  }
  const strip = <T extends ExternalOpts | undefined>(o: T): T => {
    if (!o) return o
    const { host: _h, ...rest } = o
    return rest as T
  }
  const need = <T>(fn: T | undefined, op: string): T => {
    if (!fn) throw fail('not_supported', `files.external.${op}`)
    return fn
  }
  /** Машины, где действия хоста идут их агентом: удалённые с macOS (ОС из реестра или от агента). */
  const darwinRemotes = (): string[] => [...byName.values()].filter((r) => r.info().os === 'darwin').map((r) => r.name)
  const namesOf = (h: string | undefined): string[] => (isHub(h) ? [hub ?? '', ...(ropts.hubAliases ?? [])].filter(Boolean) : [...(byName.get(h!)?.aliases ?? [h!])])

  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((ok, bad) => {
      const t = setTimeout(() => bad(fail('timeout', 'нет ответа')), ms)
      t.unref?.()
      p.then(
        (v) => {
          clearTimeout(t)
          ok(v)
        },
        (e) => {
          clearTimeout(t)
          bad(e)
        },
      )
    })

  /** Действие на машине `on` (не хаб) для файла хоста `host`. */
  async function actOn(kind: 'reveal' | 'open', raw: string, o: { app?: string; host?: string; on: string; dryRun?: boolean }): Promise<HostActionResult> {
    const dev = byName.get(o.on)
    if (!dev) throw fail('not_found', `машины «${o.on}» в реестре нет`)
    if (dev.info().os !== 'darwin') throw fail('not_supported', `действия хоста на «${o.on}» — только macOS`)
    if (o.app !== undefined && !Object.hasOwn(apps, o.app)) throw fail('bad_request', `приложения «${o.app}» нет в $host_apps стенда`)
    const argsOf = (p: string): string[] => (kind === 'reveal' ? ['-R', p] : o.app === undefined ? [p] : ['-a', apps[o.app]!, p])
    const fileHost = isHub(o.host) ? hub : o.host
    const run = async (p: string, via: HostActionResult['via']): Promise<HostActionResult> => {
      const r: HostActionResult = { on: o.on, path: p, via, cmd: 'open', args: argsOf(p) }
      if (!o.dryRun) {
        const res = await dev.exec('open', r.args!, { timeout: 15_000 })
        if (res.code !== 0) throw fail('host_error', `open на «${o.on}»: ${res.stderr.trim() || `код ${res.code}`}`)
      }
      return r
    }
    if (fileHost === o.on) return run(raw, 'direct')
    // Файл другой машины: смонтирован у устройства — по локальному пути.
    const src = isHub(o.host) ? null : byName.get(o.host!)
    const st = src ? await src.files.stat(raw) : await local.stat(raw)
    if (!st.exists) throw fail('not_found', `файла нет: ${st.path}`)
    try {
      const mounts = parseMounts((await dev.exec('mount', [], { timeout: 5000 })).stdout)
      for (const cand of mountedPaths(st.path, mounts, namesOf(o.host))) {
        const there = await dev.files.stat(cand).catch(() => null)
        if (there?.exists) return run(there.path, 'mount')
      }
    } catch {
      // нет `mount` — значит качаем
    }
    // Иначе — копия в ~/Downloads/nr/<хост>/ устройства.
    const downloads = (await dev.files.stat('~/Downloads')).path
    const name = st.path.replace(/\/+$/, '').split('/').pop() || 'file'
    const to = `${downloads}/nr/${fileHost ?? 'hub'}/${name}`
    if (!o.dryRun) {
      await dev.mkdir(to.slice(0, to.lastIndexOf('/')))
      const res = await transferAcross(src ?? agentOfHub(), dev, [{ from: st.path, to }], { overwrite: true })
      if (res.failed.length) throw fail('host_error', `не скачалось на «${o.on}»: ${res.failed[0]!.error}`)
    }
    return run(to, 'download')
  }

  /** Действие на хабе для файла удалённого хоста: смонтирован у хаба — на месте, иначе копия в ~/Downloads/nr/<хост>/. */
  async function actOnHub(kind: 'reveal' | 'open', raw: string, o: { app?: string; host: string; dryRun?: boolean }): Promise<HostActionResult> {
    const h = local.host
    if (!h) throw fail('not_supported', 'host.open')
    const src = byName.get(o.host)
    if (!src) throw fail('not_found', `хост «${o.host}» этим бэкендом не обслуживается`)
    const st = await src.files.stat(raw)
    if (!st.exists) throw fail('not_found', `файла нет: ${st.path}`)
    const go = async (p: string, via: HostActionResult['via']): Promise<HostActionResult> => {
      const c = kind === 'reveal' ? await h.reveal(p, { dryRun: o.dryRun === true }) : await h.open(p, { ...(o.app !== undefined ? { app: o.app } : {}), dryRun: o.dryRun === true })
      return { ...(hub ? { on: hub } : {}), path: p, via, cmd: c.cmd, args: c.args }
    }
    try {
      const agent = agentOfHub()
      const mounts = parseMounts((await agent.exec('mount', [], { timeout: 5000 })).stdout)
      for (const cand of mountedPaths(st.path, mounts, namesOf(o.host))) {
        const there = await local.stat(cand).catch(() => null)
        if (there?.exists) return go(there.path, 'mount')
      }
    } catch {
      // качаем
    }
    const downloads = join(homedir(), 'Downloads', 'nr', o.host)
    const to = join(downloads, st.path.replace(/\/+$/, '').split('/').pop() || 'file')
    if (!o.dryRun) {
      await mkdir(downloads, { recursive: true })
      const res = await transferAcross(src, agentOfHub(), [{ from: st.path, to }], { overwrite: true })
      if (res.failed.length) throw fail('host_error', `не скачалось: ${res.failed[0]!.error}`)
    }
    return go(to, 'download')
  }

  const hostOps = (): ExternalHost['host'] => {
    const h = local.host
    if (!h && byName.size === 0) return null
    const act = (kind: 'reveal' | 'open') => async (raw: string, o?: { app?: string; dryRun?: boolean; host?: string; on?: string }): Promise<HostCommand> => {
      if (o?.on && !isHub(o.on)) return actOn(kind, raw, { ...o, on: o.on }) as Promise<HostCommand>
      if (!isHub(o?.host)) return actOnHub(kind, raw, { ...o, host: o!.host! }) as Promise<HostCommand>
      if (!h) throw fail('not_supported', `host.${kind}`)
      return kind === 'reveal' ? h.reveal(raw, { dryRun: o?.dryRun === true }) : h.open(raw, { ...(o?.app !== undefined ? { app: o.app } : {}), dryRun: o?.dryRun === true })
    }
    return { reveal: act('reveal'), open: act('open') }
  }

  return {
    remotes: byName,
    capability() {
      const base = local.capability()
      const f: ExternalFilesCapability & { external: true } = base.files
      const hubInfo: ExternalHostInfo = { name: hub ?? '', hub: true, state: 'ok', os: process.platform, home: [...hubHome] }
      const infos = [hubInfo, ...[...byName.values()].map((r) => r.info())]
      const on = darwinRemotes()
      const host: HostCapability | undefined = base.host
        ? { ...base.host, ...(on.length ? { on } : {}) }
        : on.length
          ? { open: true, apps: Object.keys(apps), on }
          : undefined
      return {
        files: { ...f, disk: true, locate: true, hosts: infos.map((i) => i.name), hostsInfo: infos },
        ...(host ? { host } : {}),
      }
    },
    async probe() {
      await Promise.all([...byName.values()].map((r) => r.connect().catch(() => {})))
    },
    close() {
      for (const r of byName.values()) r.close()
      hubAgent?.close()
    },
    stat: (p, o) => remoteOf(o)?.files.stat(p) ?? local.stat(p, o),
    read: (p, o) => remoteOf(o)?.files.read(p, strip(o)) ?? local.read(p, o),
    list: (p, o) => remoteOf(o)?.files.list(p) ?? local.list(p, o),
    ...(local.write
      ? {
          write: (p: string, c: string, o?: FileWriteOpts & ExternalOpts) => remoteOf(o)?.files.write(p, c, strip(o)) ?? need(local.write, 'write')(p, c, o),
          mkdir: (p: string, o?: ExternalOpts) => remoteOf(o)?.files.mkdir(p) ?? need(local.mkdir, 'mkdir')(p, o),
          rename: (a: string, b: string, o?: ExternalOpts) => remoteOf(o)?.files.rename(a, b) ?? need(local.rename, 'rename')(a, b, o),
          delete: (p: string, o?: ExternalOpts & { permanent?: boolean }) => remoteOf(o)?.files.delete(p, strip(o)) ?? need(local.delete, 'delete')(p, o),
          copy: (a: string, b: string, o?: ExternalOpts & { overwrite?: boolean }) => remoteOf(o)?.files.copy(a, b, strip(o)) ?? need(local.copy, 'copy')(a, b, o),
        }
      : {}),
    search: (p, q, o) => remoteOf(o)?.files.search(p, q) ?? need(local.search, 'search')(p, q, o),
    watch: (p, l, o) => {
      const r = remoteOf(o)
      return r ? r.files.watch(p, l, strip(o)) : need(local.watch, 'watch')(p, l, o)
    },
    async disk(p, o) {
      const r = remoteOf(o)
      if (r) return r.files.disk(p)
      return need(local.disk, 'disk')(p, o)
    },
    thumb: (p, px, o) => remoteOf(o)?.thumb(p, px) ?? local.thumb(p, px, o),
    async openRaw(p, o) {
      const r = remoteOf(o)
      return r ? r.openRaw(p, o?.range) : null
    },
    async locate(p) {
      const ask = async (fn: () => Promise<ExternalFileStat>, host: string | undefined): Promise<ExternalFileStat | null> => {
        try {
          const st = await withTimeout(fn(), locateTimeout)
          return st.exists ? { ...st, ...(host ? { host } : {}) } : null
        } catch {
          return null // закрыт, нет связи, молчит — мимо
        }
      }
      const all = await Promise.all([ask(() => local.stat(p), hub), ...[...byName.values()].map((r) => ask(() => r.files.stat(p), r.name))])
      return all.filter((x): x is ExternalFileStat => x !== null)
    },
    host: hostOps(),
  }
}
