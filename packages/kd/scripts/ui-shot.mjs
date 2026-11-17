#!/usr/bin/env node
// Снимок окна `kd agent --ui` для приёмки (kd-cli-spec §9): мок-провайдер, вопрос агента в ящике,
// реплика в ленте. Запуск: node scripts/ui-shot.mjs <папка для снимков>.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { answerQuestion, ask } from '../dist/node/inbox.js'

const out = resolve(process.argv[2] ?? 'shots')
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'kd-ui-'))
const home = join(root, 'kd')
const work = join(root, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(home, 'providers.mdz'), '$default_provider: mock\n$mock_reply: Готово: прочитал README и поправил опечатку в заголовке.\n\n## $provider mock\n$type: mock\n')
const env = { ...process.env, HOME: join(root, 'home'), KD_HOME: home, KD_NO_OPEN: '1' }
delete env.RUNZ_HOME
const kd = spawn(process.execPath, [resolve('bin/kd.mjs'), 'agent', '--ui', 'поправь опечатку в README'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
let err = ''
const url = await new Promise((done, fail) => {
  const t = setTimeout(() => fail(new Error('нет адреса окна:\n' + err)), 60_000)
  kd.stderr.on('data', (b) => {
    err += b
    const m = /окно (http:\/\/127\.0\.0\.1:\d+\/)/.exec(err)
    if (m) {
      clearTimeout(t)
      done(m[1])
    }
  })
})
const browser = await chromium.launch()
const pageW = await browser.newPage({ viewport: { width: 900, height: 640 } })
await pageW.goto(url)
await pageW.waitForTimeout(2500)
// Вопрос от другого прогона — окно показывает его формой (ящик вопросов).
const q = ask(home, { question: 'Какую ветку взять для правки?', options: ['master', 'dev'], default: 'master', from: 'kd agent project', timeoutMs: 60_000 })
await pageW.waitForTimeout(2000)
await pageW.screenshot({ path: join(out, 'kd-ui.png') })
await pageW.getByRole('button', { name: 'dev' }).click()
const a = await q
await pageW.waitForTimeout(500)
await pageW.screenshot({ path: join(out, 'kd-ui-answered.png') })
await browser.close()
kd.kill('SIGINT')
console.log(JSON.stringify({ url, answer: a, shots: [join(out, 'kd-ui.png'), join(out, 'kd-ui-answered.png')] }))
void answerQuestion
process.exit(0)
