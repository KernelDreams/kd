/**
 * Мост `__host.session` (artifacts-spec §4): артефакт — редактор
 * данных сессии чата. Право `$uses: session`, скоупы
 *
 *   $session-read:  meta, personas, history     (умолчание — все три)
 *   $session-write: meta, personas              (умолчание — ничего)
 *
 * Хост (Node) только проверяет право, скоуп и форму аргументов; исполняет
 * фронт вкладки (`{delegate}`, как буфер и смотрелка): данные сессии живут у
 * клиента протокола (`ctx.session` во вкладке nrchat, `ctx.backend` в окне
 * артефакта), у сервиса плагина их нет.
 *
 * Тулы артефакта (`session.tools.register`) — декларация в `sessionMeta.tools`
 * (`executor: 'frontend'`, `artifactId` — владелец), вызов модели приходит
 * гостю `on('tool')`, ответ — обработчик гостя. Права — только `session`.
 */

/** Что гость может читать/писать в сессии. */
export const SESSION_READ_SCOPES = ['meta', 'personas', 'history'] as const
export const SESSION_WRITE_SCOPES = ['meta', 'personas'] as const
export type SessionScope = (typeof SESSION_READ_SCOPES)[number]

export const DEFAULT_SESSION_READ: readonly SessionScope[] = SESSION_READ_SCOPES
export const DEFAULT_SESSION_WRITE: readonly SessionScope[] = []

/** Метод моста → скоуп и режим; `null` — только право `session` (тулы). */
export const SESSION_METHODS: Readonly<Record<string, { scope: SessionScope; write: boolean } | null>> = {
  'session.meta.get': { scope: 'meta', write: false },
  'session.meta.on': { scope: 'meta', write: false },
  'session.meta.set': { scope: 'meta', write: true },
  'session.personas.list': { scope: 'personas', write: false },
  'session.personas.get': { scope: 'personas', write: false },
  'session.personas.set': { scope: 'personas', write: true },
  'session.history.list': { scope: 'history', write: false },
  'session.tools.register': null,
  'session.tools.unregister': null,
}

/** Ключи меты, которые гость не пишет через `meta.set`: у них свой путь или они read-only. */
const META_RESERVED: Readonly<Record<string, string>> = {
  tools: 'тулы — через session.tools.register',
  effectivePrompt: 'effectivePrompt только для чтения (его пишет сборка рана)',
}

const HISTORY_MAX = 200
const NAME_RE = /^[A-Za-z_][\w-]{0,63}$/

export type SessionCheck = { ok: true; value?: unknown } | { ok: false; error: string }

export interface SessionManifest {
  uses: readonly string[] | null
  sessionRead: readonly string[] | null
  sessionWrite: readonly string[] | null
}

/** Скоупы с учётом умолчаний. */
export function sessionScopes(m: Pick<SessionManifest, 'sessionRead' | 'sessionWrite'> | null): { read: string[]; write: string[] } {
  return { read: [...(m?.sessionRead ?? DEFAULT_SESSION_READ)], write: [...(m?.sessionWrite ?? DEFAULT_SESSION_WRITE)] }
}

/**
 * Ошибки декларации скоупов (статическая проверка finalize): незнакомые имена,
 * запись без чтения (`$session-write: personas` при `$session-read: meta`),
 * скоупы без `$uses: session`.
 */
export function sessionManifestErrors(m: SessionManifest): string[] {
  const errors: string[] = []
  const declared = m.sessionRead !== null || m.sessionWrite !== null
  if (declared && m.uses !== null && !m.uses.includes('session')) {
    errors.push('$session-read/$session-write без права session — добавь session в $uses')
  }
  for (const s of m.sessionRead ?? []) {
    if (!(SESSION_READ_SCOPES as readonly string[]).includes(s)) errors.push(`$session-read: неизвестный скоуп "${s}" (есть: ${SESSION_READ_SCOPES.join(', ')})`)
  }
  const { read } = sessionScopes(m)
  for (const s of m.sessionWrite ?? []) {
    if (!(SESSION_WRITE_SCOPES as readonly string[]).includes(s)) {
      errors.push(`$session-write: неизвестный скоуп "${s}" (есть: ${SESSION_WRITE_SCOPES.join(', ')})`)
    } else if (!read.includes(s)) {
      errors.push(`$session-write: ${s} без $session-read: ${s} — запись без чтения не бывает`)
    }
  }
  return errors
}

/** Путь меты: `prompt.pre` | `['prompt', 'pre']` | пусто (весь документ). */
export function metaPath(path: unknown): string[] | null {
  if (path === undefined || path === null || path === '') return []
  if (Array.isArray(path)) return path.every((p) => typeof p === 'string' && p !== '') ? (path as string[]) : null
  if (typeof path !== 'string') return null
  const parts = path.split('.')
  return parts.every((p) => p !== '') ? parts : null
}

function validPersona(p: unknown): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'персона — объект'
  const x = p as Record<string, unknown>
  if (typeof x.id !== 'string' || x.id.trim() === '') return 'у персоны нет id'
  if (x.kind !== 'user' && x.kind !== 'char') return `персона ${x.id}: kind — user | char`
  if (typeof x.name !== 'string' || x.name.trim() === '') return `персона ${x.id}: нет name`
  for (const k of ['avatar', 'model', 'prompt', 'color', 'description', 'scenario', 'system_prompt', 'post_history_instructions']) {
    if (x[k] !== undefined && x[k] !== null && typeof x[k] !== 'string') return `персона ${x.id}: ${k} — строка`
  }
  return null
}

/** Документ персон гостя (personas-spec §1): id уникальны, user-персона одна из списка. */
export function validatePersonasArg(personas: unknown, userId: unknown): string | null {
  if (!Array.isArray(personas)) return 'personas.set: нужен массив персон или одна персона'
  const ids = new Set<string>()
  for (const p of personas) {
    const err = validPersona(p)
    if (err) return `personas.set: ${err}`
    const id = (p as { id: string }).id
    if (ids.has(id)) return `personas.set: id ${id} повторяется`
    ids.add(id)
  }
  if (userId !== undefined && userId !== null) {
    if (typeof userId !== 'string' || !ids.has(userId)) return `personas.set: userId ${String(userId)} — не персона из списка`
  }
  return null
}

/** Декларация тула гостя → форма `SessionToolDecl` (имя — для модели). */
export function toolDecl(raw: unknown, artifactId: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'tools.register: нужна декларация {name, description, schema}' }
  const d = raw as Record<string, unknown>
  if (typeof d.name !== 'string' || !NAME_RE.test(d.name)) return { ok: false, error: `tools.register: имя тула — латиница/цифры/_/-, до 64 (${String(d.name)})` }
  if (d.description !== undefined && typeof d.description !== 'string') return { ok: false, error: 'tools.register: description — строка' }
  if (d.schema !== undefined && (typeof d.schema !== 'object' || d.schema === null || Array.isArray(d.schema))) {
    return { ok: false, error: 'tools.register: schema — JSON Schema объекта' }
  }
  return {
    ok: true,
    value: {
      name: d.name,
      ...(typeof d.description === 'string' ? { description: d.description } : {}),
      ...(d.schema ? { schema: d.schema } : {}),
      executor: 'frontend',
      artifactId,
    },
  }
}

/**
 * Проверка вызова `session.*`: право, скоуп, форма аргументов. Успех несёт
 * нормализованные аргументы для фронта (`value`). `artifactId` — владелец тулов.
 */
export function checkSession(m: SessionManifest | null, method: string, args: readonly unknown[], artifactId: string): SessionCheck {
  if (!(method in SESSION_METHODS)) return { ok: false, error: `unknown bridge method: ${method}` }
  const legacy = !m || m.uses === null
  if (!legacy && !m!.uses!.includes('session')) {
    return { ok: false, error: 'capability not declared: session — добавь в $uses и скоупы $session-read/$session-write' }
  }
  const rule = SESSION_METHODS[method]
  if (rule && !legacy) {
    const { read, write } = sessionScopes(m)
    const scopes = rule.write ? write : read
    if (!scopes.includes(rule.scope)) {
      return { ok: false, error: `session scope not declared: $session-${rule.write ? 'write' : 'read'}: ${rule.scope}` }
    }
  }
  switch (method) {
    case 'session.meta.get': {
      const path = metaPath(args[0])
      return path ? { ok: true, value: { path } } : { ok: false, error: 'meta.get: путь — "a.b" или ["a","b"]' }
    }
    case 'session.meta.set': {
      const path = metaPath(args[0])
      if (!path) return { ok: false, error: 'meta.set: путь — "a.b" или ["a","b"]' }
      if (path.length === 0) return { ok: false, error: 'meta.set: нужен путь — документ целиком не пишется (meta.set("prompt.pre", текст))' }
      const reserved = META_RESERVED[path[0]!]
      if (reserved) return { ok: false, error: `meta.set: ${path[0]} — ${reserved}` }
      if (args[1] === undefined) return { ok: false, error: 'meta.set: нет значения (null — удалить ключ)' }
      const o = (args[2] ?? null) as { ifHash?: unknown } | null
      if (o !== null && (typeof o !== 'object' || (o.ifHash !== undefined && typeof o.ifHash !== 'string'))) {
        return { ok: false, error: 'meta.set: третий аргумент — {ifHash?: string}' }
      }
      return { ok: true, value: { path, value: args[1], ...(typeof o?.ifHash === 'string' ? { ifHash: o.ifHash } : {}) } }
    }
    case 'session.meta.on':
    case 'session.personas.list':
      return { ok: true, value: {} }
    case 'session.personas.get':
      return typeof args[0] === 'string' && args[0] ? { ok: true, value: { id: args[0] } } : { ok: false, error: 'personas.get: нужен id (или "user" — персона игрока)' }
    case 'session.personas.set': {
      // Одна персона — правка/добавление по id; массив — документ целиком.
      const a = args[0]
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        const err = validPersona(a)
        return err ? { ok: false, error: `personas.set: ${err}` } : { ok: true, value: { persona: a } }
      }
      const err = validatePersonasArg(a, args[1])
      if (err) return { ok: false, error: err }
      return { ok: true, value: { personas: a, ...(typeof args[1] === 'string' ? { userId: args[1] } : {}) } }
    }
    case 'session.history.list': {
      const o = (args[0] ?? {}) as { limit?: unknown }
      const limit = typeof o.limit === 'number' && o.limit > 0 ? Math.min(Math.floor(o.limit), HISTORY_MAX) : 50
      return { ok: true, value: { limit } }
    }
    case 'session.tools.register':
      return toolDecl(args[0], artifactId)
    case 'session.tools.unregister':
      return typeof args[0] === 'string' && args[0] ? { ok: true, value: { name: args[0] } } : { ok: false, error: 'tools.unregister: нужно имя тула' }
  }
  return { ok: false, error: `unknown bridge method: ${method}` }
}

/** Ключи меты вне версии: меняются сами (ран, регистрация тулов, снимок страницы), а не правкой гостя. */
export const META_HASH_SKIP = ['effectivePrompt', 'tools', 'pageContext'] as const

/** Версия меты для `ifHash`: хэш документа без {@link META_HASH_SKIP}. */
export function metaHash(doc: unknown): string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return stableHash(doc ?? {})
  const rest: Record<string, unknown> = { ...(doc as Record<string, unknown>) }
  for (const k of META_HASH_SKIP) delete rest[k]
  return stableHash(rest)
}

/**
 * Хэш документа (FNV-1a над JSON с сортированными ключами): версия меты для
 * `meta.set(…, {ifHash})`. Тот же код у фронта плагина — копия в
 * `nrchat/plugins/artifacts/session.ts` (фронт не тянет nr-стек).
 */
export function stableHash(value: unknown): string {
  const json = stableJson(value)
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function stableJson(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`
}
