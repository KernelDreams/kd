/**
 * Живой тест против ComfyUI ( DoD): `COMFY_SERVER=<host:port> npm run test:live`.
 * Сервер не задан или не отвечает — пропуск. Маленький t2i (z-image turbo из
 * фикстуры PNG, 512², PreviewImage — в output/ не мусорит).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { connect, editableInputs, objectInfo, parsePng, setInputs, view } from '../src/index.js'
import type { ComfyEvent, Prompt } from '../src/index.js'

const SERVER = process.env.COMFY_SERVER ?? ''

async function reachable(): Promise<boolean> {
  if (!SERVER) return false
  try {
    const r = await fetch(`${SERVER.startsWith('http') ? SERVER : `http://${SERVER}`}/system_stats`, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch {
    return false
  }
}
const live = await reachable()

function smallT2i(steps: number): Prompt {
  const { prompt } = parsePng(readFileSync(new URL('./fixtures/zimage-meta.png', import.meta.url)))
  const p = setInputs(prompt!, [
    { nodeId: '7', name: 'width', value: 512 },
    { nodeId: '7', name: 'height', value: 512 },
    { nodeId: '8', name: 'steps', value: steps },
    { nodeId: '8', name: 'seed', value: Math.floor(Math.random() * 1e12) },
  ])
  p['10'] = { class_type: 'PreviewImage', inputs: { images: ['9', 0] } }
  return p
}

describe.skipIf(!live)(`ComfyUI ${SERVER}`, () => {
  it('queue t2i: executing, ≥1 progress, executed с картинкой, success', async () => {
    const conn = await connect(SERVER)
    try {
      const job = await conn.queue(smallT2i(6))
      const kinds: ComfyEvent['kind'][] = []
      let image = null
      for await (const e of job) {
        kinds.push(e.kind)
        if (e.kind === 'executed' && e.images.length) image = e.images[0]!
      }
      expect(kinds).toContain('executing')
      expect(kinds.filter((k) => k === 'progress').length).toBeGreaterThanOrEqual(1)
      expect(kinds.filter((k) => k === 'preview').length).toBeGreaterThanOrEqual(1)
      expect(kinds.at(-1)).toBe('execution_success')
      expect(image).not.toBeNull()
      const bytes = await view(SERVER, image!)
      expect(parsePng(bytes).prompt?.['8']?.class_type).toBe('KSampler')
      console.log(`previews: ${kinds.filter((k) => k === 'preview').length}, progress: ${kinds.filter((k) => k === 'progress').length}`)
    } finally {
      conn.close()
    }
  }, 600_000)

  it('interrupt посреди — execution_interrupted', async () => {
    const conn = await connect(SERVER)
    try {
      const job = await conn.queue(smallT2i(30))
      const kinds: string[] = []
      for await (const e of job) {
        kinds.push(e.kind)
        if (e.kind === 'progress' && e.value >= 2) await job.cancel()
      }
      expect(kinds.at(-1)).toBe('execution_interrupted')
      expect((await job.done).status).toBe('interrupted')
    } finally {
      conn.close()
    }
  }, 600_000)

  it('objectInfo + editableInputs по живой схеме', async () => {
    const info = await objectInfo(SERVER)
    expect(await objectInfo(SERVER)).toBe(info)
    const inputs = editableInputs(smallT2i(4), info)
    expect(inputs.find((i) => i.nodeId === '5' && i.name === 'text')).toMatchObject({ type: 'STRING', multiline: true })
    expect(inputs.find((i) => i.nodeId === '8' && i.name === 'seed')).toMatchObject({ type: 'INT', seed: true })
  }, 120_000)
})
