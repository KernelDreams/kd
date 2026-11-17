/**
 * @kerneldreams/runz-runtime — environment discovery
 *
 * `.runz/` directories form a chain: nearest to cwd wins, then walk up, then
 * `~/.runz/` as a user-level fallback. Used by the resolve hook (to fall back
 * through env node_modules) and by `runz add` (to pick where to install).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Collect existing `.runz/node_modules` directories — nearest first.
 *
 *   D:\proj\.runz\node_modules
 *   D:\.runz\node_modules
 *   ~/.runz/node_modules
 *
 * Only existing directories are returned. Order matters: closer to cwd wins.
 */
export function collectEnvNodeModules(cwd: string): string[] {
  const result: string[] = []
  let cur = path.resolve(cwd)
  while (true) {
    const nm = path.join(cur, '.runz', 'node_modules')
    if (fs.existsSync(nm)) result.push(nm)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  const userNm = path.join(os.homedir(), '.runz', 'node_modules')
  if (fs.existsSync(userNm) && !result.includes(userNm)) result.push(userNm)
  return result
}

/**
 * Nearest existing `.runz/` dir walking up from cwd. If none exists, returns
 * `<cwd>/.runz` (caller will create it).
 */
export function nearestEnvDir(cwd: string): string {
  let cur = path.resolve(cwd)
  while (true) {
    const env = path.join(cur, '.runz')
    if (fs.existsSync(env)) return env
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return path.join(path.resolve(cwd), '.runz')
}

/** User-level env directory: `~/.runz/`. */
export function userEnvDir(): string {
  return path.join(os.homedir(), '.runz')
}
