import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execute } from '../src/execute.ts'

// Профили формы (`preset`): `runz <рецепт> --models=opus` — атрибуты профиля поверх документа.
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'runz-preset-'))
  mkdirSync(join(dir, 'models'))
  writeFileSync(join(dir, 'models/opus.mdz'), '$title: Opus\n$model: opus-sub\n')
  writeFileSync(join(dir, 'models/glm.mdz'), '$title: GLM\n$model: glm-5.3\n')
  writeFileSync(
    join(dir, 'r.mdz'),
    ['$model: own', '$models: models/glm.mdz', '', '## $form', '$models: preset models/*.mdz // Модели', '', '## $@', ''].join('\n'),
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const chainOf = async (args: Record<string, string>): Promise<Record<string, unknown>> => {
  const r = await execute({ script: join(dir, 'r.mdz'), args, cwd: dir, dry: true, env: {} })
  return (JSON.parse(String(r.result.output)) as { chain: Record<string, unknown> }).chain
}

describe('профили — runz <рецепт> --models=', () => {
  it('значение в документе — профиль поверх рецепта', async () => {
    expect((await chainOf({})).model).toBe('glm-5.3')
  })
  it('--models=opus — профиль из маски по короткому имени, поверх документа', async () => {
    expect((await chainOf({ models: 'opus' })).model).toBe('opus-sub')
  })
  it('--models=models/opus.mdz и явный --model= сильнее профиля', async () => {
    expect((await chainOf({ models: 'models/opus.mdz' })).model).toBe('opus-sub')
    expect((await chainOf({ models: 'opus', model: 'x' })).model).toBe('x')
  })
  it('опечатка — громкая ошибка', async () => {
    await expect(chainOf({ models: 'opsu' })).rejects.toThrow(/профиль "opsu" не найден/)
  })
})
