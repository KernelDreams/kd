// exec / script source — ДЕЛЕГИРУЮТ исполнение в nrd-exec.execBlock (§4.4, реш. C).
// Сами код не исполняют: собирают виртуальный shell/ts/zx блок и зовут execBlock,
// передавая `executor` из SourceContext и `external: chain`.

import type { Block, Attribute } from '../../md/index.js'
import type { Value, IContext } from '../../contracts/index.js'
import { execBlock } from '../../exec/index.js'
import type { SourcePlugin, SourceContext } from '../types.js'
import { asString, requireCap, readResource, bodyOf, nameOf } from './util.js'

/** Собрать виртуальный exec-блок и прогнать через execBlock. */
async function runVirtualBlock(
  engine: 'shell' | 'ts' | 'zx',
  code: string,
  attrs: Record<string, Value>,
  ctx: SourceContext,
  source: string,
): Promise<IContext> {
  const executor = requireCap(ctx, 'executor', source)

  // Прокидываем только атрибуты, понятные execBlock (§ service attrs).
  const blockAttrs: Attribute[] = []
  const forward = ['nr-parse', 'cwd', 'timeout', 'nr-raw'] as const
  for (const key of forward) {
    const v = attrs[key]
    if (v !== undefined) blockAttrs.push({ key: [key], value: v as never })
  }

  const block: Block = {
    name: engine,
    level: 2,
    attrs: blockAttrs,
    body: code,
    children: [],
  }

  const r = await execBlock(block, {
    executor,
    external: ctx.chain,
    baseDir: ctx.baseDir,
  })
  if (!r.ok) throw r.error
  return r.value
}

export const execSource: SourcePlugin = {
  name: 'exec',
  async resolve(attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext> {
    const name = nameOf(attrs, 'exec')
    const cmd = asString(attrs['cmd']) ?? bodyOf(attrs)
    if (!cmd) throw new Error(`nrd-context: source "${name}" (exec) требует $cmd или тело блока`)
    return runVirtualBlock('shell', cmd, attrs, ctx, name)
  },
}

/** `$engine: node|zx` → движок ts|zx. Дефолт — ts (node нативно стрипит типы). */
function scriptEngine(attrs: Record<string, Value>): 'ts' | 'zx' {
  const e = (asString(attrs['engine']) ?? '').trim().toLowerCase()
  if (e === 'zx') return 'zx'
  return 'ts' // node, ts, пусто
}

export const scriptSource: SourcePlugin = {
  name: 'script',
  async resolve(attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext> {
    const name = nameOf(attrs, 'script')
    const path = asString(attrs['path'])
    const code = path ? await readResource(ctx, path, name) : bodyOf(attrs)
    if (!code) throw new Error(`nrd-context: source "${name}" (script) требует $path или тело блока`)
    return runVirtualBlock(scriptEngine(attrs), code, attrs, ctx, name)
  },
}
