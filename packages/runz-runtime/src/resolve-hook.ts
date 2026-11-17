/**
 * ESM resolve hook — opens runz workspace and `.runz/` env chain to scripts.
 *
 * External scripts (from $paths, ~/.runz/scripts/, any directory outside the
 * runz tree) and temporary `fn`-body modules (`.nrd-fn-*.ts`, written next to
 * the document) usually don't have @kerneldreams/* or runz's npm deps in
 * their own node_modules. This hook intercepts bare specifiers and walks:
 *
 *   1. @kerneldreams/* — the runz workspace first, so every script
 *      uses one canonical version. Not found there → continue the chain.
 *   2. The importer's own node_modules chain — the same directories plain
 *      Node would walk from the importing file.
 *   3. `.runz/node_modules` envs — nearest to the importing file first, then
 *      the ones above cwd, then `~/.runz/`. The walk from the importing file
 *      is what makes envs work for documents run from anywhere.
 *   4. The runz workspace (its npm deps are available without installing).
 *
 * Overlay: `RUNZ_OVERLAY` — a `node_modules` directory looked at
 * BEFORE all of the above, for any bare specifier. The task stand
 * (`runz projektor stand`) puts the task's package worktrees there, so the
 * canonical `@kerneldreams/*` resolve to the branch code instead of the main copies
 * the runz workspace links to — for the stand's whole process, transitively.
 *
 * Each step checks the filesystem and hands Node exactly one place to resolve
 * from (see `resolve` for why). Nothing matched → one error that lists every
 * `node_modules` actually looked at.
 *
 * Effect: `runz add <pkg>` installs into a chosen env; any script or document
 * body can `import 'pkg'` and get it resolved transparently.
 *
 * Built-ins (`node:fs`, `node:path`, …) and non-bare specifiers (relative,
 * absolute, URL) are passed through untouched.
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let workspaceRoot = ''
let cwdEnvs: string[] = []
let userEnv = ''
let overlay: string[] = []
/** Каталог этого модуля: от него вверх — node_modules рабочей области kd. */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))

export function initialize(data: { workspaceRoot: string; envs?: string[]; userEnv?: string; overlay?: string}): void {
  workspaceRoot = data.workspaceRoot
  cwdEnvs = data.envs ?? []
  userEnv = data.userEnv ?? path.join(os.homedir(), '.runz', 'node_modules')
  const o = data.overlay ?? process.env.RUNZ_OVERLAY ?? ''
  overlay = o && fs.existsSync(o) ? [o] : []
}

function isBareSpecifier(specifier: string): boolean {
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier === '.' ||
    specifier === '..'
  ) {
    return false
  }
  if (specifier.startsWith('/') || specifier.startsWith('#')) return false
  if (/^[a-zA-Z]:[\\/]/.test(specifier)) return false
  if (specifier.includes(':')) return false
  return true
}

function isCanonical(specifier: string): boolean {
  return specifier.startsWith('@kerneldreams/')
}

const envCache = new Map<string, string[]>()

/** Existing `.runz/node_modules` walking up from `dir` — nearest first. */
function envsAbove(dir: string): string[] {
  const hit = envCache.get(dir)
  if (hit) return hit
  const result: string[] = []
  let cur = dir
  while (true) {
    const nm = path.join(cur, '.runz', 'node_modules')
    if (fs.existsSync(nm)) result.push(nm)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  envCache.set(dir, result)
  return result
}

/** Env chain for one importer: from the file up, then cwd's, then `~/.runz/`. */
function envChain(parentURL: string | undefined): string[] {
  const chain: string[] = []
  if (parentURL?.startsWith('file:')) {
    chain.push(...envsAbove(path.dirname(fileURLToPath(parentURL))))
  }
  for (const nm of cwdEnvs) if (!chain.includes(nm)) chain.push(nm)
  if (userEnv && fs.existsSync(userEnv) && !chain.includes(userEnv)) chain.push(userEnv)
  return chain
}

/** Package name of a bare specifier: `@scope/name/sub` → `@scope/name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

const nmCache = new Map<string, string[]>()

/** Existing `node_modules` directories walking up from `dir` — nearest first. */
function nodeModulesUp(dir: string): string[] {
  const hit = nmCache.get(dir)
  if (hit) return hit
  const result: string[] = []
  let cur = dir
  while (true) {
    if (path.basename(cur) !== 'node_modules') {
      const nm = path.join(cur, 'node_modules')
      if (fs.existsSync(nm)) result.push(nm)
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  nmCache.set(dir, result)
  return result
}

function hasPackage(nm: string, name: string): boolean {
  try {
    return fs.statSync(path.join(nm, name)).isDirectory()
  } catch {
    return false
  }
}

/** A parentURL from which Node's own walk starts exactly at `nm`. */
function parentURLFor(nm: string): string {
  return pathToFileURL(path.join(nm, '..', 'package.json')).href
}

export function resolve(
  specifier: string,
  context: { parentURL?: string; conditions?: string[] },
  nextResolve: Function,
): unknown {
  if (!isBareSpecifier(specifier)) {
    return nextResolve(specifier, context)
  }

  const importer = context.parentURL?.startsWith('file:')
    ? fileURLToPath(context.parentURL)
    : (context.parentURL ?? '<unknown>')
  const name = packageName(specifier)
  const tried: string[] = []

  // Each step asks the filesystem first and calls Node only for the place
  // that has the package. Node (24–26) remembers a failed package lookup by
  // name, not by parentURL: after one miss every later `nextResolve` of the
  // same name throws the first error, whatever parentURL it gets — so
  // "try and catch" cannot walk a chain. Any error from the one real call
  // (broken exports map, missing main, …) is the real answer.
  const lookIn = (dirs: string[], label: (nm: string) => string): string | undefined => {
    for (const nm of dirs) {
      if (hasPackage(nm, name)) return nm
      tried.push(label(nm))
    }
    return undefined
  }

  // рантайм живёт в kd: его node_modules видят все пакеты @kerneldreams — запасной путь для канонических
  const workspaceDirs = [...new Set([...nodeModulesUp(workspaceRoot), ...(specifier.startsWith('@kerneldreams/') ? nodeModulesUp(SELF_DIR) : [])])]
  const importerDirs = context.parentURL?.startsWith('file:') ? nodeModulesUp(path.dirname(importer)) : []
  const envDirs = envChain(context.parentURL)

  const found =
    // 0. Overlay of the task stand — before everything.
    lookIn(overlay, nm => `оверлей: ${nm}`) ??
    // 1. Canonical packages — runz workspace first.
    (isCanonical(specifier) ? lookIn(workspaceDirs, nm => `runz: ${nm}`) : undefined) ??
    // 2. The importer's own node_modules chain.
    lookIn(importerDirs, nm => `импортёр: ${nm}`) ??
    // 3. `.runz/` envs.
    lookIn(envDirs.filter(nm => !importerDirs.includes(nm)), nm => `env: ${nm}`) ??
    // 4. Final fallback: runz workspace.
    (isCanonical(specifier) ? undefined : lookIn(workspaceDirs, nm => `runz: ${nm}`))

  if (found) return nextResolve(specifier, { ...context, parentURL: parentURLFor(found) })

  // No directory anywhere: let Node try once on its own terms (self-reference
  // by package name, non-file parents) before reporting.
  try {
    return nextResolve(specifier, context)
  } catch (err) {
    if ((err as { code?: string })?.code !== 'ERR_MODULE_NOT_FOUND') throw err
  }

  const err = new Error(
    `Cannot find package '${specifier}' imported from ${importer}\n` +
      `  просмотрено:\n` +
      tried.map(t => `    - ${t}`).join('\n') +
      `\n  поставить в окружение: runz add ${name} [--global]`,
  ) as Error & { code: string }
  err.code = 'ERR_MODULE_NOT_FOUND'
  throw err
}
