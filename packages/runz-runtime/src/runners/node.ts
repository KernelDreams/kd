/**
 * @kerneldreams/runz-runtime — node runner
 *
 * Runs the script inline in the current process. The default runner.
 */

import type { IContext } from '@kerneldreams/nrd'
import type { Runner, LoadedScript, ScriptMeta, ScriptOutput } from '../types.ts'

export const nodeRunner: Runner = {
  name: 'node',

  canRun(script: LoadedScript): boolean {
    return script.runtime === 'node'
  },

  async run(script: LoadedScript, ctx: IContext, meta: ScriptMeta): Promise<ScriptOutput> {
    return script.fn(ctx, meta)
  },
}
