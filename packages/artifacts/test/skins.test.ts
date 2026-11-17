/**
 * Мост `__host.skins`: право skins, форма аргументов, исполнение у
 * хоста (list/get/save/check), делегирование фронту (preview/apply), finalize
 * проверяет *.skin.css, тулы агента skin_check/skin_save.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkAccess, checkArtifact, parseManifest, runAgentTool } from '../src/index.js'
import type { AccessEnv } from '../src/index.js'
import { createArtifactHost } from '../src/host.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'artifacts-skins-'))
  mkdirSync(join(tmp, 'skins'))
  writeFileSync(join(tmp, 'skins', 'base.skin.css'), `/* @skin\n * description: база\n */\n${pal('base', 'light')}${pal('base', 'dark')}`)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const pal = (name: string, mode: string) =>
  `[data-skin="${name}"][data-mode="${mode}"]{--nr-bg:#fff;--nr-surface:#eee;--nr-raised:#fff;--nr-line:#ccc;--nr-fg:#111;--nr-muted:#555;--nr-accent:#c50;--nr-ok:#090;--nr-error:#c00;--nr-accent-fg:#fff;--nr-line-soft:#ddd;--nr-shadow-pop:none}\n`
const m = (text: string) => {
  const r = parseManifest(text)
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const env: AccessEnv = { artifactDir: '/a', dataDir: '/d', workspace: '/ws', selected: new Set(), artifactId: 'demo/skin-editor' }
const INDEX = '<!doctype html><html><body><script type="module" src="./app.js"></script></body></html>'

describe('право skins', () => {
  it('без $uses: skins — отказ с подсказкой; с правом — нормализованные аргументы; кривое имя — ошибка', () => {
    expect(checkAccess(m('$title: A\n$uses: $[session]\n'), 'skins.list', [], env)).toEqual({
      ok: false,
      error: 'capability not declared: skins — добавь skins в $uses (редактор тем)',
    })
    const ok = m('$title: A\n$uses: $[skins]\n')
    expect(checkAccess(ok, 'skins.save', ['my', 'x', { base: 'scene' }], env)).toEqual({ ok: true, args: { name: 'my', css: 'x', opts: { base: 'scene' } } })
    expect(checkAccess(ok, 'skins.apply', ['My Skin'], env)).toMatchObject({ ok: false, error: expect.stringMatching(/имя скина/) })
    expect(checkAccess(ok, 'skins.preview', [null], env)).toEqual({ ok: true, args: { clear: true } })
  })

  it('finalize: __host.skins без права и сломанный *.skin.css — ошибки', () => {
    const dir = join(tmp, 'art')
    mkdirSync(dir)
    writeFileSync(join(dir, 'meta.mdz'), '$title: A\n$uses: $[file]\n')
    writeFileSync(join(dir, 'index.html'), INDEX)
    writeFileSync(join(dir, 'app.js'), "await __host.skins.save('x', '')\nawait __host.readFile('./a')\n")
    writeFileSync(join(dir, 'warm.skin.css'), '/* @skin\n * mode: foo\n */\n[data-skin="warm"] .sidebar { color: red }\n')
    const r = checkArtifact(dir, m(readFileSync(join(dir, 'meta.mdz'), 'utf8')))
    expect(r.errors).toContain('app.js:1: __host.skins.save требует право "skins" — добавь в $uses')
    expect(r.errors.join('\n')).toMatch(/warm\.skin\.css: скин: строка 2: mode: "foo"/)
    // Вне контракта — предупреждение (DECISIONS 05.11 «скин ничего не запрещает»).
    expect(r.warnings.join('\n')).toMatch(/warm\.skin\.css: скин: строка 4: селектор «\.sidebar» вне контракта/)
    const ok = checkArtifact(dir, m('$title: A\n$uses: $[file, skins]\n'))
    expect(ok.errors.filter((e) => e.startsWith('app.js'))).toEqual([])
  })
})

describe('хост: skins.*', () => {
  it('list/get/check/save — у хоста над <root>/skins и .nr/skins рабочей области; preview/apply — {delegate}', async () => {
    const coll = join(tmp, 'coll')
    const dir = join(coll, 'ed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.mdz'), '$title: Ed\n$uses: $[skins]\n')
    writeFileSync(join(dir, 'index.html'), INDEX)
    writeFileSync(join(dir, 'app.js'), '')
    const ws = join(tmp, 'ws')
    mkdirSync(ws)
    const host = createArtifactHost({ root: tmp, dataRoot: join(tmp, 'data'), configFile: join(tmp, 'none.md'), warn: () => {} })
    try {
      const o = await host.open(dir, { workspace: ws })
      const list = (await host.bridge(o.key, 'skins.list', [])) as { ok: true; value: Array<{ name: string }> }
      expect(list.value.map((s) => s.name)).toEqual(['base'])
      const got = (await host.bridge(o.key, 'skins.get', ['base'])) as { value: { vars: { dark: Record<string, string> }; chain: string[] } }
      expect(got.value.vars.dark['--nr-accent']).toBe('#c50')
      const contract = (await host.bridge(o.key, 'skins.contract', [])) as { value: { tokens: Array<{ name: string }> } }
      expect(contract.value.tokens.some((t) => t.name === '--nr-accent')).toBe(true)

      const draft = '[data-skin="my"][data-mode="dark"]{--nr-accent:#fc0}'
      const bad = (await host.bridge(o.key, 'skins.preview', ['my', '[data-skin="my"]{--nr-bg:red}', { base: 'nope' }])) as { ok: false; error: string }
      expect(bad.ok).toBe(false)
      expect(bad.error).toMatch(/base: nope/)
      const prev = (await host.bridge(o.key, 'skins.preview', ['my', draft, { base: 'base' }])) as { delegate: string; value: { skin: string; css: string } }
      expect(prev.delegate).toBe('skins.preview')
      expect(prev.value.skin).toBe('my')
      expect(prev.value.css).toMatch(/--nr-accent:\s?#fc0/)

      expect(await host.bridge(o.key, 'skins.apply', ['my'])).toEqual({ ok: false, error: 'skins.apply: скина my нет' })
      const saved = (await host.bridge(o.key, 'skins.save', ['my', draft, { base: 'base', description: 'моя' }])) as { value: { ok: boolean; path: string } }
      expect(saved.value.ok).toBe(true)
      expect(saved.value.path).toBe(join(ws, '.nr', 'skins', 'my.skin.css'))
      expect(await host.bridge(o.key, 'skins.apply', ['my'])).toEqual({ ok: true, delegate: 'skins.apply', value: { name: 'my' } })
    } finally {
      await host.close()
    }
  })
})

describe('тулы агента: skin_save / skin_check / skin_convert', () => {
  it('save пишет в .nr/skins рабочей области, check видит цепочку; ошибки — с подсказкой, без записи; вне контракта — с предупреждением', async () => {
    const ws = join(tmp, 'ws')
    mkdirSync(ws)
    const opts = { registry: { workspace: ws, demoDir: null, configFile: join(tmp, 'none.md') }, skinsRoot: tmp }
    const bad = await runAgentTool('skin_save', { name: 'warm', css: '[data-skin="warm"]{--nr-bg:red}', base: 'nope' }, opts)
    expect(bad.error).toBe(true)
    expect(bad.text).toMatch(/не записан[\s\S]*base: nope/)
    // Скин ничего не запрещает (DECISIONS 05.11): вне контракта — пишется с предупреждением.
    const loose = await runAgentTool('skin_save', { name: 'loose', css: '[data-skin="loose"] .panel{color:red}', base: 'base' }, opts)
    expect(loose.text).toMatch(/✓ скин loose записан[\s\S]*warning: .*«\.panel» вне контракта/)
    const ok = await runAgentTool('skin_save', { name: 'warm', css: '[data-skin="warm"]{--nr-text-body:1.0625rem}', base: 'base', description: 'теплее' }, opts)
    expect(ok.text).toMatch(/✓ скин warm записан/)
    const chk = await runAgentTool('skin_check', { name: 'warm' }, opts)
    expect(chk.text).toMatch(/✓ скин warm: warm → base \(workspace/)
    writeFileSync(join(ws, '.nr', 'skins', 'cold.skin.css'), '/* @skin\n * base: nope\n */\n')
    expect((await runAgentTool('skin_check', { name: 'cold' }, opts)).text).toMatch(/base: nope — такого скина нет/)
  })

  it('skin_convert: тема текстом → скин в .nr/skins с отчётом; to=bot — CSS в ответе', async () => {
    const ws = join(tmp, 'ws2')
    mkdirSync(ws)
    const opts = { registry: { workspace: ws, demoDir: null, configFile: join(tmp, 'none.md') }, skinsRoot: tmp }
    const st = JSON.stringify({ name: 'Probe ST', main_text_color: 'rgba(220, 220, 210, 1)', chat_tint_color: 'rgba(23, 23, 23, 1)', font_scale: 1.2 })
    const r = await runAgentTool('skin_convert', { source: st }, opts)
    expect(r.error).toBeUndefined()
    expect(r.text).toMatch(/✓ скин probe-st записан/)
    expect(r.text).toMatch(/покрытие по контракту: \d+%/)
    expect(r.text).toMatch(/### Хвост добить агентом/)
    expect(readFileSync(join(ws, '.nr', 'skins', 'probe-st.skin.css'), 'utf8')).toMatch(/--nr-text-body: 1\.2rem/)
    const bot = await runAgentTool('skin_convert', { source: st, to: 'bot' }, opts)
    expect(bot.text).toMatch(/```css\n\/\* sillytavern → nr[\s\S]*\[data-skin\]\[data-mode\] \{/)
    expect((await runAgentTool('skin_convert', { source: 'a { color: red }' }, opts)).error).toBe(true)
  })
})

describe('шаблон jsx+skins', () => {
  it('artifact_init(jsx+skins) → finalize без ошибок, $uses: skins', async () => {
    const prevData = process.env.NR_ARTIFACTS_DATA
    process.env.NR_ARTIFACTS_DATA = join(tmp, 'data')
    const opts = { registry: { workspace: tmp, demoDir: null, configFile: join(tmp, 'none.md') }, profile: 'P', checkTimings: { ackMs: 50, resultMs: 50 } }
    const init = await runAgentTool('artifact_init', { name: 'Theme editor', template: 'jsx+skins' }, opts)
    expect(init.error).toBeUndefined()
    const id = (init.data as { id: string; dir: string }).id
    expect(readFileSync(join((init.data as { dir: string }).dir, 'meta.mdz'), 'utf8')).toMatch(/\$uses: \$\[skins\]/)
    const fin = await runAgentTool('artifact_finalize', { id }, opts)
    expect(fin.text).toMatch(/^✓ .*версия 1/)
    if (prevData === undefined) delete process.env.NR_ARTIFACTS_DATA
    else process.env.NR_ARTIFACTS_DATA = prevData
  })
})
