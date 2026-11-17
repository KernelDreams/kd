import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createObjectsEngine, parseFields } from '../src/objects.js'

/** Тип `type` (objects-spec §18): свой тип из списка типов — без кода и перезапуска. */
function stand() {
  const root = mkdtempSync(join(tmpdir(), 'objects-meta-'))
  const builtin = join(root, 'plugin-types')
  const types = join(root, 'types')
  mkdirSync(builtin, { recursive: true })
  mkdirSync(types, { recursive: true })
  writeFileSync(join(builtin, 'note.mdz'), '$type: object-type\n$id: note\n$title: Заметки\n$source: files\n$format: mdz\n$paths: notes\n$id_field: id\n')
  writeFileSync(join(types, 'broken.mdz'), '$type: object-type\n$id: broken\n')
  const engine = createObjectsEngine({ typeDirs: () => [builtin, types], base: root })
  return { root, types, engine }
}

describe('тип type', () => {
  it('$fields: разбор и ошибка', () => {
    expect(parseFields('title:string=Название, pages:number')).toEqual([{ name: 'title', type: 'string', title: 'Название' }, { name: 'pages', type: 'number' }])
    expect(parseFields('x:date')).toMatch(/тип/)
  })

  it('типы — записи: свои, встроенные, ошибки строкой', () => {
    const { engine } = stand()
    expect(engine.types().types.map((t) => t.id)).toContain('type')
    const rows = engine.list({ type: 'type' }).rows
    expect(rows.find((r) => r.id === 'note')?.badges).toContain('встроенный')
    expect(rows.find((r) => r.badges?.includes('ошибка'))?.subtitle).toMatch(/id_field/)
    expect(engine.list({ type: 'type', q: 'замет' }).rows.map((r) => r.id)).toEqual(['note'])
  })

  it('создать тип book с двумя полями → запись → схема из полей', async () => {
    const { engine, types, root } = stand()
    const r = engine.create({ type: 'type', data: { id: 'book', title: 'Книги', fields: [{ name: 'title', type: 'string', title: 'Название' }, { name: 'pages', type: 'number', title: 'Страниц' }] } })
    expect('doc' in r).toBe(true)
    expect(readFileSync(join(types, 'book.mdz'), 'utf-8')).toMatch(/\$fields: title:string=Название, pages:number=Страниц/)
    const book = engine.types().types.find((t) => t.id === 'book')!
    expect(Object.keys((book.schema as { properties: object }).properties)).toEqual(['id', 'title', 'pages'])
    expect(book.titleField).toBe('title')
    const rec = engine.create({ type: 'book', data: { id: 'dune', title: 'Дюна', pages: 412 } })
    expect('doc' in rec && rec.doc.row.title).toBe('Дюна')
    expect(readFileSync(join(root, 'objects/book/dune.mdz'), 'utf-8')).toMatch(/412/)
    const doc = await engine.get({ type: 'type', id: 'book' })
    expect(doc.data.fields).toHaveLength(2)
    // Правка полей — тот же файл, тип перечитан.
    const s = engine.save({ type: 'type', id: 'book', data: { title: 'Книги', fields: [{ name: 'title', type: 'string' }, { name: 'pages', type: 'number' }, { name: 'author', type: 'string', title: 'Автор' }] } })
    expect('doc' in s).toBe(true)
    expect(Object.keys((engine.types().types.find((t) => t.id === 'book')!.schema as { properties: object }).properties)).toContain('author')
  })

  it('встроенный тип — только чтение; удаление не трогает записи', () => {
    const { engine, root } = stand()
    const r = engine.save({ type: 'type', id: 'note', data: { title: 'x' } })
    expect('invalid' in r).toBe(true)
    engine.create({ type: 'type', data: { id: 'book', fields: [{ name: 'title' }] } })
    engine.create({ type: 'book', data: { id: 'a', title: 'A' } })
    expect(engine.remove({ type: 'type', ids: ['book', 'note'] }).removed).toEqual(['book'])
    expect(engine.types().types.map((t) => t.id)).not.toContain('book')
    expect(readFileSync(join(root, 'objects/book/a.mdz'), 'utf-8')).toMatch(/A/)
  })
})
