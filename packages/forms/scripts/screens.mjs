// Снимки демо для ревью: docs/screens/*.png.
//   npm run screens            (CHROMIUM_PATH=/path/to/chrome — свой браузер)
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

async function launch() {
  if (process.env.CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  try {
    return await chromium.launch()
  } catch {
    return chromium.launch({ channel: 'chrome' })
  }
}
const browser = await launch()
const errors = []

async function open(query, viewport = { width: 1100, height: 900 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.width < 600 ? 3 : 1 })
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${query}: ${m.text()}`))
  await page.goto(`${base}?${query}`)
  await page.waitForSelector('[data-testid="forms-form"]')
  await page.waitForTimeout(300)
  return page
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true })
  console.log(`docs/screens/${name}.png`)
  await page.close()
}

// Вся форма: секции, вариант, происхождение; светлая и тёмная.
for (const theme of ['light', 'dark']) await shot(await open(`theme=${theme}`), `form-${theme}`)

// Строки хозяина (labels) и «только изменённые».
{
  const page = await open('lang=ru')
  await page.getByTestId('forms-only-changed').click()
  await shot(page, 'only-changed-ru')
}

// Свёрнутая секция раскрыта.
{
  const page = await open('theme=light')
  await page.locator('[data-section="tune"] [data-testid="forms-section-toggle"]').click()
  await shot(page, 'section-open')
}

// Ширина телефона: без горизонтального скролла.
{
  const page = await open('theme=light', { width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 0) errors.push(`@390px: horizontal overflow ${overflow}px`)
  await shot(page, 'mobile')
}

await browser.close()
await server.close()
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
