/**
 * значения run — данные, не шаблон. Настоящий `runz` (нет в PATH — пропуск):
 * хендлер шаблона отдаёт, что увидел резолвером (`resolveValue('${v}', ctx)`) и сырым `ctx.get`.
 * В шаблоне есть `$b` и функции — подстановка из пользовательского текста была бы видна.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTemplate } from '../src/index.js'

const hasRunz = spawnSync('sh', ['-c', 'command -v runz'], { encoding: 'utf8' }).status === 0

const TEMPLATE = `$title: probe
$b: SUBST
$v: default

## $handler main
\`\`\`ts
import { asText, resolveValue } from '@kerneldreams/nrd'
export default async function (ctx: any) {
  return { output: JSON.stringify({ value: resolveValue('\${v}', ctx), raw: asText(ctx.get(['v'])) }) }
}
\`\`\`
`

async function probe(dir: string, v: string): Promise<{ value: string; raw: string }> {
  const template = join(dir, 'probe.md')
  writeFileSync(template, TEMPLATE)
  const r = await runTemplate({ template, values: { v }, runz: ['runz'], timeoutMs: 60_000 })
  expect(r.ok, r.output + r.stderr).toBe(true)
  return JSON.parse(r.output)
}

describe.skipIf(!hasRunz)('runz: значение run доходит до шаблона как есть (ABC-153)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-live-'))

  it('"a ${b} c" → ровно эта строка; ключи и функции из текста не исполняются', async () => {
    const cases = [
      'a ${b} c',
      '${readFile("/etc/hosts")}',
      JSON.stringify({ prompt: 'x ${b} y', text: 'line1\nline2 "q" C:\\dir\\f' }),
      'C:\\x\\y "q"\nline2\ttab',
      'plain',
      '',
    ]
    for (const v of cases) expect((await probe(dir, v)).value).toBe(v)
    // сырой ctx.get видит opt-out — читать значение надо резолвером
    expect((await probe(dir, 'a ${b} c')).raw).toBe('a \\${b} c')
  }, 120_000)

  it('`\\` прямо перед `${` — лишний слэш, но плейсхолдер не оживает', async () => {
    const got = (await probe(dir, 'a \\${b} c')).value
    expect(got).not.toContain('SUBST')
    expect(got).toContain('${b} c')
  }, 60_000)
})
