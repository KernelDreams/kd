/**
 * Схема из `## $form` (перенесено из nrchat `tests/forms.test.tsx`):
 * типы, enum, дефолты, обязательность, приведение; текст в поле картинки.
 */

import { describe, expect, it } from 'vitest'
import { buildSchema, coerceValues, defaultValues, missingRequired, parseField } from '../src/index.js'
import { textInput } from '../src/react.js'

const SPEC_FORM = [
  { name: 'ref', spec: 'image // Референс' },
  { name: 'prompt', spec: 'text // Что сделать' },
  { name: 'style', spec: 'select anime, photo, sketch // Стиль' },
  { name: 'face', spec: 'checkbox // Детейлер лица' },
  { name: 'mood', spec: 'radio calm, loud' },
  { name: 'extra', spec: 'image?' },
]
const SPEC_VARS = { ref: '', prompt: 'make it look like a watercolor', style: 'photo', face: 'false' }

describe('схема из ## $form', () => {
  it('JSON Schema 2020-12: типы, enum, дефолты из переменных, подписи, x-ui, required без ?', () => {
    const schema = buildSchema(SPEC_FORM, SPEC_VARS)
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.properties.ref).toEqual({ type: 'string', title: 'Референс', 'x-ui': { widget: 'image', order: 0, section: '' } })
    expect(schema.properties.prompt).toEqual({
      type: 'string',
      title: 'Что сделать',
      default: 'make it look like a watercolor',
      'x-ui': { widget: 'textarea', order: 1, section: '' },
    })
    expect(schema.properties.style).toMatchObject({ enum: ['anime', 'photo', 'sketch'], default: 'photo', 'x-ui': { widget: 'select' } })
    expect(schema.properties.face).toMatchObject({ type: 'boolean', default: false, 'x-ui': { widget: 'checkbox', order: 3 } })
    expect(schema.properties.mood).toMatchObject({ enum: ['calm', 'loud'], 'x-ui': { widget: 'radio' } })
    expect(schema.properties.mood!.title).toBeUndefined()
    // checkbox пустым не бывает, image? — необязательное.
    expect(schema.required).toEqual(['ref', 'prompt', 'style', 'mood'])
  })

  it('битая строка — throw с причиной (шаблон уйдёт в список с error)', () => {
    expect(() => parseField('x', 'bogus', 0, undefined)).toThrow(/image, text, select, radio, checkbox, string, number, model, file или preset/)
    expect(() => parseField('x', 'select // без вариантов', 0, undefined)).toThrow(/нет вариантов/)
    expect(() => parseField('x', 'text a, b', 0, undefined)).toThrow(/вариантов не бывает/)
    expect(() => buildSchema([], {})).toThrow(/без полей/)
    expect(() => buildSchema([{ name: 'a', spec: 'text' }, { name: 'a', spec: 'text' }], {})).toThrow(/дважды/)
  })

  it('дефолты, обязательность, приведение значений к схеме', () => {
    const schema = buildSchema(SPEC_FORM, SPEC_VARS)
    const values = defaultValues(schema)
    expect(values).toEqual({ ref: '', prompt: 'make it look like a watercolor', style: 'photo', face: false, mood: '', extra: '' })
    expect(missingRequired(schema, values)).toEqual(['ref', 'mood'])
    expect(coerceValues(schema, { ref: '/a.png', face: 'true', junk: 1, mood: 'calm' })).toEqual({
      ref: '/a.png',
      prompt: 'make it look like a watercolor',
      style: 'photo',
      face: true,
      mood: 'calm',
      extra: '',
    })
  })

  it('текст в поле картинки: URL — скачать, иначе путь; многострочное — не вход', () => {
    expect(textInput('https://x.io/a.png')).toEqual({ kind: 'url', url: 'https://x.io/a.png' })
    expect(textInput(' "/Users/a/b c.png" ')).toEqual({ kind: 'path', path: '/Users/a/b c.png' })
    expect(textInput('a\nb')).toBeNull()
  })
})

describe('пометки объявления тула (kd-cli-spec §2)', () => {
  it('снимаются со строки и ложатся в x-ui', () => {
    const f = parseField('url', 'string $pos=1 $kind=url $for=play,publish // Адрес бота', 0, undefined)
    expect(f.title).toBe('Адрес бота')
    expect(f['x-ui']).toMatchObject({ widget: 'input', pos: 1, kind: 'url', for: ['play', 'publish'] })
    const t = parseField('text', 'text? $rest // Текст', 1, undefined)
    expect(t['x-ui'].rest).toBe(true)
    const s = parseField('mode', 'select a, b $for=x', 2, 'a')
    expect(s.enum).toEqual(['a', 'b'])
    expect(s['x-ui'].for).toEqual(['x'])
  })
  it('битая пометка — ошибка', () => {
    expect(() => parseField('x', 'string $pos=0', 0, undefined)).toThrow(/\$pos/)
    expect(() => parseField('x', 'string $kind', 0, undefined)).toThrow(/\$kind/)
  })
  it('обязательность видна сквозь пометки', () => {
    const s = buildSchema([{ name: 'a', spec: 'string $pos=1' }, { name: 'b', spec: 'string? $pos=2' }], {})
    expect(s.required).toEqual(['a'])
  })
})
