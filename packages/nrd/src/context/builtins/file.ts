// file source — прочитать ресурс по `$path` через storage, распарсить по `$nr-parse`.

import type { Value, IContext } from '../../contracts/index.js'
import type { SourcePlugin, SourceContext } from '../types.js'
import { parseRaw, parseMode } from '../parse.js'
import { asString, readResource, nameOf } from './util.js'

export const fileSource: SourcePlugin = {
  name: 'file',
  async resolve(attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext> {
    const name = nameOf(attrs, 'file')
    const path = asString(attrs['path'])
    if (!path) throw new Error(`nrd-context: source "${name}" (file) требует атрибут $path`)
    const raw = await readResource(ctx, path, name)
    // Цепочка — как у inline (§1.3): прочитанный конфиг с `${}` обязан
    // резолвиться об внешний контекст, а не утекать InterpolatedValue.
    return parseRaw(raw, parseMode(attrs['nr-parse'], `source "${name}"`), ctx.chain)
  },
}
