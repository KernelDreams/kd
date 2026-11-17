// json source — shorthand для file + json parse. `$path` через storage.

import type { Value, IContext } from '../../contracts/index.js'
import type { SourcePlugin, SourceContext } from '../types.js'
import { parseRaw } from '../parse.js'
import { asString, readResource, nameOf } from './util.js'

export const jsonSource: SourcePlugin = {
  name: 'json',
  async resolve(attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext> {
    const name = nameOf(attrs, 'json')
    const path = asString(attrs['path'])
    if (!path) throw new Error(`nrd-context: source "${name}" (json) требует атрибут $path`)
    const raw = await readResource(ctx, path, name)
    return parseRaw(raw, 'json')
  },
}
