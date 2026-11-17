/**
 * FormView без хозяина: строки по умолчанию и свои (`labels`), свой виджет модели,
 * секции со сводкой, происхождение значения и «вернуть».
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSchema } from '../src/index.js'
import { FormView } from '../src/react.js'
import type { FormSchema, FormValue, FormViewProps, ModelWidgetProps } from '../src/react.js'

afterEach(cleanup)

const FIELDS = [
  { name: 'prompt', spec: 'text // Что сделать', section: '' },
  { name: 'model', spec: 'model? // Модель', section: '' },
  { name: 'steps', spec: 'number // Шаги', section: 'tune' },
  { name: 'face', spec: 'checkbox // Лицо', section: 'tune' },
]

function schemaOf(): FormSchema {
  const schema = buildSchema(FIELDS, { prompt: 'cat', steps: '20' }, { sections: [{ id: '', title: '' }, { id: 'tune', title: 'Тонко', collapsed: true }] })
  schema['x-ui'] = { sections: schema['x-ui']?.sections ?? [], base: 'base.mdz' }
  return schema
}

function props(patch: Partial<FormViewProps> = {}): FormViewProps {
  return {
    template: { id: 't', file: '/x/t.mdz', schema: schemaOf() },
    values: { prompt: 'cat', model: '', steps: 20, face: false },
    thumbs: {},
    imageField: null,
    disabled: false,
    onChange: vi.fn(),
    onImage: vi.fn(),
    onImageFocus: vi.fn(),
    onPasteClipboard: vi.fn(),
    onSubmit: vi.fn(),
    ...patch,
  }
}

describe('FormView', () => {
  it('сломанная схема — строка ошибки: английская по умолчанию, своя из labels', () => {
    const broken = { template: { id: 't', file: '/x/t.mdz', schema: null, error: 'boom' } }
    const { rerender } = render(<FormView {...props(broken)} />)
    expect(screen.getByTestId('forms-broken').textContent).toContain('The template form is broken: boom')
    rerender(<FormView {...props(broken)} labels={{ brokenTemplate: 'Форма сломана: {error}' }} />)
    expect(screen.getByTestId('forms-broken').textContent).toContain('Форма сломана: boom')
  })

  it('поля по порядку; свёрнутая секция — сводка; клик — onToggleSection с дефолтом', () => {
    const onToggleSection = vi.fn()
    render(<FormView {...props({ onToggleSection, values: { prompt: 'cat', model: '', steps: 20, face: true } })} />)
    const fields = screen.getAllByTestId('forms-field').map((el) => el.getAttribute('data-field'))
    expect(fields).toEqual(['prompt', 'model'])
    const section = document.querySelector('[data-section="tune"]')!
    expect(section.getAttribute('data-collapsed')).toBe('true')
    expect(screen.getByTestId('forms-section-summary').textContent).toBe('Лицо')
    fireEvent.click(screen.getByTestId('forms-section-toggle'))
    expect(onToggleSection).toHaveBeenCalledWith('tune', true)
  })

  it('виджет модели — свой (modelWidget), по умолчанию — поле со списком', () => {
    const seen: ModelWidgetProps[] = []
    const Mine = (p: ModelWidgetProps) => {
      seen.push(p)
      return <button data-testid={p.testId} onClick={() => p.onChange('gate/glm')} />
    }
    const onChange = vi.fn()
    const options = () => ({ items: ['gate/glm'], loading: false })
    const { rerender } = render(<FormView {...props({ onChange, options })} modelWidget={Mine} labels={{ modelOff: 'выкл' }} />)
    fireEvent.click(screen.getByTestId('forms-model-model'))
    expect(onChange).toHaveBeenCalledWith('model', 'gate/glm')
    expect(seen.at(-1)).toMatchObject({ placeholder: 'выкл', clearable: true, allowCustom: true, models: [{ id: 'gate/glm', provider: 'gate' }] })
    rerender(<FormView {...props({ onChange, options })} />)
    const input = screen.getByTestId('forms-model-model') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    expect(input.placeholder).toBe('off')
  })

  it('значение не из рецепта — метка «run» и «revert» → onReset', () => {
    const onReset = vi.fn()
    const values: Record<string, FormValue> = { prompt: 'dog', model: '', steps: 20, face: false }
    render(<FormView {...props({ values, onReset })} />)
    expect(screen.getByTestId('forms-origin-prompt').textContent).toBe('run')
    fireEvent.click(screen.getByTestId('forms-reset-prompt'))
    expect(onReset).toHaveBeenCalledWith('prompt')
  })
})
