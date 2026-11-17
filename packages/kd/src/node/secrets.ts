/**
 * Ключи (kd-cli-spec §3): связка ключей системы (macOS `security`, Linux `secret-tool`); где её нет —
 * `~/.kd/secrets.mdz` с правами 600. Переменные окружения — поверх: ключ, уже стоящий в окружении,
 * не подменяется. Провайдер ссылается на ключ `${env.ИМЯ}` — значение кладётся в окружение прогона.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAttrs } from './home.js'

const SERVICE = 'kd'

export type SecretStore = 'keychain' | 'file'

function has(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
}

/** Где хранить: связка, если она есть и не отключена (`KD_SECRETS=file`). */
export function secretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  if (env.KD_SECRETS === 'file') return 'file'
  if (process.platform === 'darwin' && has('security')) return 'keychain'
  if (process.platform === 'linux' && has('secret-tool') && (env.DBUS_SESSION_BUS_ADDRESS || env.DISPLAY || env.WAYLAND_DISPLAY)) return 'keychain'
  return 'file'
}

const fileOf = (home: string): string => join(home, 'secrets.mdz')

function readFile(home: string): Record<string, string> {
  const a = readAttrs(fileOf(home)) ?? {}
  return Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v as string]))
}

function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

const quote = (v: string): string => JSON.stringify(v)

export function setSecret(home: string, name: string, value: string, env: NodeJS.ProcessEnv = process.env): SecretStore {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`имя ключа ${name}: только A-Z, 0-9, _`)
  const store = secretStore(env)
  if (store === 'keychain') {
    const r =
      process.platform === 'darwin'
        ? spawnSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value], { stdio: 'ignore' })
        : spawnSync('secret-tool', ['store', '--label', `kd ${name}`, 'service', SERVICE, 'key', name], { input: value, stdio: ['pipe', 'ignore', 'ignore'] })
    if (r.status === 0) return 'keychain'
  }
  const all = readFile(home)
  all[name] = value
  writeFileAtomic(fileOf(home), Object.entries(all).map(([k, v]) => `$${k}: ${quote(v)}`).join('\n') + '\n')
  return 'file'
}

export function getSecret(home: string, name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[name]) return env[name]
  if (secretStore(env) === 'keychain') {
    const r =
      process.platform === 'darwin'
        ? spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { encoding: 'utf8' })
        : spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'key', name], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.replace(/\n$/, '')
  }
  return readFile(home)[name]
}

/** Положить известные ключи в окружение прогона (окружение — поверх). */
export function loadSecretsIntoEnv(home: string, names: string[], env: NodeJS.ProcessEnv = process.env): void {
  for (const n of names) {
    if (env[n]) continue
    const v = getSecret(home, n, env)
    if (v) env[n] = v
  }
}

/** Все имена ключей файла (у связки перечисления нет — имена берутся из провайдеров). */
export function fileSecretNames(home: string): string[] {
  return existsSync(fileOf(home)) ? Object.keys(readFile(home)) : []
}

export const _test = { readFile: (home: string): string => (existsSync(fileOf(home)) ? readFileSync(fileOf(home), 'utf8') : '') }
