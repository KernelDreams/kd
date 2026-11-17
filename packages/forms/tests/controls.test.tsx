// контролы хозяина и запасной набор без хозяина; сторож системных контролов; хелперы числа и счётчиков.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSchema, unitOf } from '../src/schema'
import { FormControlsProvider, FormView, type FormTemplate, type NumberControlProps } from '../src/react'
import { countOf, parseNumber, plural, stepNumber } from '../src/util'

afterEach(cleanup)

const schema = buildSchema(
  [
    { name: 'side', spec: 'number // Длинная сторона листа, px' },
    { name: 'captions', spec: 'checkbox // Подписи под картинками' },
    { name: 'bg', spec: 'select white, black, transparent // Фон' },
  ],
  { side: '2048', captions: 'true', bg: 'white' },
)
const template: FormTemplate = { id: 'atlas', file: 'atlas.mdz', schema }
const base = { thumbs: {}, imageField: null, disabled: false, onImage() {}, onImageFocus() {}, onPasteClipboard() {}, onSubmit() {} }

describe('запасной набор без хозяина', () => {
  it('число, флажок и выбор работают без системных контролов', () => {
    const changes: Array<[string, unknown]> = []
    render(<FormView {...base} template={template} values={{ side: 2048, captions: true, bg: 'white' }} onChange={(f, v) => changes.push([f, v])} />)
    expect(document.querySelector('select, input[type=number], input[type=checkbox]')).toBeNull()
    const side = screen.getByTestId('forms-input-side') as HTMLInputElement
    expect(side.value).toBe('2048')
    fireEvent.keyDown(side, { key: 'ArrowUp' })
    fireEvent.keyDown(side, { key: 'ArrowDown', shiftKey: true })
    const box = screen.getByTestId('forms-input-captions')
    expect(box.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(box)
    fireEvent.click(screen.getByTestId('forms-input-bg'))
    fireEvent.click(document.querySelector('[data-testid="forms-input-bg-option"][data-value="black"]')!)
    expect(changes).toEqual([
      ['side', 2049],
      ['side', 2039],
      ['captions', false],
      ['bg', 'black'],
    ])
  })

  it('подписи слева в общей сетке: строки полей — в одном FieldGrid', () => {
    render(<FormView {...base} template={template} values={{ side: 2048, captions: true, bg: 'white' }} onChange={() => {}} />)
    const rows = [...document.querySelectorAll('[data-testid="forms-field"]')]
    expect(rows.map((r) => r.getAttribute('data-row'))).toEqual(['inline', 'inline', 'inline'])
    expect(new Set(rows.map((r) => r.parentElement)).size).toBe(1)
  })
})

describe('контролы хозяина', () => {
  it('FormControlsProvider подменяет контрол во всех формах под ним', () => {
    const Mine = (p: NumberControlProps) => <output data-testid={p.testId}>host:{p.value}</output>
    render(
      <FormControlsProvider controls={{ Number: Mine }}>
        <FormView {...base} template={template} values={{ side: 7, captions: false, bg: 'white' }} onChange={() => {}} />
      </FormControlsProvider>,
    )
    expect(screen.getByTestId('forms-input-side').textContent).toBe('host:7')
    // Чего хозяин не дал — запасной.
    expect(screen.getByTestId('forms-input-captions').getAttribute('role')).toBe('checkbox')
  })

  it('чередование строк включается от шести полей', () => {
    const many = buildSchema(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, spec: 'number' })), {})
    const { container } = render(<FormView {...base} template={{ ...template, schema: many }} values={{}} onChange={() => {}} />)
    expect(container.querySelector('[data-alt="true"]')).not.toBeNull()
    cleanup()
    const { container: few } = render(<FormView {...base} template={template} values={{}} onChange={() => {}} />)
    expect(few.querySelector('[data-alt="true"]')).toBeNull()
  })
})

describe('хелперы', () => {
  it('шаг числа: границы, точность, пусто — от нуля', () => {
    expect(stepNumber(0.1, 1, { step: 0.2 })).toBe(0.3)
    expect(stepNumber(9, 1, { max: 9 })).toBe(9)
    expect(stepNumber(undefined, 1, { min: 5 })).toBe(6)
    expect(stepNumber(10, -1, { scale: 10 })).toBe(0)
    expect(parseNumber('1,5')).toBe(1.5)
    expect(parseNumber('x')).toBeUndefined()
  })

  it('единица числа из хвоста подписи', () => {
    expect(unitOf('Длинная сторона листа, px')).toEqual({ label: 'Длинная сторона листа', unit: 'px' })
    expect(unitOf('Сила, %')).toEqual({ label: 'Сила', unit: '%' })
    expect(unitOf('Имя, фамилия и отчество')).toEqual({ label: 'Имя, фамилия и отчество' })
    expect(unitOf('Шаги')).toEqual({ label: 'Шаги' })
  })

  it('множественное число', () => {
    const f = ['файл', 'файла', 'файлов'] as const
    expect([1, 2, 4, 5, 11, 21, 22, 25].map((n) => countOf(n, f))).toEqual(['1 файл', '2 файла', '4 файла', '5 файлов', '11 файлов', '21 файл', '22 файла', '25 файлов'])
    expect(plural(1.5, f)).toBe('файла')
    expect(plural(3, ['file', 'files'], 'en')).toBe('files')
  })
})

/** Сторож п. 7: в исходниках пакета нет системного числа, флажка и `<select>`. */
describe('сторож системных контролов', () => {
  const SRC = join(__dirname, '..', 'src')
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.tsx') ? [join(dir, n)] : []))
  /** Явные исключения: `путь` → почему. Пусто — и должно оставаться пустым. */
  const ALLOWED: Record<string, string> = {}
  it('нет type="number", type="checkbox", <select', () => {
    const hits = files(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(SRC, f)}:${i + 1}` }))
        .filter(({ line }) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*') && /type="number"|type="checkbox"|<select[\s>]/.test(line))
        .map(({ at }) => at),
    )
    expect(hits.filter((h) => !ALLOWED[h.split(':')[0]!])).toEqual([])
  })
})
