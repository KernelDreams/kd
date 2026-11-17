// cast('messages') / NRDocument.split() — форма ленты после выпила сплиттера
//. Дом формата `%role` — @kerneldreams/nrd/chat; здесь проверяется
// только то, что каст отдаёт: IArray сообщений формы ChatMessage
// (`role`, `body`, `name?`, `meta?`), доступных по путям и через iterate().
//
// Грамматика самой ленты (маркеры, escape-лестница, fence-зоны, JSON5-мета)
// покрыта тестами nr-chat — здесь не дублируется.

import { describe, it, expect } from 'vitest'
import { parseDocument } from '../src/core/document.js'
import type { IArray, IContext } from '../src/core/icontext.js'

function messagesOf(text: string): IArray {
  const doc = parseDocument(text)
  const arr = doc.cast<IArray>('messages')
  if (!arr) throw new Error('cast(messages) вернул undefined')
  return arr
}

describe("cast('messages') — форма ChatMessage", () => {
  it('лента из двух сообщений: role + body', () => {
    const msgs = messagesOf('%system\nYou are helpful.\n\n%user\nHello!')
    expect(msgs.length()).toBe(2)
    const first = msgs.at(0) as IContext
    expect(first.get(['role'])).toBe('system')
    expect(first.get(['body'])).toBe('You are helpful.\n')
    const second = msgs.at(1) as IContext
    expect(second.get(['role'])).toBe('user')
    expect(second.get(['body'])).toBe('Hello!')
  })

  it('имя маркера — поле name (не атрибут)', () => {
    const msgs = messagesOf('%assistant narrator\nOnce upon a time.')
    const m = msgs.at(0) as IContext
    expect(m.get(['role'])).toBe('assistant')
    expect(m.get(['name'])).toBe('narrator')
    expect(m.get(['body'])).toBe('Once upon a time.')
  })

  it('JSON5-мета маркера доступна по пути meta.<key>', () => {
    const msgs = messagesOf('%system {cache: true, temperature: 0.7}\nPrompt.')
    const m = msgs.at(0) as IContext
    expect(m.get(['meta', 'cache'])).toBe(true)
    expect(m.get(['meta', 'temperature'])).toBe(0.7)
    expect(m.get(['body'])).toBe('Prompt.')
  })

  it('без маркера мета отсутствует, лишних полей нет', () => {
    const msgs = messagesOf('%user\nHi')
    const m = msgs.at(0) as IContext
    expect(m.get(['meta'])).toBeUndefined()
    expect(m.get(['name'])).toBeUndefined()
    // `content`/`blocks` — поля мёртвого сплиттера, их больше нет
    expect(m.get(['content'])).toBeUndefined()
    expect(m.get(['blocks'])).toBeUndefined()
  })

  it('произвольные роли', () => {
    const msgs = messagesOf('%narrator\nThe scene opens.\n\n%character\nHello!')
    expect(msgs.length()).toBe(2)
    expect((msgs.at(0) as IContext).get(['role'])).toBe('narrator')
    expect((msgs.at(1) as IContext).get(['role'])).toBe('character')
  })

  it('многострочное тело сохраняется', () => {
    const msgs = messagesOf('%user\nLine 1\nLine 2\nLine 3')
    expect((msgs.at(0) as IContext).get(['body'])).toBe('Line 1\nLine 2\nLine 3')
  })

  it('текст до первого маркера игнорируется', () => {
    const msgs = messagesOf('some preamble\n\n%user\nHello')
    expect(msgs.length()).toBe(1)
    expect((msgs.at(0) as IContext).get(['role'])).toBe('user')
  })

  it('лента без маркеров → пустой массив', () => {
    expect(messagesOf('just text, no markers').length()).toBe(0)
  })

  it('iterate() отдаёт те же IContext, что at()', () => {
    const msgs = messagesOf('%user\nA\n\n%assistant\nB')
    const roles = msgs.iterate().map((m) => (m as IContext).get(['role']))
    expect(roles).toEqual(['user', 'assistant'])
  })

  it('fence-зона непрозрачна: гость с %-строками не рвёт сообщение', () => {
    const F4 = '`'.repeat(4)
    const text = ['%assistant', 'intro', F4, '%user', 'guest message', F4, 'outro'].join('\n')
    const msgs = messagesOf(text)
    expect(msgs.length()).toBe(1)
    expect((msgs.at(0) as IContext).get(['body'])).toBe(
      ['intro', F4, '%user', 'guest message', F4, 'outro'].join('\n'),
    )
  })

  it('битая JSON5-мета — SyntaxError наружу, не тихий пропуск', () => {
    expect(() => messagesOf('%user {bad: }\nHi')).toThrow(SyntaxError)
  })
})

describe("cast('messages') на блоке", () => {
  it('тело блока разбирается тем же путём', () => {
    const doc = parseDocument('## $dialog\n\n%user\nHello\n\n%assistant\nHi there')
    const block = (doc.cast<IArray>('records')!).at(0) as IContext
    const msgs = block.cast<IArray>('messages')!
    expect(msgs.length()).toBe(2)
    expect((msgs.at(1) as IContext).get(['body'])).toBe('Hi there')
  })
})

describe('NRDocument.split()', () => {
  it('тот же разбор, что cast(messages), но плоским списком', () => {
    const doc = parseDocument('%user\nHello\n\n%assistant\nHi')
    const msgs = doc.split()
    expect(msgs).toHaveLength(2)
    expect(msgs[0].get(['role'])).toBe('user')
    expect(msgs[1].get(['body'])).toBe('Hi')
  })

  it('нет маркеров → пустой список (заглушка больше не врёт)', () => {
    expect(parseDocument('plain body').split()).toHaveLength(0)
  })
})
