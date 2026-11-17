/**
 * Хаб (users-spec §1, протокол v1.29): один `ProtocolBackend`, к которому ходит
 * фронт; сессии исполняют движки за ним.
 *
 *  - встроенный движок (`local`, стенд nr) — его capabilities, проекты, сервисы,
 *    профили и каталоги — лицо хаба;
 *  - подключённые движки (`engines`: ACP, pi — отдельные процессы, тем же
 *    протоколом через `createHttpBackend`) — исполнители своих сессий;
 *  - индекс: `sessions.list` — сессии всех движков с `SessionInfo.engine`.
 *    Движок с каталогом сессий (`sessionsDir`, `.mds` nr-chat) читается с диска —
 *    его сессии видны и когда он лежит (`engineUnavailable`); без каталога —
 *    по сети, лежит — последний известный список;
 *  - операции над сессией (history, run, cancel, respond, messages, meta,
 *    personas, attachments, models.set, profiles.set, fork, rename, delete) —
 *    движку сессии, стрим проксируется как есть;
 *  - `sessions.create({engine})` — `engine` → `$engine` проекта → `defaultEngine`
 *    → встроенный;
 *  - `sessions.setEngine` — лента каноническая: `<id>.mds` и `<id>.assets/`
 *    переезжают в каталог нового движка (id тот же), в ленту — скрытая от
 *    контекста заметка «исполнитель: a → b». Новый движок получает ленту
 *    пересобранной под себя сам (ACP — транскрипт из ленты).
 *
 * Сервисы, скины, плагины, проекты, профили — у встроенного движка. Модели —
 * общим каталогом: модели подключённых движков помечены `ModelInfo.engine`.
 */

import { existsSync } from 'node:fs'
import { rename as fsRename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { DEFAULT_PROJECT_ID, NotSupportedError, archivePatch, historyWindow, isArchivedSession, isParallelRun, pageSessions, pickArchived } from '@kerneldreams/ui-protocol'
import type {
  AnyRunEvent,
  Capabilities,
  EngineCapsOverride,
  EngineInfo,
  ExternalPluginInfo,
  PluginChangedListener,
  PluginFile,
  PluginsSource,
  ProfileDoc,
  ProfileInfo,
  ProfilesListOpts,
  ProjectInfo,
  ServiceEvent,
  ModelInfo,
  ProtocolBackend,
  RunStartInput,
  SessionCreateOpts,
  SessionInfo,
  SessionListOpts,
  SessionMoveInput,
  SessionRun,
  Part,
  WorkspaceInfo,
} from '@kerneldreams/ui-protocol'
import { hasRunAttach, withRunAttach } from './run-attach.js'
import { withSessionActivity } from './session-activity.js'

/** Подключённый движок хаба. */
export interface HubEngine {
  /** `acp`, `pi`, … — значение `SessionInfo.engine`. */
  id: string
  /** Подпись в UI. */
  name?: string
  /** Бэкенд движка — обычно `createHttpBackend(url)`; в тестах — объект в процессе. */
  backend: ProtocolBackend
  /**
   * База HTTP движка (как у `createHttpBackend`): файлы его внешних плагинов
   * (`/plugins/<id>/…`) хаб отдаёт фронту прокси (`createHubPlugins`). Нет —
   * плагины движка фронту не видны.
   */
  url?: string
  /**
   * Каталог `.mds` сессий движка (nr-chat): индекс с диска (сессии видны, когда
   * движок лежит) и `setEngine` (лента переезжает файлом). Нет — индекс по сети,
   * смены исполнителя у движка нет.
   */
  sessionsDir?: string
  /**
   * Служебный движок (v1.61): новых чатов на нём не заводят и сессии на него
   * не переводят — хаб задач Claude Code, его сессии создаёт хост задач. Сессии видны,
   * открываются и продолжаются как у всех.
   */
  create?: false
}

export interface HubOpts {
  /** Встроенный движок — стенд, в котором живёт хаб. */
  local: ProtocolBackend
  /** Id встроенного движка; default `nr`. */
  localId?: string
  localName?: string
  /** Каталог сессий встроенного движка (nr-chat) — для `setEngine`. */
  localSessionsDir?: string
  engines: HubEngine[]
  /** `$engine` стенда — движок новой сессии без выбора; default — встроенный. */
  defaultEngine?: string
  /** Таймаут проверки движка, мс (default 5000). Отказ гасит движок сразу, таймаут — со второй пробы подряд. */
  probeTimeoutMs?: number
  /** Сколько верить прошлой проверке, мс (default 5000). */
  probeTtlMs?: number
  /**
   * Сколько хаб ждёт список сессий сетевого движка, мс (default 700): медленный
   * движок не держит весь список — отдаётся его прошлый список, опоздавший ответ ложится
   * в него же для следующего запроса. Прошлый список уже есть — ждём лишь `min(100, это)`
   * (быстрый движок успевает, медленный не тормозит).
   */
  listTimeoutMs?: number
  /** Диагностика; default — stderr. */
  log?: (msg: string) => void
}

/** Ошибка хаба с кодом провода. */
export class HubError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_request' | 'busy' | 'conflict' | 'not_found' | 'engine_unavailable',
  ) {
    super(`hub: ${message}`)
    this.name = 'HubError'
  }
}

/** Код ошибки «движок недоступен» (500-класс с кодом в теле). */
export const ENGINE_UNAVAILABLE_CODE = 'engine_unavailable'

interface EngineState {
  id: string
  name?: string
  backend: ProtocolBackend
  sessionsDir?: string
  local: boolean
  available: boolean
  checkedAt: number
  /** Проб подряд, упавших по таймауту: живой движок гаснет со второй (медленный ответ ≠ лёг). */
  slow?: number
  /** Последние capabilities движка (проверка доступности): отличия от стенда, сервисы, плагины. */
  caps?: Capabilities
  /** Последний список по сети (движок без каталога): лежит — отдаём его. */
  lastList?: SessionInfo[]
  /** Идущий запрос списка по сети (без `workspace`) — второй запрос не плодит третий. */
  listing?: Promise<SessionInfo[]>
  /** Стор каталога — только чтение для индекса. */
  disk?: ReturnType<typeof createNrChatStore>
  /**
   * Индекс каталога (run-resume-spec §3): перескан — по событию через хаб
   * (create/delete/fork/setEngine/конец рана), `?refresh=1` или сменившемуся
   * mtime каталога; иначе — прошлый список.
   */
  diskList?: { sessions: SessionInfo[]; dirMtime: number }
  /** Служебный движок: новых чатов нет (`HubEngine.create`). */
  create?: false
}

export function createHub(given: HubOpts): ProtocolBackend {
  // Встроенный движок исполняет раны в процессе хаба — подхват идущего рана (v1.31) здесь же.
  const opts: HubOpts = { ...given, local: hasRunAttach(given.local) ? given.local : withRunAttach(given.local) }
  const log = opts.log ?? ((m: string) => void process.stderr.write(`hub: ${m}\n`))
  const localId = opts.localId ?? 'nr'
  const probeTimeout = opts.probeTimeoutMs ?? 5000
  const probeTtl = opts.probeTtlMs ?? 5000
  const listTimeout = opts.listTimeoutMs ?? 700
  const local: EngineState = {
    id: localId,
    ...(opts.localName ? { name: opts.localName } : {}),
    backend: opts.local,
    ...(opts.localSessionsDir ? { sessionsDir: opts.localSessionsDir } : {}),
    local: true,
    available: true,
    checkedAt: Number.POSITIVE_INFINITY,
  }
  const engines = new Map<string, EngineState>([[localId, local]])
  for (const e of opts.engines) {
    if (engines.has(e.id)) throw new Error(`hub: движок ${e.id} заявлен дважды`)
    engines.set(e.id, {
      id: e.id,
      ...(e.name ? { name: e.name } : {}),
      backend: e.backend,
      ...(e.sessionsDir ? { sessionsDir: e.sessionsDir, disk: createNrChatStore({ dir: e.sessionsDir, indexFile: join(e.sessionsDir, '.list-index.hub.json') }) } : {}),
      ...(e.create === false ? { create: false as const } : {}),
      local: false,
      available: false,
      checkedAt: 0,
    })
  }
  const defaultEngine = opts.defaultEngine && engines.has(opts.defaultEngine) ? opts.defaultEngine : localId
  if (opts.defaultEngine && !engines.has(opts.defaultEngine)) log(`$engine ${opts.defaultEngine}: нет такого движка — по умолчанию ${localId}`)

  /** id сессии → движок. */
  const index = new Map<string, string>()
  /** Сессии с живым раном через хаб — `setEngine` посреди рана нельзя. */
  const running = new Set<string>()
  /** Идущие раны подключённых движков, прошедшие через хаб (`SessionInfo.run` индекса с диска). */
  const runs = new Map<string, SessionRun>()

  /** Индекс каталога движка устарел — следующий список перечитает. */
  const dirty = (e: EngineState | undefined): void => {
    if (e) delete e.diskList
  }
  const dirMtime = async (dir: string): Promise<number> => (await stat(dir).catch(() => undefined))?.mtimeMs ?? 0
  async function diskSessions(e: EngineState, refresh: boolean): Promise<SessionInfo[]> {
    const m = await dirMtime(e.sessionsDir!)
    if (!refresh && e.diskList && e.diskList.dirMtime === m) return e.diskList.sessions
    const sessions = (await e.disk!.list()).sessions as SessionInfo[]
    e.diskList = { sessions, dirMtime: m }
    return sessions
  }
  const withHubRun = (s: SessionInfo): SessionInfo => {
    const r = runs.get(s.id)
    return r && !s.run ? { ...s, run: r } : s
  }

  // ── доступность ───────────────────────────────────────────────────────────

  async function probe(e: EngineState, force = false): Promise<boolean> {
    if (e.local) return true
    if (!force && Date.now() - e.checkedAt < probeTtl) return e.available
    let timer: ReturnType<typeof setTimeout> | undefined
    const res = await Promise.race<boolean | 'timeout'>([
      e.backend.capabilities().then(
        (c) => {
          e.caps = c
          return true
        },
        () => false,
      ),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), probeTimeout)
      }),
    ])
    if (timer) clearTimeout(timer)
    // Таймаут — не смерть: залипший event loop самого хаба срабатывал таймером раньше
    // ответа и метал живой движок в «недоступен». Лежащим делает только ошибка связи.
    e.slow = res === 'timeout' ? (e.slow ?? 0) + 1 : 0
    if (res === 'timeout') {
      e.checkedAt = Date.now()
      return e.available
    }
    const ok = res === true
    if (ok !== e.available) log(`движок ${e.id}: ${ok ? 'доступен' : 'недоступен'}`)
    e.available = ok
    e.checkedAt = Date.now()
    return ok
  }

  /** Ошибка связи с движком — пометить лежащим (следующая проверка — по TTL). */
  function noteFailure(e: EngineState, err: unknown): void {
    if (e.local) return
    const code = (err as { code?: unknown } | null)?.code
    if (code === 'connection_lost' || code === 'ECONNREFUSED') {
      e.available = false
      e.checkedAt = Date.now()
    }
  }

  function engineById(id: string): EngineState {
    const e = engines.get(id)
    if (!e) throw new HubError(`нет движка ${id} (есть: ${[...engines.keys()].join(', ')})`, 'bad_request')
    return e
  }

  async function requireAvailable(e: EngineState): Promise<void> {
    if (!(await probe(e))) throw new HubError(`движок ${e.name ?? e.id} недоступен`, ENGINE_UNAVAILABLE_CODE)
  }

  // ── индекс ────────────────────────────────────────────────────────────────

  const tag = (s: SessionInfo, e: EngineState): SessionInfo => ({ ...s, engine: e.id, ...(e.available ? {} : { engineUnavailable: true }) })

  /**
   * Сессии пространства (v1.35, spaces-spec §1): его id и `$aliases`; сессии
   * алиаса без `project` — проект по `$root` старой записи (как у встроенного).
   * `ws` нет — все сессии, у сессий алиасов дописан проект.
   */
  async function spaceFilter(ws: string | undefined): Promise<(list: SessionInfo[]) => Promise<SessionInfo[]>> {
    const w = opts.local.workspace
    const spaces = w ? await w.list().catch(() => [] as WorkspaceInfo[]) : []
    const ownerOf = (sw: string): string | undefined => spaces.find((x) => x.id !== sw && x.project?.aliases?.includes(sw))?.id
    const aliases = ws === undefined ? [] : (spaces.find((x) => x.id === ws)?.project?.aliases ?? [])
    const anyAlias = spaces.some((x) => x.project?.aliases?.length)
    if (ws !== undefined && !aliases.length) return async (list) => list.filter((s) => (s.workspace || DEFAULT_PROJECT_ID) === ws)
    if (ws === undefined && !anyAlias) return async (list) => list
    const ids = new Set(ws === undefined ? [] : [ws, ...aliases])
    const repos = new Map<string, ProjectInfo[]>()
    return async (list) => {
      const out: SessionInfo[] = []
      for (const s of list) {
        const sw = s.workspace || DEFAULT_PROJECT_ID
        if (ws !== undefined && !ids.has(sw)) continue
        const space = ws === undefined ? ownerOf(sw) : sw === ws ? undefined : ws
        if (s.project || !space) {
          out.push(s)
          continue
        }
        if (!repos.has(space)) repos.set(space, w?.repos ? await w.repos({ workspace: space }).catch(() => []) : [])
        const root = spaces.find((x) => x.id === sw)?.path
        const repo = root ? repos.get(space)!.find((r) => r.root === root.replace(/\/+$/, '')) : undefined
        out.push(repo ? { ...s, project: repo.id } : s)
      }
      return out
    }
  }

  async function listOf(e: EngineState, listOpts: SessionListOpts | undefined): Promise<SessionInfo[]> {
    const ws = listOpts?.workspace
    // Архивные (v1.55) движки отдают все: индекс хаба знает и их, фильтр — в `listAll`.
    const wsOpts: SessionListOpts = { ...(ws ? { workspace: ws } : {}), archived: true }
    if (e.local) return e.backend.sessions.list(wsOpts)
    await probe(e, listOpts?.refresh === true)
    const pick = await spaceFilter(ws)
    if (e.disk) return pick((await diskSessions(e, listOpts?.refresh === true)).map(withHubRun))
    if (!e.available) return pick(e.lastList ?? [])
    const STALE = Symbol('stale')
    // Список тянется в фоне и ложится в lastList сам — даже опоздав к ответу.
    const fetching =
      (!ws && e.listing) ||
      (async () => {
        const got = await e.backend.sessions.list(wsOpts)
        if (!ws) e.lastList = got
        else e.lastList = [...(e.lastList ?? []).filter((s) => (s.workspace || DEFAULT_PROJECT_ID) !== ws), ...got]
        return got
      })()
    if (!ws) {
      e.listing = fetching
      const clear = (): void => {
        if (e.listing === fetching) delete e.listing
      }
      fetching.then(clear, clear)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const got = await Promise.race([
        fetching,
        new Promise<typeof STALE>((resolve) => {
          timer = setTimeout(() => resolve(STALE), e.lastList ? Math.min(100, listTimeout) : listTimeout)
        }),
      ])
      if (got === STALE) {
        fetching.catch((err) => noteFailure(e, err))
        log(`движок ${e.id}: список медленный — отдан прошлый (${e.lastList?.length ?? 0})`)
        return pick(e.lastList ?? [])
      }
      return got
    } catch (err) {
      noteFailure(e, err)
      log(`движок ${e.id}: список сессий не получен — ${(err as Error)?.message ?? err}`)
      return pick(e.lastList ?? [])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function listAll(listOpts?: SessionListOpts): Promise<SessionInfo[]> {
    const seen = new Set<string>()
    const out: SessionInfo[] = []
    // При совпадении id сессия — движка-хозяина файла (П-21): сетевой движок без
    // каталога nr-chat (pi) — первым, встроенный — за ним. Встроенный читает старый
    // каталог pi как легаси (только чтение) — сессию, которую пишет живой pi, он не
    // забирает: ход, форк и удаление идут в pi.
    const order = [...engines.values()].sort((a, b) => rank(a) - rank(b))
    const parts = await Promise.all(order.map(async (e) => ({ e, list: await listOf(e, listOpts).catch((err) => (log(`движок ${e.id}: ${(err as Error)?.message ?? err}`), [] as SessionInfo[])) })))
    for (const { e, list } of parts) {
      for (const s of list) {
        if (seen.has(s.id)) continue
        seen.add(s.id)
        index.set(s.id, e.id)
        out.push(tag(s, e))
      }
    }
    out.sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))
    // Поиск и окно (v1.57) — после слияния движков: движкам их не передаём.
    return pageSessions(pickArchived(out, listOpts?.archived), listOpts)
  }

  /**
   * Запущенные сессии всех движков (v1.38): у каждого — его `sessions.live` (идущие раны
   * и живые процессы агентов); раны подключённых, прошедшие через хаб, — сверху, если
   * движок их не назвал. Движок лежит — его сессий в списке нет.
   */
  async function liveAll(): Promise<SessionInfo[]> {
    const parts = await Promise.all(
      [...engines.values()].map(async (e) => {
        if (!e.local && !(await probe(e))) return [] as SessionInfo[]
        const b = e.backend
        const can = !!b.sessions.live && (e.local || e.caps?.sessions?.live === true)
        const list: SessionInfo[] = can ? await call(e, () => b.sessions.live!()).catch((err) => (log(`движок ${e.id}: live: ${(err as Error)?.message ?? err}`), [] as SessionInfo[])) : []
        if (!e.local) {
          for (const [id, r] of runs) {
            if (index.get(id) !== e.id || list.some((s) => s.id === id)) continue
            const s = await b.sessions.get(id).catch(() => undefined)
            if (s) list.push({ ...s, run: s.run ?? r })
          }
        }
        return list.map((s) => {
          index.set(s.id, e.id)
          return tag(s, e)
        })
      }),
    )
    const seen = new Set<string>()
    const out = parts.flat().filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    // Сначала идущие ходы (дольше идёт — выше), потом простаивающие процессы.
    const key = (s: SessionInfo): string => (s.run ? `0${s.run.startedAt}` : `1${s.process?.idleSince ?? ''}`)
    return out.sort((a, b) => key(a).localeCompare(key(b)))
  }

  /** Приоритет движка при совпадении id в индексе: сетевой без каталога → встроенный → с каталогом. */
  const rank = (e: EngineState): number => (e.local ? 1 : e.sessionsDir ? 2 : 0)

  /** Движок сессии: индекс → файл в каталогах → полный список. Нигде — встроенный (он и ответит `not_found`). */
  async function engineOf(sid: string): Promise<EngineState> {
    const known = index.get(sid)
    if (known) return engines.get(known)!
    for (const e of engines.values()) {
      if (e.sessionsDir && existsSync(join(e.sessionsDir, `${sid}.mds`))) {
        index.set(sid, e.id)
        return e
      }
    }
    await listAll({ archived: true })
    return engines.get(index.get(sid) ?? localId)!
  }

  /** Бэкенд движка сессии; движок лежит — ошибка до вызова. */
  async function route(sid: string): Promise<{ e: EngineState; b: ProtocolBackend }> {
    const e = await engineOf(sid)
    await requireAvailable(e)
    return { e, b: e.backend }
  }

  /** Вызов на движке с пометкой при обрыве связи. */
  async function call<T>(e: EngineState, f: () => Promise<T>): Promise<T> {
    try {
      return await f()
    } catch (err) {
      noteFailure(e, err)
      throw err
    }
  }

  function unsupported(op: string): never {
    throw new NotSupportedError(op)
  }

  // ── create ────────────────────────────────────────────────────────────────

  /** Проект новой сессии (реестр встроенного): `$engine`, `$agent`. */
  async function projectOf(workspace: string | undefined): Promise<WorkspaceInfo | undefined> {
    const ws = opts.local.workspace
    if (!ws) return undefined
    try {
      const id = workspace ?? (await ws.current()).id
      return (await ws.list()).find((w) => w.id === id)
    } catch {
      return undefined
    }
  }

  // ── агенты (agents-spec §3) ──────────────────────────────────────
  //
  // «Профиль на проводе = агент». Каталог один на все движки: встроенный
  // первым, у подключённых — только то, чего нет у предыдущих (старые слепки
  // ACP), с пометкой `engine` их движка. Движку, у которого агента нет, хаб
  // передаёт документ агента — не сбрасывает выбор.

  const wsOpts = (workspace: string | undefined): ProfilesListOpts | undefined => (workspace ? { workspace } : undefined)
  const enginesInOrder = (): EngineState[] => [engineById(localId), ...[...engines.values()].filter((x) => !x.local)]

  /** Каталог движка; подключённый лежит или отказал — пусто. Встроенный — как есть (его отказ — отказ). */
  async function profilesOf(e: EngineState, workspace: string | undefined): Promise<ProfileInfo[]> {
    if (!e.backend.profiles) return []
    if (e.local) return e.backend.profiles.list(wsOpts(workspace))
    if (!(await probe(e))) return []
    try {
      return await e.backend.profiles.list(wsOpts(workspace))
    } catch (err) {
      noteFailure(e, err)
      return []
    }
  }

  async function agentsList(workspace: string | undefined): Promise<ProfileInfo[]> {
    const lists = await Promise.all(enginesInOrder().map(async (e) => ({ e, list: await profilesOf(e, workspace) })))
    const seen = new Set<string>()
    const out: ProfileInfo[] = []
    for (const { e, list } of lists) {
      for (const p of list) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        out.push(e.local ? p : ({ ...p, engine: p.engine ?? e.id } as ProfileInfo))
      }
    }
    return out
  }

  /** Документ агента у того движка, где он есть (кроме `skip`); `source` — чтобы движок встроил его под id. */
  async function agentDoc(id: string, workspace: string | undefined, skip?: EngineState): Promise<ProfileDoc | undefined> {
    for (const e of enginesInOrder()) {
      if (e === skip || !e.backend.profiles?.get) continue
      try {
        if (!(await profilesOf(e, workspace)).some((p) => p.id === id)) continue
        const doc = await e.backend.profiles.get(id, wsOpts(workspace))
        return { ...doc, source: doc.source ?? 'legacy' }
      } catch (err) {
        if (!e.local) noteFailure(e, err)
      }
    }
    return undefined
  }

  /**
   * Новая сессия: агент — явный, иначе `$agent` проекта; движок — явный →
   * `engine` агента → `$engine` проекта → дефолт. Агента нет у движка —
   * документ; модели нет у движка — модель движка и заметка в ленте.
   */
  async function create(input?: SessionCreateOpts): Promise<SessionInfo> {
    const { engine: want, ...rest } = input ?? {}
    const project = await projectOf(rest.workspace)
    // Проект пространства (v1.35): его `$agent` (`.nrchat/project.mdz`) — раньше агента пространства.
    const repo = rest.project && opts.local.workspace?.repos ? (await opts.local.workspace.repos(rest.workspace ? { workspace: rest.workspace } : undefined).catch(() => [] as ProjectInfo[])).find((r) => r.id === rest.project) : undefined
    const agentId = typeof rest.profile === 'string' ? rest.profile : rest.profile === undefined ? (repo?.agent ?? project?.project?.profile) : undefined
    const agent = agentId && agentId !== 'default' ? (await agentsList(rest.workspace).catch(() => [] as ProfileInfo[])).find((p) => p.id === agentId) : undefined
    let id = want ?? agent?.engine ?? project?.project?.engine ?? defaultEngine
    if (!want && !engines.has(id)) {
      log(`движок ${id} (агент ${agent?.id ?? '—'} / $engine проекта): нет такого движка — ${defaultEngine}`)
      id = defaultEngine
    }
    // Служебный движок (хаб задач) — только явным выбором; от агента и проекта — дефолт.
    if (!want && engines.get(id)?.create === false) id = defaultEngine
    const e = engineById(id)
    await requireAvailable(e)
    const createOpts: SessionCreateOpts = { ...rest }
    // `$agent` проекта — явным выбором: тогда движок без этого агента получит документ.
    if (createOpts.profile === undefined && agent) createOpts.profile = agent.id
    let dropped: string | undefined
    // Пустой каталог (пробная сессия агента упала) — модель как есть: движок примет любую.
    const models = await e.backend.models?.list().catch(() => [] as ModelInfo[])
    const knows = (id: string): boolean => !models?.length || models.some((m) => m.id === id)
    if (createOpts.model && !knows(createOpts.model.model)) {
      dropped = createOpts.model.model
      delete createOpts.model
    }
    if (typeof createOpts.profile === 'string' && createOpts.profile !== 'default') {
      const own = await profilesOf(e, rest.workspace)
      const mine = own.find((p) => p.id === createOpts.profile)
      // Модели агента нет у движка (агент «под» другой движок) — документом без
      // модели: движок возьмёт свою, в ленте заметка (agents-spec §5).
      const foreignModel = !createOpts.model && (mine ?? agent)?.model !== undefined && !knows((mine ?? agent)!.model!) ? (mine ?? agent)!.model : undefined
      if (!mine || foreignModel) {
        const doc = e.backend.profiles ? await agentDoc(createOpts.profile, rest.workspace, foreignModel ? undefined : e) : undefined
        if (doc) {
          if (foreignModel) {
            delete doc.model
            dropped = foreignModel
          }
          createOpts.profile = doc
        } else if (!mine) {
          log(`агент ${createOpts.profile}: ни у одного движка нет — сессия на ${e.id} без агента`)
          delete createOpts.profile
        }
      }
    }
    const info = await call(e, () => e.backend.sessions.create(Object.keys(createOpts).length ? createOpts : undefined))
    index.set(info.id, e.id)
    dirty(e)
    if (dropped) await hiddenNote(e, info.id, `модель ${dropped} недоступна на ${e.name ?? e.id}, взята ${info.model?.model ?? 'модель движка по умолчанию'}`)
    return tag(info, e)
  }

  /** Заметка в ленте, скрытая от контекста (flags.disabled): видна человеку, модели нет. */
  async function hiddenNote(e: EngineState, sid: string, text: string): Promise<void> {
    const msgs = e.backend.messages
    if (!msgs?.append || !msgs.hide) return
    try {
      const note = await msgs.append(sid, [{ type: 'text', text }], { role: 'assistant' })
      await msgs.hide(sid, note.id, true)
    } catch (err) {
      log(`сессия ${sid}: заметка не записана — ${(err as Error)?.message ?? err}`)
    }
  }

  // ── смена исполнителя ─────────────────────────────────────────────────────

  async function setEngine(sid: string, to: string): Promise<SessionInfo> {
    const target = engineById(to)
    const from = await engineOf(sid)
    if (from.id === target.id) return tag(await call(from, () => from.backend.sessions.get(sid)), from)
    if (running.has(sid)) throw new HubError(`сессия ${sid}: идёт ран — смена исполнителя после него`, 'busy')
    if (target.create === false) throw new HubError(`движок ${target.id} служебный — сессии на него не переводят`, 'bad_request')
    if (!from.sessionsDir || !target.sessionsDir) {
      throw new NotSupportedError('sessions.setEngine', `hub: смена исполнителя ${from.id} → ${target.id} — у движка нет каталога сессий nr-chat`)
    }
    await requireAvailable(target)
    const src = join(from.sessionsDir, `${sid}.mds`)
    const dst = join(target.sessionsDir, `${sid}.mds`)
    if (!existsSync(src)) throw new HubError(`сессии ${sid} нет в ${from.sessionsDir} (старый формат? — сначала ход на ${from.id})`, 'not_found')
    if (existsSync(dst)) throw new HubError(`сессия ${sid} уже есть у ${target.id}`, 'conflict')
    await fsRename(src, dst)
    const assets = join(from.sessionsDir, `${sid}.assets`)
    if (existsSync(assets)) await fsRename(assets, join(target.sessionsDir, `${sid}.assets`))
    index.set(sid, target.id)
    dirty(from)
    dirty(target)
    log(`сессия ${sid}: исполнитель ${from.id} → ${target.id}`)
    await hiddenNote(target, sid, `⇄ исполнитель: ${from.id} → ${target.id}`)
    return tag(await call(target, () => target.backend.sessions.get(sid)), target)
  }

  // ── сборка ────────────────────────────────────────────────────────────────

  const localMessages = opts.local.messages

  /** Метод группы на движке сессии; у движка нет — not_supported. */
  /**
   * Ход в архивной сессии возвращает её из архива молча (v1.55): `archived: false` —
   * автоархив её больше не трогает. Мета не читается — не мешает ходу.
   */
  async function unarchive(e: EngineState, b: ProtocolBackend, id: string): Promise<void> {
    if (!b.meta) return
    try {
      const doc = (await b.meta.get(id)) as { archived?: unknown }
      if (!isArchivedSession({ archived: typeof doc.archived === 'string' ? doc.archived : undefined })) return
      await b.meta.patch(id, archivePatch(false))
      dirty(e)
    } catch (err) {
      log(`сессия ${id}: из архива не вернул — ${(err as Error)?.message ?? err}`)
    }
  }

  function routed<G extends keyof ProtocolBackend>(group: G, method: string) {
    return async (sid: string, ...args: unknown[]): Promise<unknown> => {
      const { e, b } = await route(sid)
      const g = b[group] as Record<string, unknown> | undefined
      const f = g?.[method] as ((...a: unknown[]) => Promise<unknown>) | undefined
      if (!f) unsupported(`${String(group)}.${method}`)
      return call(e, () => f.call(g, sid, ...args))
    }
  }

  /** Те же методы, что у встроенного (метод ⇔ capability): маршрут — по сессии. */
  function routeGroup<G extends keyof ProtocolBackend>(group: G, methods: string[]): ProtocolBackend[G] | undefined {
    const g = opts.local[group] as Record<string, unknown> | undefined
    if (!g) return undefined
    const out: Record<string, unknown> = { ...g }
    for (const m of methods) if (typeof g[m] === 'function') out[m] = routed(group, m)
    return out as unknown as ProtocolBackend[G]
  }

  /** Сервисы стенда + движков (у кого слой сервисов): общий id — встроенного. */
  function mergedServices(caps: Capabilities): Capabilities['services'] {
    let out = caps.services
    for (const e of engines.values()) {
      if (e.local || !e.available || !e.caps?.services || !e.backend.services) continue
      for (const [id, d] of Object.entries(e.caps.services)) {
        if (out?.[id]) continue
        out = { ...(out ?? {}), [id]: d }
      }
    }
    return out
  }

  const hub: ProtocolBackend = {
    async capabilities(): Promise<Capabilities> {
      let caps = await opts.local.capabilities()
      await Promise.all([...engines.values()].map((e) => probe(e)))
      const canSwitch = [...engines.values()].filter((e) => e.sessionsDir).length > 1
      // Без каталога `.mds` движок — не цель смены исполнителя (pi, v1.31: `switch: false`).
      const list: EngineInfo[] = [...engines.values()].map((e) => {
        const diff = e.local || !e.caps ? undefined : capsDiff(caps, e.caps)
        return {
          id: e.id,
          ...(e.name ? { name: e.name } : {}),
          ...(e.local ? { local: true } : {}),
          available: e.available,
          ...((canSwitch && !e.sessionsDir) || e.create === false ? { switch: false } : {}),
          ...(e.create === false ? { create: false as const } : {}),
          ...(diff ? { caps: diff } : {}),
        }
      })
      const services = mergedServices(caps)
      // v1.38: список запущенных — у хаба всегда; «погасить процесс» — если умеет хоть один движок.
      const release = !!caps.sessions?.release || [...engines.values()].some((e) => !e.local && e.available && e.caps?.sessions?.release === true)
      // v1.57: окно списка — хаб режет сам после слияния; окно ленты — сам, если движок его не умеет.
      caps = { ...caps, sessions: { ...caps.sessions, live: true, page: true, ...(release ? { release: true } : {}) }, history: { page: true } }
      return { ...caps, ...(services ? { services } : {}), engines: { list, default: defaultEngine, ...(canSwitch ? { switch: true } : {}) } }
    },

    sessions: {
      list: listAll,
      live: liveAll,
      async release(id: string) {
        const { e, b } = await route(id)
        if (!b.sessions.release || (!e.local && e.caps?.sessions?.release !== true)) unsupported('sessions.release')
        await call(e, () => b.sessions.release!(id))
      },
      create,
      async get(id) {
        const { e, b } = await route(id)
        return tag(withHubRun(await call(e, () => b.sessions.get(id))), e)
      },
      async delete(id) {
        const { e, b } = await route(id)
        await call(e, () => b.sessions.delete(id))
        index.delete(id)
        dirty(e)
      },
      // v1.31: подписка на идущий ран — движку сессии (у подключённых — их serveBackend).
      attach(id: string): AsyncIterable<AnyRunEvent> {
        return {
          [Symbol.asyncIterator]() {
            let inner: AsyncIterator<AnyRunEvent> | undefined
            return {
              async next() {
                if (!inner) {
                  const { e, b } = await route(id)
                  if (!b.sessions.attach) return { done: true, value: undefined }
                  try {
                    inner = b.sessions.attach(id)[Symbol.asyncIterator]()
                  } catch (err) {
                    noteFailure(e, err)
                    throw err
                  }
                }
                return inner.next()
              },
              async return(value?: unknown) {
                await inner?.return?.(value as never)
                return { done: true, value: undefined as never }
              },
            }
          },
        }
      },
      ...(opts.local.sessions.fork
        ? {
            async fork(id: string, atMessageId?: string) {
              const { e, b } = await route(id)
              if (!b.sessions.fork) unsupported('sessions.fork')
              const info = await call(e, () => b.sessions.fork!(id, atMessageId))
              index.set(info.id, e.id)
              dirty(e)
              return tag(info, e)
            },
          }
        : {}),
      ...(opts.local.sessions.rename
        ? {
            async rename(id: string, title: string) {
              const { e, b } = await route(id)
              if (!b.sessions.rename) unsupported('sessions.rename')
              await call(e, () => b.sessions.rename!(id, title))
            },
          }
        : {}),
      setEngine,
      // v1.55: перенос — движку сессии; список с диска перечитать.
      ...(opts.local.sessions.move
        ? {
            async move(id: string, to: SessionMoveInput) {
              const { e, b } = await route(id)
              if (!b.sessions.move) unsupported('sessions.move')
              const info = await call(e, () => b.sessions.move!(id, to))
              dirty(e)
              return tag(withHubRun(info), e)
            },
          }
        : {}),
    },

    async history(id, hopts) {
      const { e, b } = await route(id)
      const page = await call(e, () => b.history(id, hopts))
      // Движок окна не умеет (нет `total`) — режем здесь: клиенту хаба окно обещано (v1.57).
      return hopts && page.total === undefined ? { ...page, ...historyWindow(page.messages, hopts) } : page
    },

    run(id: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
      // Служебная команда (v1.47) — мимо учёта ранов: рядом с ходом, исполнителя не держит.
      if (isParallelRun(input)) {
        return {
          async *[Symbol.asyncIterator]() {
            const r = await route(id)
            yield* r.b.run(id, input)
          },
        }
      }
      return {
        [Symbol.asyncIterator]() {
          let inner: AsyncIterator<AnyRunEvent> | undefined
          let engine: EngineState | undefined
          const open = async (): Promise<AsyncIterator<AnyRunEvent>> => {
            if (inner) return inner
            const r = await route(id)
            engine = r.e
            await unarchive(r.e, r.b, id)
            running.add(id)
            inner = r.b.run(id, input)[Symbol.asyncIterator]()
            return inner
          }
          const done = (): void => {
            running.delete(id)
            runs.delete(id)
            // Ран мог переименовать сессию и сдвинуть её в списке — индекс с диска перечитать.
            dirty(engine)
          }
          return {
            async next() {
              try {
                const it = await open()
                const res = await it.next()
                if (res.done) done()
                else if (engine && !engine.local) {
                  // Идущий ран подключённого движка — в индекс (`SessionInfo.run`).
                  const ev = res.value as { type: string; runId?: string; askId?: string }
                  if (ev.type === 'run_start' && ev.runId) runs.set(id, { id: ev.runId, startedAt: new Date().toISOString() })
                  else if (ev.type === 'ask' && runs.has(id)) runs.set(id, { ...runs.get(id)!, waiting: 'ask' })
                  else if (ev.type === 'ask_end' && runs.has(id)) {
                    const { waiting: _w, ...r } = runs.get(id)!
                    runs.set(id, r)
                  } else if (ev.type === 'run_end') runs.delete(id)
                }
                return res
              } catch (err) {
                done()
                if (engine) noteFailure(engine, err)
                throw err
              }
            },
            async return(value?: unknown) {
              // Потребитель ушёл — ран у движка идёт дальше (serveBackend не отменяет).
              running.delete(id)
              await inner?.return?.(value as never)
              return { done: true, value: undefined as never }
            },
          }
        },
      }
    },

    async cancel(id, runId) {
      const { e, b } = await route(id)
      await call(e, () => b.cancel(id, runId))
    },

    // v1.37: движок сессии решает, умеет ли он steer (capability — `EngineInfo.caps.steer`).
    async steer(id: string, runId: string, userMessage: string | Part[]) {
      const { e, b } = await route(id)
      if (!b.steer) unsupported('steer')
      return call(e, () => b.steer!(id, runId, userMessage))
    },

    ...(opts.local.respond
      ? {
          async respond(id: string, askId: string, answer: unknown) {
            const { e, b } = await route(id)
            if (!b.respond) unsupported('respond')
            await call(e, () => b.respond!(id, askId, answer))
          },
        }
      : {}),
  }

  if (localMessages) hub.messages = routeGroup('messages', ['append', 'edit', 'delete', 'hide', 'swipe', 'prompt'])!
  if (opts.local.meta) {
    const m = routeGroup('meta', ['get', 'patch'])!
    // Мета меняет строку списка (закреплена, архив, теги — v1.55): индекс с диска перечитать.
    hub.meta = {
      ...m,
      async patch(id, patch) {
        const out = await m.patch(id, patch)
        dirty(await engineOf(id))
        return out
      },
    }
  }
  if (opts.local.personas) hub.personas = routeGroup('personas', ['list', 'save'])!
  if (opts.local.attachments) hub.attachments = routeGroup('attachments', ['put', 'get'])!
  if (opts.local.models) {
    const lm = opts.local.models
    hub.models = {
      ...routeGroup('models', ['set'])!,
      // Общий каталог: модели подключённых движков — с пометкой движка.
      async list(): Promise<ModelInfo[]> {
        const own = await lm.list()
        const others = await Promise.all(
          [...engines.values()]
            .filter((e) => !e.local)
            .map(async (e) => {
              if (!e.backend.models || !(await probe(e))) return []
              try {
                return (await e.backend.models.list()).map((m) => ({ ...m, engine: e.id }))
              } catch (err) {
                noteFailure(e, err)
                return []
              }
            }),
        )
        return [...own, ...others.flat()]
      },
    }
  }
  for (const k of ['workspace', 'catalogs', 'catalog', 'skins', 'plugins'] as const) {
    if (opts.local[k]) (hub as unknown as Record<string, unknown>)[k] = opts.local[k]
  }

  // Сервисы (П-7): объединение — встроенного и движков; вызов — движку-владельцу
  // (встроенный первым: общий id — его). Слоя нет ни у кого — группы нет.
  if (opts.local.services || opts.engines.some((e) => e.backend.services)) {
    const lsvc = opts.local.services
    const ownerOf = async (plugin: string): Promise<{ e: EngineState; svc: NonNullable<ProtocolBackend['services']> }> => {
      if (lsvc && (await opts.local.capabilities()).services?.[plugin]) return { e: local, svc: lsvc }
      for (const e of engines.values()) {
        if (e.local || !e.backend.services) continue
        if (!e.caps?.services?.[plugin]) await probe(e, true)
        if (e.available && e.caps?.services?.[plugin]) return { e, svc: e.backend.services }
      }
      if (lsvc) return { e: local, svc: lsvc } // встроенный ответит not_supported сам
      throw new NotSupportedError('services.call', `hub: сервиса ${plugin} нет ни у одного движка`)
    }
    hub.services = {
      async call(plugin: string, method: string, args?: unknown) {
        const { e, svc } = await ownerOf(plugin)
        return call(e, () => svc.call(plugin, method, args))
      },
      stream(plugin: string, method: string, args?: unknown): AsyncIterable<ServiceEvent> {
        return {
          [Symbol.asyncIterator]() {
            let inner: AsyncIterator<ServiceEvent> | undefined
            return {
              async next() {
                if (!inner) {
                  const { svc } = await ownerOf(plugin)
                  inner = svc.stream(plugin, method, args)[Symbol.asyncIterator]()
                }
                return inner.next()
              },
              async return(value?: unknown) {
                await inner?.return?.(value as never)
                return { done: true, value: undefined as never }
              },
            }
          },
        }
      },
    }
  }

  // Профили (П-7): `engine` в запросе — каталог движка (слепки ACP), иначе — стенда.
  if (opts.local.profiles) {
    const lp = opts.local.profiles
    const foreign = async (o: ProfilesListOpts | undefined): Promise<EngineState | undefined> => {
      if (!o?.engine || o.engine === localId) return undefined
      const e = engineById(o.engine)
      await requireAvailable(e)
      if (!e.backend.profiles) throw new NotSupportedError('profiles.list', `hub: у движка ${e.id} нет профилей`)
      return e
    }
    const strip = (o: ProfilesListOpts | undefined): ProfilesListOpts | undefined => {
      if (!o) return undefined
      const { engine: _e, ...rest } = o
      return Object.keys(rest).length ? rest : undefined
    }
    hub.profiles = {
      ...lp,
      ...routeGroup('profiles', ['set'])!,
      // Без `engine` — один каталог агентов: без дублей по движкам,
      // `engine` — движок агента по умолчанию. `workspace` — и движкам: агенты
      // проекта (envs/projects/<id>/agents) у каждого свои.
      async list(o?: ProfilesListOpts): Promise<ProfileInfo[]> {
        const e = await foreign(o)
        if (e) return (await call(e, () => e.backend.profiles!.list(strip(o)))).map((p) => ({ ...p, engine: e.id }) as ProfileInfo)
        return agentsList(o?.workspace)
      },
      async get(id: string, o?: ProfilesListOpts) {
        const e = await foreign(o)
        if (e) return call(e, () => e.backend.profiles!.get(id, strip(o)))
        try {
          return await lp.get(id, strip(o))
        } catch (err) {
          // Агент только у движка (старый слепок ACP) — его документ.
          const doc = await agentDoc(id, o?.workspace, engineById(localId))
          if (doc) return doc
          throw err
        }
      },
    }
  }
  hub.close = async () => {
    for (const e of engines.values()) if (!e.local) await e.backend.close?.().catch(() => {})
    await opts.local.close?.()
  }
  // Активность сессий (v1.69): раны всех движков идут через хаб — лента хаба перекрывает ленту встроенного.
  return withSessionActivity(hub)
}

/** Поля capabilities, которыми движок может отличаться от стенда (`EngineInfo.caps`). */
const OVERRIDE_KEYS = ['attachments', 'models', 'profiles', 'edits', 'swipes', 'fork', 'personas', 'sessionMeta', 'prompts', 'impersonate', 'steer'] as const

/** Отличия capabilities движка от стенда (П-8); нет отличий — `undefined`. */
export function capsDiff(stand: Capabilities, engine: Capabilities): EngineCapsOverride | undefined {
  const out: Record<string, unknown> = {}
  for (const k of OVERRIDE_KEYS) {
    const a = (stand as unknown as Record<string, unknown>)[k]
    const b = (engine as unknown as Record<string, unknown>)[k]
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue
    // Нет у движка: флаг — `false`; объектной группы (`models`, `profiles`) — как у стенда:
    // `undefined` по проводу не доедет, а `false` там — не «нет».
    if (b === undefined) {
      if (k !== 'models' && k !== 'profiles') out[k] = false
      continue
    }
    out[k] = b
  }
  return Object.keys(out).length ? (out as EngineCapsOverride) : undefined
}

/** Движок для `createHubPlugins`: бэкенд (capabilities) и база HTTP (файлы плагинов). */
export interface HubPluginsEngine {
  id: string
  backend: ProtocolBackend
  url?: string
  /** Заголовки к движку (ключ). */
  headers?: Record<string, string>
}

/**
 * Внешние плагины хаба (П-7): плагины стенда + плагины движков (cc у ACP), чьих
 * id у стенда нет. Файлы чужих — прокси `GET <url движка>/plugins/<id>/<путь>`;
 * сервис плагина — у его движка (`hub.services` маршрутизирует). Движок лежит —
 * его плагины из последнего известного списка (бандл тогда 404).
 */
/**
 * Адрес файла плагина движка — через хаб (`plugins/<id>/…`, прокси `file`): клиент движка
 * (`createHttpBackend`) делает адреса абсолютными (`http://127.0.0.1:7812/…`), а браузер
 * owner не на хосте — плагин не грузился (26.10: cc у ACP не грузился нигде, кроме mini).
 */
export function viaHub(id: string, url: string): string {
  const mark = `/plugins/${encodeURIComponent(id)}/`
  const at = url.indexOf(mark)
  if (at < 0) return url
  return `plugins/${encodeURIComponent(id)}/${url.slice(at + mark.length)}`
}

export function createHubPlugins(own: PluginsSource | undefined, engines: HubPluginsEngine[], log: (m: string) => void = () => {}): PluginsSource {
  const owner = new Map<string, HubPluginsEngine>()
  const last = new Map<string, ExternalPluginInfo[]>()
  // В лог — смена состояния движка, не каждый запрос списка (фронт зовёт часто).
  const down = new Set<string>()
  async function remote(e: HubPluginsEngine): Promise<ExternalPluginInfo[]> {
    if (!e.url) return []
    try {
      const got = (await e.backend.capabilities()).plugins ?? []
      last.set(e.id, got)
      if (down.delete(e.id)) log(`плагины ${e.id}: снова доступны`)
      return got
    } catch (err) {
      if (!down.has(e.id)) log(`плагины ${e.id}: ${(err as Error)?.message ?? err} — отдаю последний список`)
      down.add(e.id)
      return last.get(e.id) ?? []
    }
  }
  const src: PluginsSource = {
    async list() {
      const mine = own ? await own.list() : []
      const seen = new Set(mine.map((p) => p.id))
      const out = [...mine]
      for (const e of engines) {
        for (const p of await remote(e)) {
          if (seen.has(p.id)) continue
          seen.add(p.id)
          owner.set(p.id, e)
          out.push({ ...p, url: viaHub(p.id, p.url), ...(p.css ? { css: viaHub(p.id, p.css) } : {}) })
        }
      }
      return out
    },
    async file(id: string, path: string): Promise<PluginFile | null> {
      const e = owner.get(id)
      if (!e) return own ? own.file(id, path) : null
      if (!e.url || path.split('/').some((x) => x === '..' || x === '')) return null
      try {
        const res = await fetch(`${e.url.replace(/\/+$/, '')}/plugins/${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}`, { ...(e.headers ? { headers: e.headers } : {}) })
        if (!res.ok) return null
        return { data: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' }
      } catch (err) {
        log(`плагин ${id} (${e.id}): ${path} — ${(err as Error)?.message ?? err}`)
        return null
      }
    },
  }
  if (own?.watch) src.watch = (l: PluginChangedListener) => own.watch!(l)
  return src
}
