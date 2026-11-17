import { test } from 'vitest'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { licenseOf, parseGithubRepo, parseLooseJson, resolveVsCodeInclude, themesAt, themesFromUrl } from '../src/load.js'

const FX = join(__dirname, 'fixtures', 'load')

test('адрес репы GitHub', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/emarpiee/Retroma'), { owner: 'emarpiee', repo: 'Retroma' })
  assert.deepEqual(parseGithubRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b' })
  assert.deepEqual(parseGithubRepo('https://github.com/a/b/tree/dev'), { owner: 'a', repo: 'b', branch: 'dev' })
  assert.equal(parseGithubRepo('https://raw.githubusercontent.com/a/b/main/theme.css'), null)
})

test('лицензия по тексту LICENSE', () => {
  assert.equal(licenseOf('MIT License\n\nCopyright'), 'MIT')
  assert.equal(licenseOf('GNU GENERAL PUBLIC LICENSE\n Version 3'), 'GPL-3.0')
  assert.equal(licenseOf('GNU AFFERO GENERAL PUBLIC LICENSE'), 'AGPL-3.0')
  assert.equal(licenseOf(null), undefined)
})

test('JSONC тем VS Code', () => {
  assert.deepEqual(parseLooseJson('{ // c\n "a": [1,], /* x */ "u": "http://x" }'), { a: [1], u: 'http://x' })
})

test('include VS Code разворачивается цепочкой', () => {
  const t = resolveVsCodeInclude(join(FX, 'ext/themes/dark_modern.json')) as { colors: Record<string, string>; tokenColors: unknown[] }
  assert.equal(t.colors['editor.background'], '#1F1F1F')
  assert.ok(t.tokenColors.length > 20, 'tokenColors из dark_plus и dark_vs')
})

test('папка тем: Obsidian с манифестом и лицензией, ST и VS Code файлами', () => {
  const list = themesAt(join(FX, 'themes'))
  const by = Object.fromEntries(list.map((x) => [x.name, x]))
  assert.equal(by['Typewriter']?.from, 'obsidian')
  assert.equal(by['Typewriter']?.license, 'GPL-3.0')
  assert.equal(by['Dark Lite']?.source.endsWith('Dark Lite.json'), true)
  assert.equal(by['Dark Modern']?.name, 'Dark Modern')
  // dark_plus / dark_vs — тоже темы (по файлу на скин).
  assert.ok(list.length >= 3)
})

test('папка расширения VS Code: contributes.themes', () => {
  const list = themesAt(join(FX, 'ext'))
  assert.equal(list.length, 1)
  assert.equal(list[0]!.from, 'vscode')
  assert.equal(list[0]!.license, 'MIT')
  assert.equal((JSON.parse(list[0]!.text) as { type: string }).type, 'dark')
})

test('адрес репы Obsidian: theme.css + manifest + LICENSE с ветки по умолчанию', async () => {
  const files: Record<string, string> = {
    'https://raw.githubusercontent.com/o/r/master/theme.css': '.theme-dark { --background-primary: #000 }',
    'https://raw.githubusercontent.com/o/r/master/manifest.json': '{ "name": "Probe", "author": "me" }',
    'https://raw.githubusercontent.com/o/r/master/LICENSE': 'MIT License',
  }
  const list = await themesFromUrl('https://github.com/o/r', async (u) => files[u] ?? null)
  assert.equal(list.length, 1)
  assert.deepEqual({ name: list[0]!.name, from: list[0]!.from, license: list[0]!.license, author: list[0]!.author }, { name: 'Probe', from: 'obsidian', license: 'MIT', author: 'me' })
  await assert.rejects(themesFromUrl('https://github.com/o/none', async () => null), /нет theme\.css/)
})

test('пачка из трёх тем — три скина и сводный отчёт (§7.4)', async () => {
  const { convertInputs, summaryReport } = await import('../src/load.js')
  const themes = themesAt(join(__dirname, 'fixtures', 'load', 'themes')).filter((t) => ['Typewriter', 'Dark Lite', 'Dark Modern'].includes(t.name ?? ''))
  const items = convertInputs(themes)
  assert.deepEqual(items.map((x) => x.error ?? x.result!.name), ['dark-lite', 'dark-modern', 'typewriter'])
  const md = summaryReport(items)
  assert.match(md, /Тем: 3, сконвертировано: 3/)
  assert.match(md, /\| typewriter \| obsidian \|.*\| GPL-3\.0 \|/)
})
