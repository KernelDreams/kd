// Тело `kd acp`: агент kd → ACP-агент на stdio (слот расширения `acp`).
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { requireExtension } from '@kerneldreams/runz-runtime'
import { hostOf } from '../node/host.js'
import { makeAgent, sessionsDir } from './agent.mjs'

export default async function acp(ctx: { get(p: string[]): unknown }): Promise<{ output: string }> {
  const host = hostOf()
  const raw = ctx.get(['cwd'])
  const cwd = resolve(typeof raw === 'string' && raw ? raw : host?.io.cwd ?? process.cwd())
  const dir = sessionsDir(host?.layers.copy.dataDir ?? process.cwd(), cwd)
  mkdirSync(dir, { recursive: true })
  const log = (m: string): void => void process.stderr.write(`${m}\n`)
  // Вопросы — ящиком (окна, уведомление): терминала у ACP нет — stdin занят протоколом.
  type AcpExt = { createAcpAgent(backend: ProtocolBackend, o: unknown): unknown; serveAcpStdio(app: unknown): void }
  const { createAcpAgent, serveAcpStdio } = await requireExtension<AcpExt>('acp', 'kd acp', { ctx: ctx as never, cwd })
  const { a } = await makeAgent(ctx as never, cwd, dir, log, { terminal: false })
  const app = createAcpAgent((a as unknown as { backend: ProtocolBackend }).backend, { name: 'kd', cwd } as never)
  log(`kd acp: агент на stdio, папка ${cwd}`)
  const closed = new Promise<void>((r) => process.stdin.once('end', () => r()))
  serveAcpStdio(app as never)
  await closed
  await a.close()
  return { output: '' }
}
