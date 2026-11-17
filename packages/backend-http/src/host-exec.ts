/**
 * Команда на машине хаба с тем же контрактом, что `RemoteHost.exec` (nr-far.dev/specs/git-spec.md §3):
 * без шелла (`execFile`), `{code, stdout, stderr}`, вывод до 4 МБ, таймаут. Рабочий каталог — по закрытому
 * списку стенда ({@link DEFAULT_EXTERNAL_DENY} + `$external_deny`), как у агента хоста: `forbidden`.
 * Git этапа 3 панели файлов идёт так на хабе и через агент — на удалённых хостах.
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileGlobRegExp } from '@kerneldreams/ui-protocol'
import { DEFAULT_EXTERNAL_DENY } from './external.js'

export interface HostExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface HostExecOpts {
  cwd?: string
  timeout?: number
  /** Окружение поверх своего (на удалённом хосте — через `env K=V cmd …`). */
  env?: Record<string, string>
}

export type HostExec = (cmd: string, args: string[], opts?: HostExecOpts) => Promise<HostExecResult>

const OUT_MAX = 4 * 1024 * 1024
const GLOB_CHARS = /[*?{[]/

/** Закрыт ли путь правилами стенда (дом и его реальный путь). */
export function externalDenied(home: string, extra: readonly string[] = []): (abs: string) => boolean {
  let real = home
  try {
    real = realpathSync(home)
  } catch {
    // нет каталога — как есть
  }
  const patterns = [...DEFAULT_EXTERNAL_DENY, ...extra].map((r) => r.trim()).filter((r) => r !== '')
  const rules = [...new Set([home, real])].flatMap((h) =>
    patterns.map((raw) => {
      const p = raw === '~' ? h : raw.startsWith('~/') ? join(h, raw.slice(2)) : raw
      if (!GLOB_CHARS.test(p)) {
        const prefix = p.replace(/\/+$/, '')
        return (abs: string) => abs === prefix || abs.startsWith(`${prefix}/`)
      }
      const re = fileGlobRegExp(p.replace(/^\/+/, ''))
      return (abs: string) => re.test(abs.replace(/^\/+/, ''))
    }),
  )
  return (abs) => rules.some((r) => r(abs))
}

/** Exec хаба: контракт `RemoteHost.exec` (+ `env`). */
export function createLocalExec(opts: { home?: string; deny?: string[] } = {}): HostExec {
  const home = opts.home ?? homedir()
  const denied = externalDenied(home, opts.deny ?? [])
  return (cmd, args, o = {}) =>
    new Promise((ok, bad) => {
      let cwd: string | undefined
      if (o.cwd) {
        const p = o.cwd === '~' ? home : o.cwd.startsWith('~/') ? join(home, o.cwd.slice(2)) : o.cwd
        if (!isAbsolute(p)) return bad(Object.assign(new Error(`exec: cwd — абсолютный путь: «${o.cwd}»`), { code: 'bad_request' }))
        cwd = resolve(p)
        let real = cwd
        try {
          real = realpathSync(cwd)
        } catch {
          // нет каталога — execFile скажет сам
        }
        if (denied(cwd) || denied(real)) return bad(Object.assign(new Error(`путь закрыт: ${cwd}`), { code: 'forbidden' }))
      }
      execFile(cmd, args, { cwd, timeout: o.timeout ?? 30_000, maxBuffer: OUT_MAX, env: o.env ? { ...process.env, ...o.env } : process.env, windowsHide: true }, (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null
        ok({
          code: e ? (typeof e.code === 'number' ? e.code : e.killed ? 124 : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr || (e && !stdout ? e.message : '')),
        })
      })
    })
}
