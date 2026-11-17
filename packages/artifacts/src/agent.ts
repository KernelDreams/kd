/**
 * Тулы агента над артефактами (artifacts-spec §6) — для хоста без pi-расширения:
 * сервис плагина `artifacts` отдаёт их backend-nr по конвенции `tools`/`tool`
 * (агент стенда nr делает артефакты так же, как pi через
 * `pi-ext-artifact`). Тексты ответов — те же, что у pi-ext-artifact.
 *
 *   AGENT_TOOLS                    → декларации {name, description, schema}
 *   runAgentTool(name, args, opts) → {text, data?, error?}
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RegistryOpts } from './collections.js'
import { listCollections, resolveArtifact } from './collections.js'
import type { FinalizeResult, ListedArtifact } from './lifecycle.js'
import { finalizeArtifact, initArtifact, listForAgent, requestOpen, revertArtifact } from './lifecycle.js'
import type { RuntimeError } from './runtime.js'
import { readRuntimeErrors } from './runtime.js'
import { TEMPLATES } from './templates.js'
import type { TemplateName } from './templates.js'
import type { CheckTimings, CheckedFinalize } from './verify.js'
import { checkRuntime } from './verify.js'
import { formatReport, themeConverters } from '@kerneldreams/skins'
import { convertInputs, createFsSkins, loadThemes, type ThemeInput } from '@kerneldreams/skins/node'

export interface AgentToolDecl {
  name: string
  description: string
  schema: Record<string, unknown>
}

export interface AgentToolResult {
  text: string
  data?: unknown
  error?: boolean
}

export interface AgentToolOpts {
  registry: RegistryOpts
  /** Профиль для модели (`nrchat.dev/use/artifact-profile.md`). */
  profile?: string
  checkTimings?: CheckTimings
  /** Корень бэкенда: общие скины — `<skinsRoot>/skins`. Нет — рабочая область. */
  skinsRoot?: string
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})
const ID = { type: 'string', description: 'Artifact id (<collection>/<folder>) or folder path' }

export const AGENT_TOOLS: readonly AgentToolDecl[] = [
  {
    name: 'artifact_init',
    description:
      'Create a new artifact — a mini-app (HTML/JS, optional JSX and service.ts) that opens as a live tab in nrchat. ' +
      'Returns its id, folder and THE CONTRACT (profile). Then edit the files with your file tools and call artifact_finalize. ' +
      'An editor of THIS chat session data (personas, prompt meta) is template jsx: lib/session.js (useSessionMeta), $uses: session, changes only via window.__host.session.*. ' +
      'A theme/skin editor of nrchat is template jsx+skins ($uses: skins, window.__host.skins.*) — already works; adjust it, do not read skin files.',
    schema: obj(
      {
        name: { type: 'string', description: 'Human title, e.g. "Persona editor"; the folder name is derived from it' },
        template: { type: 'string', enum: [...TEMPLATES], description: 'html (default) | jsx (React + lib/session.js: editor of chat session data) | jsx+service | jsx+skins (working nrchat THEME editor on __host.skins: list, variables, live preview, save as, apply — start from it for any theme/skin editor) | stand (UI MOCKUP of an nrchat screen: components of @kerneldreams/kit — the same Select/Field/Section/PropList/Button as nrchat — plus roles nr-panel/nr-row/nr-node/nr-pin/nr-wire and --nr-* tokens on a stand with skin/mode/size switcher; no own colors, borders, shadows or fonts — any mockup of a view starts from it)' },
        collection: { type: 'string', description: 'Collection id or folder path; default — the workspace collection (.nr/artifacts)' },
      },
      ['name'],
    ),
  },
  {
    name: 'artifact_finalize',
    description:
      'Validate and publish an artifact after editing: parses meta.mdz, statically checks $uses vs __host.* calls, bare imports, absolute paths, compiles JSX, bumps the version and reloads open tabs. ' +
      'On errors the version does not change — fix them and call again. Then it runs the artifact in the open nrchat tab ~3 s: runtimeErrors → ok:false, the artifact is broken — fix and finalize again.',
    schema: obj({ id: ID, expectedVersion: { type: 'number', description: 'Version you last saw; stale → refused with the current one' } }, ['id']),
  },
  { name: 'artifact_open', description: 'Open an artifact as a tab in the running nrchat (next to the chat). Use after artifact_finalize.', schema: obj({ id: ID }, ['id']) },
  {
    name: 'artifact_list',
    description: 'List artifacts of all connected collections (workspace, registry $artifacts, demo): id, title, version, declared $uses, errors.',
    schema: obj({ collection: { type: 'string', description: 'Only this collection id' } }),
  },
  { name: 'artifact_errors', description: 'Latest runtime errors of an artifact reported by its nrchat tab (file:line, stack).', schema: obj({ id: ID }, ['id']) },
  {
    name: 'artifact_revert',
    description: 'Restore an artifact from .history/<version> (last 10 finalized versions kept) — published as a new version.',
    schema: obj({ id: ID, version: { type: 'number', description: 'Version from .history/' } }, ['id', 'version']),
  },
  {
    name: 'skin_check',
    description:
      'Lint a nrchat UI skin (theme) file .nr/skins/<name>.skin.css of the workspace (or a shared one). A skin may contain any CSS; errors are only unparsable CSS and a broken header (name, mode, base). ' +
      'Everything outside the contract (selectors beyond the feed hooks, properties beyond the list, @media, !important, missing palette tokens — filled from the default skin, low contrast) is a warning: the skin works, but only contract tokens and hooks are guaranteed. ' +
      'Returns errors/warnings with hints and the inheritance chain. Call after writing or editing a skin file.',
    schema: obj({ name: { type: 'string', description: 'Skin name (= file name without .skin.css)' } }, ['name']),
  },
  {
    name: 'skin_save',
    description:
      'Validate and write a nrchat UI skin to .nr/skins/<name>.skin.css of the workspace (header /* @skin */ is generated from the arguments). ' +
      'css — rules [data-skin="<name>"] / [data-skin="<name>"][data-mode="light|dark"] with --nr-* variables (+ feed hooks .nr-*). "Based on X" → base: X and only the differences. Written with warnings; nothing is written only on errors (unparsable CSS, header).',
    schema: obj(
      {
        name: { type: 'string', description: 'Skin name: lowercase latin, digits, dash' },
        css: { type: 'string', description: 'Skin CSS by the contract (header optional)' },
        base: { type: 'string', description: 'Skin to inherit from' },
        mode: { type: 'string', enum: ['light', 'dark', 'both'], description: 'Modes the skin carries (default both)' },
        description: { type: 'string', description: 'One line: what the skin is for' },
      },
      ['name', 'css'],
    ),
  },
  {
    name: 'skin_convert',
    description:
      'Convert a foreign theme into a nrchat skin (.skin.css) with a coverage report: Obsidian (theme.css, a folder with theme.css + manifest.json, or a GitHub repo URL), SillyTavern theme JSON, VS Code theme JSON / extension folder / .vsix, plus any converter registered in @kerneldreams/skins (registerThemeConverter). ' +
      'source — a file or folder path, an https URL, or the theme text itself. The source kind is detected from the content (from — to force). ' +
      'to: skin (default) — saved to .nr/skins of the workspace and shown in the nrchat theme list (save: false — only return css); bot — CSS of a bot theme ([data-skin][data-mode]), returned, not saved. ' +
      'The report lists what mapped, what was approximated, what did not and a «finish by agent» list: then fix the .skin.css (skin_save) and show before | after.',
    schema: obj(
      {
        source: { type: 'string', description: 'Path, https URL (GitHub repo of an Obsidian theme, raw file) or the theme text (CSS / JSON)' },
        from: { type: 'string', description: 'Source kind if detection fails: obsidian | sillytavern | vscode | id of a registered converter' },
        to: { type: 'string', enum: ['skin', 'bot'], description: 'skin (default) | bot' },
        name: { type: 'string', description: 'Skin name (lowercase latin, digits, dash); default — from the theme' },
        save: { type: 'boolean', description: 'to=skin: save to .nr/skins (default true)' },
      },
      ['source'],
    ),
  },
  { name: 'artifact_profile', description: 'The artifact contract: folder, meta.mdz, bridge API window.__host (incl. __host.session), permissions, examples.', schema: obj({}) },
]

/** Профиль для модели: `NR_ARTIFACT_PROFILE` / `PI_EXT_ARTIFACT_PROFILE`, иначе `~/Studio/Projects/nrchat.dev/use/artifact-profile.md`. */
export function readAgentProfile(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.NR_ARTIFACT_PROFILE || env.PI_EXT_ARTIFACT_PROFILE || join(homedir(), 'Studio', 'Projects', 'nrchat.dev', 'use', 'artifact-profile.md')
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return `(профиль не найден: ${file} — задай NR_ARTIFACT_PROFILE)`
  }
}

const errorLine = (e: RuntimeError): string =>
  `runtime: ${e.source ? `${e.source}${e.line ? `:${e.line}` : ''} ` : ''}${e.message}${e.stack ? `\n  ${e.stack.split('\n').join('\n  ')}` : ''}`

/** Итог finalize словами для модели (тот же текст, что у pi-ext-artifact). */
export function formatFinalize(r: FinalizeResult | CheckedFinalize): string {
  const rt = 'runtimeErrors' in r ? r.runtimeErrors : null
  if (rt && rt.length > 0) {
    return [
      `✗ ${r.id}: версия ${r.version} записана, но артефакт ПАДАЕТ при запуске в nrchat (ok: false). Это не успех: исправь ошибки ниже, вызови artifact_finalize снова и не сообщай пользователю, что всё работает.`,
      ...rt.map(errorLine),
      ...r.warnings.map((w) => `warning: ${w}`),
    ].join('\n')
  }
  const note = 'note' in r && r.note ? [`note: не проверено: ${r.note}`] : []
  const head = r.errors.length
    ? `✗ ${r.id}: finalize не прошёл — версия осталась ${r.version}. Исправь и вызови artifact_finalize снова.`
    : r.changed
      ? `✓ ${r.id}: версия ${r.version}. Открытые вкладки перезагрузятся сами.`
      : `= ${r.id}: изменений нет, версия ${r.version}.`
  return [head, ...r.errors.map((e) => `error: ${e}`), ...r.warnings.map((w) => `warning: ${w}`), ...note].join('\n')
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Дефолт бюджета каталога артефактов в system, символы (~1500 токенов). */
export const ARTIFACT_CATALOG_BUDGET_CHARS = 6_000

/**
 * Каталог артефактов для system prompt: «id — название — описание — vN»
 * по коллекциям, с бюджетом, и правило «чужие артефакты не читать без просьбы» —
 * агент не тратит ходы на `read` чужих папок, чтобы узнать, что есть. Не влезло —
 * хвост `…и ещё N (artifact_list)`. Пусто — артефактов нет.
 */
export function agentCatalog(reg: RegistryOpts, budgetChars = ARTIFACT_CATALOG_BUDGET_CHARS): string {
  const list = listForAgent(reg).filter((a) => !a.error)
  if (!list.length) return ''
  const head = [
    '## Artifacts',
    'Existing artifacts (mini-apps opened as nrchat tabs). This list is all you need to know what exists: do NOT read other artifacts\' files unless the user asks about that artifact. Full list with $uses — artifact_list.',
  ].join('\n')
  const line = (a: ListedArtifact): string => {
    const desc = a.description.replace(/\s+/g, ' ').trim()
    return `- ${a.id} — ${a.title}${desc ? ` — ${desc.length > 160 ? `${desc.slice(0, 157).trimEnd()}...` : desc}` : ''} — v${a.version}`
  }
  const lines: string[] = []
  let size = head.length
  for (const a of list) {
    const l = line(a)
    if (size + l.length + 1 > budgetChars) break
    lines.push(l)
    size += l.length + 1
  }
  const rest = list.length - lines.length
  return [head, ...lines, ...(rest > 0 ? [`- …и ещё ${rest} (artifact_list)`] : [])].join('\n')
}

export async function runAgentTool(name: string, args: unknown, opts: AgentToolOpts): Promise<AgentToolResult> {
  const a = (args ?? {}) as Record<string, unknown>
  const reg = opts.registry
  try {
    switch (name) {
      case 'artifact_init': {
        const title = str(a.name)
        if (!title) return { text: 'artifact_init: нужно name', error: true }
        const template = str(a.template) as TemplateName | undefined
        const r = initArtifact({ ...reg, name: title, ...(template ? { template } : {}), ...(str(a.collection) ? { collection: str(a.collection)! } : {}) })
        return {
          text: [
            `✓ создан артефакт ${r.id}`,
            `папка: ${r.dir}`,
            `файлы: ${r.files.join(', ')}`,
            'Дальше: правь файлы в папке своими инструментами → artifact_finalize(id) → artifact_open(id).',
            '',
            '──── КОНТРАКТ (профиль артефакта) ────',
            opts.profile ?? readAgentProfile(),
          ].join('\n'),
          data: r,
        }
      }
      case 'artifact_finalize': {
        const id = str(a.id)
        if (!id) return { text: 'artifact_finalize: нужен id', error: true }
        const r = await finalizeArtifact(id, { ...reg, ...(typeof a.expectedVersion === 'number' ? { expectedVersion: a.expectedVersion } : {}) })
        const checked = await checkRuntime(r, reg, opts.checkTimings)
        return { text: formatFinalize(checked), data: checked, ...(checked.ok ? {} : { error: true }) }
      }
      case 'artifact_open': {
        const info = requestOpen(str(a.id) ?? '', reg)
        return { text: `→ ${info.id} открывается вкладкой в nrchat (если nrchat с плагином artifacts открыт).`, data: { id: info.id, dir: info.dir } }
      }
      case 'artifact_list': {
        const list = listForAgent({ ...reg, ...(str(a.collection) ? { collection: str(a.collection)! } : {}) })
        const lines = list.map((x) => `${x.id} — ${x.title} · v${x.version} · uses: ${x.uses ? x.uses.join(', ') || '—' : 'НЕ ОБЪЯВЛЕНЫ'}${x.error ? ` · ОШИБКА: ${x.error}` : ''}`)
        return { text: lines.length ? lines.join('\n') : 'артефактов нет', data: list }
      }
      case 'artifact_errors': {
        const info = resolveArtifact(str(a.id) ?? '', listCollections(reg), reg.workspace ?? undefined)
        if (!info) return { text: `артефакт не найден: ${String(a.id)}`, error: true }
        const log = readRuntimeErrors(info.dir)
        if (!log || log.errors.length === 0) return { text: `${info.id} v${info.version}: ошибок рантайма не приходило`, data: { id: info.id, errors: [] } }
        return { text: [`${info.id}: ${log.errors.length} ошибок рантайма`, ...log.errors.map(errorLine)].join('\n'), data: log }
      }
      case 'artifact_revert': {
        const r = await revertArtifact(str(a.id) ?? '', Number(a.version), reg)
        return { text: formatFinalize(r), data: r, ...(r.errors.length ? { error: true } : {}) }
      }
      case 'artifact_profile':
        return { text: opts.profile ?? readAgentProfile() }
      case 'skin_check':
      case 'skin_save': {
        const skin = str(a.name)
        if (!skin) return { text: `${name}: нужно name`, error: true }
        const workspace = reg.workspace ?? opts.skinsRoot
        const skins = createFsSkins({ root: opts.skinsRoot ?? workspace ?? process.cwd() })
        const where = workspace ? { cwd: workspace } : {}
        if (name === 'skin_check') {
          const info = (await skins.list(where)).find((x) => x.name === skin)
          if (!info) return { text: `скина ${skin} нет — файл .nr/skins/${skin}.skin.css рабочей области (или skin_save)`, error: true }
          const d = await skins.get(skin, where)
          if (info.errors?.length) return { text: [`✗ скин ${skin} не прошёл проверку (${d.path}):`, ...info.errors.map((e) => `error: ${e}`), ...(info.warnings ?? []).map((w) => `warning: ${w}`)].join('\n'), data: info, error: true }
          return { text: [`✓ скин ${skin}: ${d.chain.join(' → ')} (${info.source}, ${d.path}) — в списке тем nrchat`, ...(info.warnings ?? []).map((w) => `warning: ${w}`)].join('\n'), data: info }
        }
        if (typeof a.css !== 'string') return { text: 'skin_save: нужно css', error: true }
        const mode = a.mode === 'light' || a.mode === 'dark' || a.mode === 'both' ? a.mode : undefined
        const r = await skins.save(skin, a.css, { ...where, ...(str(a.base) ? { base: str(a.base)! } : {}), ...(mode ? { mode } : {}), ...(str(a.description) ? { description: str(a.description)! } : {}) })
        if (!r.ok) return { text: [`✗ скин ${skin} не записан — исправь и вызови снова:`, ...(r.errors ?? []).map((e) => `error: ${e}`)].join('\n'), data: r, error: true }
        return { text: [`✓ скин ${skin} записан: ${r.path} — появится в списке тем nrchat`, ...(r.warnings ?? []).map((w) => `warning: ${w}`)].join('\n'), data: r }
      }
      case 'skin_convert': {
        const source = str(a.source)
        if (!source) return { text: 'skin_convert: нужно source', error: true }
        const known = themeConverters().map((c) => c.id)
        const from = str(a.from)
        if (from && !known.includes(from)) return { text: `skin_convert: нет конвертера тем «${from}» — есть: ${known.join(', ')}`, error: true }
        const to = a.to === 'bot' ? 'bot' : 'skin'
        // Текст темы прямо в аргументе — CSS или JSON; иначе путь или адрес.
        const inline = /[{}]/.test(source) && !/^https?:\/\//i.test(source)
        const themes: ThemeInput[] = inline ? [{ text: source, source: 'текст из чата' }] : await loadThemes(source.replace(/^~(?=\/)/, homedir()))
        if (!themes.length) return { text: `skin_convert: в ${source} тем не нашлось (theme.css Obsidian, JSON SillyTavern / VS Code, .vsix и зарегистрированные конвертеры)`, error: true }
        const items = convertInputs(themes, { ...(from ? { from } : {}), to, ...(str(a.name) ? { name: str(a.name)! } : {}) })
        const workspace = reg.workspace ?? opts.skinsRoot
        const skins = createFsSkins({ root: opts.skinsRoot ?? workspace ?? process.cwd() })
        const where = workspace ? { cwd: workspace } : {}
        const parts: string[] = []
        const data: unknown[] = []
        for (const x of items) {
          if (!x.result) {
            parts.push(`✗ ${x.input.source}: ${x.error}`)
            continue
          }
          const r = x.result
          const report = formatReport(r, r.name)
          if (to === 'skin' && a.save !== false) {
            const saved = await skins.save(r.name!, r.css, { ...where, ...(r.header?.source ? { origin: r.header.source } : {}), ...(r.header?.license ? { license: r.header.license } : {}), ...(r.header?.author ? { author: r.header.author } : {}) })
            parts.push(saved.ok ? `✓ скин ${r.name} записан: ${saved.path} — в списке тем nrchat` : [`✗ скин ${r.name} не записан:`, ...(saved.errors ?? []).map((e) => `error: ${e}`)].join('\n'), report)
            data.push({ name: r.name, path: saved.path, ok: saved.ok, coverage: r.report.coverage, warnings: r.lint.warnings.length })
          } else {
            parts.push(report, `\`\`\`css\n${r.css.trimEnd()}\n\`\`\``)
            data.push({ name: r.name, coverage: r.report.coverage, css: r.css })
          }
        }
        return { text: parts.join('\n\n'), data, ...(items.every((x) => !x.result) ? { error: true } : {}) }
      }
    }
    return { text: `нет такого тула: ${name}`, error: true }
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), error: true }
  }
}
