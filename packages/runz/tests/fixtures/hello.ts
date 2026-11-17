import { asText } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { ScriptMeta, ScriptResult } from '@kerneldreams/runz-runtime'

export default async function hello(
  ctx: IContext,
  _meta: ScriptMeta,
): Promise<ScriptResult> {
  const name = asText(ctx.get(['name'])) ?? 'World'
  return { output: `Hello, ${name}!` }
}
