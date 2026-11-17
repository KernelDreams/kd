/**
 * strict — фикстура: объявляет флаги, пишет файл-след при запуске.
 */
import * as fs from 'node:fs'

export const flags = { dry: 'только показать', out: 'файл-след' }

export default async function (ctx: { get(p: string[]): unknown }) {
  const out = ctx.get(['out'])
  if (typeof out === 'string') fs.writeFileSync(out, 'ran')
  return { output: 'ran' }
}
