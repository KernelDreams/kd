import { describe, expect, it } from 'vitest'
import { busyRetry, InterruptedError, isBusy, parseWait } from '../src/busy.ts'

const busy = (): Error => Object.assign(new Error('HTTP 429'), { status: 429 })

describe('busyRetry: «занято» — ждать и повторять (kd-cli-spec §7)', () => {
  it('429 до первого куска — пауза и повтор, не падение', async () => {
    let calls = 0
    const waits: number[] = []
    const s = busyRetry(
      async function* () {
        calls++
        if (calls < 3) throw busy()
        yield { type: 'text', text: 'ok' }
      },
      { sleep: async (ms) => void waits.push(ms), firstPauseMs: 10 },
    )
    const out: unknown[] = []
    for await (const c of s({})) out.push(c)
    expect(out).toEqual([{ type: 'text', text: 'ok' }])
    expect(waits).toEqual([10, 20])
  })
  it('дольше потолка — InterruptedError с кодом 4', async () => {
    const s = busyRetry(
      async function* () {
        throw busy()
      },
      { sleep: async () => {}, firstPauseMs: 100, waitMaxMs: 250 },
    )
    const run = async (): Promise<void> => {
      for await (const _ of s({})) void _
    }
    await expect(run()).rejects.toBeInstanceOf(InterruptedError)
    await expect(run()).rejects.toMatchObject({ exitCode: 4 })
  })
  it('начатый ответ не переигрывается; не «занято» — падает сразу', async () => {
    const s = busyRetry(async function* () {
      yield { type: 'text', text: 'a' }
      throw busy()
    })
    const out: unknown[] = []
    await expect(
      (async () => {
        for await (const c of s({})) out.push(c)
      })(),
    ).rejects.toThrow('429')
    expect(out).toHaveLength(1)
    expect(isBusy(new Error('boom'))).toBe(false)
    expect(isBusy({ code: 'rate_limit' })).toBe(true)
  })
  it('parseWait', () => {
    expect(parseWait('15m')).toBe(900_000)
    expect(parseWait('90')).toBe(90_000)
    expect(parseWait('x')).toBeUndefined()
  })
})
