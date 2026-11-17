/**
 * bare-импорт из тела `fn` доходит до `.runz/`-окружений.
 *
 * Документ лежит вне репы runz; тело `## $handler` импортирует пакет, которого
 * нет ни у документа, ни в runz, — только в окружении: глобальном
 * (`~/.runz/node_modules`, то, куда кладёт `runz add --global`) или проектном
 * (`<proj>/.runz/node_modules`). HOME подменяется — настоящий `~/.runz` не трогаем.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(HERE, '..', '..', 'bin', 'runz.ts')

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runz-envs-')))
const home = path.join(root, 'home')
fs.mkdirSync(home, { recursive: true })

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Минимальный ESM-пакет в `<nm>/<name>`. */
function fakePkg(nm: string, name: string, value: string): void {
  const dir = path.join(nm, ...name.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js' }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), `export const value = ${JSON.stringify(value)}\n`)
}

/** Документ с телом-хендлером, импортирующим `pkg`. */
function doc(dir: string, pkg: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'doc.mds')
  fs.writeFileSync(
    file,
    [
      "%handler main {nr: {lang: 'ts'}}",
      '```ts',
      `import { value } from '${pkg}'`,
      'export default async function () {',
      "  return { output: 'got: ' + value }",
      '}',
      '```',
      '',
    ].join('\n'),
  )
  return file
}

function runz(file: string, cwd: string): { status: number; out: string } {
  const r = spawnSync(process.execPath, [BIN, file], {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
  return { status: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

describe('ABC-88: тело fn видит .runz/-окружения', () => {
  const globalNm = path.join(home, '.runz', 'node_modules')
  fakePkg(globalNm, 'dev88-global', 'global')
  fakePkg(globalNm, '@kerneldreams/dev88-scoped', 'scoped')

  it('пакет из ~/.runz (runz add --global) — документ вне репы', () => {
    const work = path.join(root, 'work')
    const r = runz(doc(work, 'dev88-global'), work)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/got: global/)
  })

  it('@kerneldreams/* нет в воркспейсе → проваливается в окружения', () => {
    const work = path.join(root, 'work-scoped')
    const r = runz(doc(work, '@kerneldreams/dev88-scoped'), work)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/got: scoped/)
  })

  it('проектный .runz/node_modules — ищется от документа, не от cwd', () => {
    const proj = path.join(root, 'proj')
    fakePkg(path.join(proj, '.runz', 'node_modules'), 'dev88-proj', 'project')
    const file = doc(path.join(proj, 'sub'), 'dev88-proj')
    // cwd вне проекта: окружение находится только обходом вверх от тела.
    const r = runz(file, root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/got: project/)
  })

  it('проектное окружение ближе глобального', () => {
    const proj = path.join(root, 'proj2')
    fakePkg(path.join(proj, '.runz', 'node_modules'), 'dev88-global', 'nearest')
    const r = runz(doc(proj, 'dev88-global'), proj)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/got: nearest/)
  })

  it('отсутствующий пакет — внятная ошибка со списком просмотренных мест', () => {
    const proj = path.join(root, 'proj3')
    fs.mkdirSync(path.join(proj, '.runz', 'node_modules'), { recursive: true })
    const r = runz(doc(proj, 'dev88-missing'), proj)
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/Cannot find package 'dev88-missing'/)
    expect(r.out).toMatch(/просмотрено:/)
    expect(r.out).toContain(path.join(proj, '.runz', 'node_modules'))
    expect(r.out).toContain(globalNm)
    expect(r.out).toMatch(/runz: .*node_modules/)
    expect(r.out).toMatch(/runz add dev88-missing/)
  })
})

/**
 * пакет из `node_modules` импортёра, которого нет в воркспейсе runz.
 *
 * 28.09: `nrchat/node_modules/@kerneldreams/runz-run` хуком не находился — шаг
 * «node_modules импортёра» шёл после промаха в воркспейсе, а Node помнит
 * промах по имени пакета и отдаёт его на любой следующий parentURL.
 */
describe('ABC-66: node_modules импортёра вне воркспейса runz', () => {
  function script(dir: string, pkg: string): string {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'script.ts')
    fs.writeFileSync(
      file,
      [
        `import { value } from '${pkg}'`,
        'export default async function () {',
        "  return { output: 'got: ' + value }",
        '}',
        '',
      ].join('\n'),
    )
    return file
  }

  it('скрипт со своим node_modules/@acme/x — резолвится как голой нодой', () => {
    const ext = path.join(root, 'ext')
    fakePkg(path.join(ext, 'node_modules'), '@acme/dev66-x', 'own')
    const r = runz(script(path.join(ext, 'src'), '@acme/dev66-x'), root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/got: own/)
  })

  it('тело fn документа — тоже от файла-импортёра', () => {
    const ext = path.join(root, 'ext-doc')
    fakePkg(path.join(ext, 'node_modules'), '@acme/dev66-doc', 'doc-own')
    const r = runz(doc(ext, '@acme/dev66-doc'), root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/got: doc-own/)
  })

  it('ошибка перечисляет реально просмотренные node_modules импортёра', () => {
    const ext = path.join(root, 'ext-miss')
    fs.mkdirSync(path.join(ext, 'node_modules'), { recursive: true })
    const r = runz(script(path.join(ext, 'src'), '@acme/dev66-missing'), root)
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/Cannot find package '@acme\/dev66-missing'/)
    expect(r.out).toContain(`импортёр: ${path.join(ext, 'node_modules')}`)
    expect(r.out).toMatch(/runz: .*node_modules/)
  })
})
