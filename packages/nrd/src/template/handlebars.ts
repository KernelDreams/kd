// Handlebars-движок под общий контракт TemplateEngine ( §4.4).
//
// Фолбэк для старых SillyTavern-шаблонов на Handlebars-синтаксисе (`{{char}}`,
// `{{#each}}`). Мост IContext → данные — `wrapContext` (честный `ownKeys` через
// `cast('keys')`), поэтому `{{#each obj}}` обходит ключи контекста.

import type Handlebars from 'handlebars'
import type { IContext } from '../core/index.js'
import { wrapContext } from '../context/index.js'
import type { TemplateEngine } from './engine.js'

type HandlebarsModule = typeof Handlebars

let hbCache: Promise<HandlebarsModule> | undefined

/**
 * Загрузить handlebars лениво (nrd-merge §2.4): optional peer, отсутствие
 * пакета обязано бить по вызову `handlebarsEngine()`, а не по импорту
 * `nrd/template`.
 */
async function loadHandlebars(): Promise<HandlebarsModule> {
  if (hbCache === undefined) {
    hbCache = import('handlebars')
      .then((m) => ((m as { default?: HandlebarsModule }).default ?? m) as HandlebarsModule)
      .catch((e: unknown) => {
        hbCache = undefined
        throw new Error(
          'nrd/template: движок "handlebars" не установлен. Это optional peer — ' +
            `добавьте его в зависимости проекта: npm i handlebars (${(e as Error).message})`,
        )
      })
  }
  return hbCache
}

function isContextLike(v: unknown): v is IContext {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { get?: unknown }).get === 'function' &&
    typeof (v as { cast?: unknown }).cast === 'function'
  )
}

/**
 * Handlebars-движок (`TemplateEngine`). `noEscape: true` — ntpl рендерит не HTML,
 * экранирование не нужно (как `autoescape: false` у Nunjucks).
 *
 * ⚠️ ВНИМАНИЕ: Handlebars интерпретирует `{{...}}` ВЕЗДЕ, включая ЗНАЧЕНИЯ
 * контекста. В отличие от `nunjucksEngine` (делимитеры `<< >>` пропускают
 * `{{user}}`/`{{char}}` в данных нетронутыми), `handlebarsEngine` съест
 * Handlebars-синтаксис в данных. Это приемлемо для фолбэка старых SillyTavern-шаблонов
 * (там `{{char}}` — макрос, который и должен резолвиться), но НЕ для данных с
 * литеральными `{{}}` — они будут интерпретированы, а не выведены как есть.
 */
export async function handlebarsEngine(): Promise<TemplateEngine> {
  const hb = await loadHandlebars()
  return {
    name: 'handlebars',
    render(template: string, ctx: IContext | object): string {
      const data = isContextLike(ctx) ? wrapContext(ctx) : ctx
      const compiled = hb.compile(template, { noEscape: true })
      return compiled(data)
    },
  }
}
