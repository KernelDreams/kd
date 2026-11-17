/**
 * @kerneldreams/runz-runtime — `helpers.agent(opts)`: агент в `$action` (реализация — расширение `agent`).
 *
 * Тонкая обёртка над `createAgent` расширения `agent` (`extensions.ts`): полный
 * цикл (тулы, картинки, `apply_patch`, компакция, рецепт), сессия — `.mds`
 * nr-chat рядом с документом (открывается стендом nr; `$agent_store_driver: pi`
 * — старые ленты pi/2). Батч: апрувов нет —
 * `toolPolicy`/`askDefaults` (см. `createAgent` расширения).
 *
 *  - провайдер и ключ — из цепочки тем же путём, что `helpers.llm`
 *    (`$provider` → `## $provider <name>` в `~/.runz/config.md`); `mock` —
 *    встроенная заглушка без сети;
 *  - гейт маршрутизирует сам (модель не из `/models` — всё равно в ран);
 *  - профиль — `opts.profileDoc` / `opts.profile` → `$agent`: имя или путь
 *    `.mdz` (от папки документа), либо блок `## $agent` (атрибуты профиля,
 *    тело — system prompt); агент nrchat `.mds` (agents-spec §1) —
 *    путь или имя: `agents/` проекта (вверх от `cwd`) → `$agents_dir` →
 *    `~/Studio/envs/agents`; разбор — `agentDocOf` nr-chat-store (как у стенда),
 *    `%system`-шаблон рендерит движок; поле `engine` игнорируется;
 *  - модель — `opts.model` → `$agent_model` → модель агента → `$model`;
 *    `$agent_max_turns`/`$agent_tool_policy` сильнее меты агента;
 *  - скиллы — `$skills_dir` (папки), `$skillbox` (`{url?, keyRef?, name?}`),
 *    выбор — `opts.skills` → `$skills` → `skills` агента; неизвестное имя —
 *    ошибка до первого хода;
 *  - запрет-лист `exec` — `opts.execDeny` → `$exec_deny` (регэкспы);
 *  - `cwd` — `opts.cwd` → `$out` (от папки запуска) → папка документа;
 *  - раны всех сессий хелпера — не больше `$threads` разом (default 4):
 *    `Promise.all` по строкам таблицы безопасен;
 *  - агенты закрываются по концу `$action`, в котором созданы.
 *
 * Агента в открытом ядре нет: слот расширения `agent` (`extensions.ts`; `RUNZ_BACKEND_NR` —
 * путь к собранному пакету агента). Нет — понятная ошибка, остальное runz работает.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asText, isArray, isContext, parseDocument } from '@kerneldreams/nrd'
import type { Block, IContext, Value } from '@kerneldreams/nrd'
import { serialize } from '@kerneldreams/nrd/format'
import { resolveProviderConfig } from '@kerneldreams/engine'
import { MOCK_PROVIDER, MOCK_REPLY } from './provider.ts'
import { loadExtension, registerExtension, requireExtension } from './extensions.ts'

/** Опции `helpers.agent` — поверх дефолтов цепочки. */
export interface HelperAgentOptions {
  /** Имя или путь `.mdz` профиля (default `$agent`). */
  profile?: string
  /** Профиль документом (`tools`, `systemPrompt`, `model`, `tool_policy`, `mcp`…). */
  profileDoc?: Record<string, unknown>
  model?: string
  /** Имя провайдера цепочки (default `$provider`). */
  provider?: string
  cwd?: string
  /** Каталог `.mds` и драйвер: `nr-chat` (default) или `pi` — старые ленты pi/2 (`$agent_store_driver`). */
  store?: { dir?: string; driver?: 'nr-chat' | 'pi'; cardCodec?: unknown }
  toolPolicy?: 'auto' | 'deny' | Record<string, 'auto' | 'allow' | 'deny'>
  askDefaults?: Record<string, string | number | boolean>
  /** Вопрос `ask_user` человеку (ящик вопросов хоста); `undefined` — умолчание из `askDefaults`. */
  ask?: (q: { question: string; options: string[] }) => Promise<string | undefined>
  maxTurns?: number
  temperature?: number
  maxTokens?: number
  /** Тулы шага (`{name, description, schema, executor: 'backend', execute}`): имена — в `$tools` профиля или `all`. */
  tools?: unknown[]
  /** Выбор скиллов поверх агента (default `$skills`). */
  skills?: string[]
  /** Папки скиллов (default `$skills_dir`). */
  skillsDirs?: string[]
  /** Запрет-лист `exec` — регэкспы команд (default `$exec_deny`). */
  execDeny?: string[]
  log?: (line: string) => void
}

/** Агент backend-nr, как его видит `$action` (форма `Agent` из backend-nr). */
export interface HelperAgent {
  readonly cwd: string
  readonly storeDir: string
  /** Профиль, с которым создан агент (агент `.mds` — с полями цепочки поверх). */
  readonly profile?: Record<string, unknown>
  /** Итоговая модель (явная или агента; `undefined` — дефолт гейта). */
  readonly model?: string
  session(opts?: { id?: string; file?: string; meta?: Record<string, unknown>; personas?: { personas: unknown[]; userId?: string } }): Promise<any>
  close(): Promise<void>
}

/** Агенты, созданные в текущем `$action`: закрываются по его концу. */
const scope = new AsyncLocalStorage<HelperAgent[]>()

/** Тело `fn` в области: агенты, созданные внутри, закрываются после. */
export async function withAgentScope<T>(fn: () => Promise<T>): Promise<T> {
  const agents: HelperAgent[] = []
  try {
    return await scope.run(agents, fn)
  } finally {
    await Promise.allSettled(agents.map((a) => a.close()))
  }
}

type BackendNrNode = {
  createAgent(opts: Record<string, unknown>): Promise<HelperAgent>
  /** Кодек карты персоны (mdd) для драйвера nr-chat; нет — карта в шапке json5. */
  cardCodec?: unknown
}

/**
 * Реализация агента — слот расширения `agent` (`extensions.ts`): поданная хостом, `RUNZ_BACKEND_NR`
 * (путь к собранному пакету агента: `dist/host/node/index.js`) или файл `agent.mjs` в папке расширений.
 * В открытом ядре агента нет: без расширения — `ExtensionMissingError` с подсказкой.
 */
export async function loadBackendNr(ctx?: IContext, what = 'helpers.agent'): Promise<BackendNrNode> {
  const dir = process.env.RUNZ_BACKEND_NR
  if (dir && !(await loadExtension('agent', { ...(ctx ? { ctx } : {}) }))) {
    try {
      registerExtension('agent', await import(pathToFileURL(join(resolve(dir), 'dist', 'host', 'node', 'index.js')).href))
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0] : String(err)
      throw new Error(`helpers.agent: RUNZ_BACKEND_NR=${dir} не загрузился: ${why}`)
    }
  }
  const mod = await requireExtension<BackendNrNode>('agent', what, { ...(ctx ? { ctx } : {}) })
  if (typeof mod.createAgent !== 'function') throw new Error('helpers.agent: расширение agent не отдаёт createAgent')
  return mod
}

/** Значение цепочки → JS: `$[…]` — массив, блок/объект — объект, скаляр — как есть. */
export function toJs(v: Value | undefined): unknown {
  if (v === undefined || v === null) return v
  if (isArray(v)) return [...v.iterate()].map((x) => toJs(x as Value))
  if (isContext(v)) {
    const c = v as IContext
    const out: Record<string, unknown> = {}
    for (const k of c.cast<string[]>('keys') ?? []) out[k] = toJs(c.get([k]))
    return out
  }
  return v
}

/** Атрибут профиля mdz → поле `ProfileDoc` (как у конструктора appz/pi `profileDocOf`). */
const PROFILE_FIELDS: Record<string, string> = {
  name: 'name',
  description: 'description',
  model: 'model',
  thinking: 'thinking',
  tools: 'tools',
  skill: 'skills',
  extension: 'extensions',
  'system-prompt': 'systemPrompt',
  system_prompt: 'systemPrompt',
  prompt: 'prompt',
}

/** Профиль из контекста документа (mdz-файл или блок `## $agent`): атрибуты + тело как system prompt. */
export function profileDocOf(c: IContext, id: string): Record<string, unknown> {
  const doc: Record<string, unknown> = { id, name: id }
  const extra: Record<string, unknown> = {}
  for (const k of c.cast<string[]>('keys') ?? []) {
    if (k.startsWith('nr-')) continue
    const v = toJs(c.get([k]))
    const field = PROFILE_FIELDS[k]
    if (!field) {
      extra[k] = v
      continue
    }
    if (field === 'tools') doc.tools = toolsOf(v)
    else if (field === 'skills' || field === 'extensions') doc[field] = Array.isArray(v) ? v.map(String) : String(v).split(',').map((s) => s.trim()).filter(Boolean)
    else if (v !== undefined && v !== '') doc[field] = v
  }
  const body = (c.cast<string>('text') ?? '').trim()
  if (body && doc.systemPrompt === undefined) doc.systemPrompt = body
  if (Object.keys(extra).length) doc.extra = extra
  return doc
}

function toolsOf(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? v.map(String) : 'none'
  const s = String(v ?? '').trim()
  if (s === '' || s === 'none') return 'none'
  if (s === 'all') return 'all'
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** Папки агентов `.mds` по имени: `agents/` проекта вверх от `cwd` → `$agents_dir` → `~/Studio/envs/agents`. */
export function agentDirs(cwd: string, agentsDir?: string | string[]): string[] {
  const dirs: string[] = []
  for (let d = resolve(cwd); ; d = dirname(d)) {
    dirs.push(join(d, 'agents'))
    if (dirname(d) === d) break
  }
  for (const d of [agentsDir ?? []].flat()) dirs.push(expandTilde(d))
  dirs.push(join(homedir(), 'Studio', 'envs', 'agents'))
  return [...new Set(dirs)]
}

const expandTilde = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/**
 * `$agent: <имя|путь>` → файл профиля. Путь (`.mdz`/`.mds` или со `/`) — от папки
 * документа. Имя — `.mdz`: `<doc>/<имя>.mdz`, `<doc>/profiles/`, `~/.runz/agents/`;
 * затем агент nrchat `.mds` по {@link agentDirs}. Нет — ошибка со списком мест.
 */
export function profileFile(ref: string, baseDir: string, opts: { cwd?: string; agentsDir?: string | string[] } = {}): string {
  const tries = /\.(mdz|mds)$/.test(ref) || ref.includes('/')
    ? [isAbsolute(expandTilde(ref)) ? expandTilde(ref) : resolve(baseDir, ref)]
    : [
        join(baseDir, `${ref}.mdz`),
        join(baseDir, 'profiles', `${ref}.mdz`),
        join(process.env.RUNZ_GLOBAL_DIR || join(homedir(), '.runz'), 'agents', `${ref}.mdz`),
        ...agentDirs(opts.cwd ?? baseDir, opts.agentsDir).map((d) => join(d, `${ref}.mds`)),
      ]
  const hit = tries.find((p) => existsSync(p))
  if (!hit) throw new Error(`helpers.agent: профиль/агент ${ref} не найден, смотрел:\n  ${tries.join('\n  ')}`)
  return hit
}

type AgentDocOf = (id: string, text: string, file: string) => Record<string, unknown>
let agentDocOfP: Promise<AgentDocOf> | undefined
const NR_CHAT_BUILDER: string = '@kerneldreams/chat-store/builder'

/** `agentDocOf` nr-chat-store — тем же читает агентов стенд (`appz/pi/lib/agents.ts`). Динамически: не зависимость runz. */
export function loadAgentDocOf(): Promise<AgentDocOf> {
  agentDocOfP ??= (async () => {
    const dir = process.env.RUNZ_BACKEND_NR
    const tries = [...(dir ? [pathToFileURL(join(resolve(dir), 'node_modules', '@kerneldreams', 'chat-store', 'dist', 'builder', 'index.js')).href] : []), NR_CHAT_BUILDER]
    let last: unknown
    for (const spec of tries) {
      try {
        if (spec !== NR_CHAT_BUILDER && !existsSync(new URL(spec))) continue
        return ((await import(/* @vite-ignore */ spec)) as { agentDocOf: AgentDocOf }).agentDocOf
      } catch (err) {
        last = err
      }
    }
    agentDocOfP = undefined
    throw new Error(`helpers.agent: агент .mds — нет @kerneldreams/chat-store/builder (${last instanceof Error ? last.message.split('\n')[0] : String(last)})`)
  })()
  return agentDocOfP
}

/** Агент nrchat `.mds` → профиль (`agentDocOf`): id — имя файла, `template` — сам файл. */
export async function agentProfileOf(file: string): Promise<Record<string, unknown>> {
  const agentDocOf = await loadAgentDocOf()
  return agentDocOf(basename(file, '.mds'), readFileSync(file, 'utf-8'), file)
}

/** Блок `## $agent` программы (без id) — документом: атрибуты и тело как в mdz-профиле. */
export function agentBlockOf(root: Block | undefined): IContext | undefined {
  const block = root?.children.find((b) => b.name === 'agent' && !b.id)
  if (!block) return undefined
  const text = serialize({ sigil: '$', root: { name: '', level: 0, attrs: block.attrs, ...(block.body !== undefined ? { body: block.body } : {}), children: [] } } as never)
  return parseDocument(text)
}

/** Профиль агента: опции → блок `## $agent` → `$agent: <имя|путь>` (`.mdz` или агент `.mds`). Нет — undefined (все тулы). */
export async function resolveProfile(
  ctx: IContext,
  baseDir: string,
  opts: HelperAgentOptions,
  block?: IContext,
  where: { cwd?: string } = {},
): Promise<Record<string, unknown> | undefined> {
  if (opts.profileDoc) return opts.profileDoc
  if (!opts.profile && block) return profileDocOf(block, 'agent')
  const ref: Value | undefined = opts.profile ?? ctx.get(['agent'])
  if (ref === undefined || ref === null || ref === '') return undefined
  if (isContext(ref)) return profileDocOf(ref as IContext, 'agent')
  const agentsDir = listOf(toJs(ctx.get(['agents_dir'])))?.map((d) => resolve(baseDir, expandTilde(d)))
  const file = profileFile(String(asText(ref) ?? ref), baseDir, { ...(where.cwd ? { cwd: where.cwd } : {}), ...(agentsDir ? { agentsDir } : {}) })
  if (file.endsWith('.mds')) return agentProfileOf(file)
  return profileDocOf(parseDocument(readFileSync(file, 'utf-8')), basename(file, '.mdz'))
}

/** Список из атрибута: `$[…]`, строка через запятую. */
function listOf(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined
  // Элементы `$['a', "b"]` приходят с кавычками — снимаем парные.
  const clean = (s: string): string => {
    const t = s.trim()
    return t.length >= 2 && (t[0] === "'" || t[0] === '"') && t.at(-1) === t[0] ? t.slice(1, -1) : t
  }
  if (Array.isArray(v)) return v.map(String).map(clean).filter(Boolean)
  return String(v).split(',').map(clean).filter(Boolean)
}

/** `$skillbox` цепочки → опция backend-nr: `url` (или `skillbox.url` конфига), ключ — по `keyRef` из цепочки/`~/.runz/config.md`. */
function skillboxOf(ctx: IContext): { url: string; key?: string; name?: string } | undefined {
  const raw = toJs(ctx.get(['skillbox']))
  if (raw === undefined || raw === null || raw === '' || raw === false) return undefined
  const o = (typeof raw === 'object' ? raw : { url: String(raw) }) as { url?: string; keyRef?: string; key?: string; name?: string }
  let config: IContext | undefined
  const fromConfig = (path: string[]): string | undefined => {
    const v = asText(ctx.get(path))
    if (v) return v
    const file = join(process.env.RUNZ_GLOBAL_DIR || join(homedir(), '.runz'), 'config.md')
    config ??= existsSync(file) ? parseDocument(readFileSync(file, 'utf-8')) : undefined
    return config ? asText(config.get(path)) : undefined
  }
  // Блок `## $skillbox` конфига без `key`/`keyRef` — реестр не выбран (у клиента нет ключа): только папки.
  if (typeof raw === 'object' && !o.key && !o.keyRef) return undefined
  const url = o.url ?? fromConfig(['skillbox', 'url'])
  if (!url) return undefined
  const key = o.key ?? (o.keyRef ? fromConfig(o.keyRef.split('.').filter(Boolean)) : undefined)
  return { url, ...(key ? { key } : {}), ...(o.name ? { name: o.name } : {}) }
}

/** `$agent_tool_policy` → поле профиля `toolPolicy` (карта `{тул: auto|ask|deny}`). */
function policyMap(p: HelperAgentOptions['toolPolicy']): Record<string, string> | undefined {
  if (!p) return undefined
  if (p === 'auto') return { '*': 'auto' }
  if (p === 'deny') return { '*': 'deny' }
  return p as Record<string, string>
}

/** Заглушка провайдера в форме backend-nr `Provider`: один текстовый ход (`$mock_reply`). */
function mockStream(reply: string): unknown {
  return {
    stream() {
      return (async function* () {
        const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        const message = { role: 'assistant', content: [{ type: 'text', text: reply }], api: 'openai-completions', provider: 'mock', model: 'mock', usage, stopReason: 'stop', timestamp: Date.now() }
        yield { type: 'text', delta: reply, index: 0 }
        yield { type: 'usage', usage }
        yield { type: 'done', message }
      })()
    },
  }
}

/** Семафор ранов: не больше `n` разом. */
function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  return async (fn) => {
    if (active >= n) await new Promise<void>((r) => queue.push(r))
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

const num = (v: Value | undefined): number | undefined => {
  const n = Number(asText(v as Value))
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n
}

const WEB_TOOLS = ['web_search', 'web_fetch']
const PI_EXT_WEB: string = '@kerneldreams/web-tools/tools'

/** Профиль называет веб-тулы (`$tools: web_search, …`) или `all` — агенту нужны `web_search`/`web_fetch`. */
export function wantsWebTools(tools: unknown): boolean {
  if (tools === 'all') return true
  return Array.isArray(tools) && tools.some((t) => WEB_TOOLS.includes(String(t)))
}

/**
 * `web_search`/`web_fetch` (`@kerneldreams/web-tools/tools`) в форме тулов backend-nr — тем же адаптером,
 * что `createNrTools` стенда (`appz/pi/lib/nr-tools.ts`); общий пакет тулов —, тогда адаптер переезжает.
 * Необязательный импорт: пакета нет — агент без веба, строка в лог.
 */
export async function loadWebTools(log: (line: string) => void): Promise<unknown[]> {
  try {
    const { createWebTools } = (await import(/* @vite-ignore */ PI_EXT_WEB)) as {
      createWebTools(): Array<{
        name: string
        description: string
        parameters: Record<string, unknown>
        execute(args: Record<string, unknown>, o: { signal?: AbortSignal }): Promise<{ text: string; details?: unknown; isError?: boolean }>
      }>
    }
    return createWebTools().map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.parameters,
      executor: 'backend' as const,
      async execute(args: Record<string, unknown>, ctx: { signal: AbortSignal }) {
        const res = await t.execute(args, { signal: ctx.signal })
        return { text: res.text, data: res.details, ...(res.isError ? { isError: true } : {}) }
      },
    }))
  } catch (err) {
    log(`agent: веб-тулы не загрузились (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — без них`)
    return []
  }
}

/** `helpers.agent` над цепочкой документа. */
export function agentHelper(ctx: IContext, baseDir: string, log: (msg: string) => void, root?: Block): (opts?: HelperAgentOptions) => Promise<HelperAgent> {
  const block = agentBlockOf(root)
  const gate = limiter(num(ctx.get(['threads'])) || 4)
  return async (opts = {}) => {
    const nr = await loadBackendNr(ctx)
    const name = opts.provider ?? asText(ctx.get(['provider'])) ?? asText(ctx.get(['default_provider'])) ?? 'openrouter'
    const cfg = resolveProviderConfig(ctx, name)
    const type = cfg.type ?? (name === MOCK_PROVIDER ? MOCK_PROVIDER : 'openai')
    const explicitModel = opts.model ?? asText(ctx.get(['agent_model']))
    // OpenAI-совместимы все, кроме родных протоколов (как в resolveProvider): openai, openrouter, гейт…
    if (type === 'anthropic' || type === 'ollama') throw new Error(`helpers.agent: провайдер ${name} типа ${type} — агенту нужен OpenAI-совместимый гейт`)
    if (type !== MOCK_PROVIDER && !cfg.baseUrl) throw new Error(`helpers.agent: у провайдера ${name} нет base_url (## $provider ${name} в ~/.runz/config.md)`)
    const out = asText(ctx.get(['out']))
    const cwd = resolve(opts.cwd ?? (out ? resolve(process.cwd(), out) : baseDir))
    const resolved = await resolveProfile(ctx, baseDir, opts, block, { cwd })
    const askDefaults = opts.askDefaults ?? (toJs(ctx.get(['agent_ask'])) as Record<string, string> | undefined)
    const toolPolicy = opts.toolPolicy ?? (toJs(ctx.get(['agent_tool_policy'])) as HelperAgentOptions['toolPolicy'])
    const maxTurns = opts.maxTurns ?? num(ctx.get(['agent_max_turns']))
    const skills = opts.skills ?? listOf(toJs(ctx.get(['skills'])))
    // Профиль + поля цепочки поверх меты агента (модель, лимит ходов, политика, выбор скиллов).
    // Скиллы выбраны, а профиля нет — минимальный профиль (все тулы): выбору нужен носитель.
    let profileDoc = resolved ?? (skills ? { id: 'agent', name: 'Agent' } : undefined)
    if (profileDoc) {
      const p: Record<string, unknown> = { ...profileDoc }
      if (p.engine !== undefined && p.engine !== 'nr') log(`agent: поле engine агента ${String(p.id)} = ${String(p.engine)} игнорируется — движок nr в процессе`)
      if (explicitModel) p.model = explicitModel
      if (maxTurns) p.maxTurns = maxTurns
      const pol = policyMap(toolPolicy)
      if (pol) p.toolPolicy = pol
      if (skills) {
        p.extra = { ...((p.extra as Record<string, unknown> | undefined) ?? {}), skills }
      }
      profileDoc = p
    }
    const model = explicitModel ?? (asText(profileDoc?.model as Value) || undefined) ?? asText(ctx.get(['model'])) ?? (type === MOCK_PROVIDER ? 'mock' : undefined)
    const temperature = opts.temperature ?? num(ctx.get(['temperature']))
    const maxTokens = opts.maxTokens ?? num(ctx.get(['max_tokens']))
    const skillsDirs = (opts.skillsDirs ?? listOf(toJs(ctx.get(['skills_dir']))))?.map((d) => resolve(baseDir, expandTilde(d)))
    const wantSkills = Boolean(skills ?? (profileDoc ? listOf((profileDoc.extra as Record<string, unknown> | undefined)?.skills ?? (profileDoc.source === 'agents' ? profileDoc.skills : undefined)) : undefined))
    const skillbox = wantSkills ? skillboxOf(ctx) : undefined
    const execDeny = opts.execDeny ?? listOf(toJs(ctx.get(['exec_deny'])))
    // Драйвер ленты: nr-chat по умолчанию; `$agent_store_driver: pi` — старые pi/2.
    const driverAttr = asText(ctx.get(['agent_store_driver']))
    const driverPicked = driverAttr === 'pi' || driverAttr === 'nr-chat' ? { ...(opts.store ?? {}), driver: opts.store?.driver ?? driverAttr } : opts.store
    // Каталог ленты: `$agent_store_dir` (от документа) — иначе рядом с документом; `opts.store.dir` сильнее.
    const dirAttr = asText(ctx.get(['agent_store_dir']))
    const picked = dirAttr && !opts.store?.dir ? { ...(driverPicked ?? {}), dir: resolve(baseDir, expandTilde(dirAttr)) } : driverPicked
    // Карта персоны в шапке — mdd, как пишет стенд: кодек отдаёт расширение агента, если умеет.
    const cardCodec = nr.cardCodec
    // Веб агенту: профиль называет web_search/web_fetch или all — тулы pi-ext-web поверх тулов шага.
    const stepTools = opts.tools ?? []
    const webTools = wantsWebTools(profileDoc?.tools) ? (await loadWebTools(log)).filter((w) => !stepTools.some((t) => (t as { name?: string }).name === (w as { name: string }).name)) : []
    const tools = [...stepTools, ...webTools]
    const store = cardCodec ? { ...(picked ?? {}), cardCodec } : picked
    const agent = await nr.createAgent({
      cwd,
      provider:
        type === MOCK_PROVIDER
          ? { baseUrl: 'http://mock/v1', catalog: { data: [{ id: model, input: ['text', 'image'] }] }, impl: mockStream(asText(ctx.get(['mock_reply'])) ?? MOCK_REPLY), anyModel: true }
          : { baseUrl: cfg.baseUrl, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), name, anyModel: true },
      ...(model ? { model } : {}),
      ...(profileDoc ? { profileDoc } : {}),
      ...(store ? { store } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
      ...(askDefaults ? { askDefaults } : {}),
      ...(opts.ask ? { ask: opts.ask } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(tools.length ? { tools } : {}),
      ...(skillsDirs?.length ? { skillsDirs } : {}),
      ...(skillbox ? { skillbox } : {}),
      ...(execDeny?.length ? { execDeny } : {}),
      log: opts.log ?? ((line: string) => log(`agent: ${line}`)),
    })
    // Выбор скиллов: неизвестное имя — ошибка до первого хода (движок только предупредил бы).
    if (wantSkills) {
      const tpl = typeof profileDoc?.template === 'string' && profileDoc.template.endsWith('.mds') && existsSync(profileDoc.template) ? readFileSync(profileDoc.template, 'utf-8') : undefined
      if (tpl !== undefined && !/<<\s*base\b/.test(tpl)) log(`agent: в шаблоне агента ${String(profileDoc?.id)} нет << base >> — каталог скиллов в промпт не попадёт`)
      const mgr = (agent as unknown as { backend?: { skills?: { ready(): Promise<void>; select(spec: unknown): Promise<{ unknown: string[] }> } } }).backend?.skills
      const spec = skills ?? listOf((profileDoc?.extra as Record<string, unknown> | undefined)?.skills ?? profileDoc?.skills)
      if (!mgr) {
        await agent.close()
        throw new Error(`helpers.agent: выбраны скиллы (${spec?.join(', ')}), а источника нет — задай $skills_dir или $skillbox`)
      }
      if (spec && !(spec.length === 1 && (spec[0] === 'all' || spec[0] === 'none'))) {
        await mgr.ready()
        const sel = await mgr.select(spec)
        if (sel.unknown.length) {
          await agent.close()
          throw new Error(`helpers.agent: скиллов нет ни в $skills_dir, ни в skillbox: ${sel.unknown.join(', ')}`)
        }
      }
    }
    // Раны и свайпы всех сессий хелпера — через общий семафор `$threads`.
    const session = agent.session.bind(agent)
    const wrapped: HelperAgent = Object.assign(agent, {
      ...(profileDoc ? { profile: profileDoc } : {}),
      ...(model ? { model } : {}),
      async session(o?: Parameters<HelperAgent['session']>[0]) {
        const s = await session(o)
        const run = s.run.bind(s)
        const swipe = s.swipe.bind(s)
        return Object.assign(s, { run: (i: unknown) => gate(() => run(i)), swipe: (i?: unknown) => gate(() => swipe(i)) })
      },
    })
    scope.getStore()?.push(wrapped)
    return wrapped
  }
}
