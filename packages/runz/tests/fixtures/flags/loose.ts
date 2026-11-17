/**
 * loose — фикстура: флагов не объявляет, пишет файл-след при запуске.
 */
import * as fs from 'node:fs'

export default async function (ctx: { get(p: string[]): unknown }) {
  const out = ctx.get(['out'])
  if (typeof out === 'string') fs.writeFileSync(out, 'ran')
  return { output: 'ran' }
}
