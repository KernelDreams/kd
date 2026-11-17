/** Мини-appz для приёмки пути «$type → хендлер по имени» (rz-merge §4). */
import type { IContext } from '@kerneldreams/nrd'
import type { ScriptMeta, ScriptResult } from '@kerneldreams/nrd/contracts'

export default async function echoHandler(ctx: IContext, meta: ScriptMeta): Promise<ScriptResult> {
  return {
    output: `appz: ${String(ctx.get(['who']))} / doc=${meta.doc ? 'да' : 'нет'} / program=${meta.program ? 'да' : 'нет'}`,
  }
}
