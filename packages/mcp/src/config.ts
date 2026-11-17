/**
 * Конфиг машины `~/.config/nr-mcp/config.md` (board-edge-spec §3): mdz из скаляров верхнего уровня.
 * Вне `envs/` — там git с автокоммитом, а здесь токен.
 *
 *   $name: mini                 имя машины — его видит модель и хаб
 *   $token: …                 bearer (`Authorization: Bearer`, никогда в query)
 *   $connector: …             секрет пути `/c/<секрет>/mcp` — вход коннектора claude.ai (заголовков он не шлёт);
 *                             нет — маршрута нет. Свой у машины, отдельно от $token: сменить — не трогая хаб
 *   $roots: [~/Studio, ~/WORK]  корни путей; вне — отказ (страховка, не защита; default — дом)
 *   $policy: auto             апрувов у nr-mcp нет (owner 23.10) — другого значения нет
 *   $deny: [shutdown*]        маски команд `exec` (`*` — любая подстрока); default — пусто
 *   $port: 7890
 *   $listen: 127.0.0.1        адрес; хост за туннелем другой машины (Erin) — 0.0.0.0
 *   $hub: http://127.0.0.1:7800/api   хаб nrchat: тулы его сервисов — тулами машины (архив чатов)
 *   $hub_services: [archive]  какие сервисы хаба (по умолчанию archive)
 *   $hub_key: …               bearer хаба, если он за ключом
 *
 * Парсер свой и маленький: бинарю не нужен весь nrd ради шести строк.
 */

import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { childSpecs, type ChildSpec } from './children.js'

export interface McpConfig {
  name: string
  token: string
  /** Секрет пути коннектора (`/c/<connector>/mcp`); нет — маршрута нет. */
  connector?: string
  roots: string[]
  policy: 'auto'
  deny: string[]
  port: number
  listen: string
  /** Хаб nrchat: тулы его сервисов. */
  hub?: { url: string; services: string[]; key?: string }
  /** Дочерние MCP-серверы по stdio: `$stdio_<имя>: <команда> …`. */
  children: ChildSpec[]
}

export const DEFAULT_PORT = 7890

export const configPath = (home = homedir()): string => process.env.NR_MCP_CONFIG || join(home, '.config', 'nr-mcp', 'config.md')

function unquote(v: string): string {
  const t = v.trim()
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t
}

/** Значение строки: `[a, b]` — список, остальное — строка без кавычек. */
function value(raw: string): string | string[] {
  const t = raw.trim()
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    return inner ? inner.split(',').map(unquote).filter(Boolean) : []
  }
  return unquote(t)
}

/** `$ключ: значение` верхнего уровня (до первой секции `##`); `//` и `#` вне значения — комментарии. */
export function parseConfigText(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) break
    const m = /^\$([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (m) out[m[1]!] = value(m[2]!)
  }
  return out
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : v.split(',').map((x) => x.trim()).filter(Boolean))

export function expandHome(p: string, home = homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : resolve(p)
}

export function parseConfig(text: string, home = homedir()): McpConfig {
  const raw = parseConfigText(text)
  const token = typeof raw.token === 'string' ? raw.token : ''
  if (!token) throw new Error('config: нет $token')
  const policy = typeof raw.policy === 'string' && raw.policy ? raw.policy : 'auto'
  if (policy !== 'auto') throw new Error(`config: $policy ${policy} — у nr-mcp апрувов нет, есть только auto`)
  const port = Number(typeof raw.port === 'string' && raw.port ? raw.port : DEFAULT_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`config: $port ${String(raw.port)}`)
  const roots = list(raw.roots).map((r) => expandHome(r, home))
  const connector = typeof raw.connector === 'string' ? raw.connector : ''
  if (connector && connector.length < 32) throw new Error('config: $connector короче 32 знаков — секрет пути должен быть длинным')
  return {
    name: (typeof raw.name === 'string' && raw.name) || hostname().split('.')[0]!,
    token,
    ...(connector ? { connector } : {}),
    roots: roots.length ? roots : [home],
    policy: 'auto',
    deny: list(raw.deny),
    port,
    listen: (typeof raw.listen === 'string' && raw.listen) || '127.0.0.1',
    children: childSpecs(raw),
    ...(typeof raw.hub === 'string' && raw.hub
      ? { hub: { url: raw.hub, services: list(raw.hub_services).length ? list(raw.hub_services) : ['archive'], ...(typeof raw.hub_key === 'string' && raw.hub_key ? { key: raw.hub_key } : {}) } }
      : {}),
  }
}

/** Текст нового конфига (`nr-mcp init`). */
export function configTemplate(o: { name: string; token: string; roots?: string[]; port?: number; listen?: string }): string {
  return [
    '// nr-mcp — руки агента на этой машине (nrchat.dev/specs/board-edge-spec.md §3).',
    '// Токен — только здесь и в secrets клиента; файл не класть в git.',
    `$name: ${o.name}`,
    `$token: ${o.token}`,
    `$roots: [${(o.roots ?? ['~']).join(', ')}]`,
    '$policy: auto',
    '$deny: []',
    `$port: ${o.port ?? DEFAULT_PORT}`,
    `$listen: ${o.listen ?? '127.0.0.1'}`,
    '',
  ].join('\n')
}
