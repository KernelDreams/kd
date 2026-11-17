import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkContrast, compileSkin, formatIssue, modeVars, modesOf, TOKEN_BY_NAME } from '../src/index.js'

/** Набор тем площадки Emotion Hunters: `themes/eh/*.skin.css`, на стенд — `envs-lab/skins`. */
const DIR = join(__dirname, '../themes/eh')
const files = readdirSync(DIR).filter((f) => f.endsWith('.skin.css'))
const text = (name: string): string | undefined => {
  const f = join(DIR, `${name}.skin.css`)
  return existsSync(f) ? readFileSync(f, 'utf8') : undefined
}

describe('набор тем площадки', () => {
  it('две темы: светлая и тёмная', () => {
    expect(files.sort()).toEqual(['eh-dark.skin.css', 'eh-light.skin.css'])
  })

  for (const f of files) {
    const name = f.replace(/\.skin\.css$/, '')
    describe(name, () => {
      const c = compileSkin(name, text)

      it('валидатор и полная палитра заявленных режимов', () => {
        expect(c.errors.map(formatIssue)).toEqual([])
      })

      it('контраст текста и статусов ≥ 4.5:1 в каждом режиме (строго)', () => {
        for (const mode of modesOf(c.header.mode)) expect(checkContrast(modeVars(c.vars, mode), mode).map((i) => i.message)).toEqual([])
      })

      it('ручки /* @settings */ доходят до фронта и живут на своих переменных, не на палитре', () => {
        expect(c.css).toMatch(/\/\* @settings[\s\S]*id: eh-accent/)
        const ids = [...c.css.matchAll(/^\s*id: (\S+)$/gm)].map((m) => m[1]!).filter((id) => id !== name)
        expect(ids).toEqual(['eh-accent', 'eh-avatar', 'eh-measure'])
        // Ручка ставит `--<id>` инлайном на <html>: на палитре она перебила бы тему бота.
        for (const id of ids) expect(TOKEN_BY_NAME.has(`--${id}`)).toBe(false)
        expect(c.css).toContain('var(--eh-accent,')
      })
    })
  }
})

describe('таверна на стенде lab', () => {
  const lab = join(homedir(), 'Studio/envs-lab/skins')
  it.skipIf(!existsSync(join(lab, 'tavern.skin.css')))('tavern.skin.css собирается без ошибок', () => {
    const c = compileSkin('tavern', (n) => {
      const f = join(lab, `${n}.skin.css`)
      return existsSync(f) ? readFileSync(f, 'utf8') : undefined
    })
    expect(c.errors.map(formatIssue)).toEqual([])
  })
})
