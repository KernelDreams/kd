// Demo screenshots for the PR: docs/screens/*.png.
//   npm run screens            (CHROMIUM_PATH=/path/to/chrome to override the browser)
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'docs/screens')
mkdirSync(out, { recursive: true })

const server = await createServer({ configFile: resolve(root, 'demo/vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' })
await server.listen()
const base = server.resolvedUrls.local[0]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' })
const errors = []

async function open(query, viewport = { width: 1280, height: 860 }, colorScheme = 'light') {
  const page = await browser.newPage({ viewport, colorScheme, deviceScaleFactor: viewport.width < 600 ? 3 : 1 })
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${query}: ${m.text()}`))
  await page.goto(`${base}?${query}`)
  await page.waitForSelector('.cm-content')
  await page.waitForTimeout(600)
  return page
}

/** Puts the caret at the end of the document so no line shows raw markdown. */
async function parkCaret(page) {
  await page.evaluate(() => {
    const view = window.nre().view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.contentDOM.blur()
    view.scrollDOM.scrollTop = 0
  })
  await page.waitForTimeout(300)
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(out, `${name}.png`) })
  console.log(`docs/screens/${name}.png`)
  await page.close()
}

// Markdown live preview.
{
  const page = await open('file=readme.md&theme=light')
  await parkCaret(page)
  await shot(page, 'md-live-preview')
}

// mdz, light and dark.
for (const theme of ['light', 'dark']) {
  const page = await open(`file=recipe.mdz&theme=${theme}`, undefined, theme)
  await parkCaret(page)
  await shot(page, `mdz-${theme}`)
}

// mds envelopes and the opaque typed fence.
{
  const page = await open('file=session.mds&theme=dark', undefined, 'dark')
  await parkCaret(page)
  await shot(page, 'mds-dark')
}

// TypeScript: diagnostics + hover.
{
  const page = await open('file=game.ts&theme=light&ts=1')
  await page.waitForSelector('.cm-lintRange-error', { timeout: 60_000 })
  const point = await page.evaluate(() => {
    const view = window.nre().view
    const text = view.state.doc.toString()
    const pos = text.indexOf('totalWeight(hero') + 3
    const c = view.coordsAtPos(pos)
    return { x: c.left + 2, y: (c.top + c.bottom) / 2 }
  })
  await page.mouse.move(point.x, point.y)
  await page.waitForSelector('.cm-tooltip-hover', { state: 'attached', timeout: 30_000 })
  // Also show the diagnostic itself in the gutter-less lint panel style: open it via the error range.
  await page.waitForTimeout(400)
  await shot(page, 'ts-diagnostics-hover')
}
{
  const page = await open('file=game.ts&theme=dark&ts=1', undefined, 'dark')
  await page.waitForSelector('.cm-lintRange-error', { timeout: 60_000 })
  const point = await page.evaluate(() => {
    const view = window.nre().view
    const pos = view.state.doc.toString().indexOf("hp: 'full'") + 1
    const c = view.coordsAtPos(pos)
    return { x: c.left + 2, y: (c.top + c.bottom) / 2 }
  })
  await page.mouse.move(point.x, point.y)
  await page.waitForSelector('.cm-tooltip-hover, .cm-tooltip-lint', { state: 'attached', timeout: 30_000 })
  await page.waitForTimeout(400)
  await shot(page, 'ts-diagnostic-dark')
}

// Phone width.
for (const file of ['recipe.mdz', 'readme.md']) {
  const page = await open(`file=${file}&theme=light`, { width: 390, height: 844 })
  await parkCaret(page)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 0) errors.push(`${file} @390px: horizontal overflow ${overflow}px`)
  await shot(page, `mobile-${file.replace('.', '-')}`)
}

await browser.close()
await server.close()
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
