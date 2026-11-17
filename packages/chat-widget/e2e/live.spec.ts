/**
 * Приёмка вживую: `<nr-chat>` против стендов (nr 7800, ACP 7811) со
 * статики на 7820 — страница на другом origin, чем бэкенд.
 *
 *  (d) транспорт nr — стрим, апрув записи (файл — в каталоге сессии, `cwd`),
 *      ask_user с вариантами;
 *  (e) транспорт acp — стрим, permission (запись в каталоге сессии ACP);
 *  (f) demo/artifact.html — модель зовёт тул страницы `get_state`, ответ
 *      уходит модели и виден в ответе;
 *  (g) временный стенд с `$auth_key`: с ключом работает (nr и acp), без — 401.
 *
 * Модель — дефолт стенда (`glm-5.3-flash`). Сессии — новые, `qa-` в cwd.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ACP_BACKEND, NR_BACKEND } from '../playwright.config'

const RUNZ = process.env.NR_CHAT_RUNZ ?? join(homedir(), 'Studio', 'Projects', 'runz', 'bin', 'runz.ts')
const ENV_DIR = process.env.NR_CHAT_ENV_DIR ?? join(homedir(), 'Studio', 'envs')
const MODEL = process.env.NR_CHAT_MODEL ?? 'glm-5.3-flash'

/** Отправить реплику в виджет и дождаться конца рана. */
async function say(page: Page, chat: string, text: string): Promise<void> {
  const box = page.locator(`#${chat} textarea`).last()
  await expect(page.locator(`#${chat} .status-line`)).toBeEmpty()
  await box.fill(text)
  await box.press('Enter')
}

async function runEnded(page: Page, chat: string, n: number): Promise<void> {
  await expect.poll(() => page.evaluate(([id]) => (window as any).__runEnds?.[id!] ?? 0, [chat]), { timeout: 180_000 }).toBeGreaterThanOrEqual(n)
}

/** Счётчик run-end на элементе (ставится до первого хода). */
async function trackRuns(page: Page, chat: string): Promise<void> {
  await page.waitForFunction((id) => !!document.getElementById(id), chat)
  await page.evaluate((id) => {
    const w = window as any
    w.__runEnds ??= {}
    w.__runEnds[id] = 0
    w.__toolCalls ??= {}
    w.__toolCalls[id] = []
    const el = document.getElementById(id)!
    el.addEventListener('run-end', () => (w.__runEnds[id] += 1))
    el.addEventListener('tool-call', (e: Event) => w.__toolCalls[id].push((e as CustomEvent).detail))
  }, chat)
}

const lastAssistant = (page: Page, chat: string) => page.locator(`#${chat} .msg.assistant`).last()

/**
 * Уборка: сессии, созданные виджетом на стендах (nr и ACP — один стор стенда
 * nr), удаляются после теста. Временный стенд (g) уходит вместе с каталогом.
 */
const created: string[] = []
test.beforeEach(async ({ page }) => {
  await page.exposeFunction('__qaSession', (id: string) => void created.push(id))
  await page.addInitScript(() => document.addEventListener('session', (e) => (window as any).__qaSession((e as CustomEvent).detail.id)))
})
test.afterEach(async () => {
  for (const id of created.splice(0)) await fetch(`${NR_BACKEND}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
})

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port
      srv.close(() => resolve(p))
    })
  })
}

test('(d) nr: стрим, апрув записи в каталоге сессии, ask_user с вариантами', async ({ page }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'qa-widget-nr-'))
  try {
    await page.goto(`/demo/index.html?tab=nr&nr=${encodeURIComponent(NR_BACKEND)}&cwd=${encodeURIComponent(cwd)}`)
    await trackRuns(page, 'chat-nr')

    // стрим: ответ растёт, курсор живого ответа, потом текст
    await say(page, 'chat-nr', 'Ответь ровно одним словом: привет')
    await expect(page.locator('#chat-nr .msg.assistant.live')).toHaveCount(1)
    await runEnded(page, 'chat-nr', 1)
    await expect(lastAssistant(page, 'chat-nr')).toContainText(/привет/i)

    // апрув записи: карточка → «Разрешить» → файл в cwd сессии
    await say(page, 'chat-nr', 'Создай тулом write файл qa-widget.txt с текстом ok-widget. Без вопросов.')
    const approve = page.locator('#chat-nr [data-ask="tool_approval"] button.allow').first()
    await expect(approve).toBeVisible()
    await expect(page.locator('#chat-nr [data-ask="tool_approval"] .q').first()).toContainText(/qa-widget\.txt/)
    await approve.click()
    await runEnded(page, 'chat-nr', 2)
    expect(existsSync(join(cwd, 'qa-widget.txt'))).toBe(true)
    expect(readFileSync(join(cwd, 'qa-widget.txt'), 'utf-8')).toContain('ok-widget')
    await expect(page.locator('#chat-nr details.tool[data-status="done"]').first()).toBeAttached()

    // ask_user: карточка выбора → кнопка → ответ модели знает выбор
    await say(page, 'chat-nr', 'Спроси меня тулом ask_user, какой цвет выбрать, с вариантами "красный" и "синий". Потом назови мой выбор одним словом.')
    const option = page.locator('#chat-nr [data-ask="select"] button[data-value="синий"]')
    await expect(option).toBeVisible()
    await option.click()
    await runEnded(page, 'chat-nr', 3)
    await expect(lastAssistant(page, 'chat-nr')).toContainText(/синий/i)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('(e) acp: стрим и permission (запись в каталоге сессии ACP)', async ({ page }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'qa-widget-acp-'))
  try {
    await page.goto(`/demo/index.html?tab=acp&acp=${encodeURIComponent(ACP_BACKEND)}&cwd=${encodeURIComponent(cwd)}`)
    await trackRuns(page, 'chat-acp')
    await say(page, 'chat-acp', 'Ответь ровно одним словом: пока')
    await runEnded(page, 'chat-acp', 1)
    await expect(lastAssistant(page, 'chat-acp')).toContainText(/пока/i)

    await say(page, 'chat-acp', 'Создай тулом write файл qa-acp.txt с текстом ok-acp. Без вопросов.')
    const perm = page.locator('#chat-acp [data-ask="acp_permission"]').first()
    await expect(perm).toBeVisible()
    await expect(perm.locator('button')).toHaveCount(3)
    await perm.locator('button.allow').click()
    await runEnded(page, 'chat-acp', 2)
    expect(readFileSync(join(cwd, 'qa-acp.txt'), 'utf-8')).toContain('ok-acp')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('(f) артефакт: модель зовёт тул страницы get_state, ответ — из состояния страницы', async ({ page }) => {
  await page.goto(`/demo/artifact.html?cones=7&backend=${encodeURIComponent(NR_BACKEND)}`)
  await trackRuns(page, 'chat-artifact')
  await say(page, 'chat-artifact', 'Сколько шишек сейчас в открытой сцене? Узнай тулом get_state и ответь числом.')
  await runEnded(page, 'chat-artifact', 1)
  const calls = await page.evaluate(() => (window as any).__toolCalls['chat-artifact'])
  expect(calls).toContainEqual(expect.objectContaining({ name: 'get_state', page: true }))
  await expect(page.locator('#chat-artifact details.tool .badge').first()).toHaveText('тул страницы')
  await expect(page.locator('#chat-artifact details.tool[data-status="done"]').first()).toBeAttached()
  await expect(lastAssistant(page, 'chat-artifact')).toContainText('7')
})

test('(g) другой origin + $auth_key: с ключом работает (nr и acp), без — 401', async ({ page }) => {
  test.setTimeout(300_000)
  const env = mkdtempSync(join(tmpdir(), 'qa-widget-auth-'))
  const [port, acpPort] = [await freePort(), await freePort()]
  const KEY = `qa-key-${Date.now()}`
  writeFileSync(join(env, 'nr.mdz'), `$base_path: /api\n$type: nr\n$model: nr/${MODEL}\n$port: ${port}\n$acp: true\n$acp_port: ${acpPort}\n$auth_key: ${KEY}\n`)
  symlinkSync(join(ENV_DIR, 'models.json'), join(env, 'models.json'))
  let out = ''
  const child: ChildProcess = spawn(process.execPath, [RUNZ, join(env, 'nr.mdz'), '--serve'], { cwd: env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', (d) => (out += String(d)))
  child.stderr!.on('data', (d) => (out += String(d)))
  try {
    const deadline = Date.now() + 90_000
    while (!out.includes('Ctrl-C') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300))
    expect(out, out).toContain('Ctrl-C')
    const nr = `http://127.0.0.1:${port}/api`
    const acp = `ws://127.0.0.1:${acpPort}/acp`
    // без ключа — 401 и на HTTP, и в виджете
    expect((await fetch(`${nr}/capabilities`)).status).toBe(401)
    await page.goto(`/demo/index.html?tab=nr&nr=${encodeURIComponent(nr)}&profile=`)
    await expect(page.locator('#chat-nr .status-line')).toContainText(/unauthorized|401/i)
    // с ключом — ран nr
    await page.goto(`/demo/index.html?tab=nr&nr=${encodeURIComponent(nr)}&profile=&auth=${KEY}`)
    await trackRuns(page, 'chat-nr')
    await say(page, 'chat-nr', 'Ответь ровно одним словом: ключ')
    await runEnded(page, 'chat-nr', 1)
    await expect(lastAssistant(page, 'chat-nr')).toContainText(/ключ/i)
    // с ключом — ран acp; без ключа — подключение отвергнуто
    await page.goto(`/demo/index.html?tab=acp&acp=${encodeURIComponent(acp)}&profile=&auth=${KEY}`)
    await trackRuns(page, 'chat-acp')
    await say(page, 'chat-acp', 'Ответь ровно одним словом: замок')
    await runEnded(page, 'chat-acp', 1)
    await expect(lastAssistant(page, 'chat-acp')).toContainText(/замок/i)
    await page.goto(`/demo/index.html?tab=acp&acp=${encodeURIComponent(acp)}&profile=`)
    await expect(page.locator('#chat-acp .status-line')).toContainText(/Не удалось подключиться/)
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 1500))
    rmSync(env, { recursive: true, force: true })
  }
})

test('(h) onContext: снимок страницы в мете pageContext → инъекция page.context в рецепте ответа', async ({ page }) => {
  await page.goto(`/demo/artifact.html?cones=4&backend=${encodeURIComponent(NR_BACKEND)}`)
  await trackRuns(page, 'chat-artifact')
  await page.locator('#ctx').check()
  await say(page, 'chat-artifact', 'Сколько деревьев в сцене? Ответь только числом.')
  await runEnded(page, 'chat-artifact', 1)
  const sid = await page.evaluate(() => (document.getElementById('chat-artifact') as any).sessionId as string)
  const meta = (await (await fetch(`${NR_BACKEND}/sessions/${encodeURIComponent(sid)}/meta`)).json()).result
  expect(meta.pageContext).toMatchObject({ scene: 'Лес', cones: 4, trees: ['ель', 'сосна'] })
  const hist = (await (await fetch(`${NR_BACKEND}/sessions/${encodeURIComponent(sid)}/history`)).json()).result.messages
  const answer = hist.filter((m: { role: string }) => m.role === 'assistant').at(-1)
  const view = (await (await fetch(`${NR_BACKEND}/sessions/${encodeURIComponent(sid)}/messages/${encodeURIComponent(answer.id)}/prompt`)).json()).result
  expect(JSON.stringify(view)).toContain('page.context')
  await expect(lastAssistant(page, 'chat-artifact')).toContainText('2')
})
