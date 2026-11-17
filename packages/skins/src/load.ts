/**
 * Вход конвертеров тем с диска и из сети (skin-convert-spec §1): `runz skin convert`, тул `skin_convert`, плагин импорта: файл, папка, `.vsix` или адрес → список тем.
 *
 *   theme.css (+ manifest.json рядом)        Obsidian
 *   *.json                                   SillyTavern / VS Code (угадывает nr-skins)
 *   папка расширения VS Code (package.json)  contributes.themes[] — по скину на тему, `include` развёрнут
 *   *.vsix                                   zip расширения VS Code — распаковка во временную папку
 *   папка тем                                каждый файл / подпапка с theme.css — отдельная тема
 *   https://github.com/<o>/<r>               репа темы Obsidian: theme.css + manifest.json с ветки по умолчанию
 *   https://…                                файл темы как есть (raw GitHub, jsDelivr)
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { formatReport, skinName, type ConvertResult, type ConvertSource, type ConvertTarget } from './convert/core.js'
import { convertTheme } from './convert/index.js'
import { parseJsonc } from './vscode.js'

/** Одна тема на входе конвертера. */
export interface ThemeInput {
  /** Текст темы: CSS или JSON (у VS Code — с развёрнутым `include`). */
  text: string
  /** Подпись источника — в шапку `source:` и отчёт. */
  source: string
  /** Имя скина по умолчанию (из файла, манифеста, темы). */
  name?: string
  from?: ConvertSource
  manifest?: { name?: string; author?: string; version?: string }
  license?: string
  author?: string
}

export type Fetcher = (url: string) => Promise<string | null>

/** GET текстом; 404 и сетевые сбои — null. */
export const httpFetch: Fetcher = async (url) => {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'runz-skin' } })
    return r.ok ? await r.text() : null
  } catch {
    return null
  }
}

/** Репа GitHub из адреса: `https://github.com/o/r[/tree/<ветка>]` → {owner, repo, branch?}. */
export function parseGithubRepo(url: string): { owner: string; repo: string; branch?: string } | null {
  const m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+))?\/?$/.exec(url.trim())
  return m ? { owner: m[1]!, repo: m[2]!, ...(m[3] ? { branch: m[3] } : {}) } : null
}

/** SPDX лицензии по тексту LICENSE (первые строки). */
export function licenseOf(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  const head = text.slice(0, 600)
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(head)) return 'AGPL-3.0'
  if (/GNU GENERAL PUBLIC LICENSE/i.test(head)) return /Version 2/i.test(head) ? 'GPL-2.0' : 'GPL-3.0'
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(head)) return 'LGPL-3.0'
  if (/MIT License|Permission is hereby granted, free of charge/i.test(head)) return 'MIT'
  if (/This is free and unencumbered software released into the public domain/i.test(head)) return 'Unlicense'
  if (/Apache License/i.test(head)) return 'Apache-2.0'
  if (/Mozilla Public License/i.test(head)) return 'MPL-2.0'
  if (/BSD/i.test(head)) return 'BSD'
  if (/Creative Commons/i.test(head)) return 'CC'
  return undefined
}

const readJson = (p: string): Record<string, unknown> | null => {
  try {
    return parseLooseJson(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** JSON с комментариями и висячими запятыми (темы VS Code) — то же, что `parseJsonc`. */
export function parseLooseJson(text: string): unknown {
  return parseJsonc(text)
}

/** Тема VS Code с развёрнутым `include` (цепочка файлов рядом). */
export function resolveVsCodeInclude(file: string, depth = 0): Record<string, unknown> {
  const own = readJson(file) ?? {}
  const inc = typeof own.include === 'string' && depth < 8 ? join(dirname(file), own.include) : null
  if (!inc || !existsSync(inc)) return own
  const base = resolveVsCodeInclude(inc, depth + 1)
  const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
  return {
    ...base,
    ...own,
    colors: { ...((base.colors as object) ?? {}), ...((own.colors as object) ?? {}) },
    tokenColors: [...arr(base.tokenColors), ...arr(own.tokenColors)],
  }
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'COPYING']
const licenseIn = (dir: string): string | undefined => {
  for (const f of LICENSE_FILES) if (existsSync(join(dir, f))) return licenseOf(readFileSync(join(dir, f), 'utf8'))
  return undefined
}

/** Папка расширения VS Code: `package.json` с `contributes.themes[]` → темы. */
function vscodeExtension(dir: string): ThemeInput[] | null {
  const pkg = readJson(join(dir, 'package.json'))
  const themes = ((pkg?.contributes as { themes?: Array<{ label?: string; path?: string; uiTheme?: string }> } | undefined)?.themes ?? []).filter((t) => t.path)
  if (!themes.length) return null
  const license = typeof pkg?.license === 'string' ? pkg.license : licenseIn(dir)
  const author = typeof pkg?.publisher === 'string' ? pkg.publisher : typeof pkg?.author === 'string' ? pkg.author : undefined
  return themes.map((t) => {
    const theme = resolveVsCodeInclude(join(dir, t.path!))
    if (!theme.type && t.uiTheme) theme.type = /light/i.test(t.uiTheme) ? 'light' : 'dark'
    return {
      text: JSON.stringify(theme),
      source: `${typeof pkg?.name === 'string' ? pkg.name : basename(dir)}/${t.path!.replace(/^\.\//, '')}`,
      name: t.label ?? (theme.name as string | undefined),
      from: 'vscode' as const,
      ...(license ? { license } : {}),
      ...(author ? { author } : {}),
    }
  })
}

/** Папка темы Obsidian: `theme.css` (+ `manifest.json`, LICENSE). */
function obsidianDir(dir: string): ThemeInput | null {
  const css = join(dir, 'theme.css')
  if (!existsSync(css)) return null
  const manifest = readJson(join(dir, 'manifest.json')) as ThemeInput['manifest'] | null
  const license = licenseIn(dir)
  return {
    text: readFileSync(css, 'utf8'),
    source: manifest?.name ? `obsidian:${manifest.name}` : css,
    ...(manifest?.name ? { name: manifest.name } : {}),
    from: 'obsidian',
    ...(manifest ? { manifest } : {}),
    ...(license ? { license } : {}),
    ...(manifest?.author ? { author: manifest.author } : {}),
  }
}

/** Файл темы: CSS / JSON (у JSON VS Code — `include` развёрнут). */
function themeFile(file: string): ThemeInput | null {
  const ext = extname(file).toLowerCase()
  if (ext === '.css') {
    if (file.endsWith('.skin.css')) return null
    if (basename(file) === 'theme.css') return obsidianDir(dirname(file))
    return { text: readFileSync(file, 'utf8'), source: file, name: basename(file, ext) }
  }
  if (ext === '.json') {
    const j = readJson(file)
    if (!j || basename(file) === 'package.json' || basename(file) === 'manifest.json') return null
    const theme = typeof j.include === 'string' ? resolveVsCodeInclude(file) : j
    return { text: JSON.stringify(theme), source: file, name: (theme.name as string | undefined) ?? basename(file, ext) }
  }
  return null
}

/** Распаковать `.vsix` (zip) во временную папку — `unzip` системы. */
function unpackVsix(file: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'runz-skin-vsix-'))
  execFileSync('unzip', ['-q', '-o', file, '-d', dir])
  return existsSync(join(dir, 'extension')) ? join(dir, 'extension') : dir
}

/** Локальный путь → темы. Папка без маркеров — каждая тема внутри (на один уровень вглубь). */
export function themesAt(path: string): ThemeInput[] {
  const p = resolve(path)
  if (!existsSync(p)) throw new Error(`нет такого файла или папки: ${path}`)
  if (statSync(p).isFile()) {
    if (p.toLowerCase().endsWith('.vsix')) return vscodeExtension(unpackVsix(p)) ?? []
    const t = themeFile(p)
    return t ? [t] : []
  }
  const ext = vscodeExtension(p)
  if (ext) return ext
  const obs = obsidianDir(p)
  if (obs) return [obs]
  const out: ThemeInput[] = []
  for (const f of readdirSync(p).sort()) {
    if (f.startsWith('.')) continue
    const q = join(p, f)
    if (statSync(q).isDirectory()) out.push(...(vscodeExtension(q) ?? (obsidianDir(q) ? [obsidianDir(q)!] : [])))
    else if (f.toLowerCase().endsWith('.vsix')) out.push(...(vscodeExtension(unpackVsix(q)) ?? []))
    else {
      const t = themeFile(q)
      if (t) out.push(t)
    }
  }
  return out
}

/** Адрес → темы: репа GitHub (Obsidian) или файл как есть. */
export async function themesFromUrl(url: string, get: Fetcher = httpFetch): Promise<ThemeInput[]> {
  const gh = parseGithubRepo(url)
  if (gh) {
    for (const branch of gh.branch ? [gh.branch] : ['main', 'master']) {
      const raw = (f: string): string => `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${branch}/${f}`
      const css = await get(raw('theme.css'))
      if (css === null) continue
      const manifestText = await get(raw('manifest.json'))
      const manifest = manifestText ? (parseLooseJson(manifestText) as ThemeInput['manifest']) : undefined
      let license: string | undefined
      for (const f of LICENSE_FILES) {
        license = licenseOf(await get(raw(f)))
        if (license) break
      }
      return [
        {
          text: css,
          source: `https://github.com/${gh.owner}/${gh.repo}`,
          ...(manifest?.name ? { name: manifest.name } : { name: gh.repo }),
          from: 'obsidian',
          ...(manifest ? { manifest } : {}),
          ...(license ? { license } : {}),
          ...(manifest?.author ? { author: manifest.author } : {}),
        },
      ]
    }
    throw new Error(`в репе ${gh.owner}/${gh.repo} нет theme.css (ветки main, master) — для VS Code и ST дай адрес файла темы`)
  }
  const text = await get(url)
  if (text === null) throw new Error(`не скачалось: ${url}`)
  const name = decodeURIComponent(basename(new URL(url).pathname)).replace(/\.(css|json)$/i, '')
  return [{ text, source: url, name }]
}

/** Вход целиком: адрес или путь. */
export async function loadThemes(arg: string, get: Fetcher = httpFetch): Promise<ThemeInput[]> {
  return /^https?:\/\//i.test(arg) ? themesFromUrl(arg, get) : themesAt(arg)
}

// ────────────────────────────────────────────────────────────────────────────
// Пачка: темы → результаты (без записи) и сводный отчёт
// ────────────────────────────────────────────────────────────────────────────

export interface ConvertInputsOptions {
  from?: ConvertSource
  to?: ConvertTarget
  /** Имя скина (одна тема). */
  name?: string
}

export interface ConvertedTheme {
  input: ThemeInput
  result?: ConvertResult
  error?: string
}

/** Сконвертировать темы; имена уникализируются (`-2`, `-3`). */
export function convertInputs(themes: readonly ThemeInput[], opts: ConvertInputsOptions = {}): ConvertedTheme[] {
  const taken = new Set<string>()
  const run = (input: ThemeInput, name: string | undefined): ConvertResult =>
    convertTheme(input.text, {
      ...((opts.from ?? input.from) ? { from: opts.from ?? input.from } : {}),
      ...(opts.to ? { target: opts.to } : {}),
      ...(name ? { name } : {}),
      source: input.source,
      ...(input.license ? { license: input.license } : {}),
      ...(input.author ? { author: input.author } : {}),
      ...(input.manifest ? { manifest: input.manifest } : {}),
    })
  return themes.map((input) => {
    try {
      // Имя: заданное → из файла / манифеста → из самой темы (конвертер); занято — `-2`, `-3`.
      const wanted = opts.name && themes.length === 1 ? opts.name : input.name
      let result = run(input, wanted ? skinName(wanted) : undefined)
      const base = result.name ?? 'imported'
      for (let i = 2; taken.has(result.name ?? ''); i++) result = run(input, `${base.slice(0, 36)}-${i}`)
      taken.add(result.name ?? '')
      return { input, result }
    } catch (e) {
      return { input, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/** Сводный отчёт пачки (markdown): таблица и отчёты тем подряд. */
export function summaryReport(items: readonly ConvertedTheme[], title = 'Конверсия тем'): string {
  const ok = items.filter((x) => x.result)
  const lines = [
    `# ${title}`,
    '',
    `Тем: ${items.length}, сконвертировано: ${ok.length}${items.length > ok.length ? `, не вышло: ${items.length - ok.length}` : ''}.`,
    '',
    '| скин | источник | откуда | режим | покрытие | линтер | лицензия |',
    '|---|---|---|---|---|---|---|',
    ...items.map((x) =>
      x.result
        ? `| ${x.result.name} | ${x.result.source} | ${x.input.source} | ${x.result.mode ?? '—'} | ${Math.round(x.result.report.coverage * 100)}% | ${x.result.lint.ok ? 'ok' : 'ошибки'}, ⚠ ${x.result.lint.warnings.length} | ${x.result.header?.license ?? '—'} |`
        : `| — | — | ${x.input.source} | — | — | ✗ ${x.error} | — |`,
    ),
    '',
  ]
  for (const x of ok) lines.push(formatReport(x.result!, x.result!.name))
  return lines.join('\n')
}
