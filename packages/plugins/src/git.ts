/**
 * git машины (plugin-registry-spec §5: «доступ к закрытым репам решает git»): клон, теги, закреплённый коммит. Пароль
 * не спрашивается (`GIT_TERMINAL_PROMPT=0`) — нет доступа, значит отказ словами, а не висящий процесс.
 */

import { execFileSync } from 'node:child_process'
import { PluginError } from './manifest.js'

export interface GitOpts {
  /** Бинарь git; default — `git` из PATH. */
  bin?: string
  /** Таймаут одной команды, мс; default 120 с. */
  timeoutMs?: number
}

let defaults: GitOpts = {}
/** Тестам и хостам: свой бинарь / таймаут. */
export function configureGit(opts: GitOpts): void {
  defaults = { ...defaults, ...opts }
}

export function git(args: readonly string[], cwd?: string): string {
  try {
    return execFileSync(defaults.bin ?? 'git', args, {
      ...(cwd ? { cwd } : {}),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: defaults.timeoutMs ?? 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: process.env.GIT_ASKPASS ?? '', LC_ALL: 'C' },
      maxBuffer: 32 * 1024 * 1024,
    }).trim()
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string; code?: string }
    const text = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? e.message ?? '').trim()
    if (e.code === 'ENOENT') throw new PluginError('на машине нет git', 'git')
    const line = text.split('\n').filter((l) => !/^hint:/.test(l)).slice(-3).join(' ').replace(/https:\/\/[^@\s]+@/g, 'https://')
    throw new PluginError(`git ${args[0]}: ${line || 'ошибка'}`, 'git')
  }
}

/** `url#тег` → ссылка и тег (тега нет — `''`). */
export function splitRef(ref: string): { url: string; tag: string } {
  const at = ref.lastIndexOf('#')
  return at > 0 ? { url: ref.slice(0, at).trim(), tag: ref.slice(at + 1).trim() } : { url: ref.trim(), tag: '' }
}

/** Похоже ли на ссылку на git (а не на id или путь). */
export function isGitUrl(ref: string): boolean {
  const { url } = splitRef(ref)
  return /^(https?|ssh|git|file):\/\//.test(url) || /^[\w.-]+@[\w.-]+:/.test(url)
}

/** Теги удалённой репы без клона. */
export function remoteTags(url: string): string[] {
  const out = git(['ls-remote', '--tags', '--refs', url])
  return out
    .split('\n')
    .map((l) => /refs\/tags\/(.+)$/.exec(l)?.[1])
    .filter((t): t is string => !!t)
}

/** Теги клона (после `fetch --tags`). */
export function localTags(dir: string): string[] {
  const out = git(['tag', '--list'], dir)
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : []
}

export function commitOf(dir: string, rev: string): string {
  return git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], dir)
}

/** Нет правок отслеживаемых файлов. Неотслеживаемое (трассы прогонов runz `.runz/runs` рядом с файлом) — не правка. */
export function isClean(dir: string): boolean {
  return git(['status', '--porcelain', '--untracked-files=no'], dir) === ''
}

export function isGitDir(dir: string): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir) === 'true' && git(['rev-parse', '--show-toplevel'], dir) !== ''
  } catch {
    return false
  }
}
