import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describeScript, firstParagraph } from '@kerneldreams/runz-runtime/src/describe.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runz-describe-'))

describe('describeScript (ABC-551)', () => {
  it('appz: первое предложение первого абзаца README', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'index.ts'), '')
    fs.writeFileSync(path.join(d, 'README.md'), '# vault\n\nПравка markdown по секциям `## Имя`. Ещё текст.\n')
    expect(describeScript(path.join(d, 'index.ts'))).toBe('Правка markdown по секциям ## Имя.')
  })
  it('абзац-ссылка — берётся хвост заголовка', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'index.ts'), '')
    fs.writeFileSync(path.join(d, 'README.md'), '# host — хост nrchat как параметр\n\nDEV-410, спека.\n')
    expect(describeScript(path.join(d, 'index.ts'))).toBe('хост nrchat как параметр')
  })
  it('документ: $description главнее текста; .ts — док-комментарий', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'a.mdz'), '$type: x\n$description: Делает раз.\n\nТекст.\n')
    fs.writeFileSync(path.join(d, 'b.ts'), '/**\n * Built-in script: b\n *\n * Single-shot call.\n */\n')
    expect(describeScript(path.join(d, 'a.mdz'))).toBe('Делает раз.')
    expect(describeScript(path.join(d, 'b.ts'))).toBe('Single-shot call.')
  })
  it('пропускает атрибуты и код до абзаца', () => {
    expect(firstParagraph('$type: x\n```\ncode\n```\nТекст абзаца\nпродолжение\n\nдругой')).toBe('Текст абзаца продолжение')
  })
})
