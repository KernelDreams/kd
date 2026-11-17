import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkContrast,
  compileSkin,
  convertObsidian,
  convertSillyTavern,
  convertTheme,
  convertVsCode,
  detectSource,
  registerThemeConverter,
  themeConverters,
  evalColor,
  formatReport,
  mergeVsCodeThemes,
  parseJsonc,
  parseStyleSettings,
  REQUIRED_TOKENS,
  toHex,
  type ConvertResult,
  type VsCodeTheme,
} from '../src/index.js'

const fx = (p: string): string => readFileSync(join(__dirname, 'fixtures', p), 'utf8')
const obsidian = (n: string): ConvertResult => convertObsidian(fx(`obsidian/${n}.theme.css`), { manifest: JSON.parse(fx(`obsidian/${n}.manifest.json`)) as { name: string }, source: `obsidian/${n}`, license: n === 'typewriter' ? 'GPL-3.0' : 'MIT' })
const vscodeTheme = (f: string): VsCodeTheme => parseJsonc(fx(`vscode/${f}.json`)) as VsCodeTheme
const darkModern = (): VsCodeTheme => mergeVsCodeThemes(mergeVsCodeThemes(vscodeTheme('dark_vs'), vscodeTheme('dark_plus')), vscodeTheme('dark_modern'))

/** Все 12 токенов уровня A в каждом режиме: из источника или выведены (`derived` в `sources`). */
function expectFullPalette(r: ConvertResult): void {
  for (const [mode, p] of Object.entries(r.palettes)) {
    const all = { ...r.tokens, ...p }
    expect(REQUIRED_TOKENS.filter((t) => !(t in all)), `режим ${mode}`).toEqual([])
    for (const t of REQUIRED_TOKENS) expect(r.sources.some((s) => s.token === t), `${t} без источника`).toBe(true)
  }
}

/** Пробы (skin-convert-spec §7.1): ключевые токены, полная палитра, покрытие не ниже замера 05.11. */
const PROBES: Array<{ name: string; run: () => ConvertResult; mode: string; coverage: number; expect: Record<string, Record<string, string>> }> = [
  {
    name: 'Obsidian Minimal (MIT)',
    run: () => obsidian('minimal'),
    mode: 'both',
    coverage: 0.48,
    expect: { light: { '--nr-bg': '#ffffff', '--nr-surface': '#f5f5f5', '--nr-line': '#e5e5e5' }, dark: { '--nr-bg': '#262626' } },
  },
  {
    name: 'Obsidian Retroma (MIT)',
    run: () => obsidian('retroma'),
    mode: 'both',
    coverage: 0.62,
    expect: { light: { '--nr-bg': '#cbe9ff', '--nr-fg': '#4a4468' }, dark: { '--nr-bg': '#000720', '--nr-fg': '#ada8d0' } },
  },
  {
    name: 'Obsidian Typewriter (GPL-3.0)',
    run: () => obsidian('typewriter'),
    mode: 'both',
    coverage: 0.88,
    expect: { light: { '--nr-bg': '#fcf5e4', '--nr-fg': '#262626', '--nr-accent': '#605586' }, dark: { '--nr-bg': '#262626', '--nr-fg': '#c5b8a1', '--nr-accent': '#af9af4' } },
  },
  {
    name: 'SillyTavern Dark Lite',
    run: () => convertSillyTavern(fx('sillytavern/dark-lite.json')),
    mode: 'dark',
    coverage: 0.8,
    expect: { dark: { '--nr-fg': 'rgba(220, 220, 210, 1)', '--nr-em': 'rgba(145, 145, 145, 1)', '--nr-bg': '#171717', '--nr-bg-chat': 'rgba(23, 23, 23, 1)', '--nr-measure': '85ch', '--nr-avatar-radius': '9999px' } },
  },
  {
    name: 'VS Code Dark Modern',
    run: () => convertVsCode(darkModern()),
    mode: 'dark',
    coverage: 0.93,
    expect: {
      dark: { '--nr-bg': '#1f1f1f', '--nr-surface': '#181818', '--nr-fg': '#cccccc', '--nr-focus': '#0078d4', '--nr-code-comment': '#6a9955', '--nr-code-keyword': '#569cd6', '--nr-code-string': '#ce9178', '--nr-code-number': '#b5cea8', '--nr-code-title': '#dcdcaa', '--nr-code-type': '#4ec9b0', '--nr-code-attr': '#9cdcfe' },
    },
  },
]

describe('пробы конвертеров (§7.1)', () => {
  for (const p of PROBES) {
    describe(p.name, () => {
      const r = p.run()
      it('ключевые токены по таблице', () => {
        expect(r.mode).toBe(p.mode)
        for (const [mode, tokens] of Object.entries(p.expect)) for (const [k, v] of Object.entries(tokens)) expect(r.palettes[mode as 'light' | 'dark']?.[k] ?? r.tokens[k], `${mode} ${k}`).toBe(v)
      })
      it('12 токенов уровня A в каждом режиме', () => expectFullPalette(r))
      it(`покрытие ≥ ${p.coverage} (порог регрессии)`, () => expect(r.report.coverage).toBeGreaterThanOrEqual(p.coverage))
      it('линтер: ошибок нет, скин собирается', () => {
        expect(r.lint.errors).toEqual([])
        const c = compileSkin(r.name!, (n) => (n === r.name ? r.css : undefined))
        expect(c.errors).toEqual([])
        expect(c.css.length).toBeGreaterThan(0)
        // Контраст собранного скина проверяется (и живые ссылки на ручки раскрываются) — строго.
        expect(c.warnings.filter((w) => w.message.startsWith('контраст')).map((w) => w.message)).toEqual([])
      })
      it('контраст текста и статусов ≥ 4.5:1', () => {
        for (const [mode, pal] of Object.entries(r.palettes)) expect(checkContrast({ ...r.tokens, ...pal }, mode as 'light' | 'dark').map((c) => c.message)).toEqual([])
      })
      it('отчёт: покрытие, легло, не легло, хвост агенту', () => {
        const md = formatReport(r)
        expect(md).toMatch(/покрытие по контракту: \d+%/)
        expect(md).toMatch(/### Легло/)
        expect(r.report.todo.length).toBeGreaterThan(0)
      })
    })
  }
})

describe('Obsidian', () => {
  it('шапка: source, license, author из манифеста', () => {
    const r = obsidian('typewriter')
    expect(r.header).toMatchObject({ name: 'typewriter', mode: 'both', source: 'obsidian/typewriter', license: 'GPL-3.0' })
    expect(r.css).toMatch(/^\/\* @skin\n \* name: typewriter\n[\s\S]*? \* license: GPL-3.0\n/)
  })
  it('ручки Style Settings Minimal: блок как есть, class-select — классы на корне', () => {
    const r = obsidian('minimal')
    expect(r.css).toMatch(/\/\* @settings\n/)
    const handles = parseStyleSettings([...r.css.matchAll(/\/\*\s*@settings[\s\S]*?\*\//g)].map((m) => m[0]))
    expect(handles.some((h) => h.type === 'class-select')).toBe(true)
    expect(handles.some((h) => h.type === 'variable-themed-color' || h.type === 'variable-color')).toBe(true)
    // `body.<класс>` / `.theme-dark.<класс>` → `[data-skin="minimal"].<класс>`.
    expect(r.css).toMatch(/\[data-skin="minimal"\](\[data-mode="(light|dark)"\])?\.[a-z][\w-]* /)
  })
  it('разметка заметки → .nr-text, интерфейс Obsidian — не легло (чужой DOM)', () => {
    const r = convertObsidian(`.theme-dark { --background-primary: #101010; --text-normal: #eeeeee; --interactive-accent: #ff8800; }
.theme-light { --background-primary: #fafafa; --text-normal: #111111; }
.markdown-rendered h1 { color: var(--interactive-accent); margin-top: 2em; }
.markdown-rendered .callout[data-callout="note"] { background: #222; }
.workspace-leaf { background: red; }
.nav-file-title { color: red; }
body.my-toggle .markdown-rendered em { color: hotpink; }
/* @settings
name: T
id: t
settings:
    -
        id: my-toggle
        title: Toggle
        type: class-toggle
*/`, { name: 'probe' })
    expect(r.mode).toBe('both')
    expect(r.css).toContain('[data-skin="probe"] .nr-text h1 {\n  color: var(--nr-accent);\n}')
    expect(r.css).toContain('[data-skin="probe"] .nr-text blockquote {\n  background: #222;\n}')
    expect(r.css).toContain('[data-skin="probe"].my-toggle .nr-text em {\n  color: hotpink;\n}')
    expect(r.report.approximated.map((a) => a.nr)).toContain('.nr-text blockquote')
    expect(r.report.droppedProps['.nr-text h1: margin-top']).toBe(1)
    expect(r.report.dropped.map((d) => d.what)).toEqual(expect.arrayContaining(['.workspace-leaf', '.nav-file-title']))
    expect(r.report.foreign).toBeGreaterThanOrEqual(2)
    expect(r.palettes.dark!['--nr-accent']).toBe('#ff8800')
    expect(r.lint.warnings).toEqual([])
  })
  it('акцент --accent-h/s/l раскрывается; без темы — умолчание Obsidian 254 80% 68%', () => {
    const r = convertObsidian(`.theme-dark { --background-primary: #000000; --accent-h: 120; --accent-s: 50%; --accent-l: 50%; }`, { name: 'a' })
    expect(r.palettes.dark!['--nr-accent']).toBe('#40bf40')
    const d = convertObsidian(`.theme-dark { --background-primary: #000000; }`, { name: 'd' })
    // Умолчание — и подтяжка контраста к чёрному фону поверх него.
    expect(d.sources.find((x) => x.token === '--nr-accent' && x.mode === 'dark')!.from).toBe(`contrast ${toHex(evalColor('hsl(254, 80%, 68%)')!)} → 4.5:1 (10% к белому)`)
  })
})

describe('SillyTavern', () => {
  it('font_scale 1.2 → --nr-text-body = 1.2 × база; chat_display: bubbles — фон у реплик (§7.6)', () => {
    const base = JSON.parse(fx('sillytavern/dark-lite.json')) as Record<string, unknown>
    const r = convertSillyTavern({ ...base, font_scale: 1.2, chat_display: 1, user_mes_blur_tint_color: undefined, bot_mes_blur_tint_color: undefined })
    expect(r.tokens['--nr-text-body']).toBe('1.2rem')
    expect(r.tokens['--nr-text-xs']).toBe('0.975rem')
    expect(r.css).toMatch(/\.nr-message\[data-role=user\] \{\n  border-radius: var\(--nr-radius-lg\);\n  padding: [^;]+;\n  background: var\(--nr-surface\);/)
    expect(r.css).toMatch(/\.nr-message\[data-role=assistant\] \{[^}]*background: var\(--nr-surface\)/)
  })
  it('font_scale мельче — не ниже пола читаемости', () => {
    const r = convertSillyTavern({ main_text_color: '#eee', chat_tint_color: '#111', font_scale: 0.8 })
    expect(r.tokens['--nr-text-body']).toBe('0.9375rem')
    expect(r.tokens['--nr-text-xs']).toBe('0.8125rem')
  })
  it('chat_display: document — без аватаров; custom_css — проекцией', () => {
    const r = convertSillyTavern({
      main_text_color: '#eee',
      chat_tint_color: '#111',
      chat_display: 2,
      custom_css: ':root { --SmartThemeBodyColor: #ddd; } .mes .mes_text em { color: var(--SmartThemeEmColor); margin: 3px } #rightNavHolder { color: red } .mes[is_user="true"] .name_text { font-weight: 700 }',
      italics_text_color: '#c0a',
    })
    expect(r.css).toContain('.nr-avatar {\n  display: none;\n}')
    expect(r.tokens['--nr-gutter-w']).toBe('0')
    expect(r.tokens['--nr-fg']).toBe('#ddd')
    expect(r.css).toContain('[data-skin="st-theme"] .nr-message .nr-text em {\n  color: var(--nr-em);\n}')
    expect(r.css).toContain('[data-skin="st-theme"] .nr-message[data-role=user] .nr-author {\n  font-weight: 700;\n}')
    expect(r.report.droppedProps['.nr-message .nr-text em: margin']).toBe(1)
    expect(r.report.dropped.some((d) => d.what === '#rightNavHolder')).toBe(true)
  })
})

describe('VS Code', () => {
  it('type light — светлый режим; tokenColors — точный scope сильнее уточнений', () => {
    const r = convertVsCode({
      type: 'light',
      colors: { 'editor.background': '#ffffff', 'editor.foreground': '#333333', 'button.background': '#005fb8' },
      tokenColors: [{ scope: 'comment', settings: { foreground: '#008000' } }, { scope: ['string.regexp'], settings: { foreground: '#811f3f' } }, { scope: 'string', settings: { foreground: '#a31515' } }],
    })
    expect(r.mode).toBe('light')
    expect(r.tokens['--nr-code-comment']).toBe('#008000')
    expect(r.tokens['--nr-code-string']).toBe('#a31515')
    expectFullPalette(r)
  })
  it('JSONC: комментарии и висячие запятые', () => {
    expect(parseJsonc('{ // c\n "a": [1, 2,], /* b */ "s": "x//y" }')).toEqual({ a: [1, 2], s: 'x//y' })
  })
})

describe('угадывание источника', () => {
  it('JSON ST / VS Code, CSS Obsidian', () => {
    expect(detectSource(fx('sillytavern/dark-lite.json'))).toBe('sillytavern')
    expect(detectSource(fx('vscode/dark_modern.json'))).toBe('vscode')
    expect(detectSource(fx('obsidian/typewriter.theme.css'))).toBe('obsidian')
    expect(() => convertTheme('a { color: red }')).toThrow(/from: obsidian/)
    expect(convertTheme(fx('sillytavern/dark-lite.json')).source).toBe('sillytavern')
  })
})

describe('реестр конвертеров', () => {
  it('внешний конвертер: детект по уверенности, convert, снятие', () => {
    const base = themeConverters().map((c) => c.id)
    expect(base).toEqual(['obsidian', 'sillytavern', 'vscode'])
    const css = '.theme-dark { --background-primary: #000 } .x-site { color: red }'
    expect(detectSource(css)).toBe('obsidian')
    const off = registerThemeConverter({
      id: 'site',
      detect: (text) => (/\.x-site\b/.test(text) ? 2 : false),
      convert: (text, opts) => convertObsidian(text, opts),
    })
    expect(detectSource(css)).toBe('site')
    expect(convertTheme(css).css).toContain('@skin')
    expect(() => convertTheme('a { color: red }')).toThrow(/from: obsidian \| sillytavern \| vscode \| site/)
    off()
    expect(themeConverters().map((c) => c.id)).toEqual(base)
    expect(() => convertTheme('a {}', { from: 'site' })).toThrow(/нет конвертера тем «site»/)
  })
})

describe('цвет CSS (evalColor)', () => {
  it.each([
    ['oklch(0.7 0.1 30)', '#d58679'],
    ['oklch(from #ff0000 l c h)', '#ff0000'],
    ['hsl(from #ff0000 h s calc(l - 20))', '#990000'],
    ['color-mix(in srgb, #000 50%, #fff)', '#808080'],
    ['lch(50 30 270)', '#5d78aa'],
    ['hsl(201 17% 50%)', '#6a8695'],
    ['rebeccapurple', '#663399'],
  ])('%s → %s', (v, hex) => expect(toHex(evalColor(v)!)).toBe(hex))
  it('не цвет — null', () => expect(evalColor('var(--x)')).toBeNull())
})
