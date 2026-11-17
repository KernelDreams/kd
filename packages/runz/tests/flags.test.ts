// `--help` у любого скрипта — справка без запуска; объявленные флаги — неизвестный отказ до запуска.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { execute, parseFlags, unknownFlags, unknownFlagsError, wantsHelp } from '@kerneldreams/runz-runtime'
import type { ScriptResult } from '@kerneldreams/runz-runtime'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'flags')
const BIN = path.join(HERE, '..', 'bin', 'runz.ts')
const trace = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runz-flags-')), 'ran')
const out = (r: { result: unknown }): string => (r.result as ScriptResult).output ?? ''

describe('справка и флаги (ABC-783)', () => {
  it('разбор: --help/-h, неизвестные, подсказка', () => {
    expect(wantsHelp({ help: true })).toBe(true)
    expect(wantsHelp({ _: '-h' })).toBe(true)
    expect(wantsHelp({ _: ['install', '-h'] })).toBe(true)
    expect(wantsHelp({ dry: true, _: 'install' })).toBe(false)
    const known = parseFlags(['dry', '--force'])!
    expect([...known.keys()]).toEqual(['dry', 'force'])
    expect(unknownFlags({ dyr: true, force: true, _: 'x', paths: 'a' }, known)).toEqual(['dyr'])
    expect(unknownFlagsError('release', ['dyr'], known)).toMatch(/--dyr \(может, --dry\?\)/)
    expect(parseFlags(undefined)).toBe(null)
  })

  for (const name of ['loose.ts', 'strict.ts']) {
    it(`${name} --help — справка из шапки, скрипт не исполняется`, async () => {
      const f = trace()
      const r = await execute({ script: path.join(FIX, name), args: { help: true, out: f }, cwd: FIX })
      expect(out(r)).toMatch(/фикстура: /)
      expect(fs.existsSync(f)).toBe(false)
      const h = await execute({ script: path.join(FIX, name), args: { _: '-h', out: f }, cwd: FIX })
      expect(out(h)).toMatch(/фикстура: /)
      expect(fs.existsSync(f)).toBe(false)
    })
  }

  it('объявленные флаги — в справке с описаниями', async () => {
    const r = await execute({ script: path.join(FIX, 'strict.ts'), args: { help: true }, cwd: FIX })
    expect(out(r)).toMatch(/--dry\s+только показать/)
  })

  it('неизвестный флаг у объявившего — отказ, скрипт не исполняется', async () => {
    const f = trace()
    await expect(execute({ script: path.join(FIX, 'strict.ts'), args: { dyr: true, out: f }, cwd: FIX })).rejects.toThrow(/неизвестный флаг --dyr \(может, --dry\?\)/)
    expect(fs.existsSync(f)).toBe(false)
  })

  it('известные флаги и необъявивший скрипт — как раньше', async () => {
    const f = trace()
    expect(out(await execute({ script: path.join(FIX, 'strict.ts'), args: { dry: true, out: f }, cwd: FIX }))).toBe('ran')
    expect(fs.existsSync(f)).toBe(true)
    const g = trace()
    expect(out(await execute({ script: path.join(FIX, 'loose.ts'), args: { whatever: 1, out: g }, cwd: FIX }))).toBe('ran')
    expect(fs.existsSync(g)).toBe(true)
  })

  it('документ: $description в справке, $flags — проверка', async () => {
    const r = await execute({ script: path.join(FIX, 'doc.mdz'), args: { help: true }, cwd: FIX })
    expect(out(r)).toMatch(/документ с объявленными флагами/)
    expect(out(r)).toMatch(/Флаги: --name/)
    await expect(execute({ script: path.join(FIX, 'doc.mdz'), args: { nmae: 'x' }, cwd: FIX })).rejects.toThrow(/--nmae/)
  })

  it('CLI: runz <скрипт> --dyr — код 1, след не появился; runz -h — справка runz', () => {
    const f = trace()
    const r = spawnSync(process.execPath, [BIN, path.join(FIX, 'strict.ts'), '--dyr', `--out=${f}`], { encoding: 'utf8', cwd: FIX })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/неизвестный флаг --dyr/)
    expect(r.stderr).toMatch(/известные: --dry --out/)
    expect(fs.existsSync(f)).toBe(false)
    const h = spawnSync(process.execPath, [BIN, '-h'], { encoding: 'utf8', cwd: FIX })
    expect(h.status).toBe(0)
    expect(h.stdout).toMatch(/runz — runtime/)
  })
})
