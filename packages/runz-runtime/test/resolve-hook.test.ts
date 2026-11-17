import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initialize, resolve } from '../src/resolve-hook.ts'

/** Папка с `node_modules/<name>/package.json`. */
function pkgRoot(dir: string, name: string): string {
  fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name }))
  return dir
}

/** Откуда хук велел Node начать поиск: папка node_modules, из которой он ходит. */
function walkFrom(specifier: string, importer: string): string {
  let ctx: { parentURL?: string } = {}
  resolve(specifier, { parentURL: 'file://' + importer }, (_s: string, c: { parentURL?: string }) => {
    ctx = c
    return { url: 'file:///x' }
  })
  return path.join(path.dirname(fileURLToPath(ctx.parentURL!)), 'node_modules')
}

describe('resolve-hook: оверлей стенда задачи (ABC-777)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runz-overlay-'))
  const ws = pkgRoot(path.join(tmp, 'ws'), '@kerneldreams/backend-http')
  const importer = path.join(pkgRoot(path.join(tmp, 'app'), '@kerneldreams/backend-http'), 'index.ts')
  const stand = pkgRoot(path.join(tmp, 'stand'), '@kerneldreams/backend-http')
  pkgRoot(path.join(tmp, 'ws'), 'left-pad')

  afterEach(() => initialize({ workspaceRoot: ws, envs: [], overlay: '' }))

  it('без оверлея канонический @kerneldreams/* — из воркспейса runz, мимо node_modules импортёра', () => {
    initialize({ workspaceRoot: ws, envs: [], overlay: '' })
    expect(walkFrom('@kerneldreams/backend-http', importer)).toBe(path.join(ws, 'node_modules'))
  })

  it('оверлей — раньше воркспейса', () => {
    initialize({ workspaceRoot: ws, envs: [], overlay: path.join(stand, 'node_modules') })
    expect(walkFrom('@kerneldreams/backend-http/x', importer)).toBe(path.join(stand, 'node_modules'))
  })

  it('пакета нет в оверлее — прежний порядок', () => {
    initialize({ workspaceRoot: ws, envs: [], overlay: path.join(stand, 'node_modules') })
    expect(walkFrom('left-pad', importer)).toBe(path.join(ws, 'node_modules'))
  })

  it('RUNZ_OVERLAY из окружения; несуществующая папка — без оверлея', () => {
    process.env.RUNZ_OVERLAY = path.join(stand, 'node_modules')
    initialize({ workspaceRoot: ws, envs: [] })
    expect(walkFrom('@kerneldreams/backend-http', importer)).toBe(path.join(stand, 'node_modules'))
    process.env.RUNZ_OVERLAY = path.join(tmp, 'нет')
    initialize({ workspaceRoot: ws, envs: [] })
    expect(walkFrom('@kerneldreams/backend-http', importer)).toBe(path.join(ws, 'node_modules'))
    delete process.env.RUNZ_OVERLAY
  })
})

describe('resolve-hook: подмены имён нет', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runz-names-'))
  const ws = pkgRoot(path.join(tmp, 'ws'), '@kerneldreams/nrd')
  const importer = path.join(tmp, 'app', 'index.ts')
  it('чужой скоуп идёт в Node как есть', () => {
    initialize({ workspaceRoot: ws, envs: [], overlay: '' })
    let out = ''
    try {
      resolve('@old-scope/nr-md/schema', { parentURL: 'file://' + importer }, (s: string) => {
        out = s
        return { url: 'file:///x' }
      })
    } catch {
      /* не найден — громкая ошибка хука, это и нужно */
    }
    expect(out === '' || out === '@old-scope/nr-md/schema').toBe(true)
  })
})
