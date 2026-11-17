// Общее для скриптов kd: корень репы, скоуп и версия пакетов, чтение манифестов, пакеты рабочей области.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SCOPE = '@kerneldreams'

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

/** Единая версия пакетов kd — версия корневого package.json. */
export const VERSION = readJson(path.join(KD_ROOT, 'package.json')).version

/** Имя пакета из спецификатора: `@a/b/c` → `@a/b`, `x/y` → `x`. */
export function packageOf(spec) {
  const parts = spec.split('/')
  return parts.slice(0, spec.startsWith('@') ? 2 : 1).join('/')
}

/** Пакеты рабочей области kd: [{ dir, abs, pkg }]. */
export function workspacePackages(root = KD_ROOT) {
  const base = path.join(root, 'packages')
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, 'package.json')))
    .map((d) => ({ dir: d.name, abs: path.join(base, d.name), pkg: readJson(path.join(base, d.name, 'package.json')) }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

/** Внутренние зависимости пакета kd (имена `@kerneldreams/*` из всех секций, кроме себя). */
export function internalDeps(pkg) {
  const out = new Set()
  for (const sec of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const n of Object.keys(pkg[sec] ?? {})) if (n.startsWith(SCOPE + '/') && n !== pkg.name) out.add(n)
  }
  return [...out]
}
