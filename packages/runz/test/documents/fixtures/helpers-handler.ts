/** Мини-appz: через `$type` получает helpers хоста третьим аргументом. */
import type { IContext } from '@kerneldreams/nrd'
import type { ProgramHelpers, ScriptMeta, ScriptResult } from '@kerneldreams/runz-runtime'

export default async function helpersHandler(
  _ctx: IContext,
  _meta: ScriptMeta,
  helpers?: ProgramHelpers,
): Promise<ScriptResult> {
  if (!helpers) return { output: 'helpers: нет' }
  const reply = await helpers.llm([{ role: 'user', content: 'привет' }])
  const fn = await helpers.run('local')
  return {
    output: [
      `llm: ${reply}`,
      `attr: ${helpers.attr('who')}`,
      `list: ${helpers.list('tags')?.join(',')}`,
      `run: ${fn.output}`,
    ].join('\n'),
  }
}
