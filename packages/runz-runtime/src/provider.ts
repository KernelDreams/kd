/**
 * @kerneldreams/runz-runtime — резолв LLM-провайдера для документов.
 *
 * Конфиг провайдера — `resolveProviderConfig` из nr-engine (единственная точка,
 * знающая форму `## $provider <name>`-блоков и фолбэков ключа; копировать
 * lookupProvider запрещено). Транспорт — `@kerneldreams/nrd/web`.
 *
 * `--provider=mock` (или `$type: mock` в блоке провайдера) переключает на
 * встроенный мок: приёмка и smoke не ходят в сеть и не зависят от llm-gate.
 * Мок — не «тестовая обвязка в проде», а явно запрошенный провайдер: без него
 * ни один документ с LLM нельзя прогнать offline.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { asText } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { ImageSetup, ProviderSetup, StreamChunk, StreamProvider } from '@kerneldreams/nrd/node'
import { ok, type ImageProvider, type LLMRequest, type MediaKind } from '@kerneldreams/nrd/contracts'
import { resolveProviderConfig } from '@kerneldreams/engine'
import { findProviderFile, isMediaFile, listProviderFiles, loadProviderFile, providerDirs } from './provider-files.ts'

export const MOCK_PROVIDER = 'mock'

/** Дефолтный ответ мока: пригоден и как mdd-секция персонажа, и как реплика. */
export const MOCK_REPLY = [
  '## @char Mock Character (Mock Source)',
  '@slug: mock-character',
  '@role: protagonist',
  '',
  'Мок-ответ: провайдер mock не ходит в сеть.',
].join('\n')

/**
 * Детерминированный провайдер без сети. Отдаёт `reply` одним text-чанком;
 * `echo: true` дописывает последнюю реплику запроса — чтобы тест видел, что
 * сборка сообщений доехала.
 */
export function mockProvider(opts: { reply?: string; echo?: boolean } = {}): StreamProvider {
  const reply = opts.reply ?? MOCK_REPLY
  return {
    async *stream(req: LLMRequest): AsyncIterable<StreamChunk> {
      const last = req.messages?.[req.messages.length - 1]
      const tail = opts.echo && last ? `\n[echo] ${String(last.content ?? '')}` : ''
      yield { type: 'text', text: reply + tail }
    },
  }
}

/** Собрать провайдер и дефолты запроса из цепочки контекста. */
export async function resolveProvider(ctx: IContext): Promise<ProviderSetup> {
  const name =
    asText(ctx.get(['provider'])) ?? asText(ctx.get(['default_provider'])) ?? 'openrouter'
  const cfg = resolveProviderConfig(ctx, name)

  const model = asText(ctx.get(['model'])) ?? ''
  const temperature = Number(asText(ctx.get(['temperature']))) || undefined
  const maxTokens = Number(asText(ctx.get(['max_tokens']))) || undefined
  const timeout = Number(cfg.timeout) || Number(asText(ctx.get(['timeout']))) || 120000

  const type = cfg.type ?? (name === MOCK_PROVIDER ? MOCK_PROVIDER : 'openai')

  // Провайдер файлом: `<type>.ts` в папке провайдеров — раньше встроенных.
  const file = findProviderFile(providerDirs(ctx), type)
  if (file) {
    const provider = await loadProviderFile<ProviderSetup['provider']>(file, { ...cfg, name }, ctx, 'llm')
    return { provider, model, temperature, maxTokens, name }
  }

  if (type === MOCK_PROVIDER) {
    const reply = asText(ctx.get(['mock_reply'])) ?? undefined
    const echo = asText(ctx.get(['mock_echo'])) === 'true'
    return { provider: mockProvider({ reply, echo }), model, temperature, maxTokens, name }
  }

  // Транспорт — только по требованию: документ без LLM не тянет web-ступень.
  const web = await import('@kerneldreams/nrd/web')

  const opts: Record<string, unknown> = {
    baseUrl: cfg.baseUrl ?? '',
    apiKey: cfg.apiKey ?? '',
    // timeout → заголовки, idleTimeout → idle-watchdog стрима: одно значение.
    timeout,
    idleTimeout: timeout,
  }
  if (type === 'ollama') {
    const think = asText(ctx.get(['think']))
    if (think !== undefined) opts.think = think !== 'false'
  }
  const providerFn =
    type === 'anthropic'
      ? web.anthropicProvider
      : type === 'ollama'
        ? web.ollamaProvider
        : web.openaiProvider

  // Провайдер целиком (LLMProvider): helpers.embed берёт у него `embed`,
  // если транспорт его умеет (openai/ollama; anthropic — нет).
  return {
    provider: providerFn(opts as never) as ProviderSetup['provider'],
    model,
    temperature,
    maxTokens,
    name,
  }
}

// ============================================================================
// Картинки (image-gen-spec §3)
// ============================================================================

/** PNG 1×1 — ответ мока картинок. */
const MOCK_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Мок картинок без сети: на запрос — `n` (из `params.n`, дефолт 1) PNG 1×1.
 * Нужен приёмке и тестам `helpers.image`, как `mockProvider` — LLM.
 */
export function mockImageProvider(): ImageProvider {
  const png = Uint8Array.from(atob(MOCK_PNG_B64), (c) => c.charCodeAt(0))
  return {
    async generate(req) {
      const n = Math.max(1, Number(req.params?.n) || 1)
      return ok({
        images: Array.from({ length: n }, () => png.slice()),
        mime: 'image/png',
        meta: { model: req.model, id: 'mock', cost: 0 },
      })
    },
  }
}

/**
 * Типы блоков `## $provider`, которые умеют медиа (без мока): картинки — все,
 * видео — bfl (flux-3-video), google/vertex (Veo), музыка — google/vertex (Lyria).
 */
export const IMAGE_PROVIDER_TYPES = ['bfl', 'nanogpt', 'comfy', 'google', 'vertex', 'gate'] as const

/**
 * Где искать gcloud после PATH (у MCP-шелла и приложения из Finder его в PATH нет): Homebrew (Apple Silicon и Intel),
 * установщик Google в доме, пакеты Linux; Windows — «Cloud SDK» в LocalAppData и Program Files.
 */
export function gcloudDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === 'win32') {
    const sdk = (root: string | undefined): string | null => (root ? join(root, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin') : null)
    return [sdk(env.LOCALAPPDATA), sdk(env.ProgramFiles), sdk(env['ProgramFiles(x86)'])].filter((x): x is string => !!x)
  }
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/share/google-cloud-sdk/bin',
    '/usr/local/bin',
    '/usr/local/share/google-cloud-sdk/bin',
    '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
    join(home, 'google-cloud-sdk', 'bin'),
    '/usr/lib/google-cloud-sdk/bin',
    '/snap/bin',
    '/usr/bin',
  ]
}

/**
 * gcloud на этой машине (комплект приезжал с `$gcloud` машины сборки — `/home/…/google-cloud-sdk`).
 * Явный `$gcloud` — если есть на диске; путь, которого здесь нет, и имя без пути — поиском: PATH, затем `gcloudDirs`.
 * Не нашли — `null`.
 */
export function findGcloud(explicit?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  const name = explicit && !isAbsolute(explicit) && !/[\\/]/.test(explicit) ? explicit : 'gcloud'
  if (explicit && name !== explicit && exists(explicit)) return explicit
  const names = platform === 'win32' ? (/\.(cmd|bat|exe)$/i.test(name) ? [name] : [`${name}.cmd`, `${name}.exe`]) : [name]
  const dirs = [...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter), ...gcloudDirs(env, platform)].filter(Boolean)
  for (const d of dirs) for (const n of names) if (exists(join(d, n))) return join(d, n)
  return null
}

/** Токен Vertex — ADC: `gcloud auth application-default print-access-token` (кэш — у провайдера). gcloud — этой машины. */
export function gcloudToken(gcloud?: string): () => Promise<string> {
  return () =>
    new Promise((resolve, reject) => {
      const bin = findGcloud(gcloud)
      if (!bin) {
        reject(new Error('runz: нет gcloud на этой машине — Vertex выключен (установите Google Cloud SDK и выполните gcloud auth application-default login)'))
        return
      }
      const PATH = [process.env.PATH ?? '', dirname(bin)].filter(Boolean).join(delimiter)
      execFile(bin, ['auth', 'application-default', 'print-access-token'], { env: { ...process.env, PATH }, timeout: 30_000, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) }, (e, stdout, stderr) => {
        if (e) reject(new Error(`runz: токен Vertex не получен (${bin} auth application-default print-access-token): ${String(stderr || e.message).trim().split('\n')[0]}`))
        else resolve(stdout.trim())
      })
    })
}

/** Дефолтный каталог шаблонов comfy — тот же, что видит comfy-gen и `appz/comfy`. */
export const COMFY_TEMPLATES = '~/Studio/appz/comfy/workflows'

const home = (p: string): string => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p)

/** Атрибут блока `## $provider <name>` (не из стандартного набора resolveProviderConfig). */
function blockAttr(ctx: IContext, name: string, key: string): string | undefined {
  const block = ctx.get(['provider', name])
  if (block && typeof block === 'object' && 'get' in block) return asText((block as IContext).get([key])) ?? undefined
  return undefined
}

/** Список строк или одна строка атрибута цепочки. */
function textList(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (typeof v === 'object' && v && 'iterate' in v) {
    return [...(v as { iterate(): Iterable<unknown> }).iterate()].map((x) => asText(x as never) ?? '').filter(Boolean)
  }
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  const t = asText(v as never)
  return t ? [t] : []
}

/**
 * Имена блоков `## $provider`, чей `$type` — bfl / nanogpt / comfy / google / vertex / gate или
 * медиа-провайдер файлом (`providers/<type>.ts` с `kind` image/video/audio): список для
 * хостов (артефакт image-gen), чтобы показать выбор провайдера (image-gen-2-spec §5).
 * Цепочка — хоста (конфиги без документа): `$provider` документа строкой
 * затеняет блоки конфига, и список тогда пуст.
 */
export function listImageProviders(ctx: IContext): string[] {
  // Блоков несколько — IArray звеньев (имя блока — cast('id')), один — само звено.
  const v = ctx.get(['provider'])
  if (!v || typeof v !== 'object') return []
  const items: unknown[] = 'iterate' in v ? [...(v as { iterate(): Iterable<unknown> }).iterate()] : [v]
  const names: string[] = []
  const dirs = providerDirs(ctx)
  for (const item of items) {
    const name = (item as IContext | undefined)?.cast?.('id') as unknown
    if (typeof name !== 'string' || !name || names.includes(name)) continue
    const type = resolveProviderConfig(ctx, name).type
    if (!type) continue
    // Файл перекрывает встроенный тип — решает его kind.
    const file = findProviderFile(dirs, type)
    if (file ? isMediaFile(file.path) : (IMAGE_PROVIDER_TYPES as readonly string[]).includes(type)) names.push(name)
  }
  return names
}

/**
 * Провайдер медиа из цепочки: `$image_provider ?? $provider ?? $default_provider`
 * (видео/музыка — сначала `$video_provider` / `$audio_provider`) → блок
 * `## $provider <имя>` (конфиг — `resolveProviderConfig`). Транспорт по `$type`:
 * `bfl` → `bflImageProvider`, `nanogpt` → `nanogptImageProvider` (nrd/web),
 * `google` → `googleMediaProvider` (ключ AI Studio; `$base_url` — необязателен),
 * `vertex` → `vertexMediaProvider` (`$project`, `$location`, `$media_location`, токен
 * gcloud ADC, `$gcloud`), `comfy` → `comfyImageProvider` (comfy-client: сервер
 * `$server ?? $comfy`, шаблоны `$comfy_templates ?? ~/Studio/appz/comfy/workflows`),
 * `mock` → PNG 1×1. Раньше встроенных — файл `<type>.ts` папки провайдеров (* `provider-files.ts`). `name` — явное имя блока (хост выбрал провайдер сам). Нет
 * поддержки — ошибка с типом и списком встроенных и файловых типов.
 */
export async function resolveImageProvider(ctx: IContext, name?: string, kind: MediaKind = 'image'): Promise<ImageSetup> {
  const helper = `helpers.${kind}`
  name ??=
    (kind !== 'image' ? asText(ctx.get([`${kind}_provider`])) : undefined) ??
    asText(ctx.get(['image_provider'])) ??
    asText(ctx.get(['provider'])) ??
    asText(ctx.get(['default_provider']))
  if (!name) {
    throw new Error(
      `runz: ${helper} — провайдер не задан: ${kind !== 'image' ? `$${kind}_provider, ` : ''}$image_provider, $provider или $default_provider`,
    )
  }
  const cfg = resolveProviderConfig(ctx, name)
  const type = cfg.type ?? (name === MOCK_PROVIDER ? MOCK_PROVIDER : undefined)
  const timeout = Number(cfg.timeout) || undefined

  const dirs = providerDirs(ctx)
  const file = findProviderFile(dirs, type)
  if (file) return { provider: await loadProviderFile<ImageProvider>(file, { ...cfg, name }, ctx, 'media'), name }

  if (type === MOCK_PROVIDER) return { provider: mockImageProvider(), name }
  if (type === 'bfl' || type === 'nanogpt') {
    if (!cfg.baseUrl) throw new Error(`runz: провайдер "${name}" ($type: ${type}) — нет $base_url`)
    if (!cfg.apiKey) throw new Error(`runz: провайдер "${name}" ($type: ${type}) — нет ключа ($api_key)`)
    const web = await import('@kerneldreams/nrd/web')
    const make = type === 'bfl' ? web.bflImageProvider : web.nanogptImageProvider
    return { provider: make({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, timeout }), name }
  }
  if (type === 'google') {
    if (!cfg.apiKey) throw new Error(`runz: провайдер "${name}" ($type: google) — нет ключа ($api_key)`)
    const web = await import('@kerneldreams/nrd/web')
    // $base_url блока LLM (…/v1beta/openai) медиа не нужен — адаптер срежет /openai.
    return { provider: web.googleMediaProvider({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}), timeout }), name }
  }
  if (type === 'vertex') {
    const project = blockAttr(ctx, name, 'project')
    if (!project) throw new Error(`runz: провайдер "${name}" ($type: vertex) — нет $project`)
    const location = blockAttr(ctx, name, 'location')
    const mediaLocation = blockAttr(ctx, name, 'media_location')
    const web = await import('@kerneldreams/nrd/web')
    return {
      provider: web.vertexMediaProvider({
        project,
        ...(location ? { location } : {}),
        ...(mediaLocation ? { mediaLocation } : {}),
        token: gcloudToken(blockAttr(ctx, name, 'gcloud')),
        timeout,
      }),
      name,
    }
  }
  if (type === 'gate') {
    // llm-gate (gate-media-spec §7): ключи медиа-провайдеров на гейте, здесь — адрес и ключ гейта.
    if (!cfg.baseUrl) throw new Error(`runz: провайдер "${name}" ($type: gate) — нет $base_url`)
    const web = await import('@kerneldreams/nrd/web')
    return { provider: web.gateMediaProvider({ baseUrl: cfg.baseUrl, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...(timeout ? { timeout } : {}) }), name }
  }
  if (type === 'comfy') {
    // Только скаляр: блок с id `comfy`/`server` (`## $batch comfy`) затеняет атрибут цепочки
    // (id-lookup раньше атрибута) — его тело адресом не считаем.
    const scalar = (key: string): string | undefined => {
      const v = ctx.get([key])
      return typeof v === 'string' ? v.trim() || undefined : undefined
    }
    const server = blockAttr(ctx, name, 'server') ?? scalar('server') ?? scalar('comfy')
    if (!server) {
      const shadowed = ctx.get(['comfy']) !== undefined || ctx.get(['server']) !== undefined
      throw new Error(
        `runz: провайдер "${name}" ($type: comfy) — нет сервера: $server или $comfy` +
          (shadowed ? ' (имя занято блоком документа — `## $… comfy`/`server` затеняет атрибут; переименуй блок или задай $server в ## $provider)' : ''),
      )
    }
    const tpl = textList(blockAttr(ctx, name, 'templates') ?? ctx.get(['comfy_templates']))
    const templatesDir = (tpl.length ? tpl : [COMFY_TEMPLATES]).map(home)
    const { comfyImageProvider } = await import('@kerneldreams/comfy-client')
    return { provider: comfyImageProvider({ server, templatesDir, timeout }), name }
  }
  const files = listProviderFiles(dirs).filter((f) => isMediaFile(f.path))
  throw new Error(
    `runz: ${helper} — провайдер "${name}" ($type: ${type ?? 'не задан'}) не умеет медиа; поддержаны: ${[...IMAGE_PROVIDER_TYPES, MOCK_PROVIDER].join(', ')}` +
      (files.length ? `; файлами: ${files.map((f) => `${f.type} (${f.path})`).join(', ')}` : '') +
      `; новый тип — файл <type>.ts в ${dirs.length ? dirs.join(', ') : '$providers_dir или ~/.runz/providers'}`,
  )
}
