// Тело `kd ui` отдельным модулем: каталог читает объявление `ui.mts` без загрузки агента.
import { hostOf } from '../node/host.js'

export default async function ui(ctx: { get(p: string[]): unknown }, meta: { dataDir?: string }): Promise<{ output: string; exitCode?: number }> {
  const { default: agent } = await import('./agent.mjs')
  const wrap = { get: (p: string[]) => (p[0] === 'ui' ? true : p[0] === 'continue' || p[0] === 'resume' ? false : ctx.get(p)) }
  const h = hostOf()
  if (h) h.io.interactive = true
  return agent(wrap as never, meta)
}
