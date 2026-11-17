/**
 * `kd chat [сессия.mds] [реплика]` (kd-cli-spec §4: `.mds` — сессия) — ход в сессии: реплика уходит
 * агенту kd в той же сессии; без реплики — лента сессии текстом; `--ui` — окно с этой сессией.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from '@kerneldreams/nrd/chat'
import { hostOf } from '../node/host.js'

export const tool = {
  description: 'сессия .mds: показать ленту или сделать ход',
  fields: {
    session: 'string? $pos=1 $kind=session // Сессия (.mds)',
    text: 'text? $rest // Реплика',
    ui: 'checkbox // Окно с этой сессией',
    provider: 'string? // Провайдер',
    model: 'string? $kind=model // Модель',
  },
  examples: ['kd chat разговор.mds', 'kd разговор.mds "продолжим"'],
}

type Ctx = { get(p: string[]): unknown }
const s = (ctx: Ctx, k: string): string => {
  const v = ctx.get([k])
  return typeof v === 'string' ? v : ''
}

export default async function chat(ctx: Ctx, meta: { dataDir?: string }): Promise<{ output: string; exitCode?: number }> {
  const file = s(ctx, 'session')
  const text = s(ctx, 'text')
  if (!file) return { output: 'kd chat: нужна сессия .mds\nkd chat <сессия.mds> ["реплика"]', exitCode: 2 }
  const abs = resolve(hostOf()?.io.cwd ?? process.cwd(), file)
  if (!text && ctx.get(['ui']) !== true) {
    const msgs = parse(readFileSync(abs, 'utf8')).filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'char')
    return { output: msgs.map((m) => `${m.role === 'user' ? '›' : '‹'} ${m.body.trim()}`).join('\n\n') || '(пустая сессия)' }
  }
  const { default: agent } = await import('./agent.mjs')
  const wrap = { get: (p: string[]) => (p[0] === 'session' ? abs : p[0] === 'task' ? text : p[0] === 'check' ? undefined : ctx.get(p)) }
  return agent(wrap as never, meta)
}
