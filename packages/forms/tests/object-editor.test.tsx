import { act, fireEvent, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseWidgets, createCatalog, createDocument, fateWidgets, parseEditor } from '../src/editor/index.js'
import { ObjectEditor, type WidgetProps } from '../src/react.js'

const FIX = join(__dirname, 'fixtures', 'editor')
const FATE = parseEditor(readFileSync(join(FIX, 'fate.editor.mdz'), 'utf8')).def
const yaroslava = () => JSON.parse(readFileSync(join(FIX, 'yaroslava.json'), 'utf8'))
const catalog = createCatalog([...baseWidgets, ...fateWidgets])
const boxes = (c: HTMLElement) => c.querySelectorAll('[data-path="stress.physical"] [data-testid="fate-stress-box"]').length

describe('<ObjectEditor>', () => {
  it('лист: правка документа → пересчёт трека; клик по ячейке — команда', () => {
    const doc = createDocument(yaroslava(), FATE, { catalog })
    const { container } = render(<ObjectEditor doc={doc} view="sheet" />)
    expect(boxes(container)).toBe(4)
    act(() => void doc.exec('object.set', { path: 'skills.physique', value: 3 }))
    expect(boxes(container)).toBe(5)
    fireEvent.click(container.querySelectorAll('[data-path="stress.physical"] [data-testid="fate-stress-box"]')[0]!)
    expect((doc.object as any).stress.physical[0]).toBe(true)
    act(() => void doc.undo())
    act(() => void doc.undo())
    expect(boxes(container)).toBe(4)
  })

  it('root — поля одной строки повторителя', () => {
    const doc = createDocument(yaroslava(), FATE, { catalog })
    const { container } = render(<ObjectEditor doc={doc} root="aspects[asp002]" />)
    const fields = [...container.querySelectorAll('[data-testid="oe-field"]')].map((e) => e.getAttribute('data-path'))
    expect(fields).toEqual(['aspects[asp002].text'])
  })

  it('свой виджет из widgets и происхождение с «вернуть»', () => {
    const doc = createDocument(yaroslava(), FATE, { catalog })
    const Mine = (p: WidgetProps) => <button data-testid="mine" onClick={() => p.onChange('Новое')}>{String(p.value)}</button>
    const { getByTestId, getAllByTestId } = render(<ObjectEditor doc={doc} view="sheet" widgets={{ 'fate.aspect': Mine }} origins={{ trouble: { label: 'библиотека', base: 'Долг перед Лешим' } }} />)
    fireEvent.click(getAllByTestId('mine')[0]!)
    expect((doc.object as any).highConcept).toBe('Новое')
    expect(() => getByTestId('oe-revert')).toThrow()
    act(() => void doc.exec('object.set', { path: 'trouble', value: 'Другое' }))
    fireEvent.click(getByTestId('oe-revert'))
    expect((doc.object as any).trouble).toBe('Долг перед Лешим')
  })

  it('ошибка данных — под полем', () => {
    const doc = createDocument({ ...yaroslava(), name: '' }, FATE, { catalog })
    const { container } = render(<ObjectEditor doc={doc} view="sheet" />)
    expect(container.querySelector('[data-path="name"] [data-testid="oe-field-error"]')?.getAttribute('data-code')).toBe('E_REQUIRED')
  })
})

describe('генераторы поля (ABC-723 §10)', () => {
  const DEF = parseEditor(`$editor: 1
$id: g
## $section s
### $repeat greetings
#### $field text
$type: string
$widget: textarea
$generators: $[greeting-write, unknown-gen]
`).def
  it('кнопка из $generators (незнакомый id не рисуется), кандидат со строкой повторителя → «Принять» пишет значение', async () => {
    const doc = createDocument({ greetings: [{ _id: 'a1', text: 'Hi.' }] }, DEF, { catalog })
    const seen: unknown[] = []
    const { getAllByTestId, getByTestId, queryByTestId } = render(
      <ObjectEditor doc={doc} generators={{ 'greeting-write': { title: 'напиши', run: async (f, c) => (seen.push([f.path, c.row]), 'Привет.') } }} />,
    )
    expect(getAllByTestId('oe-generator').map((b) => b.getAttribute('data-generator'))).toEqual(['greeting-write'])
    await act(async () => void fireEvent.click(getByTestId('oe-generator')))
    expect(seen).toEqual([['greetings[a1].text', { _id: 'a1', text: 'Hi.' }]])
    expect(getByTestId('oe-candidate-value').textContent).toBe('Привет.')
    expect((doc.object as any).greetings[0].text).toBe('Hi.')
    fireEvent.click(getByTestId('oe-candidate-accept'))
    expect((doc.object as any).greetings[0].text).toBe('Привет.')
    expect(queryByTestId('oe-candidate')).toBeNull()
  })
  it('ошибка генератора — под полем, значение не тронуто', async () => {
    const doc = createDocument({ greetings: [{ _id: 'a1', text: 'Hi.' }] }, DEF, { catalog })
    const { container } = render(<ObjectEditor doc={doc} generators={{ 'greeting-write': { title: 'g', run: async () => Promise.reject(new Error('нет модели')) } }} />)
    await act(async () => void fireEvent.click(container.querySelector('[data-testid="oe-generator"]')!))
    expect(container.querySelector('[data-testid="oe-candidate-error"]')!.textContent).toContain('нет модели')
    expect((doc.object as any).greetings[0].text).toBe('Hi.')
  })
})
