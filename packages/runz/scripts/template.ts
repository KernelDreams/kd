/**
 * Built-in script: template
 *
 * Resolves `${...}` placeholders in a document body against the chain.
 */

import { resolve, asText } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { ScriptMeta, ScriptResult } from '@kerneldreams/runz-runtime'

export default async function template(
  ctx: IContext,
  meta: ScriptMeta,
): Promise<ScriptResult> {
  if (meta.doc) {
    const body = (meta.doc.cast('text') as string | undefined) ?? ''
    return { output: resolve(body, ctx) }
  }
  // Virtual run: resolve a `body` value from the chain.
  const body = asText(ctx.get(['body'])) ?? ''
  return { output: resolve(body, ctx) }
}
