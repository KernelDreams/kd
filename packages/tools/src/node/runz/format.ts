/**
 * Представление результатов текстом — для модели (content tool_result) и для
 * человека (`/runz`). Структура целиком уезжает в `details`.
 */

import type { RunOutcome, RunzError } from './run.js'

/** Аргумент в командной строке для показа: с кавычками, если нужно. */
export function quoteArg(arg: string): string {
  return arg !== '' && /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

export function commandLine(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}

function status(r: RunOutcome, timeoutMs: number): string {
  if (r.timedOut) return `killed: timeout after ${timeoutMs / 1000}s`
  if (r.aborted) return 'killed: aborted'
  if (r.exitCode !== null) return `exit ${r.exitCode}`
  return `killed by ${r.signal ?? 'signal'}`
}

/**
 * Результат запуска. При обрезке первая строка — `[truncated: N of M chars]`
 * (§2): модель видит, что это не всё, до того как дочитает.
 */
export function formatRun(argv: readonly string[], r: RunOutcome, timeoutMs: number): string {
  const lines: string[] = []
  if (r.truncated) {
    lines.push(`[truncated: ${r.stdout.length + r.stderr.length} of ${r.stdoutChars + r.stderrChars} chars]`)
  }
  lines.push(`$ ${commandLine(argv)}  (${status(r, timeoutMs)}, ${r.durationMs} ms)`)
  if (r.stdout !== '') lines.push('', r.stdout.replace(/\n$/, ''))
  if (r.stderr !== '') lines.push('', '[stderr]', r.stderr.replace(/\n$/, ''))
  if (r.stdout === '' && r.stderr === '') lines.push('', '(no output)')
  return lines.join('\n')
}

/** Строки `runz --runz-list` → имена. */
export function parseList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Строки `runz --runz-list --runz-describe`: `имя<TAB>что это`; старый runz — одни имена. */
export function parseCatalog(stdout: string): { name: string; about: string }[] {
  return parseList(stdout).map((l) => {
    const i = l.indexOf('\t')
    return i < 0 ? { name: l, about: '' } : { name: l.slice(0, i).trim(), about: l.slice(i + 1).trim() }
  })
}

/** Фильтр по подстроке имени или описания. */
export function filterCatalog<T extends { name: string; about: string }>(items: readonly T[], filter: string | undefined): T[] {
  const needle = filter?.trim().toLowerCase()
  return needle ? items.filter((x) => x.name.toLowerCase().includes(needle) || x.about.toLowerCase().includes(needle)) : [...items]
}

export function formatCatalog(items: readonly { name: string; about: string }[], filter: string | undefined): string {
  const scope = filter?.trim() ? ` matching "${filter.trim()}"` : ''
  if (items.length === 0) return `No runz scripts${scope}.`
  return `${items.length} runz scripts${scope}:\n${items.map((x) => (x.about ? `${x.name} — ${x.about}` : x.name)).join('\n')}`
}

export function filterNames(names: readonly string[], filter: string | undefined): string[] {
  const needle = filter?.trim().toLowerCase()
  return needle ? names.filter((n) => n.toLowerCase().includes(needle)) : [...names]
}

export function formatList(names: readonly string[], filter: string | undefined): string {
  const scope = filter?.trim() ? ` matching "${filter.trim()}"` : ''
  if (names.length === 0) return `No runz scripts${scope}.`
  return `${names.length} runz scripts${scope}:\n${names.join('\n')}`
}

export function errorText(tool: string, e: RunzError): string {
  return `${tool} failed [${e.code}]: ${e.message}`
}
