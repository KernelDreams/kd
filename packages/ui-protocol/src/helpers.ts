/**
 * nr-ui-protocol — хелперы над типами протокола.
 *
 * derivedText, matchToolPair, type guards для Part/RunEvent, isKnownPart.
 * Никакой реализации транспорта — чистые функции над DTO.
 */

import { COMPACTION_PART_HINT } from './types.js'
import type {
  Capabilities,
  CompactionPartData,
  AnyPart,
  AnyRunEvent,
  CustomPart,
  EngineInfo,
  ErrorPart,
  FilePart,
  ImagePart,
  KnownPartType,
  KnownRunEventType,
  Message,
  ParticipantRef,
  Part,
  ProfileDoc,
  ProfileInfo,
  RunEvent,
  RunStartInput,
  SessionMetaDoc,
  SessionMetaPatch,
  SessionMetaPrompt,
  SessionPromptMode,
  SessionSkill,
  SessionSkillMode,
  TextPart,
  ThinkingPart,
  ToolResultPart,
  ToolUsePart,
} from './types.js'

// ────────────────────────────────────────────────────────────────────────────
// Известные типы (реестры для isKnownPart / isKnownRunEvent)
// ────────────────────────────────────────────────────────────────────────────

/** Все типы part закрытого ядра (§2.3), включая escape hatch `custom`. */
export const KNOWN_PART_TYPES: readonly KnownPartType[] = [
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'file',
  'image',
  'error',
  'custom',
]

/** Все типы событий рана закрытого ядра (§5.2). */
export const KNOWN_RUN_EVENT_TYPES: readonly KnownRunEventType[] = [
  'run_start',
  'message_start',
  'part_start',
  'part_delta',
  'part_end',
  'message_end',
  'ask',
  'ask_end',
  'activity',
  'session_update',
  'run_end',
]

const KNOWN_PART_TYPE_SET = new Set<string>(KNOWN_PART_TYPES)
const KNOWN_RUN_EVENT_TYPE_SET = new Set<string>(KNOWN_RUN_EVENT_TYPES)

// ────────────────────────────────────────────────────────────────────────────
// Part type guards (narrowing по type)
// ────────────────────────────────────────────────────────────────────────────

export function isTextPart(part: AnyPart): part is TextPart {
  return part.type === 'text'
}

export function isThinkingPart(part: AnyPart): part is ThinkingPart {
  return part.type === 'thinking'
}

export function isToolUsePart(part: AnyPart): part is ToolUsePart {
  return part.type === 'tool_use'
}

export function isToolResultPart(part: AnyPart): part is ToolResultPart {
  return part.type === 'tool_result'
}

export function isFilePart(part: AnyPart): part is FilePart {
  return part.type === 'file'
}

export function isImagePart(part: AnyPart): part is ImagePart {
  return part.type === 'image'
}

export function isErrorPart(part: AnyPart): part is ErrorPart {
  return part.type === 'error'
}

export function isCustomPart(part: AnyPart): part is CustomPart {
  return part.type === 'custom'
}

/**
 * Part принадлежит закрытому ядру протокола (§1.2, §2.3).
 * `custom` считается известным (escape hatch), но всё равно рендерится
 * fallback-веткой по `meta.hint`. Тип вне реестра → opaque part.
 */
export function isKnownPart(part: AnyPart): part is Part {
  return KNOWN_PART_TYPE_SET.has(part.type)
}

// ────────────────────────────────────────────────────────────────────────────
// RunEvent type guards (narrowing по type)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Общий guard: `event.type === type` с сужением до конкретного варианта
 * дискриминированного объединения RunEvent.
 *
 * @example isRunEvent(ev, 'part_delta') → ev: PartDeltaEvent
 */
export function isRunEvent<T extends KnownRunEventType>(
  event: AnyRunEvent,
  type: T,
): event is Extract<RunEvent, { type: T }> {
  return event.type === type
}

/** Событие рана принадлежит закрытому ядру (§5.2). Иначе — opaque, игнорировать. */
export function isKnownRunEvent(event: AnyRunEvent): event is RunEvent {
  return KNOWN_RUN_EVENT_TYPE_SET.has(event.type)
}

// ────────────────────────────────────────────────────────────────────────────
// derivedText (§2.2)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Плоский текст сообщения = конкатенация text-parts (§2.2).
 * `content` в протоколе отсутствует — считает клиент.
 * Учитываются только `text`-части; thinking/tool/файлы игнорируются.
 */
export function derivedText(message: Pick<Message, 'parts'>): string {
  let out = ''
  for (const part of message.parts as AnyPart[]) {
    if (isTextPart(part)) out += part.text
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// matchToolPair (§2.3)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Связка одного запуска тула: tool_use (вход) + tool_result (выход),
 * матч по `callId`. Любая половина может отсутствовать (стрим/разные
 * сообщения) — `use`/`result` опциональны.
 */
export interface ToolPair {
  callId: string
  name?: string
  use?: ToolUsePart
  result?: ToolResultPart
}

/**
 * Матчит tool_use ↔ tool_result по `meta.callId` (§2.3).
 * Возвращает пары в порядке первого появления callId.
 * Не-tool part'ы игнорируются; неизвестные типы не роняют.
 */
export function matchToolPair(parts: readonly AnyPart[]): ToolPair[] {
  const byId = new Map<string, ToolPair>()
  const order: string[] = []

  const ensure = (callId: string): ToolPair => {
    let pair = byId.get(callId)
    if (!pair) {
      pair = { callId }
      byId.set(callId, pair)
      order.push(callId)
    }
    return pair
  }

  for (const part of parts) {
    if (isToolUsePart(part)) {
      const pair = ensure(part.meta.callId)
      pair.use = part
      pair.name ??= part.meta.name
    } else if (isToolResultPart(part)) {
      const pair = ensure(part.meta.callId)
      pair.result = part
      if (part.meta.name) pair.name ??= part.meta.name
    }
  }

  return order.map((id) => byId.get(id)!)
}

// ────────────────────────────────────────────────────────────────────────────
// session-meta-spec §2 — merge патча меты
// ────────────────────────────────────────────────────────────────────────────

/**
 * Применить патч к документу меты (session-meta-spec §2).
 *
 * Правило одно на всех: shallow merge по верхним ключам, `prompt` мержится по
 * своим ключам, `null` удаляет ключ, `undefined` — «ключ не патчили».
 *
 * Функция живёт здесь, а не в бэкенде, потому что merge — часть контракта
 * `meta.patch`, а не деталь хранилища: pi-расширение, backend-pi и store-бэкенд
 * обязаны применять один и тот же патч одинаково. Чистая, вход не мутирует.
 */
export function mergeSessionMeta(doc: SessionMetaDoc, patch: SessionMetaPatch): SessionMetaDoc {
  const out: SessionMetaDoc = { ...doc }
  // Read-only ключи документом не хранятся (§7): их вычисляет тот, кто собирал
  // ран, а не тот, кто прислал патч. Выбрасываются молча — клиент, отправивший
  // назад весь прочитанный документ, не должен получать ошибку за честность.
  delete out.effectivePrompt

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'effectivePrompt') continue
    if (value === undefined) continue
    if (value === null) {
      delete out[key]
      continue
    }
    if (key !== 'prompt') {
      out[key] = value
      continue
    }

    // `prompt` — единственный ключ с вложенным merge (§2): пришедший `{post}`
    // не должен стирать уже лежащий `pre`.
    const current = isPlainRecord(out.prompt) ? { ...(out.prompt as Record<string, unknown>) } : {}
    for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
      if (pv === undefined) continue
      if (pv === null) delete current[pk]
      else current[pk] = pv
    }
    // Пустой `prompt` не хранится: «промпта нет» и «промпт есть, но пустой» —
    // для потребителя одно и то же, а мусорный ключ вылезал бы в UI и в диффах.
    if (Object.keys(current).length === 0) delete out.prompt
    else out.prompt = current as SessionMetaPrompt
  }

  return out
}

/** Значение — известный режим промпта (`/meta mode`, валидация патча). */
export function isSessionPromptMode(v: unknown): v is SessionPromptMode {
  return v === 'append' || v === 'replace'
}

/**
 * Режим промпта документа (§7); дефолт — `append`.
 *
 * Дефолт живёт здесь, а не у каждого потребителя: «ключа нет» обязано означать
 * одно и то же в расширении, бэкенде и панели, иначе один и тот же документ
 * собирал бы разный промпт. Незнакомое значение (старый клиент, чужой бэкенд)
 * — тоже `append`: неизвестный режим не повод молча выкинуть штатный промпт.
 */
export function sessionPromptMode(doc: SessionMetaDoc): SessionPromptMode {
  const mode = doc.prompt?.mode
  return isSessionPromptMode(mode) ? mode : 'append'
}

// ────────────────────────────────────────────────────────────────────────────
// profile-editor-spec §2 — документ профиля
// ────────────────────────────────────────────────────────────────────────────

/**
 * `SessionInfo.profile` сессии со встроенным профилем (bot-as-session-spec §1):
 * документ лежит в самой сессии, каталога за ним нет. Id зарезервирован —
 * каталожный профиль так называться не может.
 */
export const INLINE_PROFILE_ID = 'inline'

/**
 * Годный id профиля каталога: имя файла из `[a-z0-9-]`, не с дефиса (`-x`
 * читался бы флагом в любой командной строке, куда id уедет), и не
 * {@link INLINE_PROFILE_ID} — иначе `SessionInfo.profile` не отличил бы
 * каталожный профиль от встроенного.
 */
export function isProfileId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(v) && v !== INLINE_PROFILE_ID
}

/**
 * Профиль в `sessions.create` / `profiles.set` — документ, а не id
 * (bot-as-session-spec §1). Форма минимальная: объект со строковым `name`;
 * `id` встроенного бэкенд ставит сам.
 */
export function isProfileDoc(v: unknown): v is ProfileDoc {
  return isPlainRecord(v) && typeof v.name === 'string'
}

/**
 * Документ профиля → витрина `ProfileInfo` (profiles-spec §4).
 *
 * Правило одно на всех бэкендов: пустое имя — `id`, пустые списки и промпт без
 * режима в витрину не выходят.
 */
export function profileInfoOf(doc: ProfileDoc): ProfileInfo {
  const info: ProfileInfo = { id: doc.id, name: doc.name || doc.id }
  if (doc.description) info.description = doc.description
  if (doc.tools !== undefined) info.tools = doc.tools
  if (doc.skills?.length) info.skills = doc.skills
  if (doc.model) info.model = doc.model
  if (doc.prompt?.mode) info.promptMode = doc.prompt.mode
  if (doc.engine) info.engine = doc.engine
  if (doc.source) info.source = doc.source
  if (doc.card) info.card = doc.card
  if (doc.icon) info.icon = doc.icon
  if (doc.avatar) info.avatar = doc.avatar
  if (doc.voice && Object.keys(doc.voice).length) info.voice = { ...doc.voice }
  return info
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ────────────────────────────────────────────────────────────────────────────
// v1.10 — continue
// ────────────────────────────────────────────────────────────────────────────

/**
 * Можно ли ран без user-сообщения («продолжай», capability `run.continue`).
 * Не заявлено — бэкенд такой ран отвергает `not_supported`, кнопку не показывать.
 */
export function canContinue(caps: Pick<Capabilities, 'run'>): boolean {
  return caps.run?.continue === true
}

// ────────────────────────────────────────────────────────────────────────────
// v1.18 — команды рана, узел компакции
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// v1.19 — адресат хода (target), impersonate бэкендом
// ────────────────────────────────────────────────────────────────────────────

/** Умеет ли бэкенд impersonate раном (`RunStartInput.target: {kind: 'user'}`). */
export function canImpersonate(caps: Pick<Capabilities, 'impersonate'>): boolean {
  return caps.impersonate === true
}

/** Форма {@link ParticipantRef}: `{kind: 'user'}` или `{kind: 'char', personaId?: string}`. */
export function isParticipantRef(v: unknown): v is ParticipantRef {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const r = v as { kind?: unknown; personaId?: unknown }
  if (r.kind === 'user') return true
  return r.kind === 'char' && (r.personaId === undefined || typeof r.personaId === 'string')
}

/** Ран impersonate: адресат хода — игрок. */
export function targetsUser(input: Pick<RunStartInput, 'target'>): boolean {
  return input.target?.kind === 'user'
}

// ────────────────────────────────────────────────────────────────────────────
// v1.20 — рабочий каталог сессии
// ────────────────────────────────────────────────────────────────────────────

/** Применяет ли бэкенд `cwd` сессии к тулам (capability `workspace.perSession`). */
export function canSessionCwd(caps: Pick<Capabilities, 'workspace'>): boolean {
  return caps.workspace?.perSession === true
}

/** Абсолютный ли путь (POSIX `/…`, Windows `C:\…`/`C:/…`, UNC `\\host\…`). */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** `cwd` сессии из меты (`workspace.cwd`); нет или не строка — `undefined`. */
export function sessionCwdOf(meta: unknown): string | undefined {
  if (!isPlainRecord(meta)) return undefined
  const ws = meta.workspace
  if (!isPlainRecord(ws)) return undefined
  return typeof ws.cwd === 'string' && ws.cwd !== '' ? ws.cwd : undefined
}

// ────────────────────────────────────────────────────────────────────────────
// v1.26 — проекты (projects-spec)
// ────────────────────────────────────────────────────────────────────────────

/** Проект сессий без пометки (до проектов) и стенда без реестра: `$root` = `$cwd` стенда. */
export const DEFAULT_PROJECT_ID = 'default'

/** Работает ли бэкенд с проектами (capability `workspace.projects`). */
export function canProjects(caps: Pick<Capabilities, 'workspace'>): boolean {
  return caps.workspace?.projects === true
}

/** Проект сессии из меты (`workspace.project`); нет — {@link DEFAULT_PROJECT_ID}. */
export function sessionProjectOf(meta: unknown): string {
  if (!isPlainRecord(meta)) return DEFAULT_PROJECT_ID
  const ws = meta.workspace
  if (!isPlainRecord(ws)) return DEFAULT_PROJECT_ID
  return typeof ws.project === 'string' && ws.project !== '' ? ws.project : DEFAULT_PROJECT_ID
}

/**
 * Id проекта из имени (имя файла реестра `projects/<id>.mdz`): латиница, цифры,
 * `-`; кириллица и прочее — прочь. Пусто — `project`.
 */
export function projectIdOf(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return id || 'project'
}

/** Годится ли строка в id проекта (имя файла без пути и точки в начале). */
export function isProjectId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(id) && id.length <= 64
}

/** Плагины для текущего проекта: плагины стенда + проекта `workspace` (v1.26). */
export function pluginsForWorkspace<T extends { workspace?: string }>(plugins: readonly T[], workspace: string | undefined): T[] {
  return plugins.filter((p) => p.workspace === undefined || p.workspace === workspace)
}

/**
 * Умеет ли бэкенд влить сообщение в идущий ран (v1.37, capability `steer`).
 * Нет — сообщение посреди рана UI держит в очереди и шлёт после хода.
 */
export function canSteer(caps: Pick<Capabilities, 'steer'> | null | undefined): boolean {
  return caps?.steer === true
}

/** Понимает ли бэкенд команду рана (`RunStartInput.command`, capability `run.commands`). */
export function canCommand(caps: Pick<Capabilities, 'run'>, name: string): boolean {
  return caps.run?.commands?.includes(name) === true
}

/** Варианты хода CYOA (v1.47): команда `choices` заявлена. */
export function canChoices(caps: Pick<Capabilities, 'run'>): boolean {
  return canCommand(caps, 'choices')
}

/** Редактор CYOA (v1.47): команда `editor` заявлена. */
export function canEditor(caps: Pick<Capabilities, 'run'>): boolean {
  return canCommand(caps, 'editor')
}

/**
 * Данные компакции из сообщения — узла `role: 'system'` с custom-частью
 * {@link COMPACTION_PART_HINT}. Не узел компакции — `undefined`.
 */
export function compactionOf(message: Pick<Message, 'role' | 'parts'>): CompactionPartData | undefined {
  for (const part of message.parts) {
    if (part.type !== 'custom') continue
    if ((part.meta as { hint?: unknown } | undefined)?.hint !== COMPACTION_PART_HINT) continue
    const data = (part as { data?: unknown }).data
    if (!isPlainRecord(data)) continue
    const summary = typeof data.summary === 'string' ? data.summary : typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : undefined
    if (summary === undefined || typeof data.firstKeptEntryId !== 'string') continue
    const out: CompactionPartData = { summary, firstKeptEntryId: data.firstKeptEntryId, tokensBefore: typeof data.tokensBefore === 'number' ? data.tokensBefore : 0 }
    if (data.details !== undefined) out.details = data.details
    if (data.fromHook === true) out.fromHook = true
    return out
  }
  return undefined
}

// ────────────────────────────────────────────────────────────────────────────
// v1.29 — движки хаба (users-spec §1)
// ────────────────────────────────────────────────────────────────────────────

/** Стенд — хаб с движками (`Capabilities.engines`): сессии несут `engine`. */
export function canEngines(caps: Pick<Capabilities, 'engines'> | null | undefined): boolean {
  return !!caps?.engines && Array.isArray(caps.engines.list) && caps.engines.list.length > 0
}

/** Хаб умеет менять исполнителя сессии (`sessions.setEngine`). */
export function canSetEngine(caps: Pick<Capabilities, 'engines'> | null | undefined): boolean {
  return canEngines(caps) && caps!.engines!.switch === true
}

/** Встроенный движок хаба (`EngineInfo.local`); нет хаба — `undefined`. */
export function localEngineOf(caps: Pick<Capabilities, 'engines'> | null | undefined): string | undefined {
  return caps?.engines?.list.find((e) => e.local)?.id
}

/**
 * Движок сессии глазами клиента: `SessionInfo.engine`, иначе встроенный движок
 * хаба (сессия без поля — его). Не хаб — `undefined`.
 */
export function sessionEngineOf(caps: Pick<Capabilities, 'engines'> | null | undefined, session: { engine?: string } | null | undefined): string | undefined {
  if (!canEngines(caps)) return undefined
  return session?.engine ?? localEngineOf(caps)
}

/**
 * Каталог (модели, профили) глазами движка: у хаба элементы подключённых
 * движков помечены `engine`, без пометки — встроенного. Движок не задан или
 * встроенный — непомеченные; иначе — его. Не хаб (`localEngine` нет) — как есть.
 */
export function engineItems<T extends { engine?: string }>(items: readonly T[], engine: string | undefined, localEngine: string | undefined): T[] {
  if (localEngine === undefined) return [...items]
  if (engine === undefined || engine === localEngine) return items.filter((i) => i.engine === undefined || i.engine === localEngine)
  return items.filter((i) => i.engine === engine)
}

/**
 * Движки, на которые можно перевести сессию (v1.31): хаб умеет менять
 * исполнителя, движок доступен и не помечен `switch: false` (нет `.mds`).
 */
export function switchTargets(caps: Pick<Capabilities, 'engines'> | null | undefined): EngineInfo[] {
  if (!canSetEngine(caps)) return []
  return caps!.engines!.list.filter((e) => e.switch !== false)
}

/**
 * Capabilities для сессии движка `engine` (v1.33, П-8): стенд с полями, которыми
 * движок отличается (`EngineInfo.caps`). Нет движка, встроенный, нет отличий —
 * caps стенда как есть.
 */
export function engineCaps<C extends Capabilities | null | undefined>(caps: C, engine: string | undefined): C {
  if (!caps || !engine) return caps
  const info = caps.engines?.list.find((e) => e.id === engine)
  if (!info || info.local || !info.caps) return caps
  return { ...caps, ...info.caps } as C
}

// ────────────────────────────────────────────────────────────────────────────
// v1.31 — подхват идущего рана (run-resume-spec §1)
// ────────────────────────────────────────────────────────────────────────────

/** Бэкенд отдаёт идущий ран подпиской (`sessions.attach`). */
export function canAttachRun(caps: Pick<Capabilities, 'sessions'> | null | undefined): boolean {
  return caps?.sessions?.attach === true
}

/** Архив и теги сессий на мете (v1.55): `sessions.list({archived})`, `sessionMeta.archived/tags`. */
export function canArchiveSessions(caps: Pick<Capabilities, 'sessions'> | null | undefined): boolean {
  return caps?.sessions?.archive === true
}

/** Перенос сессии в другое пространство (`sessions.move`, v1.55). */
export function canMoveSession(caps: Pick<Capabilities, 'sessions'> | null | undefined): boolean {
  return caps?.sessions?.move === true
}

/** Сессия в архиве (v1.55): дата в `archived`; `false` — вернули руками. */
export function isArchivedSession(s: { archived?: string | false } | null | undefined): boolean {
  return typeof s?.archived === 'string' && s.archived !== ''
}

/**
 * Список по правилу `SessionListOpts.archived` (v1.55): нет / `false` — без архивных, `true` —
 * все, `'only'` — только архивные. Один фильтр на хаб, стор-бэкенд и клиент.
 */
export function pickArchived<T extends { archived?: string | false }>(list: readonly T[], archived: boolean | 'only' | undefined): T[] {
  if (archived === true) return [...list]
  if (archived === 'only') return list.filter((s) => isArchivedSession(s))
  return list.filter((s) => !isArchivedSession(s))
}

/** Патч меты «в архив» / «вернуть» (v1.55): вернул человек — `archived: false`, автоархив её не трогает. */
export function archivePatch(on: boolean, by?: 'auto'): Record<string, unknown> {
  return on ? { archived: new Date().toISOString(), archivedBy: by ?? null } : { archived: false, archivedBy: null }
}

/** Бэкенд отдаёт список запущенных сессий (`sessions.live`, v1.38). */
export function canListLive(caps: Pick<Capabilities, 'sessions'> | null | undefined): boolean {
  return caps?.sessions?.live === true
}

/** Бэкенд гасит процесс агента простаивающей сессии (`sessions.release`, v1.38). */
export function canReleaseSession(caps: Pick<Capabilities, 'sessions'> | null | undefined): boolean {
  return caps?.sessions?.release === true
}

// ────────────────────────────────────────────────────────────────────────────
// v1.30 — пользователи стенда (users-spec §2–5)
// ────────────────────────────────────────────────────────────────────────────

/** Стенд с пользователями (`Capabilities.users`). */
export function canUsers(caps: Pick<Capabilities, 'users'> | null | undefined): boolean {
  return !!caps?.users?.me
}

/** Вошедший — owner стенда (или стенд без пользователей: владелец один). */
export function isStandOwner(caps: Pick<Capabilities, 'users'> | null | undefined): boolean {
  return !caps?.users || caps.users.me.role === 'owner'
}

/** Сессия глазами вошедшего: «поделиться» — автору и owner стенда. */
export function canShareSession(caps: Pick<Capabilities, 'users'> | null | undefined, session: { owner?: string } | null | undefined): boolean {
  if (!canUsers(caps) || !session) return false
  const me = caps!.users!.me
  return me.role === 'owner' || (session.owner ?? '') === me.id
}

/**
 * Можно ли слать ходы в сессию: автор, owner стенда или расшаренная с `write`.
 * Движок сессии, которого нет у пользователя (ACP), — только чтение.
 */
export function canWriteSession(
  caps: Pick<Capabilities, 'users' | 'engines'> | null | undefined,
  session: { owner?: string; shared?: { write?: boolean }; engine?: string } | null | undefined,
): boolean {
  if (!canUsers(caps) || !session) return true
  const me = caps!.users!.me
  if (me.role === 'owner') return true
  const engine = sessionEngineOf(caps, session)
  if (engine && !me.engines.includes(engine)) return false
  return session.owner === me.id || session.shared?.write === true
}

/** Файлы проекта на запись: роль не `viewer` (стенд без пользователей — да). */
export function canWriteFiles(workspace: { role?: string } | null | undefined): boolean {
  return workspace?.role !== 'viewer'
}

// ── v1.57: окна ленты и списка ────────────────────────────────────

/** Бэкенд отдаёт ленту окнами (`history(id, {limit, before})`, v1.57). */
export function canPageHistory(caps: Pick<Capabilities, 'history'> | null | undefined): boolean {
  return caps?.history?.page === true
}

/** Бэкенд ищет и режет список сессий сам (`SessionListOpts.query/limit/offset`, v1.57). */
export function canPageSessions(caps: Pick<Capabilities, 'sessions'> | null | undefined): boolean {
  return caps?.sessions?.page === true
}

/**
 * Подходит ли сессия под строку поиска (v1.57): слова через пробел — все должны найтись;
 * `#тег` — среди тегов, прочее — подстрокой без регистра в названии, боте, тегах, id.
 * Одно правило на сервере (`SessionListOpts.query`) и в клиенте (фильтр без capability).
 */
export function matchSessionQuery(s: { id: string; title?: string; botName?: string; tags?: readonly string[] }, query: string | undefined): boolean {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const tags = (s.tags ?? []).map((t) => t.toLowerCase())
  const hay = [s.title ?? '', s.botName ?? '', s.id, ...tags].join('\n').toLowerCase()
  return words.every((w) => (w.startsWith('#') && w.length > 1 ? tags.some((t) => t === w.slice(1) || t.startsWith(`${w.slice(1)}/`)) : hay.includes(w)))
}

/** Окно списка по `SessionListOpts` (v1.57): поиск, потом `offset`/`limit`. */
export function pageSessions<T extends { id: string; title?: string; botName?: string; tags?: readonly string[] }>(rows: T[], opts: { query?: string; limit?: number; offset?: number } | undefined): T[] {
  const found = opts?.query ? rows.filter((r) => matchSessionQuery(r, opts.query)) : rows
  const from = Math.max(0, opts?.offset ?? 0)
  return opts?.limit !== undefined || from ? found.slice(from, opts?.limit !== undefined ? from + Math.max(0, opts.limit) : undefined) : found
}

/**
 * Окно ленты (v1.57): хвост `limit` до сообщения `before` (нет его — с конца).
 * Для бэкендов, у которых лента уже в памяти целиком.
 */
export function historyWindow<M extends { id: string }>(messages: M[], opts: { limit?: number; before?: string } | undefined): { messages: M[]; more: boolean; total: number } {
  const total = messages.length
  let end = total
  if (opts?.before) {
    const at = messages.findIndex((m) => m.id === opts.before)
    if (at >= 0) end = at
  }
  const start = opts?.limit !== undefined ? Math.max(0, end - Math.max(0, opts.limit)) : 0
  return { messages: start === 0 && end === total ? messages : messages.slice(start, end), more: start > 0, total }
}

/** Бэкенд читает скиллы сессии с режимами (v1.59). */
export function canSessionSkills(caps: Pick<Capabilities, 'skills'> | null | undefined): boolean {
  return caps?.skills?.session === true
}

/**
 * Скиллы сессии из меты (v1.59): строка — `loaded` (скилл старта v1.35), запись без
 * имени и чужой режим — мимо; одно имя — первая запись.
 */
export function sessionSkills(meta: { skills?: unknown } | null | undefined): SessionSkill[] {
  const raw = meta?.skills
  if (!Array.isArray(raw)) return []
  const out: SessionSkill[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    const s: SessionSkill | undefined =
      typeof x === 'string'
        ? { name: x.trim(), mode: 'loaded' }
        : isPlainRecord(x) && typeof x.name === 'string' && (x.mode === 'linked' || x.mode === 'loaded')
          ? { name: x.name.trim(), mode: x.mode, ...(typeof x.source === 'string' && x.source ? { source: x.source } : {}) }
          : undefined
    if (!s?.name || seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
  return out
}

/** Имена скиллов сессии в режиме `mode`. */
export function sessionSkillNames(meta: { skills?: unknown } | null | undefined, mode: SessionSkillMode): string[] {
  return sessionSkills(meta).filter((s) => s.mode === mode).map((s) => s.name)
}

/**
 * Родитель вызова субагента (v1.60): callId тула `Agent`/`Task`, чей субагент
 * сделал этот вызов, — `meta.parent` у tool_use / tool_result. Такие части — в контексте
 * субагента, а не чата: в ленте вложенно под родителем, в счётчике контекста чата — нет.
 */
export function subagentParent(part: AnyPart): string | undefined {
  if (part.type !== 'tool_use' && part.type !== 'tool_result') return undefined
  const parent = (part as { meta?: { parent?: unknown } }).meta?.parent
  return typeof parent === 'string' && parent ? parent : undefined
}
