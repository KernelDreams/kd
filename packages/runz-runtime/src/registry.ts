/**
 * @kerneldreams/runz-runtime — script registry
 *
 * Resolves a script name to a file. Search order (first match wins):
 *   1. current directory
 *   2. project registry `.runz/scripts/`
 *   3. `$paths` directories from the chain
 *   4. built-in scripts (runz distribution)
 *   5. global registry `~/.runz/scripts/`
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { expandHome, resolvePath } from './paths.ts'
import { builtinScriptsDir } from './home.ts'

export interface RegistryOptions {
  /** Working directory. */
  cwd: string
  /** Project root (directory containing `.runz/`), or null. */
  projectDir: string | null
  /** Extra script directories from `$paths` in the chain. */
  paths: string[]
}

export interface ResolvedScript {
  /** Absolute path to the resolved `.ts` or `.md` file. */
  file: string
  /** Script name (basename without extension). */
  name: string
}

export { builtinScriptsDir }

/** Global registry directory `~/.runz/`. */
export function globalRunzDir(): string {
  // `RUNZ_GLOBAL_DIR` — хост (команда kd) решает, видит ли прогон пользовательский слой runz.
  return process.env.RUNZ_GLOBAL_DIR || path.join(os.homedir(), '.runz')
}

/** Расширения документов, которые runz исполняет (rz-merge §2.4). */
const DOC_EXT = ['.md', '.mdz', '.mdd', '.mds'] as const

/** Is this argument an explicit path (vs a registry name)? */
export function isDirectPath(arg: string): boolean {
  const lower = arg.toLowerCase()
  return (
    arg.startsWith('~') ||
    arg.includes('/') ||
    arg.includes('\\') ||
    path.isAbsolute(arg) ||
    lower.endsWith('.ts') ||
    DOC_EXT.some((e) => lower.endsWith(e))
  )
}

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      // not found
    }
  }
  return null
}

/** Candidate files for a script name inside a directory. */
function candidatesIn(dir: string, name: string, tsOnly: boolean): string[] {
  const out = [path.join(dir, `${name}.ts`)]
  if (!tsOnly) {
    for (const ext of DOC_EXT) out.push(path.join(dir, `${name}${ext}`))
  }
  out.push(path.join(dir, name, 'index.ts'))
  // Атом, собранный бандлом (переносной комплект: без исходников и без хука .ts).
  out.push(path.join(dir, name, 'index.mjs'))
  return out
}

/** Ordered list of directories searched by the registry. */
function searchDirs(opts: RegistryOptions): string[] {
  const dirs: string[] = [opts.cwd]
  if (opts.projectDir) {
    dirs.push(path.join(opts.projectDir, '.runz', 'scripts'))
  }
  for (const p of opts.paths) {
    dirs.push(expandHome(p))
  }
  dirs.push(builtinScriptsDir())
  dirs.push(path.join(globalRunzDir(), 'scripts'))
  return dirs
}

export interface FindOptions {
  /** Restrict resolution to `.ts` files only (used for handler lookup). */
  tsOnly?: boolean
}

/**
 * Resolve a script argument to a file.
 *
 * An explicit path (`./x.ts`, absolute, `.md`/`.ts` extension) is resolved
 * directly. A bare name is searched through the registry.
 */
export function findScript(
  arg: string,
  opts: RegistryOptions,
  find: FindOptions = {},
): ResolvedScript | null {
  if (isDirectPath(arg)) {
    const abs = resolvePath(arg, opts.cwd)
    const found = firstExisting([abs])
    if (found) {
      const base = path.basename(found).replace(/\.(ts|mjs|md|mdz|mdd|mds)$/i, '')
      // `<папка>/index.ts` путём — тот же скрипт, что по имени папки (его `<имя>.config.md` рядом).
      return { file: found, name: base === 'index' ? path.basename(path.dirname(found)) : base }
    }
    return null
  }

  for (const dir of searchDirs(opts)) {
    const found = firstExisting(candidatesIn(dir, arg, find.tsOnly ?? false))
    if (found) return { file: found, name: arg }
  }
  return null
}

/**
 * List all script names from curated registry directories — project
 * `.runz/scripts/`, `$paths`, built-in, and global. The bare working
 * directory is searched for resolution but not enumerated here (it holds
 * arbitrary files, not a curated script set).
 */
/** Заметки агентам и описания рядом со скриптами, не скрипты. */
const NOT_SCRIPTS = /^(CLAUDE|AGENTS|README)\.md$/i

export function listScripts(opts: RegistryOptions): string[] {
  const names = new Set<string>()
  for (const dir of searchDirs(opts)) {
    if (path.resolve(dir) === path.resolve(opts.cwd)) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue
      if (NOT_SCRIPTS.test(e.name)) continue
      const lower = e.name.toLowerCase()
      if (e.isFile() && (lower.endsWith('.ts') || DOC_EXT.some((x) => lower.endsWith(x)))) {
        if (lower.endsWith('.config.md')) continue
        if (lower.endsWith('.test.ts')) continue
        names.add(e.name.replace(/\.(ts|md|mdz|mdd|mds)$/i, ''))
      } else if (e.isDirectory()) {
        try {
          if (firstExisting([path.join(dir, e.name, 'index.ts'), path.join(dir, e.name, 'index.mjs')])) {
            names.add(e.name)
          }
        } catch {
          // no index.ts
        }
      }
    }
  }
  return [...names].sort()
}

/** Walk up from `cwd` to find the directory containing a `.runz/` folder. */
export function findProjectDir(cwd: string): string | null {
  let dir = path.resolve(cwd)
  while (true) {
    try {
      if (fs.statSync(path.join(dir, '.runz')).isDirectory()) return dir
    } catch {
      // no .runz here
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
