/**
 * Вопросы прогонов через хаб (kd-cli-spec §9): запись файлом, список открытых, ответ первого,
 * срок, уведомление, встроенный сервис поверх хоста сервисов.
 */

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createQuestions, withQuestionsService, QUESTIONS_SERVICE_ID } from '../src/questions.js'

const dirOf = (): string => mkdtempSync(join(tmpdir(), 'nr-questions-'))

describe('вопросы прогонов', () => {
  it('ask → в списке, уведомление; answer → ушёл из списка, ответ виден get; переживает «рестарт»', async () => {
    const dir = dirOf()
    const sent: string[] = []
    const q = createQuestions({ dir, notify: (t) => void sent.push(t) })
    const made = q.ask({ id: 'a1-1', question: 'Перезаписать файл?', options: ['да', 'нет'], default: 'нет', from: 'kd agent', host: 'air' })
    expect(made.deadline > made.created).toBe(true)
    expect(q.list().map((x) => x.id)).toEqual(['a1-1'])
    expect(sent[0]).toContain('kd agent (air): Перезаписать файл? [да / нет]')
    expect(sent[0]).toContain('по умолчанию «нет»')
    const again = createQuestions({ dir })
    expect(again.list().map((x) => x.id)).toEqual(['a1-1'])
    again.answer('a1-1', 'да')
    expect(q.list()).toEqual([])
    expect(q.get('a1-1')).toMatchObject({ answer: 'да', by: 'human' })
    // повторный ответ не перебивает первый
    expect(q.answer('a1-1', 'нет').answer).toBe('да')
    expect(q.cancel('a1-1')).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  it('срок вышел — в списке нет, ответить нельзя; старое чистится', () => {
    const dir = dirOf()
    let t = Date.parse('2026-11-15T10:00:00Z')
    const q = createQuestions({ dir, now: () => t })
    q.ask({ id: 'b', question: 'Ок?', default: 'да', deadline: '2026-11-15T10:01:00Z' })
    t += 2 * 60_000
    expect(q.list()).toEqual([])
    expect(() => q.answer('b', 'нет')).toThrow(/срок вопроса b вышел/)
    t += 60 * 60_000
    q.list()
    expect(readdirSync(dir)).toEqual([])
  })

  it('без умолчания и без текста — громкая ошибка', () => {
    const q = createQuestions({ dir: dirOf() })
    expect(() => q.ask({ question: '', default: 'x' })).toThrow(/нет текста/)
    expect(() => q.ask({ question: 'a', default: undefined as unknown as string })).toThrow(/умолчание/)
    expect(() => q.ask({ id: '../x', question: 'a', default: 'b' })).toThrow(/id/)
  })

  it('сервис поверх хоста: свои методы, чужие — хосту, capability с questions', async () => {
    const q = createQuestions({ dir: dirOf() })
    const host = withQuestionsService(
      {
        call: async (plugin, method) => `${plugin}.${method}`,
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
        capability: async () => ({ forms: { methods: ['x'], streams: [] } }),
        close: async () => {},
      },
      q,
    )
    const made = (await host.call(QUESTIONS_SERVICE_ID, 'ask', { question: 'Куда?', default: 'сюда', options: ['сюда', 'туда'] })) as { id: string }
    expect(((await host.call(QUESTIONS_SERVICE_ID, 'list', {})) as unknown[]).length).toBe(1)
    await host.call(QUESTIONS_SERVICE_ID, 'answer', { id: made.id, answer: 'туда' })
    expect(await host.call(QUESTIONS_SERVICE_ID, 'get', { id: made.id })).toMatchObject({ answer: 'туда' })
    expect(await host.call('forms', 'x', {})).toBe('forms.x')
    expect(Object.keys(await host.capability())).toEqual(['forms', 'questions'])
  })
})
