import { describe, expect, it } from 'vitest'
import { compileSkin, formatIssue, parseHeader, validateSkin, withHeader } from '../src/index.js'

const PALETTE = (mode: string) => `[data-skin="x"][data-mode="${mode}"] {
  --nr-bg: #000; --nr-surface: #111; --nr-raised: #222; --nr-line: #333; --nr-fg: #eee; --nr-muted: #999;
  --nr-accent: #f80; --nr-ok: #0f0; --nr-error: #f00; --nr-accent-fg: #000; --nr-line-soft: #222; --nr-shadow-pop: none;
}`
const HEAD = (extra = '') => `/* @skin\n * name: x\n * description: тест\n * mode: both\n${extra} */\n`

describe('ручки скина', () => {
  it('блок @settings переживает компиляцию (csstree комментарии не держит)', () => {
    const block = '/* @settings\nname: X\nid: x\nsettings:\n    -\n        id: glow\n        type: class-toggle\n*/'
    const c = compileSkin('x', () => HEAD() + block + '\n' + PALETTE('light') + PALETTE('dark'))
    expect(c.errors).toEqual([])
    expect(c.css).toContain(block)
  })
})

describe('шапка', () => {
  it('разбирает ключи; неизвестный — предупреждение, mode вне списка — ошибка', () => {
    const { header, errors, warnings } = parseHeader(`/* @skin\n * name: scene\n * mode: dark\n * base: parchment\n * colour: red\n */\n`)
    expect(header).toEqual({ name: 'scene', mode: 'dark', base: 'parchment' })
    expect(errors).toEqual([])
    expect(warnings.map(formatIssue)[0]).toMatch(/неизвестный ключ шапки "colour"/)
    expect(parseHeader(`/* @skin\n * mode: foo\n */`).errors.map((e) => e.message)).toEqual(['mode: "foo"'])
  })
  it('source, license, author — в шапке и обратно (skin-convert-spec §1)', () => {
    const t = withHeader('a{}', { name: 'retroma', source: 'https://github.com/x/retroma', license: 'MIT', author: 'Someone' })
    expect(parseHeader(t)).toMatchObject({ header: { name: 'retroma', mode: 'both', source: 'https://github.com/x/retroma', license: 'MIT', author: 'Someone' }, errors: [], warnings: [] })
  })
  it('withHeader заменяет шапку', () => {
    const t = withHeader(HEAD() + 'a{}', { name: 'y', base: 'x' })
    expect(parseHeader(t).header).toEqual({ name: 'y', mode: 'both', base: 'x' })
    expect(t.match(/@skin/g)).toHaveLength(1)
  })
})

describe('линтер (skin-spec §2 v1.1: скин ничего не запрещает)', () => {
  it('скин по контракту — ok без замечаний, переменные по режимам', () => {
    const r = validateSkin(HEAD() + PALETTE('light') + PALETTE('dark') + `
[data-skin="x"] { --nr-font-body: Lora, serif; --nr-avatar-size: 38px; }
[data-skin="x"] .nr-message[data-role=user] .nr-author { color: var(--nr-muted); }
[data-skin='x'][data-mode='dark'] .nr-text em { color: #c9a; font-style: italic; }
`, { name: 'x' })
    expect(r.errors.map(formatIssue)).toEqual([])
    expect(r.warnings.map(formatIssue)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.vars.dark['--nr-bg']).toBe('#000')
    expect(r.vars.common['--nr-avatar-size']).toBe('38px')
  })

  it('чужой селектор — предупреждение со строкой и подсказкой', () => {
    const r = validateSkin(HEAD() + `[data-skin="x"] .sidebar { color: red }\n.panel { --nr-bg: red }`, { name: 'x' })
    expect(r.ok).toBe(true)
    const msgs = r.warnings.map(formatIssue)
    expect(msgs[0]).toMatch(/строка 6: селектор «\.sidebar» вне контракта — гарантированы: \.nr-feed/)
    expect(msgs[1]).toMatch(/«\.panel» без \[data-skin="x"\]/)
    // Переменные правила вне корня — не палитра.
    expect(r.vars.common['--nr-bg']).toBeUndefined()
  })

  it('@media, !important, селектор вне хуков, служебные токены, свойства вне списка — предупреждения', () => {
    const r = validateSkin(HEAD() + `@media (min-width: 1px) { [data-skin="x"] { --nr-bg: red } }
[data-skin="x"] { --my-color: red; color: red; --nr-z-modal: 1 }
[data-skin="x"] .nr-message { display: flex; position: absolute }
[data-skin="x"] .nr-message:hover { color: red }
[data-skin="x"] > .nr-message { color: red }
[data-skin="x"] .nr-message em { color: red }
[data-skin="x"] .nr-text em { color: red !important }`, { name: 'x' })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    const msgs = r.warnings.map((e) => e.message)
    expect(msgs[0]).toBe('@media вне контракта')
    expect(msgs).toContain('свойство color в корневом правиле')
    expect(msgs).toContain('--nr-z-modal — служебная переменная')
    expect(msgs).toContain('display: flex вне контракта')
    expect(msgs).toContain('свойство position вне контракта')
    expect(msgs).toContain('псевдо-селектор :hover вне контракта')
    expect(msgs).toContain('комбинатор «>» вне контракта')
    expect(msgs).toContain('тег em вне .nr-text')
    expect(msgs).toContain('color: !important')
    // Свои переменные скина — молча.
    expect(msgs.join('\n')).not.toMatch(/--my-color/)
  })

  it('панель и полоса клавиш (FRR-5): хуки .nr-panel-*, .nr-keybar-*; display: none у .nr-avatar — по контракту', () => {
    const ok = validateSkin(HEAD() + `[data-skin="x"] .nr-panel { background: #0000aa; color: #0ff }
[data-skin="x"] .nr-panel-active .nr-panel-cursor { background: #00aaaa; color: #000 }
[data-skin="x"] .nr-panel-cursor.nr-panel-selected { color: #ff5 }
[data-skin="x"] .nr-keybar .nr-keybar-key .nr-keybar-num { color: #0ff }
[data-skin="x"] .nr-message .nr-avatar { display: none }`, { name: 'x' })
    expect(ok.warnings.map(formatIssue)).toEqual([])
    const loose = validateSkin(HEAD() + `[data-skin="x"] .nr-panel-row { display: none }`, { name: 'x' })
    expect(loose.warnings.map((e) => e.message)).toEqual(['display: none вне контракта'])
  })

  it('неизвестный --nr-* — предупреждение, плагинный --nr-tv-* — молча', () => {
    const r = validateSkin(HEAD() + `[data-skin="x"] { --nr-accnet: red; --nr-tv-gold: #fc0 }`, { name: 'x' })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.message)).toEqual(['неизвестный токен --nr-accnet'])
  })

  it('ручки Style Settings: класс на корне [data-skin="x"].cls — молча, переменные не в палитру', () => {
    const r = validateSkin(HEAD() + `[data-skin="x"].glow { --nr-accent: #ff0 }\n[data-skin="x"].glow .nr-text em { color: #ff0 }`, { name: 'x' })
    expect(r.warnings).toEqual([])
    expect(r.vars.common['--nr-accent']).toBeUndefined()
  })

  it('шрифты с любых https-хостов — молча; http и @import после правил — предупреждение', () => {
    const ok = validateSkin(HEAD() + `@import url("https://fonts.googleapis.com/css2?family=Lora&display=swap");
@import url(https://cdn.jsdelivr.net/npm/x/font.css);
@font-face { font-family: L; src: local("Lora"), url(https://example.com/lora.woff2) format("woff2"); }
[data-skin="x"] { --nr-font-body: L, serif }`, { name: 'x' })
    expect(ok.errors).toEqual([])
    expect(ok.warnings).toEqual([])
    const loose = validateSkin(HEAD() + `[data-skin="x"] { --nr-font-body: L }\n@import url("http://evil.example/x.css");
@font-face { font-family: L; src: url(http://evil.example/l.woff2) }`, { name: 'x' })
    expect(loose.ok).toBe(true)
    expect(loose.warnings.map((e) => e.message)).toEqual(['@import после правил', '@import http://evil.example/x.css', '@font-face src: http://evil.example/l.woff2'])
  })

  it('нечитаемый CSS и mode: foo — ошибка; чужой скин в селекторе — предупреждение; имя в шапке ≠ файл — ошибка', () => {
    expect(validateSkin(HEAD() + `[data-skin="x"] { --nr-bg: red; }}} @@@ {`, { name: 'x' }).ok).toBe(false)
    expect(validateSkin(`/* @skin\n * mode: foo\n */\n[data-skin="x"] { --nr-bg: red }`, { name: 'x' }).ok).toBe(false)
    const r = validateSkin(`/* @skin\n * name: y\n */\n[data-skin="parchment"] { --nr-bg: red }`, { name: 'x' })
    expect(r.errors.map((e) => e.message)).toEqual(['name: y в шапке, а файл — x.skin.css'])
    expect(r.warnings.map((e) => e.message)).toContain('селектор для чужого скина [data-skin="parchment"]')
  })
})

describe('наследование base', () => {
  const files: Record<string, string> = {
    x: HEAD() + `@import url("https://fonts.bunny.net/css?family=lora");\n` + PALETTE('light') + PALETTE('dark') + `\n[data-skin="x"] .nr-author { color: var(--nr-accent) }`,
    y: `/* @skin\n * name: y\n * base: x\n */\n@import url("https://fonts.googleapis.com/css2?family=Inter");\n[data-skin="y"][data-mode="dark"] { --nr-accent: #fc0 }`,
    loop1: `/* @skin\n * base: loop2\n */\n`,
    loop2: `/* @skin\n * base: loop1\n */\n`,
    half: `/* @skin\n * mode: both\n */\n` + PALETTE('light').replace(/"x"/, '"half"'),
  }
  const lookup = (n: string) => files[n]

  it('база переименована в наследника и стоит раньше, @import — наверху', () => {
    const c = compileSkin('y', lookup, Object.keys(files))
    expect(c.errors).toEqual([])
    expect(c.chain).toEqual(['y', 'x'])
    expect(c.css).not.toMatch(/data-skin="x"/)
    expect(c.css.indexOf('[data-skin="y"] .nr-author')).toBeGreaterThan(0)
    expect(c.css.indexOf('base: x')).toBeLessThan(c.css.indexOf('/* y */'))
    expect(c.css.trimStart().startsWith('@import')).toBe(true)
    expect(c.css.match(/@import/g)).toHaveLength(2)
    expect(c.vars.dark['--nr-accent']).toBe('#fc0')
    expect(c.vars.light['--nr-accent']).toBe('#f80')
  })

  it('нет базы и цикл — ошибки', () => {
    expect(compileSkin('z', () => `/* @skin\n * base: nope\n */`, ['z']).errors.map((e) => e.message)).toContain('base: nope — такого скина нет')
    expect(compileSkin('loop1', lookup, Object.keys(files)).errors[0]!.message).toMatch(/цикл наследования: loop1 → loop2 → loop1/)
  })

  it('неполная палитра — предупреждение, дыры добиты встроенной палитрой; скин собирается', () => {
    const half = compileSkin('half', lookup)
    expect(half.errors).toEqual([])
    expect(half.warnings[0]!.message).toMatch(/палитра режима dark неполная: нет --nr-bg/)
    expect(half.warnings[0]!.hint).toMatch(/встроенной палитры/)
    expect(half.vars.dark['--nr-bg']).toBe('#171310')
    expect(half.css).toMatch(/\[data-skin="half"\]\[data-mode="dark"\] \{\n  --nr-bg: #171310;/)
  })

  it('дыры — из дефолтного скина набора, если он есть', () => {
    const set: Record<string, string> = { ...files, parchment: `/* @skin\n */\n` + PALETTE('light').replace('"x"', '"parchment"') + PALETTE('dark').replace('"x"', '"parchment"'), bare: `/* @skin\n * mode: dark\n */\n[data-skin="bare"][data-mode="dark"] { --nr-accent: #fc0 }` }
    const c = compileSkin('bare', (n) => set[n])
    expect(c.errors).toEqual([])
    expect(c.vars.dark['--nr-bg']).toBe('#000')
    expect(c.vars.dark['--nr-accent']).toBe('#fc0')
    expect(c.warnings[0]!.hint).toMatch(/дефолтного скина parchment/)
  })
})

describe('приёмка линтера (skin-convert-spec §7.2)', () => {
  it('@media, !important, селектор вне хуков и неполная палитра — предупреждения, скин собирается', () => {
    const text = `/* @skin\n * mode: dark\n */
@media (max-width: 600px) { [data-skin="loose"] .nr-text { font-size: 15px } }
[data-skin="loose"][data-mode="dark"] { --nr-bg: #101010; --nr-fg: #eeeeee }
[data-skin="loose"] .sidebar .item { color: red !important }`
    const c = compileSkin('loose', (n) => (n === 'loose' ? text : undefined))
    expect(c.errors).toEqual([])
    const w = c.warnings.map((x) => x.message).join('\n')
    expect(w).toMatch(/@media вне контракта/)
    expect(w).toMatch(/!important/)
    expect(w).toMatch(/«\.sidebar» вне контракта/)
    expect(w).toMatch(/палитра режима dark неполная/)
    expect(c.css).toMatch(/@media/)
    expect(c.vars.dark['--nr-accent']).toBe('#e0a458')
  })
  it('нечитаемый CSS и mode: foo — ошибка, скин не собирается', () => {
    expect(compileSkin('bad', () => `/* @skin\n * mode: foo\n */`).errors.map((e) => e.message)).toEqual(['mode: "foo"'])
    expect(compileSkin('bad', () => `[data-skin="bad"] { --nr-bg: red; }}} @@@ {`).css).toBe('')
  })
})

describe('роли полотна (ABC-816)', () => {
  it('токены ноды, пина, провода, плашки и полотна — в контракте, необязательные: без замечаний', () => {
    const r = validateSkin(HEAD() + PALETTE('light') + PALETTE('dark') + `
[data-skin="x"] { --nr-node-border-w: 2px; --nr-node-shadow: 3px 3px 0 #000; --nr-node-radius: 6px; --nr-pin-border-w: 2px; --nr-pin-radius: 2px;
  --nr-wire-w: 2px; --nr-wire-dash: 6 3; --nr-edge-label-border-w: 2px; --nr-canvas-grid-size: 16px; --nr-type-2: #a0f; }
`, { name: 'x' })
    expect(r.errors.map(formatIssue)).toEqual([])
    expect(r.warnings.map(formatIssue)).toEqual([])
    // Скин без них тоже по контракту: дефолты у ядра (`tokens.css`).
    expect(validateSkin(HEAD() + PALETTE('light') + PALETTE('dark'), { name: 'x' }).ok).toBe(true)
  })
})
