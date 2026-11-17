import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { loadProgram } from '../../src/node/program.js'
import { expandPresets, presetFields, presetOptions, presetValues, resolvePreset } from '../../src/node/presets.js'

let dir: string
function put(rel: string, text: string): string {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return p
}

const BASE = [
  '$run: help',
  '$models_a: $[base-a]',
  '$model_g: base-g',
  '$job_keys: $[mac]',
  '',
  '## $form',
  '$models: preset? models/*.mdz // Модели',
  '$models_a: model[] // A',
  '',
  '## $action help',
  'x',
  '',
  '## $@',
  '',
].join('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nrd-preset-'))
  put('base.mdz', BASE)
  put('models/opus.mdz', '$// профиль\n$title: Opus (подписка)\n$description: Сильный текст\n$job_keys: $[opus]\n$models_a: $[opus-sub]\n$model_g: opus-sub\n')
  put('models/glm.mdz', '$title: GLM 5.3\n$job_keys: $[glm]\n$models_a: $[glm-5.3]\n$model_g: glm-5.3\n')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const strOf = (v: unknown): string => String((v as { toString(): string }) ?? '')
const listOf = (p: ReturnType<typeof loadProgram>, key: string): string[] =>
  [...((p.doc.get([key]) as { iterate(): Iterable<unknown> }).iterate())].map(strOf)

describe('профили (preset, ABC-255)', () => {
  it('поля preset — из блоков ## $form', () => {
    expect(presetFields(BASE)).toEqual([{ name: 'models', glob: 'models/*.mdz' }])
  })

  it('варианты: значение — путь, подпись — $title, подсказка — $description', () => {
    const opts = presetOptions([dir], 'models/*.mdz')
    expect(opts.map((o) => [o.value, o.title, o.description])).toEqual([
      ['models/glm.mdz', 'GLM 5.3', ''],
      ['models/opus.mdz', 'Opus (подписка)', 'Сильный текст'],
    ])
  })

  it('значение: короткое имя, путь от папки, абсолютный путь; опечатка — громко', () => {
    const opus = join(dir, 'models/opus.mdz')
    expect(resolvePreset('opus', 'models/*.mdz', [dir])).toBe(opus)
    expect(resolvePreset('models/opus.mdz', 'models/*.mdz', [dir])).toBe(opus)
    expect(resolvePreset(opus, 'models/*.mdz', [dir])).toBe(opus)
    expect(resolvePreset('', 'models/*.mdz', [dir])).toBeNull()
    expect(() => resolvePreset('opsu', 'models/*.mdz', [dir])).toThrow(/opsu.*glm, opus/)
  })

  it('атрибуты профиля значениями — без $title/$description', () => {
    expect(presetValues(join(dir, 'models/opus.mdz'))).toEqual({ job_keys: ['opus'], models_a: ['opus-sub'], model_g: 'opus-sub' })
  })

  it('профиль поверх рецепта, под тем, что написано ниже (вариант)', () => {
    const recipe = put('fix.mdz', '$[[base.mdz]]\n$models: models/glm.mdz\n$model_g: own-g\n')
    const p = loadProgram(recipe)
    expect(listOf(p, 'models_a')).toEqual(['glm-5.3'])
    expect(listOf(p, 'job_keys')).toEqual(['glm'])
    expect(strOf(p.doc.get(['model_g']))).toBe('own-g')
    expect(p.doc.get(['title'])).toBeUndefined()
  })

  it('значение CLI (--models=opus) — поверх документа, профиль документа перекрыт', () => {
    const recipe = put('fix.mdz', '$[[base.mdz]]\n$models: models/glm.mdz\n')
    const p = loadProgram(recipe, undefined, { presets: { models: 'opus', other: 'x' } })
    expect(listOf(p, 'models_a')).toEqual(['opus-sub'])
    expect(strOf(p.doc.get(['model_g']))).toBe('opus-sub')
    expect(strOf(p.doc.get(['models']))).toBe(join(dir, 'models/opus.mdz'))
  })

  it('значения запуска, дописанные после профиля, перекрывают его (материализация задачи)', () => {
    const text = '$[[base.mdz]]\n$models: "models/opus.mdz"\n$model_g: user-g\n'
    const recipe = put('run.mdz', text)
    const p = loadProgram(recipe)
    expect(strOf(p.doc.get(['model_g']))).toBe('user-g')
    expect(listOf(p, 'models_a')).toEqual(['opus-sub'])
  })

  it('без полей preset текст не меняется; пустое значение и ${…} — не профиль', () => {
    expect(expandPresets('$a: 1\n', { dirs: [dir] })).toBe('$a: 1\n')
    const recipe = put('fix.mdz', '$[[base.mdz]]\n$models:\n')
    expect(listOf(loadProgram(recipe), 'models_a')).toEqual(['base-a'])
    const t = BASE + '$models: ${x}\n'
    expect(expandPresets(t, { dirs: [dir] })).toBe(t)
  })
})
