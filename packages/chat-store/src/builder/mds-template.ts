/**
 * Билдер `mds-template` (session-document-spec §4.3): шаблон агента `.mds` ×
 * документ сессии → узлы промпта, рецепт и `.mds` выхода.
 *
 *  1. Шаблон разбирается кодеком nr-chat (`%role name {meta}` — тот же формат,
 *     что под pi-session-mds): `%system`/`%user`/`%assistant` — узлы, слова
 *     имени `prefill`/`hidden` и мета `{source, prefill, hidden}` — пометки,
 *     `%include <файл>` — узлы файла как есть, `%meta {…}` — мета выхода.
 *  2. Тело узла — ntpl (`nrd/template`: `<{ }>`, `<< >>`, `<# #>`; `{{…}}`
 *     сквозь) с контекстом §4.4, фильтрами и тегами §4.5 (`tags.ts`).
 *  3. История — путь сессии с именами по персонам и маркером «продолжай»;
 *     вставки `inject` — на глубине от конца ленты (история и узлы после неё,
 *     без префила) — как `assembleRp`.
 *  4. Макросы `{{user}}`/`{{char}}` раскрываются на итоговом тексте узлов
 *     шаблона и в тексте истории (гритинг хранит `{{user}}`).
 *
 * Семантика RP-кусков — те же хелперы, что у `assembleRp` (лорбук ×3, блок
 * персоны, блок участников, impersonate, вставка на глубине): `rp.mds` обязан
 * давать тот же system и те же инъекции (паритет — тест backend-nr).
 */

import { parse, stringify, type ChatMessage } from '@kerneldreams/nrd/chat'
import { createEnv } from '@kerneldreams/nrd/template'
import type { Message as DtoMessage, Part, Persona, PersonasDoc } from '../model.js'
import { compactionData } from '../assembly/engine.js'
import { subNodeToPart } from '../nr-chat/parts.js'
import { loreSourceLabel, type LoreSelection } from '../assembly/lorebook.js'
import { loreV2Label, loreV2Reason, rollPercent, type LoreV2Selection } from '../assembly/lore-v2.js'
import { LORE_NODE_PREFIX, loreDiagnostics, loreInserts, mergedLoreText, runLore } from '../assembly/lore-run.js'
import {
  PERSONA_INJECTION_SOURCE,
  charPersonas,
  expandMessageNames,
  expandPersonaNames,
  expandPlayerNames,
  personaPrefixed,
  personasSystemBlock,
  personasTurnLine,
  personasVoiced,
  playPersonas,
  turnPersona,
  userPersona,
} from '../assembly/personas.js'
import { EDITOR_SOURCE, directionMacros, editorNotesForTurn, editorNotesText, type TurnEditorNotes } from '../assembly/cyoa.js'
import { CONTINUE_TEXT, impersonatePrompt, injectAtDepth, type SystemBlock } from '../assembly/rp.js'
import { activeCast, botTypeOf, cardVarsOf, groupLayoutOf, type GroupLayout, chatNotes, chipVarsOf, formNoteOf, idSlotOf, namesModeOf, nrBotFields, presetVarsOf, resolveVars, stopUserOf, varsBlocks, varsValues, type ChatNote, type NrBotFields, type ResolvedVar } from '../assembly/bot.js'
import { estimateTokens } from '../assembly/tokens.js'
import { CONTINUE_SOURCE, IMPERSONATE_SOURCE, SYNTHETIC_ID_PREFIX, insertAfter, textOf, type RpInjection } from '../assembly/assemble-rp.js'
import type { BuildInput, BuildOutput, BuildRecipe, PromptBuilder, PromptNode } from './contract.js'
import { PROJECT_TAG_RE, mark, parseRendered, preprocess, registerTags, splitLeadingSources, stripMarks, type InjectSpec } from './tags.js'

export const MDS_TEMPLATE_BUILDER = 'mds-template'

/** Поля карты, из которых собирается текст карточки для скана лорбука (порядок story string). */
/** Шаблон сам печатает платформенные блоки: `<< base >>`, `<< base.skills >>`, `<{ if base }>`… */
const BASE_REF_RE = /(<<|<\{)-?[^}>]*\bbase\b/

const CARD_SCAN_FIELDS =['system_prompt', 'description', 'personality', 'scenario', 'mes_example'] as const

/** Тайные поля user-персоны (personas-spec §9) — видит только impersonate. */
const USER_SECRET_FIELDS = ['scenario', 'system_prompt', 'post_history_instructions'] as const

export const mdsTemplateBuilder: PromptBuilder = {
  name: MDS_TEMPLATE_BUILDER,
  build: buildMdsTemplate,
}

// ────────────────────────────────────────────────────────────────────────────

interface TemplateNode {
  role: string
  body: string
  /**
   * Вызовы тулов примера (`%%tool_use` под `%assistant`, `%%tool_result` под `%tool`): уходят модели частями, как в
   * истории, — пример «запрос → вызов тула → ответ» модель видит настоящим вызовом, а не текстом про него.
   */
  parts?: Part[]
  source?: string
  prefill: boolean
  hidden: boolean
  /** Узел из `%include` — не рендерится. */
  raw?: boolean
  /** Контракт блока ( §2): `stable: false` — меняется между ходами (рвёт кэш наверху). */
  stable?: boolean
  /** Порядок вытеснения при нехватке окна; нет — не вытесняется. */
  evict?: number
  /** Сорт содержимого: reference · form · position · rules. */
  sort?: string
  /** Место: top · examples · depth N · tail · last (для рецепта и предупреждений). */
  slot?: string
}

/** Шаблон → записи (узлы, include, meta). Ошибки — текстом с путём шаблона. */
export function parseTemplate(text: string, where = 'шаблон'): { nodes: TemplateNode[]; includes: string[]; meta: Record<string, unknown>; records: ChatMessage[] } {
  const records = parse(text)
  if (!records.length) throw new Error(`${where}: шаблон агента пуст (нет ни одного %-узла)`)
  const includes: string[] = []
  const nodes: TemplateNode[] = []
  let meta: Record<string, unknown> = {}
  let inMeta = false
  for (const r of records) {
    if (r.role === 'meta') {
      meta = { ...meta, ...(r.meta ?? {}) }
      inMeta = true
      continue
    }
    // `%%поле` под `%meta` — тело поля меты (текст правится руками); не узел промпта.
    if (r.role.startsWith('%')) {
      if (inMeta) meta[r.role.slice(1)] = r.body
      else attachToolPart(nodes, r)
      continue
    }
    inMeta = false
    if (r.role === 'include') {
      const path = (r.name ?? '').trim()
      if (!path) throw new Error(`${where}: %include без файла`)
      includes.push(path)
      continue
    }
    nodes.push(templateNode(r))
  }
  return { nodes, includes, meta, records }
}

/** `%%tool_use` / `%%tool_result` примера — частью к последнему узлу шаблона (другие `%%` здесь не узлы). */
function attachToolPart(nodes: TemplateNode[], r: ChatMessage): void {
  if ((r.role !== '%tool_use' && r.role !== '%tool_result') || !nodes.length) return
  const last = nodes[nodes.length - 1]!
  last.parts = [...(last.parts ?? []), subNodeToPart({ rawRole: r.role, kind: r.role.slice(1), ...(r.name ? { name: r.name } : {}), ...(r.meta ? { meta: r.meta } : {}), body: r.body, message: r as never })]
}

function templateNode(r: ChatMessage, raw = false): TemplateNode {
  const words = new Set((r.name ?? '').split(/\s+/).filter(Boolean))
  const m = r.meta ?? {}
  const node: TemplateNode = {
    role: r.role,
    body: r.body,
    prefill: words.has('prefill') || m.prefill === true,
    hidden: words.has('hidden') || m.hidden === true,
  }
  if (typeof m.source === 'string' && m.source !== '') node.source = m.source
  if (typeof m.stable === 'boolean') node.stable = m.stable
  if (typeof m.evict === 'number' && Number.isFinite(m.evict)) node.evict = m.evict
  if (typeof m.sort === 'string') node.sort = m.sort
  if (typeof m.slot === 'string') node.slot = m.slot
  if (raw) node.raw = true
  return node
}

// ────────────────────────────────────────────────────────────────────────────
// Документ → контекст шаблона
// ────────────────────────────────────────────────────────────────────────────

interface DocView {
  doc: PersonasDoc
  turn: Persona | undefined
  user: Persona | undefined
  voiced: boolean
  names: { char?: string; user?: string }
  card: Record<string, unknown>
  userCard: Record<string, unknown>
  /** Классика (`classic`-книги). */
  lore: LoreSelection | undefined
  /** Лорбук v2. */
  lore2: LoreV2Selection | undefined
  /** Заметки редактора хода (CYOA); у impersonate — пусто. */
  editor: TurnEditorNotes
  /** id последнего user/assistant пути — якорь `once`. */
  lastId: string | undefined
  expand: (text: string) => string
  /** Поля персоны игрока: `{{user}}` и `{{char}}` — оба она (DECISIONS 09.10). */
  expandPlayer: (text: string) => string
  /** Переменные пресета хода ( §5). */
  vars: ResolvedVar[]
  /** Заметки хода (§11). */
  notes: ChatNote[]
  /** Бот хода по сортам (`nr`/`raw`, §4.2). */
  bot: NrBotFields & { type: ReturnType<typeof botTypeOf>; formNote: string }
  /** Номер хода игрока (1 — первый). */
  turnNo: number
  /** Тексты постов пути (user/assistant) — скан упоминаний ансамбля (§7). */
  posts: string[]
  /** Зерно броска хода (`chance` ансамбля): то же, что у лорбука. */
  roll: string
  /** Индекс выбранного гритинга (если сборка его видит). */
  greetingIndex?: number
}

function viewOf(input: BuildInput): DocView {
  const { document: d } = input
  const doc: PersonasDoc = { personas: playPersonas({ personas: d.personas }).personas, ...(d.userId !== undefined ? { userId: d.userId } : {}) }
  const hasCast = doc.personas.length > 0
  const turn = hasCast ? turnPersona(doc, input.turn?.target) ?? turnPersona(doc) : undefined
  const user = hasCast ? userPersona(doc) : undefined
  // Формат сообщений (§8a): `names` агента — always / personas (как было) / off.
  const namesMode = namesModeOf(input.agent)
  const voiced = namesMode === 'off' ? false : hasCast && (namesMode === 'always' || personasVoiced(doc, turn))
  const names = {
    ...(turn?.name ?? charPersonas(doc)[0]?.name ? { char: (turn?.name ?? charPersonas(doc)[0]?.name)! } : {}),
    ...(user?.name ?? personaUserOf(d.meta) ? { user: (user?.name ?? personaUserOf(d.meta))! } : {}),
  }
  const expand = (text: string) => expandPersonaNames(text, names)
  const expandPlayer = (text: string) => expandPlayerNames(text, names.user)
  const card = isRecord(turn?.card) ? turn!.card : {}
  const userCard = userCardOf(user)

  // Лорбук v2: книги всех char-персон (старый `meta.lorebook` — книга первой), персоны, сессии, профиля.
  // Карточка для скана: override меты или текст карты, и ОТКРЫТЫЕ поля персоны.
  const botText = nonEmpty(promptOf(d.meta).pre) ?? cardStory(card)
  const cardText = [botText === undefined ? undefined : expand(botText), ...[str(userCard.description), str(userCard.personality)].map((t) => (t === undefined ? t : expandPlayer(t)))]
    .filter((t): t is string => t !== undefined && t.trim() !== '')
    .join('\n')
  const userForLore = user ? ({ ...user, card: { ...userCard, ...(isRecord(user.card) ? user.card : {}) } } as Persona) : undefined
  const lore2 = runLore({
    meta: d.meta as Record<string, unknown>,
    doc,
    user: userForLore,
    path: d.path,
    books: input.profileLore?.books ?? [],
    ...(input.profileLore ? { extras: input.profileLore } : {}),
    expand,
    cardText,
    scanCard: input.profileLore?.scanCard === true,
    ...(input.turn?.impersonate ? { impersonate: true } : {}),
    seed: input.session.id,
    ...(input.turn?.roll !== undefined ? { roll: input.turn.roll } : {}),
    ...(d.greeting ? { greeting: d.greeting.index } : {}),
    ...(input.profileLore?.budget !== undefined ? { budget: input.profileLore.budget } : {}),
  })
  const lore = lore2?.classic
  const lastId = [...d.path].reverse().find((m) => !compactionData(m) && (m.role === 'user' || m.role === 'assistant'))?.id
  const editor = input.turn?.impersonate ? { notes: [] } : editorNotesForTurn(d.path)
  // Переменные пресета (§5): чип (реплика игрока хода) → персона → бот в сессии → агент.
  const vars = resolveVars(presetVarsOf(input.agent), { chip: chipVarsOf(d.path), persona: cardVarsOf(user?.card), bot: cardVarsOf(turn?.card) })
  const notes = input.turn?.impersonate ? [] : chatNotes({ meta: d.meta, card: turn?.card, agent: input.agent, path: d.path })
  const bot = { ...nrBotFields(turn?.card), type: botTypeOf(turn?.card), formNote: formNoteOf(turn?.card) }
  const turnNo = Math.max(1, d.path.filter((m) => m.role === 'user').length)
  const posts = d.path.filter((m) => (m.role === 'user' || m.role === 'assistant') && !compactionData(m)).map((m) => textOf(m))
  const roll = input.turn?.roll ?? `${input.session.id}\u0001${lastId ?? ''}\u0001${d.path.length}`
  return { doc, turn, user, voiced, names, card, userCard, lore, lore2, editor, lastId, expand, expandPlayer, vars, notes, bot, turnNo, posts, roll, ...(d.greeting ? { greetingIndex: d.greeting.index } : {}) }
}

/** Текст карты, как его раскладывал `card-pre.ntpl` импорта: для скана лорбука. */
function cardStory(card: Record<string, unknown>): string | undefined {
  const parts: string[] = []
  for (const k of CARD_SCAN_FIELDS) {
    const v = str(card[k])
    if (v && v.trim()) parts.push(v.trim())
  }
  return parts.length ? parts.join('\n\n') : undefined
}

/** Поля user-персоны: плоские (старые записи) под картой (новые). */
function userCardOf(user: Persona | undefined): Record<string, unknown> {
  if (!user) return {}
  const flat = user as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['description', 'personality', ...USER_SECRET_FIELDS]) if (typeof flat[k] === 'string') out[k] = flat[k]
  return { ...out, ...(isRecord(user.card) ? user.card : {}) }
}

/**
 * Главный промпт impersonate по умолчанию: модель пишет за игрока —
 * GM-инструкции агента и карты бота («не пиши за {{user}}») сюда не идут.
 */
export const DEFAULT_IMPERSONATE_PRE =
  "You are writing as {{user}}, the player's character, in an ongoing roleplay with {{char}}. Stay in {{user}}'s voice and knowledge; do not narrate for {{char}}."

/**
 * Поля персоны игрока для шаблона (`player.<поле>`): текст с
 * источником `persona.<поле>`, `{{user}}` и `{{char}}` — оба имя персоны
 * (DECISIONS 09.10); пусто — поля нет (`default` шаблона срабатывает). Плоские
 * поля под картой персоны (карта сильнее) — как `userCardOf`.
 */
function playerOf(v: DocView): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['description', 'personality', ...USER_SECRET_FIELDS]) {
    const text = nonEmpty(str(v.userCard[k]))
    if (text !== undefined && text.trim() !== '') out[k] = mark.source(`persona.${k}`) + v.expandPlayer(text).trim()
  }
  return out
}

/** Строка с источниками блоков: каждый кусок со своим `S:`-маркером, через пустую строку. */
function sourced(blocks: ReadonlyArray<{ source: string; text: string }>): string {
  return blocks
    .filter((b) => b.text.trim() !== '')
    .map((b) => mark.source(b.source) + b.text)
    .join('\n\n')
}

/** Строка с полями (`base.skills`): `<< base >>` печатает строку, поля — для выборочной вставки. */
function stringWith(text: string, fields: Record<string, string>): string {
  // eslint-disable-next-line no-new-wrappers
  return Object.assign(new String(text), fields) as unknown as string
}

function contextOf(input: BuildInput, v: DocView): Record<string, unknown> {
  const { document: d, agent } = input
  const lore = v.lore
  const fired = (list: LoreSelection['before']) => list.map((e) => ({ source: loreSourceLabel(e.source, e.name), text: e.content }))
  const prefix = (pos: 'before_char' | 'after_char') => (v.lore2?.prefix ?? []).filter((e) => (e.position ?? 'before_char') === pos).map((e) => ({ source: loreV2Label(e), text: e.content }))
  const inserts = loreInserts(v.lore2, v.lastId).map((ins) => ({
    content: ins.fired.content,
    after: ins.after,
    role: ins.merge ? 'user' : 'system',
    send: ins.merge ? '' : 'system',
    merge: ins.merge,
    source: ins.source,
    reason: ins.reason,
    delivery: ins.fired.delivery,
  }))
  const description = str(v.userCard.description)
  const personaText = v.names.user && description?.trim() ? `${v.names.user}'s Persona: ${v.expandPlayer(description).trim()}` : ''
  // Раскладка группы с общим верхом (§9): «чей ход» — из верха в хвост (`group.tail`).
  const groupSplit = groupLayoutOf(input.agent) !== 'actor' && charPersonas(v.doc).filter((p) => isRecord(p.card)).length > 1
  const cast = v.voiced ? personasSystemBlock(v.doc, v.turn, { turnLine: !groupSplit }) : ''
  const skills = input.base.filter((b) => b.source === 'skills')
  const services = input.base.filter((b) => b.source !== 'skills')
  return {
    agent: {
      ...(agent.extra ?? {}),
      id: agent.id,
      name: agent.name,
      pre: agentPre(agent),
      post: agent.prompt?.post ?? '',
      // Главный промпт impersonate без своего у персоны: нейтральный,
      // без GM-инструкций бота; профиль перекрывает `$impersonate_pre`.
      impersonate_pre: mark.source('agent.impersonate_pre') + (nonEmpty(str(agent.extra?.impersonate_pre)) ?? DEFAULT_IMPERSONATE_PRE),
    },
    player: playerOf(v),
    card: v.card,
    char: v.names.char ?? '',
    user: v.names.user ?? '',
    persona: personaText ? mark.source('persona.user') + personaText : '',
    personas: v.doc.personas,
    cast: cast ? mark.source(PERSONA_INJECTION_SOURCE) + cast : '',
    greeting: d.greeting,
    lore: {
      before: sourced([...prefix('before_char'), ...(lore ? fired(lore.before) : [])]),
      after: sourced([...prefix('after_char'), ...(lore ? fired(lore.after) : [])]),
      sticky: inserts.filter((e) => e.delivery === 'sticky'),
      once: inserts.filter((e) => e.delivery === 'once'),
      depth: [
        ...(lore?.depth ?? []).map((e) => ({
          content: e.content,
          depth: e.depth ?? 4,
          role: e.role ?? 'system',
          source: `${loreSourceLabel(e.source, e.name)} @${e.depth ?? 4}`,
          reason: e.reason,
        })),
        // «На глубине» в книгах v2 любой подачи ( §4.1: `depth`/`role` записей ST, `@@depth`).
        ...(v.lore2?.depth ?? []).map((e) => ({ content: e.content, depth: e.depth ?? 4, role: e.role ?? 'system', source: `${loreV2Label(e)} @${e.depth ?? 4}`, reason: e.reason })),
      ],
      dropped: lore?.droppedEntries ?? [],
    },
    // Заметки редактора (CYOA §4): хвост хода после реплики игрока, роль — как `$lore_role`.
    editor: {
      notes: v.editor.anchor && v.editor.notes.length
        ? [{
            content: editorNotesText(v.editor.notes),
            after: v.editor.anchor,
            role: input.profileLore?.role === 'user' ? 'user' : 'system',
            send: input.profileLore?.role === 'user' ? '' : 'system',
            source: EDITOR_SOURCE,
            reason: v.editor.notes.map((n) => `${n.from}#${n.i}`).join(', '),
          }]
        : [],
    },
    base: stringWith(sourced(input.base), { skills: sourced(skills), services: sourced(services) }),
    user_card: input.userCard?.trim() ? mark.source('user-card') + input.userCard.trim() : '',
    meta: d.meta,
    turn: { impersonate: input.turn?.impersonate === true, continue: input.turn?.continue === true, input: input.turn?.input ?? '', number: v.turnNo },
    model: input.model,
    // Переменные пресета ( §5): значения для условий (`vars.person == '1'`) и блоки по слотам.
    vars: varsContext(v.vars),
    // Заметки чата (§11): `notes.tail` — текстом в хвост, `notes.depth` — вставками на глубине.
    notes: {
      tail: sourced(v.notes.filter((n) => n.slot === 'tail').map((n) => ({ source: `note:${n.scope}`, text: n.text }))),
      depth: v.notes.filter((n) => n.slot !== 'tail').map((n) => ({ content: n.text, depth: n.slot as number, role: n.role, source: `note:${n.scope} @${n.slot}` })),
    },
    // Форма в хвосте (§3, §13 п. 4): поле `form` бота `nr` и заметка формы экземпляра.
    form: sourced([{ source: 'bot.form', text: v.bot.form }, ...castForms(v), { source: 'bot.form_note', text: v.bot.formNote }]),
    bot: botContext(v),
    group: groupContext(v, groupLayoutOf(input.agent)),
  }
}

/**
 * `group` шаблона (§9): `split` — раскладка группы не `actor` и персонажей больше одного (тогда
 * шаблон не кладёт карту говорящего наверх); `top` — все карты (рассказчик), `tail` — карта
 * говорящего в хвост. Одиночная сессия: `split: false`, блоки пусты — промпт прежний.
 */
function groupContext(v: DocView, layout: GroupLayout): Record<string, unknown> {
  const chars = charPersonas(v.doc).filter((p) => isRecord(p.card))
  const split = layout !== 'actor' && chars.length > 1
  const cardText = (p: Persona): string => {
    const c = p.card as Record<string, unknown>
    const ex = (t: unknown) => (typeof t === 'string' && t.trim() ? expandPersonaNames(t.trim(), { char: p.name, ...(v.names.user ? { user: v.names.user } : {}) }) : '')
    const reference = nrBotFields(c).reference
    return [`${p.name}:`, ex(c.description) || ex(reference), ex(c.personality) ? `Personality: ${ex(c.personality)}` : '', ex(c.scenario) ? `Scenario: ${ex(c.scenario)}` : ''].filter(Boolean).join('\n')
  }
  const top = split && layout === 'narrator' ? chars.map((p) => mark.source(`group.card:${p.name}`) + cardText(p)).join('\n\n') : ''
  const turnCard = split && layout === 'tail' && v.turn && isRecord(v.turn.card) ? cardText(v.turn) : ''
  const turnLine = split && v.voiced && v.turn ? personasTurnLine(v.doc, v.turn) : ''
  const tail = [turnCard, turnLine].filter(Boolean).join('\n\n')
  const tailMarked = tail ? mark.source(`group.tail:${v.turn?.name ?? ''}`) + tail : ''
  return { layout, size: chars.length, split, top, tail: tailMarked }
}

/** `vars` шаблона: значения по id и блоки `top` / `tail` / `last` с источниками. */
function varsContext(resolved: readonly ResolvedVar[]): Record<string, string> {
  const blocks = varsBlocks(resolved)
  return {
    ...varsValues(resolved),
    top: blocks.top ? mark.source('vars.top') + blocks.top : '',
    tail: blocks.tail ? mark.source('vars.tail') + blocks.tail : '',
    last: blocks.last ? mark.source('vars.last') + blocks.last : '',
  }
}

/** Гритинг бота `nr` хода: выбранный по индексу (нет индекса — первый). */
function activeGreeting(v: DocView): NrBotFields['greetings'][number] | undefined {
  if (v.bot.type !== 'nr') return undefined
  return v.bot.greetings[v.greetingIndex ?? 0]
}

/** Первый ответ бота на пути — гритинг (к нему приклеены состояние и примеры ходами, §6, §8). */
function greetingNodeId(path: readonly DtoMessage[]): string | undefined {
  const first = path.find((m) => !compactionData(m) && (m.role === 'user' || m.role === 'assistant'))
  return first?.role === 'assistant' ? first.id : undefined
}

/** Формы персонажей ансамбля, упомянутых в последних `cast_scan` постах (§7). */
function castForms(v: DocView): Array<{ source: string; text: string }> {
  const b = v.bot
  if (b.type !== 'nr' || !b.cast.length) return []
  const posts = v.posts.slice(-b.castScan)
  return activeCast(b.cast, posts, b.castScan, (k) => rollPercent(v.roll, k)).filter((c) => c.form).map((c) => ({ source: `bot.cast:${c.name}.form`, text: `${c.name}: ${c.form}` }))
}

/** `bot` шаблона: тип и сорта полей (`nr`), текст (`raw`), правила (PHI бота) и копия состояния со сроком. */
function botContext(v: DocView): Record<string, unknown> {
  const b = v.bot
  const greeting = activeGreeting(v)
  const state = greeting?.state ? b.states.find((s) => s.id === greeting.state) : undefined
  const examplesBlock = b.examplesMode === 'block' ? b.examples.map((e) => e.text).join('\n\n') : ''
  return {
    type: b.type,
    reference: [b.reference ? mark.source('bot.reference') + b.reference : '', ...b.cast.filter((c) => c.reference).map((c) => mark.source(`bot.cast:${c.name}`) + `${c.name}:\n${c.reference}`)].filter(Boolean).join('\n\n'),
    rules: b.rules ? mark.source('bot.rules') + b.rules : '',
    text: b.text ? mark.source('bot.text') + b.text : '',
    examples: examplesBlock ? mark.source('bot.examples') + examplesBlock : '',
    state_tail: state?.ttl && v.turnNo <= state.ttl ? mark.source(`bot.state:${state.id}`) + state.text : '',
  }
}

/** Словарь шаблона агента (подсказка конструктора): что шаблон видит. */
export interface TemplateVocabulary {
  /** Переменные контекста: `agent`, `agent.pre`, `player.description`, `lore.before`… */
  variables: string[]
  /** Фильтры ntpl: `card`, `post`, `greeting`, `label`, `macros`. */
  filters: string[]
  /** Теги: `history`, `inject`, `impersonate`, `files`. */
  tags: string[]
  /** Макросы текста на выходе. */
  macros: string[]
}

/**
 * Словарь шаблона — из самого билдера, не списком руками: контекст и
 * фильтры строятся на пустом документе с полной персоной игрока, теги — у
 * расширений ntpl. Новая переменная `contextOf` появится в подсказке сама.
 */
export async function templateVocabulary(): Promise<TemplateVocabulary> {
  const full = Object.fromEntries(['description', 'personality', ...USER_SECRET_FIELDS].map((k) => [k, 'x']))
  const input: BuildInput = {
    session: { id: 'vocabulary' },
    document: { path: [], meta: {}, personas: [{ id: 'c', kind: 'char', name: 'C' }, { id: 'u', kind: 'user', name: 'U', card: full } as Persona], userId: 'u' },
    agent: { id: 'a', name: 'A', template: '', includes: {}, templatePath: 'vocabulary' },
    model: { id: 'm' },
    base: [],
    tools: [],
  }
  const v = viewOf(input)
  const ctx = contextOf(input, v)
  const variables: string[] = []
  for (const [k, val] of Object.entries(ctx)) {
    variables.push(k)
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof String)) for (const sub of Object.keys(val)) variables.push(`${k}.${sub}`)
  }
  for (const sub of ['skills', 'services']) variables.push(`base.${sub}`)
  const env = await createEnv()
  registerTags(env)
  const tags = ((env as unknown as { extensionsList?: Array<{ tags?: string[] }> }).extensionsList ?? []).flatMap((e) => e.tags ?? [])
  return { variables, filters: Object.keys(filtersOf(input, v)), tags, macros: ['{{user}}', '{{char}}', '{{original}}'] }
}

/** `agent.pre`: `$prompt.pre`, иначе тело профиля (`systemPrompt`) — один источник, два способа записать. */
export function agentPre(agent: { prompt?: { pre?: string }; systemPrompt?: string }): string {
  return nonEmpty(agent.prompt?.pre) ?? agent.systemPrompt ?? ''
}

// ────────────────────────────────────────────────────────────────────────────
// Фильтры (§4.4)
// ────────────────────────────────────────────────────────────────────────────

function filtersOf(input: BuildInput, v: DocView) {
  const meta = promptOf(input.document.meta)
  return {
    /** Главный промпт: `meta.prompt.pre` → `card.system_prompt` (`{{original}}` = вход) → вход. */
    card(value: unknown): string {
      const original = strOf(value)
      const override = nonEmpty(meta.pre)
      if (override !== undefined) return mark.source('meta.prompt.pre') + override
      const sp = nonEmpty(str(v.card.system_prompt))
      if (sp !== undefined) return mark.source('card.system_prompt') + replaceOriginal(sp, stripMarks(original))
      return original
    },
    /** Хвост: `meta.prompt.post` → `card.post_history_instructions` (`{{original}}`) → вход. */
    post(value: unknown): string {
      const original = strOf(value)
      const override = nonEmpty(meta.post)
      if (override !== undefined) return mark.source('meta.prompt.post') + override
      const ph = nonEmpty(str(v.card.post_history_instructions))
      if (ph !== undefined) return mark.source('card.post_history_instructions') + replaceOriginal(ph, stripMarks(original))
      return original
    },
    /** Поле из данных выбранного гритинга (`greeting.data.<поле>`, по умолчанию `scenario`), иначе вход. */
    greeting(value: unknown, field = 'scenario'): string {
      const g = input.document.greeting
      const data = g && isRecord(g.data) ? g.data : undefined
      const own = data ? nonEmpty(str(data[field])) : undefined
      if (own !== undefined && g) return mark.source(`greeting[${g.index}].${field}`) + own
      // Своих данных у гритинга нет — текст карты, подпись с номером выбранного.
      const text = strOf(value)
      if (g && stripMarks(text).trim() !== '') {
        const { head, rest } = splitLeadingSources(text)
        return (head || mark.source(`card.${field} @greeting[${g.index}]`)) + rest
      }
      return text
    },
    /** Подпись блока: `label('Personality')` → `Personality: текст`; пусто — пусто. */
    label(value: unknown, name: unknown, sep: unknown = ': '): string {
      const text = strOf(value)
      if (stripMarks(text).trim() === '') return ''
      const { head, rest } = splitLeadingSources(text)
      return `${head}${String(name)}${String(sep)}${rest}`
    },
    /** Явное раскрытие `{{user}}`/`{{char}}` (по умолчанию и так на выходе). */
    macros(value: unknown): string {
      return v.expand(strOf(value))
    },
  }
}

function replaceOriginal(text: string, original: string): string {
  return text.replace(/\{\{\s*original\s*\}\}/gi, () => original)
}

// ────────────────────────────────────────────────────────────────────────────
// Сборка
// ────────────────────────────────────────────────────────────────────────────

type Piece =
  | { kind: 'node'; node: PromptNode; blocks: SystemBlock[]; template: TemplateNode }
  | { kind: 'history'; injects: InjectSpec[] }
  | { kind: 'impersonate' }

export async function buildMdsTemplate(input: BuildInput): Promise<BuildOutput> {
  const where = `агент ${input.agent.id || '?'} (${input.agent.templatePath ?? 'шаблон'})`
  const tpl = parseTemplate(input.agent.template, where)
  // Контекст проекта (spaces-spec §4): агент с `project: false` его не берёт, скиллы старта — да.
  const prefix = (input.agent.project ?? []).filter((b) => !(tpl.meta.project === false && b.source === 'project'))
  const v = viewOf(input)
  const filters = filtersOf(input, v)
  const env = await createEnv({
    helpers: [
      (e) => {
        registerTags(e, { files: input.agent.files ?? {}, project: prefix })
        for (const [name, fn] of Object.entries(filters)) e.addFilter(name, fn as (...a: unknown[]) => unknown)
      },
    ],
  })
  const ctx = contextOf(input, v)

  // Узлы шаблона и include → куски (рендер тел).
  const nodes: TemplateNode[] = []
  for (const r of tpl.records) {
    if (r.role.startsWith('%')) {
      attachToolPart(nodes, r)
      continue
    }
    if (r.role === 'meta') continue
    if (r.role === 'include') {
      const path = (r.name ?? '').trim()
      const text = input.agent.includes[path]
      if (text === undefined) throw new Error(`${where}: %include ${path} — файл не прочитан платформой`)
      for (const ir of parse(text)) {
        if (ir.role === 'meta' || ir.role === 'include' || ir.role.startsWith('%')) continue
        const n = templateNode(ir, true)
        n.source ??= `include:${path}`
        nodes.push(n)
      }
      continue
    }
    nodes.push(templateNode(r))
  }

  // Тега `<{ project }>` нет — в конец первого (не raw) `%system` агента: префикс агента до него тот же.
  if (prefix.length && !nodes.some((n) => !n.raw && PROJECT_TAG_RE.test(n.body))) {
    const first = nodes.find((n) => n.role === 'system' && !n.raw)
    // Узел с `<{ history }>` (встроенный agent.mds) — перед историей: проект — часть system.
    const h = first ? /<\{-?\s*history\b/.exec(first.body) : null
    if (first && h) first.body = `${first.body.slice(0, h.index).replace(/\s+$/, '')}\n\n<{ project }>\n\n${first.body.slice(h.index)}`
    else if (first) first.body = `${first.body.replace(/\n+$/, '')}\n\n<{ project }>\n`
    else nodes.unshift({ role: 'system', body: '<{ project }>', prefill: false, hidden: false })
  }

  // Шаблон не печатает `base` (агент `.mds`, написанный под Claude Code) — платформенные блоки
  // (память, скиллы, сервисы, штамп) в конец первого `%system`, как `<{ project }>`; иначе nr
  // собирает их и молча выбрасывает. У ACP `base` пустой — без изменений.
  if (input.base.some((b) => b.text.trim() !== '') && !nodes.some((n) => !n.raw && BASE_REF_RE.test(n.body))) {
    const first = nodes.find((n) => n.role === 'system' && !n.raw)
    const h = first ? /<\{-?\s*history\b/.exec(first.body) : null
    if (first && h) first.body = `${first.body.slice(0, h.index).replace(/\s+$/, '')}\n\n<< base >>\n\n${first.body.slice(h.index)}`
    else if (first) first.body = `${first.body.replace(/\n+$/, '')}\n\n<< base >>\n`
    else nodes.unshift({ role: 'system', body: '<< base >>', prefill: false, hidden: false })
  }

  const pieces: Piece[] = []
  let historySeen = false
  for (const [i, n] of nodes.entries()) {
    const nodeSource = n.source ?? `template:${n.role}`
    if (n.raw) {
      if (n.body.trim() !== '') pieces.push({ kind: 'node', node: textNode(n, n.body, nodeSource), blocks: [{ source: nodeSource, text: n.body }], template: n })
      continue
    }
    let rendered: string
    try {
      rendered = env.renderString(preprocess(n.body), ctx)
    } catch (err) {
      throw new Error(`${where}: узел #${i + 1} %${n.role}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const before = pieces.length
    for (const p of parseRendered(rendered, nodeSource, `${where}: узел #${i + 1} %${n.role}`)) {
      if (p.kind === 'text') {
        const blocks = p.blocks.map((b) => ({ source: b.source, text: v.expand(b.text) })).filter((b) => b.text.trim() !== '')
        if (!blocks.length) continue
        const text = blocks.map((b) => b.text).join('\n\n')
        pieces.push({ kind: 'node', node: textNode(n, text, n.source ?? blocks[0]!.source), blocks, template: n })
      } else if (p.kind === 'history') {
        if (historySeen) throw new Error(`${where}: <{ history }> в шаблоне дважды`)
        historySeen = true
        pieces.push({ kind: 'history', injects: p.injects.map((s) => ({ ...s, text: v.expand(s.text) })) })
      } else {
        pieces.push(p)
      }
    }
    // Вызовы тулов примера — в узел этого шаблона (текст есть — после него; нет — узлом из одних вызовов).
    if (n.parts?.length) {
      const own = pieces.slice(before).filter((x): x is Extract<Piece, { kind: 'node' }> => x.kind === 'node' && x.template === n).at(-1)
      if (own) own.node.parts = [...own.node.parts, ...n.parts]
      else pieces.push({ kind: 'node', node: { role: n.role, parts: [...n.parts], source: nodeSource }, blocks: [], template: n })
    }
  }

  // Ведущие system-узлы шаблона — system prompt.
  let lead = 0
  while (lead < pieces.length) {
    const p = pieces[lead]!
    if (p.kind !== 'node' || p.node.role !== 'system') break
    lead++
  }
  const systemBlocks: SystemBlock[] = pieces.slice(0, lead).flatMap((p) => (p.kind === 'node' ? p.blocks : []))

  // Хвост: история, узлы после неё, impersonate.
  const impersonate = input.turn?.impersonate === true
  const tail: PromptNode[] = []
  let injects: InjectSpec[] = []
  let continueNode: PromptNode | undefined
  let impersonateNode: PromptNode | undefined
  const historyIds: string[] = []
  for (const p of pieces.slice(lead)) {
    if (p.kind === 'node') {
      // Хвост impersonate (переменные пресета, §5) — в ту же реплику-инструкцию,
      // не отдельной: инструкция остаётся последним сообщением запроса.
      if (impersonateNode && tail.at(-1) === impersonateNode && p.node.role === 'user' && !p.node.prefill) {
        const add = textOf(p.node)
        if (add.trim()) {
          impersonateNode = withLastText(impersonateNode, (t) => `${t}\n\n${add}`)
          tail[tail.length - 1] = impersonateNode
        }
        continue
      }
      tail.push(p.node)
    } else if (p.kind === 'history') {
      injects = p.injects
      const greetingId = v.bot.type === 'nr' ? greetingNodeId(input.document.path) : undefined
      for (const m of input.document.path) {
        if (m.id === greetingId && !impersonate) tail.push(...beforeGreeting(v))
        historyIds.push(m.id)
        tail.push(historyNode(m, v))
      }
      // Ход без реплики: история кончается ответом — маркер (при именах — «Имя:»).
      const last = input.document.path.filter((m) => !compactionData(m)).at(-1)
      if (!impersonate && last?.role === 'assistant') {
        continueNode = synthetic('continue', 'user', v.voiced && v.turn ? `${v.turn.name}:` : CONTINUE_TEXT, CONTINUE_SOURCE)
        tail.push(continueNode)
      }
    } else if (impersonate) {
      const u = { ...v.userCard }
      // Шаблон сам поставил промпт/хвост персоны (`player.system_prompt` в system,
      // `player.post_history_instructions` в хвосте) — в инструкции их не повторять.
      if (/\bplayer\.system_prompt\b/.test(input.agent.template)) delete u.system_prompt
      if (/\bplayer\.post_history_instructions\b/.test(input.agent.template)) delete u.post_history_instructions
      const instruction = impersonatePrompt(input.agent.impersonate, {
        user: v.names.user ?? 'User',
        char: v.names.char ?? 'Character',
        input: input.turn?.input ?? '',
        ...directionMacros(input.turn?.direction),
        ...playerNoteOf(input.document.meta),
        persona: {
          ...(str(u.description) ? { description: str(u.description)! } : {}),
          ...(str(u.scenario) ? { scenario: str(u.scenario)! } : {}),
          ...(str(u.system_prompt) ? { system_prompt: str(u.system_prompt)! } : {}),
          ...(str(u.post_history_instructions) ? { post_history_instructions: str(u.post_history_instructions)! } : {}),
        },
      })
      impersonateNode = synthetic('impersonate', 'user', instruction, IMPERSONATE_SOURCE)
      tail.push(impersonateNode)
    }
  }

  // Лорбук `$lore_role: user`: текстом в реплику-якорь — до подсказки хода.
  for (const s of injects) {
    if (!s.merge || !s.after) continue
    const at = tail.findIndex((n) => n.history && n.id === s.after)
    if (at >= 0) tail[at] = withLastText(tail[at]!, (t) => `${t}\n\n${mergedLoreText(nameOfSource(s.source), s.text)}`)
  }

  // Префил — только последним узлом.
  let prefill: PromptNode | undefined
  const pi = tail.findIndex((n) => n.prefill)
  if (pi >= 0) {
    if (pi !== tail.length - 1) throw new Error(`${where}: %assistant prefill — только последним узлом промпта`)
    prefill = tail.pop()
  }

  // Подсказка хода (personas-spec §2): `\nИмя: ` к последней реплике user.
  // В рецепте — текст узла без подсказки (как assembleRp).
  const recipeText = new Map<PromptNode, string>()
  const end = tail.at(-1)
  if (!impersonate && v.voiced && v.turn && end && end.role === 'user' && end !== continueNode) {
    const hinted = withLastText(end, (t) => `${t}\n${v.turn!.name}: `)
    recipeText.set(hinted, textOf(end))
    tail[tail.length - 1] = hinted
  }

  // Вставки на глубине от конца ленты (без префила): как assembleRp.
  const injected = injects.flatMap((s, k) =>
    s.after ? [] : [{ depth: s.at, message: { ...synthetic(`inject-${k}`, 'user', s.text, s.source), injectRole: s.role } as PromptNode }],
  )
  // Вставки после якоря (лорбук v2): после узла истории по id — позиция стабильна от хода к ходу.
  const anchored = injects
    .filter((s) => s.after && !s.merge)
    .map((s, k) => ({
      after: s.after!,
      message: { ...synthetic(`${LORE_NODE_PREFIX.slice(SYNTHETIC_ID_PREFIX.length)}${k}`, 'system', s.text, s.source), injectRole: s.role, ...(s.send ? { injectSend: s.send } : {}) } as PromptNode,
    }))
  const ordered = insertAfter(injectAtDepth(tail, injected), anchored)
  const out: PromptNode[] = [
    ...pieces.slice(0, lead).flatMap((p) => (p.kind === 'node' ? [p.node] : [])),
    ...ordered,
    ...(prefill ? [prefill] : []),
  ]

  // Контракт блока ( §2): нестабильный блок наверху — предупреждение (сборщик не запрещает).
  const warnings: string[] = []
  for (const p of pieces.slice(0, lead)) if (p.kind === 'node' && p.template.stable === false) warnings.push(`нестабильный блок наверху (рвёт кэш): ${p.node.source}`)
  // Вытеснение при нехватке окна: узлы с `evict` по возрастанию, пока не влезет.
  const evicted = evictNodes(out, input.budget)
  const kept = evicted.length ? out.filter((n) => !evicted.includes(n)) : out
  const keptTail = evicted.length ? ordered.filter((n) => !evicted.includes(n)) : ordered
  const recipe = recipeOf({ systemBlocks, v, injects, tail: keptTail, prefill, impersonateNode, continueNode, historyIds, input, recipeText })
  for (const w of warnings) recipe.injections.push({ role: 'system', text: w, source: BLOCK_WARNING_SOURCE })
  if (evicted.length) recipe.injections.push({ role: 'system', text: evicted.map((n) => n.source).join(', '), source: `вытеснено ${evicted.length} (окно)`, reason: 'evict' })
  if (warnings.length) recipe.warnings = warnings
  // Формат сообщений (§8a) и кэш (§9): стоп-строка с именем игрока, слот llama.cpp.
  const stop = stopUserOf(input.agent) && v.names.user ? [`\n${v.names.user}:`] : undefined
  const idSlot = idSlotOf(input.agent)
  const sampling = { ...((tpl.meta.sampling as Record<string, unknown> | undefined) ?? {}), ...(stop ? { stop } : {}), ...(idSlot !== undefined ? { id_slot: idSlot } : {}) }
  const meta = { ...tpl.meta, model: input.model.id, tools: [...input.tools], ...(input.document.greeting ? { greeting: input.document.greeting.index } : {}), ...(Object.keys(sampling).length ? { sampling } : {}) }
  return { nodes: kept, meta, recipe, mds: toMds(meta, kept), ...(v.lore2 ? { lore: v.lore2 } : {}), ...(v.editor.notes.length ? { editor: v.editor } : {}) }
}

/** Источник предупреждения контракта блоков в рецепте («Отладка промпта»). */
export const BLOCK_WARNING_SOURCE = 'сборка: предупреждение'

/** Узлы под вытеснение (§2 `evict`): по возрастанию `evict`, пока промпт не влезет в окно минус резерв. */
function evictNodes(nodes: readonly PromptNode[], budget: BuildInput['budget']): PromptNode[] {
  if (!budget || budget.contextWindow <= 0) return []
  const limit = budget.contextWindow - budget.reserveTokens
  let total = nodes.reduce((n, x) => n + estimateTokens(textOf(x)), 0)
  if (total <= limit) return []
  const out: PromptNode[] = []
  for (const n of [...nodes].filter((x) => x.evict !== undefined).sort((a, b) => a.evict! - b.evict!)) {
    if (total <= limit) break
    out.push(n)
    total -= estimateTokens(textOf(n))
  }
  return out
}

function recipeOf(a: {
  systemBlocks: SystemBlock[]
  v: DocView
  injects: InjectSpec[]
  tail: PromptNode[]
  prefill: PromptNode | undefined
  impersonateNode: PromptNode | undefined
  continueNode: PromptNode | undefined
  historyIds: string[]
  input: BuildInput
  recipeText: Map<PromptNode, string>
}): BuildRecipe {
  const lore = a.v.lore
  const reasons = new Map<string, string>()
  for (const e of a.v.lore2?.prefix ?? []) reasons.set(loreV2Label(e), loreV2Reason(e))
  for (const e of [...(lore?.before ?? []), ...(lore?.after ?? [])]) reasons.set(loreSourceLabel(e.source, e.name), e.reason)
  // system: записи лорбука, «отброшено», персона, участники — в порядке system, как assembleRp.
  const loreInj: RpInjection[] = []
  const otherInj: RpInjection[] = []
  for (const b of a.systemBlocks) {
    if (reasons.has(b.source)) loreInj.push({ role: 'system', text: b.text, source: b.source, reason: reasons.get(b.source)! })
    else if (b.source === 'persona.user' || b.source === PERSONA_INJECTION_SOURCE) otherInj.push({ role: 'system', text: b.text, source: b.source })
  }
  const injections: RpInjection[] = [...loreInj]
  if (lore?.dropped.length) {
    injections.push({
      role: 'system',
      text: `не вошли (бюджет ${lore.budget}): ${lore.droppedEntries.map((d) => `${d.label} (≈${d.tokens} tok)`).join(', ')}`,
      source: `lorebook: отброшено ${lore.dropped.length} записей (бюджет)`,
      reason: 'бюджет',
    })
  }
  injections.push(...loreDiagnostics(a.v.lore2))
  injections.push(...otherInj)
  if (a.impersonateNode) injections.push({ role: 'user', text: textOf(a.impersonateNode), source: IMPERSONATE_SOURCE })
  for (const s of a.injects) injections.push({ role: s.role, text: s.text, source: s.source, ...(s.reason ? { reason: s.reason } : {}) })
  // Узлы шаблона после истории (post, заметки), затем маркер «продолжай».
  for (const n of a.tail) {
    if (n.history || n.injectRole || n === a.impersonateNode || n === a.continueNode) continue
    injections.push({ role: n.role === 'assistant' ? 'assistant' : n.role === 'system' ? 'system' : 'user', text: a.recipeText.get(n) ?? textOf(n), source: n.source })
  }
  if (a.continueNode) {
    const marker = a.tail.find((n) => n.id === a.continueNode!.id)
    injections.push({ role: 'user', text: textOf(marker ?? a.continueNode), source: CONTINUE_SOURCE })
  }
  if (a.prefill) injections.push({ role: 'assistant', text: textOf(a.prefill), source: a.prefill.source })
  const recipe: BuildRecipe = { systemBlocks: a.systemBlocks, injections, messageIds: a.historyIds }
  if (a.input.document.greeting) recipe.greeting = a.input.document.greeting.index
  return recipe
}

// ────────────────────────────────────────────────────────────────────────────

function textNode(n: TemplateNode, text: string, source: string): PromptNode {
  const node: PromptNode = { role: n.role, parts: [{ type: 'text', text }], source }
  if (n.prefill) node.prefill = true
  if (n.hidden) node.hidden = true
  if (n.stable !== undefined) node.stable = n.stable
  if (n.evict !== undefined) node.evict = n.evict
  return node
}

/** Узел истории: `{{char}}`/`{{user}}` — по текущим персонам; при именах — префикс `Имя: ` по персонам. */
function historyNode(m: DtoMessage, v: DocView): PromptNode {
  let msg = m
  if (!compactionData(m) && (m.role === 'user' || m.role === 'assistant')) msg = expandMessageNames(m, v.expand)
  if (v.voiced && !compactionData(m) && (m.role === 'user' || m.role === 'assistant')) {
    const persona = v.doc.personas.find((p) => p.id === speakerOf(m, v))
    if (persona) msg = withFirstText(msg, (t) => personaPrefixed(persona.name, t))
  }
  return { role: msg.role, parts: msg.parts, source: compactionData(m) ? 'compaction' : 'history', id: m.id, history: true }
}

/**
 * Перед гритингом бота `nr` (§6, §8): примеры ходами (`turns`, со сроком, вытесняются
 * первыми) и состояние сцены — отдельным сообщением, уезжает вглубь с историей.
 */
function beforeGreeting(v: DocView): PromptNode[] {
  const out: PromptNode[] = []
  const b = v.bot
  if (b.examplesMode === 'turns' && b.examples.length && v.turnNo <= b.examplesTtl) {
    b.examples.forEach((e, i) => {
      const node = synthetic(`example-${i}`, e.role ?? 'assistant', v.expand(e.text), 'bot.examples')
      node.evict = 0
      out.push(node)
    })
  }
  const g = activeGreeting(v)
  const state = g?.state ? b.states.find((s) => s.id === g.state) : undefined
  if (state) out.push({ ...synthetic(`state-${state.id}`, 'user', v.expand(state.text), `bot.state:${state.id}`), injectRole: 'system' })
  return out
}

/** Кто сказал (правило assembleRp): `meta.personaId`; user — игрок; ответ — первая `char`. */
function speakerOf(m: DtoMessage, v: DocView): string | undefined {
  const id = m.meta?.personaId
  if (typeof id === 'string') return id
  if (m.role === 'user') return v.user?.id
  if (m.role === 'assistant') return charPersonas(v.doc)[0]?.id ?? v.turn?.id
  return undefined
}

function synthetic(name: string, role: string, text: string, source: string): PromptNode {
  return { id: `${SYNTHETIC_ID_PREFIX}${name}`, role, parts: [{ type: 'text', text }], source }
}

function withFirstText(m: DtoMessage, edit: (t: string) => string): DtoMessage {
  const at = m.parts.findIndex((p) => p.type === 'text')
  if (at < 0) return { ...m, parts: [{ type: 'text', text: edit('') }, ...m.parts] }
  return { ...m, parts: m.parts.map((p, i) => (i === at && p.type === 'text' ? { ...p, text: edit(p.text) } : p)) }
}

function withLastText(n: PromptNode, edit: (t: string) => string): PromptNode {
  let at = -1
  n.parts.forEach((p, i) => {
    if (p.type === 'text') at = i
  })
  if (at < 0) return { ...n, parts: [...n.parts, { type: 'text', text: edit('') }] }
  return { ...n, parts: n.parts.map((p, i) => (i === at && p.type === 'text' ? { ...p, text: edit(p.text) } : p)) }
}

/** `meta` + узлы → `.mds` (nr-chat): `%meta {…}`, затем `%<роль> {source, …}` с текстом. */
export function toMds(meta: Record<string, unknown>, nodes: readonly PromptNode[]): string {
  const records: ChatMessage[] = [{ role: 'meta', meta: { ...meta }, body: '' }]
  for (const n of nodes) {
    const m: Record<string, unknown> = { source: n.source }
    if (n.id !== undefined) m.id = n.id
    if (n.prefill) m.prefill = true
    if (n.hidden) m.hidden = true
    if (n.injectRole) m.inject = n.injectRole
    if (n.injectSend) m.send = n.injectSend
    records.push({ role: n.role, meta: m, body: partsText(n.parts) })
  }
  return stringify(records)
}

function partsText(parts: readonly Part[]): string {
  return parts
    .map((p) => (p.type === 'text' || p.type === 'thinking' ? p.text : `[${p.type}${p.type === 'tool_use' || p.type === 'tool_result' ? ` ${(p.meta as { name?: string }).name ?? ''}`.trimEnd() : ''}]`))
    .filter((t) => t !== '')
    .join('\n')
}

/** Имя записи из метки `lorebook:<источник>/<подача>: <имя>`. */
/** Заметка игрока (CYOA §3.1): постоянная, `meta.playerNote` сессии. */
function playerNoteOf(meta: BuildInput['document']['meta']): { playerNote?: string } {
  const note = (meta as Record<string, unknown>).playerNote
  return typeof note === 'string' && note.trim() ? { playerNote: note } : {}
}

function nameOfSource(source: string): string {
  const at = source.indexOf(': ')
  return at >= 0 ? source.slice(at + 2) : source
}

function promptOf(meta: BuildInput['document']['meta']): { pre?: unknown; post?: unknown } {
  const p = meta.prompt
  return p && typeof p === 'object' ? p : {}
}

function personaUserOf(meta: BuildInput['document']['meta']): string | undefined {
  const p = meta.persona as { user?: unknown } | undefined
  return p && typeof p === 'object' && typeof p.user === 'string' && p.user.trim() ? p.user.trim() : undefined
}

function strOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  return String(v)
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
