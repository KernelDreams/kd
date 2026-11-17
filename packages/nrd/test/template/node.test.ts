import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { objectContext } from '../../src/core/index.js'
import { createEnv, render, extractNrd, registerSite } from '../../src/template/index.js'
import { findTemplate, searchDirs, nodeLoader, discoverSites } from '../../src/node/template.js'

import { exampleSite } from './example-site.js'

const tmpOut = path.join(process.cwd(), 'test', '.tmp-out.md')
let offSite: () => void
beforeAll(() => {
  offSite = registerSite(exampleSite)
})
afterAll(() => {
  offSite()
  if (fs.existsSync(tmpOut)) fs.rmSync(tmpOut)
})

describe('node — резолв шаблонов', () => {
  it('findTemplate находит шаблон зарегистрированного сайта (templatesDir)', () => {
    const p = findTemplate('example/page')
    expect(p.endsWith('page.ntpl')).toBe(true)
    expect(fs.existsSync(p)).toBe(true)
  })

  it('searchDirs включает каталог шаблонов зарегистрированного сайта', () => {
    const dirs = searchDirs()
    expect(dirs).toContain(exampleSite.templatesDir)
  })

  it('findTemplate бросает на отсутствующем шаблоне', () => {
    expect(() => findTemplate('nope/missing')).toThrow(/не найден/)
  })

  it('шаблон сайта парсится extractNrd', () => {
    const text = fs.readFileSync(findTemplate('example/page'), 'utf-8')
    const { nrdBlock, body } = extractNrd(text)
    expect(nrdBlock).toContain('$nr-type: http')
    expect(body).toContain('<< page.title >>')
  })
})

describe('node — nodeLoader', () => {
  it('getSource резолвит шаблон сайта по имени', async () => {
    const loader = await nodeLoader()
    const src = loader.getSource('example/page.ntpl')
    expect(src).not.toBeNull()
    expect(src!.src).toContain('<< page.title >>')
  })

  it('createEnv принимает nodeLoader без ошибок', async () => {
    const env = await createEnv({ loader: await nodeLoader() })
    expect(render(env, '<< x >>', objectContext({ x: 'ok' }))).toBe('ok')
  })
})

describe('node — discoverSites', () => {
  it('включает зарегистрированные registerSite', async () => {
    const sites = await discoverSites()
    expect(sites.some((s) => s.name === 'example')).toBe(true)
  })
})

describe('node — output в файл (-o)', () => {
  it('render → writeFileSync → читается обратно', async () => {
    const out = render(await createEnv(), '# << t >>', objectContext({ t: 'Saved' }))
    fs.writeFileSync(tmpOut, out)
    expect(fs.readFileSync(tmpOut, 'utf-8')).toBe('# Saved')
  })
})
