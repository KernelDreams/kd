#!/usr/bin/env node
// Снимок окна `kd --ui <документ>` — прогон не-агента в окне (kd-cli-spec §9): ход тула, шаги узлами,
// вывод ответом. Запуск: node scripts/ui-run-shot.mjs <папка для снимков>.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const out = resolve(process.argv[2] ?? 'shots')
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'kd-uirun-'))
const work = join(root, 'project')
mkdirSync(work, { recursive: true })
const step = (id, ms, text) =>
  [`## $step ${id}`, '```ts', `export default async () => { process.stderr.write('${id}: идёт\\n'); await new Promise((r) => setTimeout(r, ${ms})); return { output: '${text}' } }`, '```', ''].join('\n')
writeFileSync(
  join(work, 'report.mdz'),
  ['$title: сводка по боту', '', step('fetch', 600, 'карточка забрана: 3 гритинга'), step('lint', 600, 'замечаний 2: длинный гритинг, нет тегов'), step('summary', 400, 'сводка готова')].join('\n'),
)
const env = { ...process.env, HOME: join(root, 'home'), KD_HOME: join(root, 'home', '.kd'), KD_NO_OPEN: '1' }
delete env.RUNZ_HOME
const kd = spawn(process.execPath, [resolve('bin/kd.mjs'), '--ui', 'report.mdz'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
await page.goto(url)
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, 'kd-ui-run-live.png') })
await new Promise((r) => {
  const t = setInterval(() => {
    if (/окно открыто/.test(err)) {
      clearInterval(t)
      r()
    }
  }, 100)
})
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, 'kd-ui-run.png') })
await browser.close()
kd.kill('SIGINT')
console.log(JSON.stringify({ url, shots: [join(out, 'kd-ui-run-live.png'), join(out, 'kd-ui-run.png')] }))
process.exit(0)
