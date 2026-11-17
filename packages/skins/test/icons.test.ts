import { describe, expect, it } from 'vitest'
import { checkIcons, validateSkin, TOKEN_BY_NAME, ICON_STYLES } from '../src/index.js'

const skin = (vars: string): string => `/* @skin\nname: ic\n*/\n[data-skin="ic"] {\n${vars}\n}\n`

describe('иконки скина (icons-spec §2)', () => {
  it('токены пакета и способа — в контракте, без «неизвестный токен»', () => {
    expect(TOKEN_BY_NAME.get('--nr-icon-pack')?.kind).toBe('keyword')
    expect(ICON_STYLES).toEqual(['outline', 'plate', 'duotone'])
    const r = validateSkin(skin('  --nr-icon-pack: office;\n  --nr-icon-style: duotone;'))
    expect(r.ok).toBe(true)
    expect(r.warnings.filter((w) => /неизвестный токен|контур/.test(w.message))).toEqual([])
  })
  it('тонкий контур одноцветного пакета — предупреждение, не ошибка', () => {
    const r = validateSkin(skin('  --nr-icon-pack: lucide;\n  --nr-icon-style: outline;\n  --nr-icon-stroke: 1.5;'))
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => /тонкий контур/.test(w.message))).toBe(true)
  })
  it('outline по умолчанию (2.4) и plate — без замечания; многоцветный не проверяется', () => {
    expect(checkIcons({ '--nr-icon-style': 'outline', '--nr-record-accent': '#3366cc' })).toEqual([])
    expect(checkIcons({ '--nr-icon-style': 'plate', '--nr-icon-stroke': '1' })).toEqual([])
    expect(checkIcons({ '--nr-icon-pack': 'office', '--nr-icon-style': 'outline', '--nr-icon-stroke': '1' })).toEqual([])
    expect(checkIcons({ '--nr-icon-pack': 'mine', '--nr-icon-style': 'outline', '--nr-icon-stroke': '1' }, { colorPacks: ['mine'] })).toEqual([])
  })
  it('outline при сером эталоне записи — соседи одного цвета', () => {
    const w = checkIcons({ '--nr-icon-style': 'outline', '--nr-record-accent': '#777777' })
    expect(w.map((x) => x.message).join()).toMatch(/одного цвета/)
  })
})

describe('растровые пакеты и размеры (ABC-867)', () => {
  it('office2000 — многоцветный: контур не проверяется, тулбар мельче 24 — предупреждение', async () => {
    const { checkIcons } = await import('../src/readability.js')
    expect(checkIcons({ '--nr-icon-pack': 'office2000', '--nr-icon-style': 'outline', '--nr-icon-stroke': '1' })).toEqual([])
    expect(checkIcons({ '--nr-icon-pack': 'office2000', '--nr-icon-bar': '20px' })).toHaveLength(1)
    expect(checkIcons({ '--nr-icon-pack': 'office2000', '--nr-icon-bar': '32px' })).toEqual([])
  })
  it('растр мельче 2× показа — предупреждение', async () => {
    const { checkRasterIcon } = await import('../src/readability.js')
    expect(checkRasterIcon({ name: 'folder', width: 96, height: 96 })).toBeNull()
    expect(checkRasterIcon({ name: 'folder', width: 48, height: 48 })?.message).toContain('48×48')
  })
})
