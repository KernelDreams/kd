// inline source — данные внутри самого блока. Portable (никаких capabilities).
//
// Две формы (следствие парсера mdz, sigil '$'):
//  - тело блока непустое (text / json / `@`-mdd) → parseRaw(body, $nr-parse);
//  - тела нет, данные записаны `$key: value` (mdz) → парсер сложил их в
//    атрибуты блока → собираем IContext из них (service-атрибуты отбрасываем).

import { objectContext } from '../../core/index.js'
import type { Value, IContext } from '../../contracts/index.js'
import type { SourcePlugin, SourceContext } from '../types.js'
import { parseRaw, parseMode } from '../parse.js'
import { bodyOf, nameOf } from './util.js'

const SERVICE = new Set(['nr-type', 'type', 'nr-parse', 'nr-kind', 'nr-input'])

export const inlineSource: SourcePlugin = {
  name: 'inline',
  async resolve(attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext> {
    const body = bodyOf(attrs)
    if (body.trim() !== '') {
      // `ctx.chain` — накопленная цепочка (§1.3): `${}` в теле резолвится ровно
      // об то же, что `${}` в атрибутах. Иначе две формы одного плагина ведут
      // себя по-разному, и телесная молча утекает объектом.
      return parseRaw(
        body,
        parseMode(attrs['nr-parse'], `source "${nameOf(attrs, 'inline')}"`),
        ctx.chain,
      )
    }
    // mdz-инлайн: данные в `$key: value` атрибутах блока.
    const data: Record<string, Value> = {}
    for (const [k, v] of Object.entries(attrs)) {
      if (SERVICE.has(k) || k.startsWith('$')) continue
      data[k] = v
    }
    return objectContext(data)
  },
}
