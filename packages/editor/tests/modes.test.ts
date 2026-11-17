import { describe, expect, it } from 'vitest'
import { modeFromFilename, type Mode } from '../src/modes'

describe('modeFromFilename', () => {
  const table: Array<[string, Mode]> = [
    ['a.md', 'md'],
    ['a.markdown', 'md'],
    ['a.mdz', 'mdz'],
    ['a.mdd', 'mdd'],
    ['a.mds', 'mds'],
    ['a.js', 'js'],
    ['a.mjs', 'js'],
    ['a.cjs', 'js'],
    ['a.ts', 'ts'],
    ['a.mts', 'ts'],
    ['a.cts', 'ts'],
    ['a.jsx', 'jsx'],
    ['a.tsx', 'tsx'],
    ['a.json', 'json'],
    ['a.json5', 'json'],
    ['a.yaml', 'yaml'],
    ['a.yml', 'yaml'],
    ['a.css', 'css'],
    ['a.html', 'html'],
    ['a.htm', 'html'],
    ['a.txt', 'text'],
    ['a.rs', 'text'],
    ['Makefile', 'text'],
    ['.gitignore', 'text'],
    ['', 'text'],
  ]
  it.each(table)('%s → %s', (name, mode) => {
    expect(modeFromFilename(name)).toBe(mode)
  })

  it('takes the last extension of compound names', () => {
    expect(modeFromFilename('deck.slides.md')).toBe('md')
    expect(modeFromFilename('x.widget.mdz')).toBe('mdz')
    expect(modeFromFilename('archive.md.txt')).toBe('text')
    expect(modeFromFilename('types.d.ts')).toBe('ts')
  })

  it('ignores case', () => {
    expect(modeFromFilename('README.MD')).toBe('md')
    expect(modeFromFilename('App.TSX')).toBe('tsx')
    expect(modeFromFilename('Recipe.Mdz')).toBe('mdz')
    expect(modeFromFilename('CI.YML')).toBe('yaml')
  })

  it('uses only the file name of a path', () => {
    expect(modeFromFilename('docs/v1.2/notes')).toBe('text')
    expect(modeFromFilename('src/app/main.ts')).toBe('ts')
    expect(modeFromFilename('C:\\work\\page.HTM')).toBe('html')
  })
})
