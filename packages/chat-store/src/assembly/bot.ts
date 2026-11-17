/**
 * Бот и сборка промпта (`nrchat.dev/specs/bot-assembly-spec.md`): чистые
 * функции над документом сессии, общие для билдера `mds-template` и хоста (backend-nr).
 *
 *  - тип бота (§4): `ccv3` (по умолчанию, карта CCv3/CCv2/V1), `nr` (наш: сорта
 *    полей), `raw` (одно поле); `type` карты или `extensions.nrchat.type`;
 *  - свой шаблон сборки бота (§4, §13 п. 1): `extensions.nrchat.template` — текст `.mds`;
 *  - переменные пресета (§5): объявление у агента (`vars`), каскад значения
 *    чип → персона → бот в сессии → агент; блоки `top` / `tail` / `last` (`hard`);
 *  - заметки чата (§11): `{text, slot, role, every, scope}` трёх областей;
 *  - заметка формы экземпляра бота (§13 п. 4): `extensions.nrchat.form_note`;
 *  - формат сообщений (§8a): `names: always | personas | off`, `stop_user`.
 */

import type { Message as DtoMessage, Persona, PersonasDoc } from '../model.js'
import { layoutOf, layoutParts } from './layout.js'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/**
 * Строгий JSON из JSON5 объекта значения (`$vars: {language: {…}}` профиля `.mdz` nrd
 * сериализует ключи без кавычек): ключи-идентификаторы в кавычки, строки в одинарных —
 * в двойные, висячие запятые прочь. Внутри строк ничего не трогается.
 */
export function json5ToJson(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  let expectKey = false
  while (i < n) {
    const c = text[i]!
    if (c === '"' || c === "'") {
      let j = i + 1
      let body = ''
      while (j < n && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < n) {
          body += text[j + 1] === "'" ? "'" : text[j]! + text[j + 1]!
          j += 2
          continue
        }
        body += text[j] === '"' ? '\\"' : text[j]!
        j++
      }
      out += `"${body}"`
      i = j + 1
      expectKey = false
      continue
    }
    if (c === '{' || c === ',') {
      // Висячая запятая: `,` перед `}`/`]`.
      if (c === ',') {
        const rest = text.slice(i + 1).match(/^\s*([}\]])/)
        if (rest) {
          i++
          continue
        }
      }
      out += c
      i++
      expectKey = c === '{' || (c === ',' && isInObject(out))
      continue
    }
    if (expectKey && /[A-Za-z_$0-9]/.test(c)) {
      const m = /^[A-Za-z_$0-9][\w$-]*/.exec(text.slice(i))!
      const after = text.slice(i + m[0].length).match(/^\s*:/)
      if (after) {
        out += `"${m[0]}"`
        i += m[0].length
        expectKey = false
        continue
      }
    }
    if (!/\s/.test(c)) expectKey = false
    out += c
    i++
  }
  return out
}

/** Последняя незакрытая скобка вывода — `{` (ключ после запятой) или `[` (элемент). */
function isInObject(out: string): boolean {
  let depth = 0
  let inStr = false
  for (let k = out.length - 1; k >= 0; k--) {
    const ch = out[k]!
    if (ch === '"' && out[k - 1] !== '\\') inStr = !inStr
    if (inStr) continue
    if (ch === '}' || ch === ']') depth++
    else if (ch === '{' || ch === '[') {
      if (depth === 0) return ch === '{'
      depth--
    }
  }
  return false
}

/** Значение `extra` агента: объект как есть, строка JSON / JSON5 — разобранной. */
function jsonOf(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!/^[[{]/.test(t)) return v
  try {
    return JSON.parse(t)
  } catch {
    try {
      return JSON.parse(json5ToJson(t))
    } catch {
      return v
    }
  }
}

/** Поле агента: сам документ или его `extra` (строкой JSON — из `.mdz`/`%meta`). */
export function agentField(agent: unknown, key: string): unknown {
  const a = (agent ?? {}) as Record<string, unknown> & { extra?: Record<string, unknown> }
  return jsonOf(a[key] ?? a.extra?.[key])
}

// ────────────────────────────────────────────────────────────────────────────
// Тип бота и шаблон (§4)
// ────────────────────────────────────────────────────────────────────────────

export type BotType = 'ccv3' | 'nr' | 'raw'
export const BOT_TYPES: readonly BotType[] = ['ccv3', 'nr', 'raw']

/** `data` карты: обёртка `{spec, data}` или плоская. */
export function cardDataOf(card: unknown): Record<string, unknown> {
  if (!isRecord(card)) return {}
  return isRecord(card.data) ? card.data : card
}

/** `extensions.nrchat` карты. */
export function nrchatExt(card: unknown): Record<string, unknown> {
  const ext = cardDataOf(card).extensions
  return isRecord(ext) && isRecord(ext.nrchat) ? ext.nrchat : {}
}

/** Тип бота: `type` карты → `extensions.nrchat.type` → `ccv3`. */
export function botTypeOf(card: unknown): BotType {
  const d = cardDataOf(card)
  const t = d.type ?? nrchatExt(card).type ?? (layoutOf(card) ? 'nr' : undefined)
  return (BOT_TYPES as readonly unknown[]).includes(t) ? (t as BotType) : 'ccv3'
}

/** Тип объявлен явно (карта не по умолчанию): только тогда шаблон типа перебивает агента. */
export function botTypeDeclared(card: unknown): boolean {
  const d = cardDataOf(card)
  return (BOT_TYPES as readonly unknown[]).includes(d.type ?? nrchatExt(card).type) || layoutOf(card) !== undefined
}

/** Свой шаблон бота (`extensions.nrchat.template`): текст `.mds` или путь от каталога профилей. */
export function botTemplateOf(card: unknown): string | undefined {
  return str(nrchatExt(card).template)
}

/** Встроенный шаблон типа (§4): `ccv3` → `rp.mds`, `nr` → `bot-nr.mds`, `raw` → `bot-raw.mds`. */
export const BOT_TYPE_TEMPLATES: Readonly<Record<BotType, string>> = { ccv3: 'rp.mds', nr: 'bot-nr.mds', raw: 'bot-raw.mds' }

/**
 * Шаблон сборки каскадом (§4): шаблон экземпляра бота в сессии (карта персоны
 * сессии — она и есть экземпляр, копия библиотечной) → шаблон типа (только если тип
 * объявлен явно) → агент → встроенный. `undefined` — решает агент (как раньше).
 */
export function botTemplateRef(card: unknown): { ref: string; from: 'bot' | 'type' } | undefined {
  const own = botTemplateOf(card)
  if (own) return { ref: own, from: 'bot' }
  if (botTypeDeclared(card)) return { ref: BOT_TYPE_TEMPLATES[botTypeOf(card)], from: 'type' }
  return undefined
}

/** Бот хода: персона по id → по имени (с картой) → первая char с картой. */
export function turnBot(doc: PersonasDoc | undefined, who?: { id?: string; name?: string }): Persona | undefined {
  const chars = (doc?.personas ?? []).filter((p) => p.kind === 'char')
  return (who?.id ? chars.find((p) => p.id === who.id) : undefined) ?? (who?.name ? chars.find((p) => p.name === who.name && p.card !== undefined) : undefined) ?? chars.find((p) => p.card !== undefined)
}

// ────────────────────────────────────────────────────────────────────────────
// Бот `nr` (§4.2) и `raw` (§4.3)
// ────────────────────────────────────────────────────────────────────────────

export interface NrBotState {
  id: string
  text: string
  /** Копия в `tail` на N ходов (§6); 0 — нет. */
  ttl?: number
}

export interface NrBotGreeting {
  id?: string
  state?: string
  text: string
  /** Под какие значения переменных написан (§6). */
  vars?: Record<string, string>
}

export interface NrBotExample {
  text: string
  /** `user` / `assistant` — ходом (`turns`); нет — блоком. */
  role?: 'user' | 'assistant'
}

/**
 * Персонаж ансамбля бота `nr` (§7 «ядро формы по имени»): справочник — наверху у всех,
 * форма — в хвосте только у упомянутых (имя или ключ) в последних `cast_scan` постах.
 */
export interface NrCastMember {
  name: string
  /** Ключи упоминания сверх имени (склонения, прозвища). */
  keys: string[]
  reference: string
  form: string
  /** Вероятность подачи формы, % (манеры без рефрена, §7 [гипотеза]); нет — 100. */
  chance?: number
}

/** Поля бота `nr` по сортам (§3, §4.2); `raw` — `text` одним полем. */
export interface NrBotFields {
  reference: string
  form: string
  rules: string
  states: NrBotState[]
  greetings: NrBotGreeting[]
  examples: NrBotExample[]
  /** `block` (в `top`) | `turns` (ходами перед гритингом, со сроком) (§8). */
  examplesMode: 'block' | 'turns'
  /** Срок жизни примеров ходами, ходов (§8); по умолчанию 3. */
  examplesTtl: number
  /** Ансамбль (§7): персонажи со своими справочником и формой. */
  cast: NrCastMember[]
  /** Сколько последних постов смотреть на упоминание (§7, N = 5). */
  castScan: number
  text: string
}

/** Секции справочника: строка или `[{title, text}]`. */
function sectionsText(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (!Array.isArray(v)) return ''
  return v
    .map((s) => (isRecord(s) ? [str(s.title) ? `## ${String(s.title).trim()}` : '', String(s.text ?? '').trim()].filter(Boolean).join('\n') : typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

/** Поля бота `nr`/`raw` из карты; у `ccv3` — пустые. */
export function nrBotFields(card: unknown): NrBotFields {
  const d = cardDataOf(card)
  const states: NrBotState[] = Array.isArray(d.states)
    ? d.states.filter(isRecord).filter((s) => str(s.id) && str(s.text)).map((s) => ({ id: String(s.id), text: String(s.text), ...(typeof s.ttl === 'number' && s.ttl > 0 ? { ttl: Math.floor(s.ttl) } : {}) }))
    : []
  const greetings: NrBotGreeting[] = Array.isArray(d.greetings)
    ? d.greetings
        .map((g) => (typeof g === 'string' ? { text: g } : isRecord(g) && str(g.text) ? { ...(str(g.id) ? { id: String(g.id) } : {}), ...(str(g.state) ? { state: String(g.state) } : {}), text: String(g.text), ...(isRecord(g.vars) ? { vars: Object.fromEntries(Object.entries(g.vars).map(([k, v]) => [k, String(v)])) } : {}) } : undefined))
        .filter((g): g is NrBotGreeting => g !== undefined)
    : []
  const examples: NrBotExample[] = Array.isArray(d.examples)
    ? d.examples
        .map((e) => (typeof e === 'string' ? { text: e } : isRecord(e) && str(e.text) ? { text: String(e.text), ...(e.role === 'user' || e.role === 'assistant' ? { role: e.role } : {}) } : undefined))
        .filter((e): e is NrBotExample => e !== undefined)
    : []
  const ttl = Number(d.examples_ttl)
  const cast: NrCastMember[] = Array.isArray(d.cast)
    ? d.cast.filter(isRecord).filter((c) => str(c.name)).map((c) => {
        const chance = Number(c.chance)
        return {
          name: String(c.name).trim(),
          keys: Array.isArray(c.keys) ? c.keys.filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim()) : [],
          reference: sectionsText(c.reference),
          form: sectionsText(c.form),
          ...(Number.isFinite(chance) && chance >= 0 && chance < 100 ? { chance } : {}),
        }
      })
    : []
  const scan = Number(d.cast_scan)
  // раскладка кубиков: куски — на те же блоки (справочник наверху, форма в хвосте, гритинги)
  const lay = layoutOf(card)
  const lp = lay ? layoutParts(lay) : undefined
  const join = (a: string, b: string | undefined) => [a, b ?? ''].filter(Boolean).join('\n\n')
  if (lp && !greetings.length) greetings.push(...lp.greetings)
  if (lp && !examples.length) examples.push(...lp.examples.map((text) => ({ text })))
  return {
    reference: join(sectionsText(d.reference), lp?.reference),
    form: join(sectionsText(d.form), lp?.form),
    rules: sectionsText(d.rules),
    states,
    greetings,
    examples,
    examplesMode: d.examples_mode === 'turns' ? 'turns' : 'block',
    examplesTtl: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 3,
    cast,
    castScan: Number.isFinite(scan) && scan > 0 ? Math.floor(scan) : 5,
    text: typeof d.text === 'string' ? d.text.trim() : '',
  }
}

/**
 * Активные персонажи ансамбля (§7): имя или ключ встречается (без регистра, подстрокой —
 * как ключи лорбука) в последних `scan` постах; у кого `chance` — бросок `rollPct(name)`.
 */
export function activeCast(cast: readonly NrCastMember[], posts: readonly string[], scan: number, rollPct?: (key: string) => number): NrCastMember[] {
  const text = posts.slice(-scan).join('\n').toLowerCase()
  return cast.filter((c) => [c.name, ...c.keys].some((k) => text.includes(k.toLowerCase())) && (c.chance === undefined || !rollPct || rollPct(`cast\u0001${c.name}`) < c.chance))
}

/** Гритинги бота любого типа текстами: `nr` — `greetings[]`, `raw` — `greeting`, `ccv3` — `first_mes` + `alternate_greetings`. */
export function botGreetings(card: unknown): NrBotGreeting[] {
  const t = botTypeOf(card)
  const d = cardDataOf(card)
  if (t === 'nr') return nrBotFields(card).greetings
  if (t === 'raw') return str(d.greeting) ? [{ text: String(d.greeting) }] : []
  return [d.first_mes, ...(Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [])].filter((g): g is string => typeof g === 'string' && g.trim() !== '').map((text) => ({ text }))
}

/**
 * Гритинг под значения переменных (§6): рукописный автора с `vars`, совпавшими со
 * всеми его ключами, побеждает; нет такого — `undefined` (играет выбранный как есть).
 */
export function greetingForVars(greetings: readonly NrBotGreeting[], values: Readonly<Record<string, string>>): number | undefined {
  const i = greetings.findIndex((g) => g.vars && Object.keys(g.vars).length && Object.entries(g.vars).every(([k, v]) => values[k] === v))
  return i < 0 ? undefined : i
}

// ────────────────────────────────────────────────────────────────────────────
// Переменные пресета (§5)
// ────────────────────────────────────────────────────────────────────────────

export type VarSlot = 'top' | 'tail' | 'last'

export interface PresetVarValue {
  text: string
  hard?: boolean
  /** Текст на языке игры (§5 «наборы на язык»): `{ru: '…'}` — при `language: ru`. */
  lang?: Record<string, string>
}

export interface PresetVar {
  id: string
  label: string
  values: Record<string, PresetVarValue>
  default?: string
  /** Умолчание по языку игры (§5): `{ru: 'mixed', en: 'past'}` — перебивает `default`. */
  defaults?: Record<string, string>
  slot: VarSlot
  /** Значение, выбранное игроком (чип, персона), — жёсткое (`last` после PHI). По умолчанию — у `language`. */
  hardPlayer: boolean
}

/** Переменные формы — по умолчанию в хвосте (§5); прочие (`rating`, роль рассказчика) — в `top`. */
export const FORM_VARS: readonly string[] = ['language', 'person', 'tense', 'length']

/**
 * Объявление переменных агента: `vars: {<id>: {label, values: {<значение>: текст | {text, hard}}, default, slot, hard_player}}`
 * (`%meta` агента `.mds` или `$vars` профиля `.mdz` — в `extra` строкой JSON).
 */
export function presetVarsOf(agent: unknown): PresetVar[] {
  const raw = agentField(agent, 'vars')
  if (!isRecord(raw)) return []
  const out: PresetVar[] = []
  for (const [id, v] of Object.entries(raw)) {
    if (!isRecord(v) || !isRecord(v.values)) continue
    const values: Record<string, PresetVarValue> = {}
    for (const [val, t] of Object.entries(v.values)) {
      if (typeof t === 'string') values[val] = { text: t }
      else if (isRecord(t) && typeof t.text === 'string') {
        const lang = isRecord(t.lang) ? Object.fromEntries(Object.entries(t.lang).filter(([, x]) => typeof x === 'string')) as Record<string, string> : undefined
        values[val] = { text: t.text, ...(t.hard === true ? { hard: true } : {}), ...(lang && Object.keys(lang).length ? { lang } : {}) }
      }
    }
    const slot: VarSlot = v.slot === 'top' || v.slot === 'tail' || v.slot === 'last' ? v.slot : FORM_VARS.includes(id) ? 'tail' : 'top'
    out.push({
      id,
      label: str(v.label) ?? id,
      values,
      ...(str(v.default) ? { default: String(v.default) } : {}),
      ...(isRecord(v.defaults) ? { defaults: Object.fromEntries(Object.entries(v.defaults).filter(([, x]) => typeof x === 'string')) as Record<string, string> } : {}),
      slot,
      hardPlayer: typeof v.hard_player === 'boolean' ? v.hard_player : id === 'language',
    })
  }
  return out
}

/** Слой значения: откуда пришло (`chip` — один ран, `persona`, `bot`, `agent`). */
export type VarLayer = 'chip' | 'persona' | 'bot' | 'agent'

export interface ResolvedVar {
  id: string
  value: string
  layer: VarLayer
  text: string
  slot: VarSlot
}

/** `extensions.nrchat.vars` карты (персона, бот в сессии). */
export function cardVarsOf(card: unknown): Record<string, string> {
  const v = nrchatExt(card).vars
  return isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' && x !== '').map(([k, x]) => [k, String(x)])) : {}
}

/** Мета реплики игрока с перебивкой на один ран (чип): `meta.vars`. */
export const VARS_META = 'vars'

/** Чип хода: `meta.vars` последней реплики игрока на пути. */
export function chipVarsOf(path: readonly DtoMessage[]): Record<string, string> {
  const last = [...path].reverse().find((m) => m.role === 'user')
  const v = (last?.meta as Record<string, unknown> | undefined)?.[VARS_META]
  return isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' && x !== '').map(([k, x]) => [k, String(x)])) : {}
}

/**
 * Значения переменных каскадом (§5, как «Игра» cyoa-spec §5.1): чип → персона →
 * бот в сессии → агент. Значения нет в вариантах — слой пропускается.
 * `hard` — флаг значения; у `hardPlayer` — и когда значение выбрал игрок (чип, персона).
 */
export function resolveVars(decl: readonly PresetVar[], layers: { chip?: Record<string, string>; persona?: Record<string, string>; bot?: Record<string, string> }): ResolvedVar[] {
  const out: ResolvedVar[] = []
  const pickOf = (d: PresetVar, lang: string | undefined) => {
    const pick = (['chip', 'persona', 'bot'] as const).map((l) => [l, layers[l]?.[d.id]] as const).find(([, v]) => v !== undefined && d.values[v] !== undefined)
    const layer: VarLayer = pick ? pick[0] : 'agent'
    // Умолчание агента — по языку игры (§5), иначе общее.
    const value = pick ? pick[1]! : (lang !== undefined ? d.defaults?.[lang] : undefined) ?? d.default
    return { layer, value }
  }
  // Язык игры — первым: от него зависят умолчания и тексты остальных (наборы на язык, §5).
  const langDecl = decl.find((d) => d.id === 'language')
  const lang = langDecl ? pickOf(langDecl, undefined).value : undefined
  for (const d of decl) {
    const { layer, value } = pickOf(d, lang)
    if (value === undefined || !d.values[value]) continue
    const def = d.values[value]!
    const hard = def.hard === true || (d.hardPlayer && (layer === 'chip' || layer === 'persona'))
    const text = ((lang !== undefined ? def.lang?.[lang] : undefined) ?? def.text).trim()
    if (!text) continue
    out.push({ id: d.id, value, layer, text, slot: hard ? 'last' : d.slot })
  }
  return out
}

/** Тексты переменных по слотам: `top`, `tail` (один блок формы), `last` (жёсткие, после PHI). */
export function varsBlocks(resolved: readonly ResolvedVar[]): Record<VarSlot, string> {
  const join = (slot: VarSlot) => resolved.filter((r) => r.slot === slot).map((r) => r.text).join('\n')
  return { top: join('top'), tail: join('tail'), last: join('last') }
}

/** Значения переменных хода одним объектом (`vars.language`…) для условий шаблона. */
export function varsValues(resolved: readonly ResolvedVar[]): Record<string, string> {
  return Object.fromEntries(resolved.map((r) => [r.id, r.value]))
}

// ────────────────────────────────────────────────────────────────────────────
// Заметки чата (§11) и заметка формы (§13 п. 4)
// ────────────────────────────────────────────────────────────────────────────

export type NoteScope = 'chat' | 'bot' | 'default'

export interface ChatNote {
  text: string
  /** `tail` — в хвост хода; число — глубина от конца ленты. */
  slot: 'tail' | number
  role: 'system' | 'user' | 'assistant'
  /** Раз в N ходов игрока (1 — каждый). */
  every: number
  scope: NoteScope
}

function notesFrom(v: unknown, scope: NoteScope): ChatNote[] {
  const list = Array.isArray(v) ? v : isRecord(v) ? [v] : []
  return list.filter(isRecord).filter((n) => str(n.text) && n.enabled !== false).map((n) => {
    const depth = typeof n.slot === 'number' ? n.slot : typeof n.slot === 'string' && /^depth\s+\d+$/.test(n.slot.trim()) ? Number(n.slot.trim().split(/\s+/)[1]) : typeof n.depth === 'number' ? n.depth : undefined
    const every = Number(n.every)
    return {
      text: String(n.text).trim(),
      slot: depth !== undefined && Number.isFinite(depth) && depth >= 0 ? Math.floor(depth) : 'tail',
      role: n.role === 'user' || n.role === 'assistant' ? n.role : 'system',
      every: Number.isFinite(every) && every >= 1 ? Math.floor(every) : 1,
      scope,
    }
  })
}

/**
 * Заметки хода (§11): области «этот чат» (`meta.notes` сессии) · «этот бот везде»
 * (`extensions.nrchat.notes` карты бота) · «по умолчанию» (`notes` агента). Идёт
 * заметка, если номер хода игрока делится на `every`.
 */
export function chatNotes(a: { meta: unknown; card: unknown; agent: unknown; path: readonly DtoMessage[] }): ChatNote[] {
  const all = [
    ...notesFrom(isRecord(a.meta) ? a.meta.notes : undefined, 'chat'),
    ...notesFrom(nrchatExt(a.card).notes, 'bot'),
    ...notesFrom(layoutNotes(a.card), 'bot'),
    ...notesFrom(agentField(a.agent, 'notes'), 'default'),
  ]
  const turn = Math.max(1, a.path.filter((m) => m.role === 'user').length)
  return all.filter((n) => turn % n.every === 0)
}

/** Куски раскладки «каждый N-й ход» — заметками «этот бот». */
function layoutNotes(card: unknown): unknown {
  const l = layoutOf(card)
  return l ? layoutParts(l).notes : undefined
}

/** Заметка формы экземпляра бота (§13 п. 4): блок `form` в хвосте, карта не трогается. */
export function formNoteOf(card: unknown): string {
  const v = nrchatExt(card).form_note
  return typeof v === 'string' ? v.trim() : ''
}

// ────────────────────────────────────────────────────────────────────────────
// Формат сообщений (§8a)
// ────────────────────────────────────────────────────────────────────────────

export type NamesMode = 'always' | 'personas' | 'off'

/** `names` агента; по умолчанию — `personas` (как сейчас). */
export function namesModeOf(agent: unknown): NamesMode {
  const v = agentField(agent, 'names')
  return v === 'always' || v === 'off' ? v : 'personas'
}

/** `stop_user` агента: стоп-строка с именем игрока. По умолчанию — нет. */
export function stopUserOf(agent: unknown): boolean {
  const v = agentField(agent, 'stop_user')
  return v === true || v === 'true' || v === 'yes' || v === 'да' || v === 'on'
}

/**
 * Раскладка группы (§9) — переменная агента `group_layout`:
 *  - `actor` (по умолчанию, как было) — карта говорящего наверху: свой верх и кэш у каждого актёра;
 *  - `narrator` — один верх рассказчика со всеми картами: один кэш, карта не прыгает со сменой хода;
 *  - `tail` — общий верх без карт, карта говорящего в хвосте хода (owner 10.11) [гипотеза, стол].
 * Одиночной сессии раскладка не касается.
 */
export type GroupLayout = 'actor' | 'narrator' | 'tail'

export function groupLayoutOf(agent: unknown): GroupLayout {
  const v = agentField(agent, 'group_layout')
  return v === 'narrator' || v === 'tail' ? v : 'actor'
}

/** Закреплённый слот кэша локального llama.cpp (§9): `id_slot` агента. */
export function idSlotOf(agent: unknown): number | undefined {
  const n = Number(agentField(agent, 'id_slot'))
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

export type { Persona }
