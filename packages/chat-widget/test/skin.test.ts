import { describe, expect, it } from 'vitest'
import { shadowSkinCss } from '../src/skin.js'

describe('скин nrchat в Shadow DOM (ABC-229)', () => {
  it('корень скина → :host, режим → :host([data-nr-mode]); элементные правила как есть', () => {
    const css = `@import url("https://fonts.bunny.net/css?family=literata");
[data-skin="scene"][data-mode="dark"]{--nr-bg:#17151a}
[data-skin='scene'][data-mode='light']{--nr-bg:#f5f0e7}
[data-skin=scene]{--nr-measure:76ch}
[data-skin="scene"] .nr-text em{color:var(--nr-em)}
[data-skin="sceneX"]{--nr-bg:red}`
    expect(shadowSkinCss(css, 'scene')).toBe(`@import url("https://fonts.bunny.net/css?family=literata");
:host([data-nr-mode="dark"]){--nr-bg:#17151a}
:host([data-nr-mode="light"]){--nr-bg:#f5f0e7}
:host{--nr-measure:76ch}
:host .nr-text em{color:var(--nr-em)}
[data-skin="sceneX"]{--nr-bg:red}`)
  })
})
