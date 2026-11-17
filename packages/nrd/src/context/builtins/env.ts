// env source — переменные окружения. Portable (process.env, guard для браузера).

import { objectContext } from '../../core/index.js'
import type { Value, IContext } from '../../contracts/index.js'
import type { SourcePlugin, SourceContext } from '../types.js'
import { asList } from './util.js'

function env(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {}
}

export const envSource: SourcePlugin = {
  name: 'env',
  async resolve(attrs: Record<string, Value>, _ctx: SourceContext): Promise<IContext> {
    const keys = asList(attrs['keys'])
    const e = env()
    const obj: Record<string, Value> = {}
    for (const k of keys) obj[k] = e[k] ?? undefined
    return objectContext(obj)
  },
}
