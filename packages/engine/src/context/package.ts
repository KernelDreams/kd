// ContextPackage → IContext (§8).
//
// Шаблон видит пакет как обычный контекст: `${card.personality}`, `${messages}`,
// `${injections}`. Кладётся ПЕРВЫМ звеном цепочки рендера — поля карточки,
// прошедшие через движок (untrusted-резолв + бюджет), перекрывают сырые.

import { arrayValue, chainContext, objectContext } from '@kerneldreams/nrd'
import type { IContext, Value } from '@kerneldreams/nrd'
import type { ContextPackage } from './types.js'
import { CARD_FIELDS } from './card.js'

/** Инъекции с фильтром по тегу: `injections | tag('lore')` — уже отсортированы. */
function injectionValues(pkg: ContextPackage): Value[] {
  return pkg.injections.map((i) => ({ ...i }) as unknown as Value)
}

export function packageContext(pkg: ContextPackage): IContext {
  const fields: Record<string, Value> = {}
  for (const f of CARD_FIELDS) {
    const v = pkg.card.get([f])
    if (typeof v === 'string') fields[f] = v
  }

  const own = objectContext({
    ...fields,
    injections: arrayValue(injectionValues(pkg)),
    examples: arrayValue(pkg.examples as unknown as Value[]),
    ctx_meta: pkg.meta as unknown as Value,
  })

  // messages / card / persona остаются живыми контекстами — не плющим в объекты.
  const live: IContext = {
    get(path) {
      const head = path[0]
      if (path.length >= 1 && head === 'card') {
        return path.length === 1 ? pkg.card : pkg.card.get(path.slice(1))
      }
      if (path.length >= 1 && head === 'messages' && path.length === 1) {
        return arrayValue(pkg.messages as unknown as Value[])
      }
      return undefined
    },
    func: () => undefined,
    cast: (name: string) => (name === 'keys' ? ['card', 'messages'] : undefined),
  }

  return chainContext(own, live)
}
