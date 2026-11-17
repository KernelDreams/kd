/**
 * Палитры (kd-cli-spec §6): ⌘K чата и палитра помощника читают тот же каталог и те же правила объектов,
 * что командная строка. Здесь — данные для них без исполнения: тулы с формами, действия объекта по тексту
 * (вставил адрес бота — «показать / play / fork / persona»), план вызова (поля, недостающее) и команда
 * задачи `kd …` для очереди. Разбор слов и нормализация — те же функции ядра, что у `kd` (§9.6).
 */

import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import type { FormSchema } from '@kerneldreams/forms'
import type { LinkRules } from '@kerneldreams/ui-protocol'
import { matchWord } from '@kerneldreams/ui-protocol/links-rules'
import { normalize, shellWord, splitWords, tokenize, formatCommand } from '../core/call.js'
import { defaultAction, type ToolDecl } from '../core/decl.js'
import { formFor } from '../core/describe.js'
import { describeEntry, loadDecl, staticDecl, type Catalog, type ToolEntry } from './catalog.js'
import { expandHome, KIT_ROOT } from './home.js'
import type { Layers } from './layers.js'
import { actionVars, actionVarsFor, actionWord, fileRule, isFile, objectActions, resolveTemplate, shellSplit, wordKinds } from './objects.js'

/** Поле «как в командной строке» у тула без объявления: слова и флаги одной строкой. */
export const ARGS_FIELD = 'args'

export interface PaletteAction {
  name: string
  title?: string
  default?: boolean
}

export interface PaletteTool {
  name: string
  description: string
  /** Действия тула; пусто — без действий. */
  actions: PaletteAction[]
  /** Полная схема формы (поля всех действий с `$for` в `x-ui`); форма действия — `formFor`. */
  schema: FormSchema
  /** Тул без объявления: одно поле {@link ARGS_FIELD} — слова как в командной строке. */
  legacy: boolean
  /** Поля формы каждого действия (`formFor`, `$for`); у тула без действий — пусто. */
  fields: Record<string, string[]>
}

const legacySchema = (): FormSchema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { [ARGS_FIELD]: { type: 'string', title: 'Слова и флаги, как в командной строке', 'x-ui': { widget: 'input', order: 0, section: '' } } },
  required: [],
})

const emptySchema = (): FormSchema => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {}, required: [] })

/**
 * Объявление без загрузки чужого кода: документ и `tool.mdz` читаются, модули комплекта (`.mjs`) грузятся,
 * `.ts` без `tool.mdz` — тул по-старому (модуль не исполняется ради палитры).
 */
async function quickDecl(t: ToolEntry): Promise<ToolDecl | null> {
  try {
    return staticDecl(t) ?? (t.layer === 'kit' && /\.mjs$/.test(t.file) ? await loadDecl(t) : null)
  } catch {
    return null
  }
}

function toolOf(t: ToolEntry, d: ToolDecl | null): PaletteTool {
  if (!d || d.legacy) return { name: t.name, description: d?.description || describeEntry(t), actions: [], schema: legacySchema(), legacy: true, fields: {} }
  const schema = d.form ?? emptySchema()
  return {
    fields: Object.fromEntries(d.actions.map((a) => [a.name, Object.keys(formFor(schema, a.name).properties)])),
    name: d.name,
    description: d.description || describeEntry(t),
    actions: d.actions.map((a) => ({ name: a.name, ...(a.title ? { title: a.title } : {}), ...(a.default ? { default: true } : {}) })),
    schema,
    legacy: false,
  }
}

/** Каталог для палитр: тулы по имени с формами. */
export async function paletteCatalog(c: Catalog): Promise<PaletteTool[]> {
  const out: PaletteTool[] = []
  for (const t of [...c.tools.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    let d: ToolDecl | null = null
    try {
      d = await quickDecl(t)
    } catch {
      d = null
    }
    try {
      out.push(toolOf(t, d))
    } catch {
      // описание тула не читается — в палитре его нет, в `kd -v` видно
    }
  }
  return out
}

/** План вызова: тул, действие, поля после раскладки слов и умолчаний, недостающее. */
export interface PalettePlan {
  tool: string
  action?: string
  params: Record<string, unknown>
  missing: string[]
  /** Форма действия с подставленными значениями (умолчание поля = значение плана). */
  schema: FormSchema
  legacy: boolean
}

/** Слова вызова тула → план (без исполнения): та же раскладка, что у `kd <тул> слова…`. */
export async function planTool(l: Layers, c: Catalog, rules: LinkRules, argv: string[], cwd: string): Promise<PalettePlan> {
  const [name, ...rest] = argv
  const t = name === undefined ? undefined : c.tools.get(name)
  if (!t) throw new Error(`kd: «${name ?? ''}» — нет такого тула в каталоге`)
  const d = (await quickDecl(t)) ?? (await loadDecl(t))
  if (d.legacy) return { tool: t.name, params: { [ARGS_FIELD]: rest.join(' ') }, missing: [], schema: legacySchema(), legacy: true }
  const raw = splitWords(d, tokenize(rest, d), { kindOf: (w) => wordKinds(w, rules, cwd) })
  const n = normalize(d, raw)
  const action = n.call.action ?? defaultAction(d)
  const form = formFor(d.form ?? emptySchema(), action)
  const schema: FormSchema = { ...form, properties: { ...form.properties } }
  for (const [k, v] of Object.entries(n.call.params)) {
    const f = schema.properties[k]
    if (f && v !== undefined && v !== null) schema.properties[k] = { ...f, default: v as never }
  }
  void l
  return { tool: t.name, ...(action ? { action } : {}), params: n.call.params, missing: n.missing, schema, legacy: false }
}

/** Действие объекта для палитры. */
export interface PaletteObjectAction {
  /** Слово действия (`play`). */
  word: string
  title?: string
  default?: boolean
  /** Чем исполняется: `kd` (вызов тула), `exec`, `script`. */
  run: string
  /** Слова `kd …` целиком: для `kd`-действия — развёрнутый `$cmd`, иначе — объект и слово. */
  argv: string[]
  /** План вызова тула (только у `kd`-действий, чей `$cmd` начинается с тула каталога). */
  plan?: PalettePlan
}

export interface PaletteObject {
  /** Текст, который распознан (адрес, номер задачи, путь). */
  text: string
  kind?: string
  rule: string
  actions: PaletteObjectAction[]
}

/**
 * Текст запроса → объект и его действия по правилам ссылок (§4.2–4.4): слово целиком — адрес, задача,
 * существующий путь. Ничего не подошло — `null` (палитра просто ищет по тулам).
 */
export async function paletteMatch(l: Layers, c: Catalog, rules: LinkRules, text: string, cwd: string): Promise<PaletteObject | null> {
  const word = text.trim()
  if (!word || /\s/.test(word) || c.tools.has(word)) return null
  const path = resolvePath(cwd, expandHome(word))
  const file = isFile(path)
  const matches = file ? [] : matchWord(word, rules.links)
  if (!file && !matches.length) return null
  const ruleList = file ? fileRule(path) : [matches[0]!.rule, ...matches.slice(1).map((m) => m.rule).filter((r) => r.kind && r.kind !== matches[0]!.rule.kind)]
  const acts = objectActions(rules, ruleList)
  if (!acts.length) return null
  const vars = actionVars(word, matches[0] ?? null, file ? path : undefined)
  const out: PaletteObjectAction[] = []
  for (const a of acts) {
    const w = actionWord(a)
    const base = { word: w, ...(a.title ? { title: a.title } : {}), ...(a.default ? { default: true } : {}), run: a.run }
    if (a.run === 'kd' && a.cmd) {
      const argv = shellSplit(resolveTemplate(a.cmd, actionVarsFor(a, vars)))
      let plan: PalettePlan | undefined
      if (argv[0] && c.tools.has(argv[0])) {
        try {
          plan = await planTool(l, c, rules, argv, cwd)
        } catch {
          plan = undefined
        }
      }
      out.push({ ...base, argv, ...(plan ? { plan } : {}) })
    } else out.push({ ...base, argv: [word, w] })
  }
  const first = ruleList[0]!
  return { text: word, ...(first.kind ? { kind: first.kind } : {}), rule: first.id, actions: out }
}

/** Вход `kd` этой копии: `bin/kd.mjs` комплекта; `KD_BIN` — код kd в чужом бандле, вход — частная копия сборки. */
export const kdBin = (): string => process.env.KD_BIN || fileURLToPath(new URL('../../bin/kd.mjs', import.meta.url))

/**
 * Команда задачи для очереди (jobs `cmd`): `node <kd> <тул> [действие] --поля` — из плана, как
 * `formatCommand` пишет исправленную команду. Тул без объявления — его слова как есть.
 */
export async function jobCommand(c: Catalog, call: { tool: string; action?: string; params: Record<string, unknown> }, opts: { node?: string; bin?: string } = {}): Promise<string> {
  const head = `${shellWord(opts.node ?? process.execPath)} ${shellWord(opts.bin ?? kdBin())}`
  const t = c.tools.get(call.tool)
  if (!t) throw new Error(`kd: «${call.tool}» — нет такого тула в каталоге`)
  const d = (await quickDecl(t)) ?? (await loadDecl(t))
  if (d.legacy) {
    const words = shellSplit(String(call.params[ARGS_FIELD] ?? ''))
    return [head, shellWord(t.name), ...words.map(shellWord)].join(' ')
  }
  const known = new Set(d.fields.map((f) => f.name))
  const params = Object.fromEntries(Object.entries(call.params).filter(([k, v]) => known.has(k) && v !== '' && v !== undefined && v !== null))
  const action = call.action ?? defaultAction(d)
  if (action && d.actions.length && !d.actions.some((a) => a.name === action)) throw new Error(`kd: у «${d.name}» нет действия «${action}»`)
  // `formatCommand` пропускает действие по умолчанию — для задачи оно пишется явно: команда читается однозначно.
  const line = formatCommand(d, { ...(action ? { action } : {}), params }).replace(/^kd /, '')
  const words = line.split(' ')
  if (action && action === defaultAction(d) && words[1] !== action) words.splice(1, 0, action)
  return `${head} ${words.join(' ')}`
}

/** Команда задачи для действия объекта без плана (`exec`, `script`): `node <kd> <объект> <слово>`. */
export function objectJobCommand(text: string, word: string, opts: { node?: string; bin?: string } = {}): string {
  return [opts.node ?? process.execPath, opts.bin ?? kdBin(), text, word].map(shellWord).join(' ')
}

export { KIT_ROOT }
