// Живой смоук контекстного движка об llama-server (§13.2).
//
// Пропускается, пока не задан CTX_LIVE_URL — обычный прогон остаётся герметичным.
//
//   CTX_LIVE_URL=http://<llm-host>:8081/v1 npx vitest run test/live-context.test.ts
//
// Проверяет ровно то, что руками: entry лорбука, поднятый по ключевому слову из
// `$lorebooks` сессии, реально доезжает до модели — ответ содержит факт, который
// существует ТОЛЬКО в лорбуке.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { objectContext } from '@kerneldreams/nrd'
import { run } from '../src/run.js'
import { memSession } from './helpers.js'

const baseUrl = process.env['CTX_LIVE_URL']
const model = process.env['CTX_LIVE_MODEL'] ?? 'local'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nr-live-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!baseUrl)('live llama-server — лорбук end-to-end', () => {
  it('факт из лорбука доезжает до модели', async () => {
    mkdirSync(join(dir, 'lorebooks'))
    writeFileSync(
      join(dir, 'lorebooks', 'fantasy.mdd'),
      `## @entry elves
@keys: @[эльфы]
@priority: 50
@tags: @[lore]

Эльфы этого мира живут в хрустальных башнях Аэлиона.

## @entry rules
@constant: true
@priority: 900
@tags: @[post]

Отвечай коротко, одним предложением.
`,
    )

    const { store, sid } = await memSession()
    await store.appendNode(sid, { role: 'system', text: 'Ты рассказчик фэнтези-мира.' })
    await store.appendNode(sid, { role: 'user', text: 'Где живут эльфы?' })

    const res = await run(
      {
        assembly: 'direct',
        orchestrator: 'simple',
        handler: 'chat',
        providerType: 'openai',
        model,
        baseUrl,
        apiKey: process.env['CTX_LIVE_KEY'] ?? 'sk-test',
        maxTokens: 256,
        temperature: 0.1,
      },
      { target: { store, sessionId: sid }, context: objectContext({ __basedir: dir, lorebooks: 'fantasy' }) },
    )

    // «Аэлион» существует только в лорбуке — модель не могла его выдумать.
    expect(res.output.toLowerCase()).toContain('аэлион')
  }, 120_000)
})
