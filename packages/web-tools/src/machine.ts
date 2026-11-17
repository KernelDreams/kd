/**
 * Настройки веба машины — блок `## $web` в `~/.runz/config.md` (тот же, что
 * читает `runz web`), для хостов, у которых окружение запечено при старте
 * (стенд nr): правка блока действует со следующего вызова, без рестарта.
 *
 *   ## $web
 *   $provider: searxng,ddg            → NR_WEB_SEARCH
 *   $searxng_url: http://127.0.0.1:8888 → SEARXNG_URL
 *   $brave_api_key: …                  → BRAVE_API_KEY
 *   $browser_cdp: 9303                 → NR_WEB_BROWSER_CDP
 *   $browser_window: http://server:8083 → NR_WEB_BROWSER_WINDOW
 *   $allow_hosts: $[searx.lan]         → NR_WEB_FETCH_ALLOW_HOSTS
 *
 * Разбор — строки `$ключ: значение` до следующего `## `; переменные окружения
 * процесса сильнее блока. Файл перечитывается по mtime.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebEnv } from './search/types.js'

export const WEB_KEYS: Readonly<Record<string, string>> = {
  provider: 'NR_WEB_SEARCH',
  searxng_url: 'SEARXNG_URL',
  brave_api_key: 'BRAVE_API_KEY',
  browser_cdp: 'NR_WEB_BROWSER_CDP',
  browser_window: 'NR_WEB_BROWSER_WINDOW',
  allow_hosts: 'NR_WEB_FETCH_ALLOW_HOSTS',
}

/** Блок `## $web` текста конфига → переменные окружения веба. */
export function parseWebBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+\$web\s*$/.test(l.trim()))
  if (start < 0) return out
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break
    const m = /^\$([a-z_]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const env = WEB_KEYS[m[1]!]
    if (!env) continue
    let v = m[2]!.trim().replace(/^["']|["']$/g, '')
    const list = /^\$\[(.*)\]$/.exec(v)
    if (list) v = list[1]!.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).join(',')
    if (v) out[env] = v
  }
  return out
}

let cache: { file: string; mtime: number; env: Record<string, string> } | undefined

export function machineWebEnv(file = join(homedir(), '.runz', 'config.md')): Record<string, string> {
  try {
    const mtime = statSync(file).mtimeMs
    if (cache && cache.file === file && cache.mtime === mtime) return cache.env
    const env = parseWebBlock(readFileSync(file, 'utf8'))
    cache = { file, mtime, env }
    return env
  } catch {
    return {}
  }
}

/** Окружение для тулов: блок машины, поверх — заданные переменные процесса. */
export function defaultWebEnv(processEnv: NodeJS.ProcessEnv = process.env): WebEnv {
  const out: Record<string, string | undefined> = { ...machineWebEnv() }
  for (const k of Object.values(WEB_KEYS)) if (processEnv[k]) out[k] = processEnv[k]
  for (const k of ['NR_WEB_PROVIDER_TIMEOUT_MS']) if (processEnv[k]) out[k] = processEnv[k]
  return out
}
