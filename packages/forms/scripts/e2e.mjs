// e2e <ObjectEditor> на тестовой странице пакета (demo/editor.html): universal-editor-spec §11, шаги 1–6,
// + виджет-iframe (мост v2, канал widget) и поиск инспектора. Снимки «стало» — docs/screens/editor-*.png.
//   npm run e2e                 (E2E_PORT_BASE — порт стенда, по умолчанию 24900; CHROMIUM_PATH — свой браузер)
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')
const shots = resolve(root, 'docs/screens')
mkdirSync(shots, { recursive: true })
const port = Number(process.env.E2E_PORT_BASE ?? 24900)
const server = await createServer({ configFile: resolve(root, 'demo/vite.config.ts'), server: { port, host: '127.0.0.1', strictPort: true }, logLevel: 'error' })
await server.listen()
const base = `http://127.0.0.1:${port}/editor.html`

async function launch() {
  if (process.env.CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  try {
    return await chromium.launch()
  } catch {
    return chromium.launch({ channel: 'chrome' })
  }
}
const browser = await launch()
const pageErrors = []
const results = []

/** Выбор контролом пакета (без системного `<select>`): якорь → пункт списка по значению или подписи. */
async function pick(anchor, choice) {
  await anchor.click()
  const opts = anchor.locator('xpath=..').locator('[role="option"]')
  const opt = typeof choice === 'string' ? opts.and(anchor.page().locator(`[data-value="${choice}"]`)) : opts.filter({ hasText: new RegExp(`^${choice.label}$`) })
  await opt.click()
}

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', (e) => pageErrors.push(`${query}: ${e.message}`))
  await page.goto(`${base}?${query}`)
  await page.waitForSelector('[data-testid="oe-sheet"],[data-testid="oe-inspector"]')
  return page
}
const obj = (page) => page.evaluate(() => window.__doc.object)
const field = (scope, path) => scope.locator(`[data-testid="oe-field"][data-path="${path}"]`)

async function step(name, fn) {
  try {
    await fn()
    results.push(`ok   ${name}`)
  } catch (e) {
    results.push(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').slice(0, 6).join('\n     ')}`)
  }
}

// 1. Лист Ярославы: 5 секций по порядку, 19 навыков лестницей, трек 4 ячейки, портрет.
await step('1 лист: секции, навыки, трек, портрет', async () => {
  const page = await open('view=sheet')
  const sheet = page.getByTestId('oe-sheet')
  assert.deepEqual(await sheet.locator('[data-testid="oe-section"]').evaluateAll((els) => els.map((e) => e.dataset.section)), ['character', 'aspects', 'skills', 'stunts', 'stress'])
  assert.equal(await sheet.getByTestId('fate-ladder').count(), 19)
  assert.equal(await field(sheet, 'skills.physique').getByTestId('fate-ladder').getAttribute('data-value'), '2')
  assert.equal(await field(sheet, 'stress.physical').getByTestId('fate-stress-box').count(), 4)
  assert.ok(await sheet.getByTestId('oe-image-preview').isVisible())
  await page.screenshot({ path: resolve(shots, 'editor-sheet.png'), fullPage: true })
  await page.close()
})

// 2. Physique 3 → трек 5 без перезагрузки; undo → 4.
await step('2 вычисление: Physique 3 → 5 ячеек, undo → 4', async () => {
  const page = await open('view=sheet')
  const sheet = page.getByTestId('oe-sheet')
  await pick(field(sheet, 'skills.physique').getByTestId('fate-ladder'), '3')
  await page.waitForFunction(() => document.querySelectorAll('[data-path="stress.physical"] [data-testid="fate-stress-box"]').length === 5)
  assert.equal(await page.locator('[data-testid="oe-computed"][data-id="physicalBoxes"] [data-testid="oe-computed-value"]').textContent(), '5')
  await page.getByTestId('demo-undo').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-path="stress.physical"] [data-testid="fate-stress-box"]').length === 4)
  assert.equal((await obj(page)).skills.physique, 2)
  await page.close()
})

// 3. Добавить аспект, перетащить → _id не изменились (видно «как текст»), undo одной записью.
await step('3 повторитель: добавить, перетащить, _id целы, undo', async () => {
  const page = await open('view=sheet')
  const rep = page.locator('[data-testid="oe-repeat"][data-path="aspects"]')
  await rep.getByTestId('oe-repeat-add').click()
  const ids0 = (await obj(page)).aspects.map((a) => a._id)
  assert.equal(ids0.length, 3)
  const added = ids0[2]
  const input = field(rep, `aspects[${added}].text`).getByTestId('oe-input')
  await input.fill('Ведьмин знак')
  await input.press('Enter')
  const history = Number(await page.getByTestId('demo-history').textContent())
  // Перетащить новую строку на первую.
  await rep.locator(`[data-testid="oe-row"][data-id="${added}"] [data-testid="oe-row-handle"]`).dragTo(rep.locator(`[data-testid="oe-row"][data-id="${ids0[0]}"]`))
  await page.waitForFunction((id) => window.__doc.object.aspects[0]._id === id, added)
  const after = (await obj(page)).aspects
  assert.deepEqual(after.map((a) => a._id), [added, ids0[0], ids0[1]])
  assert.deepEqual(new Set(after.map((a) => a._id)), new Set(ids0))
  assert.equal(after[0].text, 'Ведьмин знак')
  await page.getByTestId('demo-as-text').click()
  const text = await page.getByTestId('demo-text').textContent()
  for (const id of ids0) assert.ok(text.includes(`"_id": "${id}"`), `«как текст» без ${id}`)
  assert.ok(text.indexOf(added) < text.indexOf(ids0[0]))
  assert.equal(Number(await page.getByTestId('demo-history').textContent()), history + 1)
  await page.getByTestId('demo-undo').click()
  assert.deepEqual((await obj(page)).aspects.map((a) => a._id), ids0)
  await page.close()
})

// 4. CCv3: kind = persona → «Диалог» скрыт; bot → есть, гритинги на месте.
await step('4 show-if: персона без «Диалога», бот — с гритингами', async () => {
  const page = await open('def=ccv3&view=sheet')
  const sheet = page.getByTestId('oe-sheet')
  const dialogue = sheet.locator('[data-testid="oe-section"][data-section="dialogue"]')
  assert.equal(await dialogue.count(), 1)
  const kind = field(sheet, 'data.extensions.nrchat.kind').getByTestId('oe-input')
  await pick(kind, { label: 'Персона' })
  await dialogue.waitFor({ state: 'detached' })
  assert.equal((await obj(page)).data.extensions.nrchat.kind, 'persona')
  await pick(kind, { label: 'Бот' })
  await dialogue.waitFor()
  const greetings = await field(sheet, 'data.alternate_greetings').getByTestId('oe-list-item').evaluateAll((els) => els.map((e) => e.value))
  assert.deepEqual(greetings, ['Опять ты.', 'Дверь не заперта.'])
  // json-виджет расширений не показывает поле kind, описанное отдельно, и не теряет его при правке.
  const ext = field(sheet, 'data.extensions').getByTestId('oe-input')
  assert.ok(!(await ext.inputValue()).includes('nrchat'))
  await ext.fill('{"depth_prompt": {"depth": 2, "prompt": "x"}}')
  await ext.blur()
  assert.deepEqual((await obj(page)).data.extensions, { depth_prompt: { depth: 2, prompt: 'x' }, nrchat: { kind: 'bot' } })
  await page.close()
})

// 5. Описание с ошибкой (виджет не по типу) → вкладка открыта, строка ошибки с путём узла, остальное живо.
await step('5 описание с ошибкой: строка с путём узла, поля живы', async () => {
  const page = await open('def=broken&view=sheet')
  const issue = page.getByTestId('oe-issue').first()
  assert.match(await issue.textContent(), /section character \/ field refresh: виджет fate\.stress-track ждёт boolean\[\], а тип integer/)
  const name = field(page, 'name').getByTestId('oe-input')
  await name.fill('Яра')
  await name.press('Enter')
  assert.equal((await obj(page)).name, 'Яра')
  const refresh = field(page, 'refresh')
  assert.equal(await refresh.getAttribute('data-widget'), 'number')
  await page.screenshot({ path: resolve(shots, 'editor-broken.png') })
  await page.close()
})

// 6. Скин «пергамент»: лист в токенах --nr-sheet-*, инспектор — в теме оболочки.
await step('6 скин листа: лист пергамент, инспектор в теме оболочки', async () => {
  const page = await open('view=both&sheet=parchment')
  const bg = (sel) => page.locator(sel).evaluate((e) => getComputedStyle(e).backgroundColor)
  assert.equal(await bg('[data-testid="oe-sheet"]'), 'rgb(243, 230, 200)')
  // Инспектор без своей заливки: лежит на фоне хозяина, текст — цветом оболочки.
  assert.equal(await bg('[data-testid="oe-inspector"]'), 'rgba(0, 0, 0, 0)')
  assert.equal(await page.locator('[data-testid="oe-inspector"]').evaluate((e) => getComputedStyle(e).color), 'rgb(27, 28, 32)')
  const font = await page.locator('[data-testid="oe-sheet"]').evaluate((e) => getComputedStyle(e).fontFamily)
  assert.match(font, /Georgia/)
  assert.equal(await page.locator('[data-testid="oe-sheet"] [data-testid="oe-section-title"]').first().evaluate((e) => getComputedStyle(e).color), 'rgb(122, 62, 18)')
  // Одна правка видна в обоих видах.
  await pick(field(page.getByTestId('oe-sheet'), 'skills.physique').getByTestId('fate-ladder'), '3')
  await page.getByTestId('oe-inspector').locator('[data-section="stress"] [data-testid="oe-section-toggle"]').click()
  assert.equal(await page.getByTestId('oe-inspector').locator('[data-path="stress.physical"] [data-testid="fate-stress-box"]').count(), 5)
  await page.getByTestId('demo-undo').click()
  await page.screenshot({ path: resolve(shots, 'editor-both-parchment.png'), fullPage: true })
  await page.close()
})

// Инспектор: секции свёрнуты со сводкой, поиск ≥ 15 полей.
await step('инспектор: сводка свёрнутых, поиск по полям', async () => {
  const page = await open('view=inspector')
  const insp = page.getByTestId('oe-inspector')
  const skills = insp.locator('[data-testid="oe-section"][data-section="skills"]')
  assert.equal(await skills.getAttribute('data-collapsed'), 'true')
  assert.match(await skills.getByTestId('oe-section-summary').textContent(), /Athletics 2/)
  await page.screenshot({ path: resolve(shots, 'editor-inspector.png'), fullPage: true })
  await insp.getByTestId('oe-search').fill('physique')
  assert.equal(await insp.getByTestId('oe-field').count(), 1)
  assert.equal(await field(insp, 'skills.physique').count(), 1)
  await insp.getByTestId('oe-search').fill('нет-такого')
  assert.equal(await insp.getByTestId('oe-no-matches').count(), 1)
  await page.close()
})

// Виджет-артефакт: трек рисует iframe (мост v2, канал widget), клик → значение в объекте, undo.
await step('виджет-iframe: клик в кадре → объект, undo → кадр', async () => {
  const page = await open('view=sheet&frame=1')
  const holder = field(page, 'stress.physical')
  assert.equal(await holder.getAttribute('data-widget'), 'fate.stress-track-alt')
  const frame = page.frameLocator('[data-testid="oe-frame"]')
  await frame.locator('b').nth(3).waitFor()
  assert.equal(await frame.locator('b').count(), 4)
  await frame.locator('b').nth(1).click()
  await page.waitForFunction(() => window.__doc.object.stress.physical[1] === true)
  await frame.locator('b.on').first().waitFor()
  await pick(field(page, 'skills.physique').getByTestId('fate-ladder'), '3')
  await frame.locator('b').nth(4).waitFor()
  await page.getByTestId('demo-undo').click()
  await page.getByTestId('demo-undo').click()
  await page.waitForFunction(() => window.__doc.object.stress.physical[1] === false)
  // Кадр перерисуется асинхронно (postMessage) — ждать его, а не проверять мгновенно.
  await frame.locator('b.on').first().waitFor({ state: 'detached' })
  assert.equal(await frame.locator('b').count(), 4)
  await page.close()
})

await browser.close()
await server.close()
console.log(results.join('\n'))
if (pageErrors.length) console.error('page errors:\n' + pageErrors.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed || pageErrors.length ? 1 : 0)
