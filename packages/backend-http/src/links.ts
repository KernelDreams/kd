/**
 * Сервис ядра `links` (v1.54, link-resolver-spec §3–4): правила ссылок —
 * документы mdz (`links.mdz`) на каскаде слоёв агент → пространство → пользователь → стенд
 * (первый сильнее, как `chainContext` nrd). Блок `## $link <id>` — распознавание,
 * `## $action <id>` — действие; одноимённый блок сильного слоя вытесняет нижние,
 * `$off: true` снимает нижнее (и встроенное фронта). Внутри файла — last-wins ленты mdz.
 *
 * Разбор и резолв `${}` — nrd (`parseDocument`, `blockSelf`, `resolve` над
 * `chainContext(objectContext(params), funcContext(coreFunctions + basename/dirname/ext))`):
 * модуль nrd отдаёт `service.ts` (как ntpl у `objects`), здесь своего парсера нет.
 *
 * Доверие: слои агента, пространства и пользователя у гостя (не owner стенда — `$caller`
 * от гейта пользователей) собираются без `exec`/`script`; стенд — доверенный всегда.
 *
 *   import { createLinksService } from './links.js'
 *   export default createLinksService({ nrd, layers: (input) => defaultLinkLayers(root, input) })
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LinkLayer, LinkLayersInput, LinkRules, LinkRunResult } from '@kerneldreams/ui-protocol'
import { linkListOf, mergeLinkRules, parseLinksText, type LayeredLinksFile, type LinksNrd, type ParsedLinksFile } from '@kerneldreams/ui-protocol/links-rules'
import type { ServiceMeta, ServiceSink } from '@kerneldreams/ui-protocol/service'
import { parse as parseChat } from '@kerneldreams/nrd/chat'

/** То, что нужно от nrd (`@kerneldreams/nrd`): модуль целиком подходит. Разбор и сведение — `@kerneldreams/ui-protocol/links-rules`. */
export type { LinksNrd }

/** Файлы слоя: сильный слой первым; в слое — сильный файл первым. */
export interface LinkLayerFiles {
  layer: LinkLayer
  files: string[]
}

export interface LinksEngineOpts {
  nrd: LinksNrd
  layers(input: LinkLayersInput): LinkLayerFiles[]
  /** Имя хаба (`NR_HOST`): `$where` с ним или пустой — локально. */
  hub?: string
  /** `exec` на другой машине (агент хоста); нет — только хаб. */
  execOn?(where: string, cmd: string, opts: { timeout: number }): Promise<LinkRunResult>
}

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

const listOf = linkListOf

type ParsedFile = ParsedLinksFile

/** Файл слоя → блоки, включения `$links` — абсолютными путями от файла. */
export function parseLinksFile(nrd: LinksNrd, path: string, text: string, layer: LinkLayer): ParsedFile {
  const parsed = parseLinksText(nrd, path, text, layer)
  const base = dirname(path)
  const includes = parsed.includes.map((p) => {
    const e = expandHome(p)
    return isAbsolute(e) ? e : resolvePath(base, e)
  })
  return { ...parsed, includes }
}

/** Слои по умолчанию (§4): каталог стенда `root` (`envs`), поиск `.nr/links.mdz` вверх от `cwd`. */
export function defaultLinkLayers(root: string, input: LinkLayersInput, opts: { standFiles?: string[]; nrd?: LinksNrd } = {}): LinkLayerFiles[] {
  const safe = (id: string | undefined): string | null => (id && /^[\w.@-]+$/.test(id) && !id.startsWith('.') ? id : null)
  const out: LinkLayerFiles[] = []
  const agent = safe(input.agent)
  out.push({ layer: 'agent', files: agent ? agentLinkFiles(root, agent, safe(input.space)) : [] })
  const space: string[] = []
  if (input.cwd && isAbsolute(expandHome(input.cwd))) {
    const stop = homedir()
    for (let d = resolvePath(expandHome(input.cwd)); ; d = dirname(d)) {
      space.push(join(d, '.nr', 'links.mdz'))
      if (d === stop || dirname(d) === d) break
    }
  }
  const sp = safe(input.space)
  if (sp && opts.nrd) {
    const reg = join(root, 'projects', `${sp}.mdz`)
    try {
      const doc = opts.nrd.parseDocument(readFileSync(reg, 'utf8'), { sigil: '$' }) as { get(p: string[]): unknown }
      for (const p of listOf(opts.nrd, doc.get(['links'])) ?? []) {
        const e = expandHome(p)
        space.push(isAbsolute(e) ? e : resolvePath(dirname(reg), e))
      }
    } catch {
      // нет реестра пространства — только `.nr/links.mdz`
    }
  }
  out.push({ layer: 'space', files: space })
  const user = safe(input.user)
  out.push({ layer: 'user', files: user ? [join(root, 'users', user, 'links.mdz')] : [] })
  out.push({ layer: 'stand', files: [join(root, 'links.mdz'), ...(opts.standFiles ?? [])] })
  return out
}

/**
 * Файлы слоя агента: `links` из `%meta` агента (`.mds`; пути — от файла агента) и соседний
 * `<id>.links.mdz` — у агента стенда (`<стенд>/agents`) и пространства (`<стенд>/projects/<id>/agents`).
 */
function agentLinkFiles(root: string, agent: string, space: string | null): string[] {
  const dirs = [...(space ? [join(root, 'projects', space, 'agents')] : []), join(root, 'agents')]
  const out: string[] = []
  for (const dir of dirs) {
    const doc = join(dir, `${agent}.mds`)
    try {
      const meta = parseChat(readFileSync(doc, 'utf8')).find((m) => m.role === 'meta')?.meta
      const list = meta?.links
      for (const p of Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : []) {
        if (typeof p !== 'string' || !p.trim()) continue
        const e = expandHome(p.trim())
        out.push(isAbsolute(e) ? e : resolvePath(dir, e))
      }
    } catch {
      // нет агента здесь — только соседний файл
    }
    out.push(join(dir, `${agent}.links.mdz`))
  }
  return out
}

/** Функции резолва правил: `coreFunctions` + пути. */
export function linkFunctions(nrd: LinksNrd): Record<string, (args: unknown[]) => unknown> {
  const s = (a: unknown[]): string => String(a[0] ?? '')
  const trim = (p: string): string => p.replace(/[\\/]+$/, '')
  return {
    ...nrd.coreFunctions,
    basename: (a) => basename(trim(s(a))),
    dirname: (a) => dirname(trim(s(a))),
    ext: (a) => extname(trim(s(a))).replace(/^\./, ''),
  }
}

export interface LinksEngine {
  /** Прочитать слои и свести правила (§3: сильный слой вытесняет одноимённые нижние). */
  rules(input: LinkLayersInput, o?: { trusted?: boolean }): LinkRules
  /** `${}` строк об слой `params` (самый сильный) + функции. */
  resolve(templates: string[], vars: Record<string, unknown>): string[]
  /** Действие `$run: exec` / `script` по id, сведённое заново по тем же слоям. */
  run(p: { action: string; vars: Record<string, unknown>; input: LinkLayersInput; trusted?: boolean; dryRun?: boolean }): Promise<LinkRunResult>
  /** Все файлы слоёв (в том числе несуществующие — их появление тоже событие). */
  files(input: LinkLayersInput): string[]
}

export function createLinksEngine(opts: LinksEngineOpts): LinksEngine {
  const { nrd } = opts
  const fns = nrd.funcContext(linkFunctions(nrd))
  const cache = new Map<string, { mtime: number; size: number; parsed: ParsedFile }>()

  function read(path: string, layer: LinkLayer): ParsedFile | null {
    let st
    try {
      st = statSync(path)
    } catch {
      return null
    }
    if (!st.isFile()) return null
    const key = `${layer}\0${path}`
    const hit = cache.get(key)
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.parsed
    try {
      const parsed = parseLinksFile(nrd, path, readFileSync(path, 'utf8'), layer)
      cache.set(key, { mtime: st.mtimeMs, size: st.size, parsed })
      return parsed
    } catch (err) {
      process.stderr.write(`links: ${path} не разобран — ${(err as Error).message}\n`)
      return null
    }
  }

  /** Файлы слоя с `$links`-включениями (сильный первым, включения — за своим файлом), без циклов. */
  function expand(layer: LinkLayerFiles, seen: Set<string>): ParsedFile[] {
    const out: ParsedFile[] = []
    const walk = (path: string, depth: number): void => {
      if (seen.has(path) || depth > 4) return
      seen.add(path)
      const f = read(path, layer.layer)
      if (!f) return
      out.push(f)
      for (const inc of f.includes) walk(inc, depth + 1)
    }
    for (const f of layer.files) walk(f, 0)
    return out
  }

  function files(input: LinkLayersInput): string[] {
    const seen = new Set<string>()
    for (const l of opts.layers(input)) expand(l, seen)
    for (const l of opts.layers(input)) for (const f of l.files) seen.add(f)
    return [...seen]
  }

  function rules(input: LinkLayersInput, o: { trusted?: boolean } = {}): LinkRules {
    const trusted = o.trusted !== false
    const seen = new Set<string>()
    const files: LayeredLinksFile[] = []
    for (const layer of opts.layers(input)) {
      const layerTrusted = trusted || layer.layer === 'stand'
      for (const file of expand(layer, seen)) files.push({ layer: layer.layer, trusted: layerTrusted, file })
    }
    return mergeLinkRules(files, trusted)
  }

  function resolveAll(templates: string[], vars: Record<string, unknown>): string[] {
    const ctx = nrd.chainContext(nrd.objectContext(vars), fns)
    return templates.map((t) => {
      try {
        return nrd.resolve(String(t ?? ''), ctx)
      } catch (err) {
        return `⚠ ${(err as Error).message}`
      }
    })
  }

  const runLocal = (cmd: string, timeout: number): Promise<LinkRunResult> =>
    new Promise((done) => {
      execFile('/bin/sh', ['-c', cmd], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
        done({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === 1 ? err.message : '') })
      })
    })

  return {
    rules,
    resolve: resolveAll,
    files,
    async run(p) {
      const set = rules(p.input, { trusted: p.trusted !== false })
      const a = set.actions.find((x) => x.id === p.action)
      if (!a) throw fail('not_found', `links.run: действия «${p.action}» нет (или оно недоступно без доверия)`)
      if (a.run === 'exec') {
        if (!a.cmd) throw fail('bad_request', `links.run: у «${a.id}» нет $cmd`)
        const [cmd, where] = resolveAll([a.cmd, a.where ?? ''], p.vars)
        const w = where!.trim()
        const at = w || opts.hub
        if (p.dryRun) return { code: 0, stdout: '', stderr: '', command: cmd!, ...(at ? { where: at } : {}) }
        if (!w || w === opts.hub) return { ...(await runLocal(cmd!, 30_000)), ...(opts.hub ? { where: opts.hub } : {}) }
        if (!opts.execOn) throw fail('not_supported', `links.run: машины «${w}» хаб не знает`)
        return { ...(await opts.execOn(w, cmd!, { timeout: 30_000 })), where: w }
      }
      if (a.run === 'script') {
        if (!a.path) throw fail('bad_request', `links.run: у «${a.id}» нет $path`)
        const file = isAbsolute(expandHome(a.path)) ? expandHome(a.path) : resolvePath(dirname(a.source ?? '.'), a.path)
        if (!existsSync(file)) throw fail('not_found', `links.run: нет модуля ${file}`)
        if (p.dryRun) return { code: 0, stdout: '', stderr: '', command: file }
        const mod = (await import(pathToFileURL(file).href)) as { default?: (vars: Record<string, unknown>) => unknown }
        if (typeof mod.default !== 'function') throw fail('bad_request', `links.run: ${file} — нет default-функции`)
        const out = await mod.default(p.vars)
        return { code: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out ?? null), stderr: '' }
      }
      throw fail('bad_request', `links.run: «${a.run}» выполняет фронт`)
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Сервис
// ────────────────────────────────────────────────────────────────────────────

export interface LinksServiceOpts extends Omit<LinksEngineOpts, 'layers'> {
  layers(input: LinkLayersInput, meta: ServiceMeta, ctx: unknown): LinkLayerFiles[]
  /** Слежение за файлами слоёв; default — да. */
  watch?: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Вход слоёв из параметров вызова; пользователя у гостя решает гейт (`$caller`), не клиент. */
function inputOf(p: Record<string, unknown>): { input: LinkLayersInput; trusted: boolean } {
  const s = (k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : undefined)
  const caller = isRecord(p.$caller) ? p.$caller : null
  const user = caller && typeof caller.user === 'string' ? caller.user : s('user')
  const input: LinkLayersInput = {
    ...(s('agent') ? { agent: s('agent')! } : {}),
    ...(s('space') ? { space: s('space')! } : {}),
    ...(s('cwd') ? { cwd: s('cwd')! } : {}),
    ...(user ? { user } : {}),
  }
  return { input, trusted: !caller || caller.owner === true }
}

/**
 * `service.ts` сервиса `links`: `rules`, `resolve`, `run`, стрим `watch` (кадр `changed`).
 */
export function createLinksService(opts: LinksServiceOpts): (ctx: unknown, meta: ServiceMeta) => void {
  return (ctx, meta) => {
    const engine = createLinksEngine({ ...opts, layers: (input) => opts.layers(input, meta, ctx) })
    const P = (p: unknown): Record<string, unknown> => (isRecord(p) ? p : {})
    meta.on('rules', (p) => {
      const { input, trusted } = inputOf(P(p))
      return engine.rules(input, { trusted })
    })
    meta.on('resolve', (p) => {
      const q = P(p)
      const templates = Array.isArray(q.templates) ? q.templates.map((t) => String(t ?? '')) : []
      return engine.resolve(templates, isRecord(q.vars) ? q.vars : {})
    })
    meta.on('run', (p) => {
      const q = P(p)
      if (typeof q.action !== 'string' || q.action === '') throw fail('bad_request', 'links.run: нужен action')
      const { input, trusted } = inputOf(q)
      return engine.run({ action: q.action, vars: isRecord(q.vars) ? q.vars : {}, input, trusted, dryRun: q.dryRun === true })
    })
    meta.stream('watch', (p, sink: ServiceSink, signal) => watchLayers(engine, inputOf(P(p)).input, sink, signal, opts.watch !== false))
  }
}

/** Файлы слоёв меняются → `changed` (склейка 150 мс); каталоги, которых ещё нет, — опросом раз в 2 с. */
function watchLayers(engine: LinksEngine, input: LinkLayersInput, sink: ServiceSink, signal: AbortSignal, enabled: boolean): Promise<void> {
  return new Promise<void>((done) => {
    const watchers: FSWatcher[] = []
    let armed = ''
    let timer: NodeJS.Timeout | null = null
    let stamp = ''
    const stampOf = (fs: string[]): string =>
      fs
        .map((f) => {
          try {
            const st = statSync(f)
            return `${f}:${st.mtimeMs}:${st.size}`
          } catch {
            return `${f}:-`
          }
        })
        .join('\n')
    const fire = (): void => {
      timer = null
      const now = stampOf(engine.files(input))
      if (now === stamp) return
      stamp = now
      sink('changed', {})
      arm()
    }
    const bump = (): void => {
      if (!timer) timer = setTimeout(fire, 150)
    }
    const arm = (): void => {
      if (!enabled) return
      const fs = engine.files(input)
      const dirs = [...new Set(fs.map((f) => dirname(f)))].filter((d) => existsSync(d))
      const key = dirs.join('\n')
      if (key === armed) return
      armed = key
      for (const w of watchers.splice(0)) w.close()
      const names = new Set(fs.map((f) => basename(f)))
      for (const dir of dirs) {
        try {
          watchers.push(watch(dir, (_ev, name) => (name === null || names.has(String(name)) ? bump() : undefined)))
        } catch {
          // каталог исчез — опрос подберёт
        }
      }
    }
    stamp = stampOf(engine.files(input))
    arm()
    const poll = setInterval(() => {
      if (stampOf(engine.files(input)) !== stamp) bump()
    }, 2000)
    signal.addEventListener('abort', () => {
      clearInterval(poll)
      if (timer) clearTimeout(timer)
      for (const w of watchers) w.close()
      done()
    })
  })
}
