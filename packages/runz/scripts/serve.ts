/**
 * Built-in script: serve
 *
 * Starts the `@kerneldreams/runz-runtime/web` HTTP service with parameters from the chain.
 */

import { get, asText } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'
import type { ScriptMeta, ServiceResult } from '@kerneldreams/runz-runtime'
import { serve } from '@kerneldreams/runz-runtime/web'

export default async function serveScript(
  ctx: IContext,
  _meta: ScriptMeta,
): Promise<ServiceResult> {
  const portValue = get(['port'], ctx)
  const port = typeof portValue === 'number' ? portValue : Number(asText(portValue) ?? 3050)
  const key = asText(get(['key'], ctx))

  const handle = await serve({ port, key: key || undefined })

  return {
    pid: process.pid,
    url: handle.url,
  }
}
