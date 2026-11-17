// Nunjucks Environment + render (spec §4). Portable.
//
// Кастомные делимитеры: `<{ tag }>`, `<< var >>`, `<# comment #>`. Handlebars в
// данных (`{{user}}`) проходит сквозь нетронутым. Loader инъектируется → движок
// работает и в браузере; Node-loader живёт в `@kerneldreams/nrd/node`.
//
// Мост IContext → Nunjucks: `wrapContext` из ./context (Proxy с честным
// `ownKeys` через `cast('keys')`). Nunjucks ЭАГЕРНО копирует ключи контекста
// (`lib.extend({}, ctx)` через `Object.keys`) — теперь IContext перечисляет
// свои ключи, поэтому отдельный AST-разбор шаблона больше не нужен.

import type nunjucks from 'nunjucks'
import type { IContext } from '../core/index.js'
import { wrapContext } from '../context/index.js'
import { loadBuiltinHelpers } from './helpers/index.js'

// ---------- ленивая загрузка движка (nrd-merge §2.4) ----------
//
// `nunjucks` — optional peer, а не dependency: `nrd/template` обязан
// импортироваться и без него (проверка §5). Поэтому статический импорт здесь
// ТОЛЬКО типовой (стирается компилятором), а рантайм-модуль подтягивается
// динамическим `import()` в момент вызова — отсутствие пакета бьёт по вызову,
// не по загрузке модуля.

type Nunjucks = typeof nunjucks

let nunjucksCache: Promise<Nunjucks> | undefined

/** Загрузить nunjucks. Кэшируется; понятная ошибка, если peer не установлен. */
async function loadNunjucks(): Promise<Nunjucks> {
  if (nunjucksCache === undefined) {
    nunjucksCache = import('nunjucks')
      .then((m) => ((m as { default?: Nunjucks }).default ?? m) as Nunjucks)
      .catch((e: unknown) => {
        nunjucksCache = undefined
        throw new Error(
          'nrd/template: движок "nunjucks" не установлен. Это optional peer — ' +
            `добавьте его в зависимости проекта: npm i nunjucks (${(e as Error).message})`,
        )
      })
  }
  return nunjucksCache
}

/** Регистратор дополнительных фильтров/глобалов на Nunjucks env. */
export type HelperRegistrar = (env: nunjucks.Environment) => void

export interface CreateEnvOptions {
  /** Loader для `<{ include }>`/`<{ extends }>`. Node-вариант — `nodeLoader()`. */
  loader?: nunjucks.ILoader | nunjucks.ILoader[]
  /** Дополнительные фильтры поверх встроенных. */
  helpers?: HelperRegistrar[]
}

/** Кастомные ntpl-делимитеры (spec §3.2). */
const NTPL_TAGS = {
  blockStart: '<{',
  blockEnd: '}>',
  variableStart: '<<',
  variableEnd: '>>',
  commentStart: '<#',
  commentEnd: '#>',
}

/**
 * `<{ nrd }>` допустим лишь раз в корневом шаблоне и вырезается `extractNrd()` до
 * рендера. Если тег дошёл до компиляции (в партиале или после первой обработки) —
 * это ошибка. Guard-расширение бросает понятное сообщение.
 */
class NrdGuardExtension implements nunjucks.Extension {
  tags = ['nrd']
  parse(parser: any): any {
    const tok = parser.peekToken()
    const pos = tok ? ` (line ${tok.lineno + 1}, col ${tok.colno + 1})` : ''
    throw new Error(
      `ntpl: <{ nrd }> допустим только один раз в корневом шаблоне и вырезается до рендера; ` +
        `найден внутри партиала / после extractNrd${pos}.`,
    )
  }
}

/**
 * Создать Nunjucks Environment с ntpl-делимитерами и встроенными фильтрами.
 * Loader инъектируется (portable); helpers добавляются поверх встроенных.
 *
 * Асинхронна с nrd-merge §2.4: движок грузится лениво (optional peer).
 */
export async function createEnv(opts: CreateEnvOptions = {}): Promise<nunjucks.Environment> {
  return createEnvWith(await loadNunjucks(), opts)
}

/**
 * То же синхронно, над переданным модулем nunjucks (вызывающий уже держит его:
 * выражения редактора, Worker). Без кодогенерации — `noEvalTemplate` над этим env.
 */
export function createEnvWith(nj: Nunjucks, opts: CreateEnvOptions = {}): nunjucks.Environment {
  const env = new nj.Environment(opts.loader ?? null, {
    tags: NTPL_TAGS,
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  })
  env.addExtension('NrdGuard', new NrdGuardExtension())
  loadBuiltinHelpers(env)
  for (const reg of opts.helpers ?? []) reg(env)
  return env
}

// ---------- TemplateEngine — общий контракт движков ( §4.1) ----------

/** Единый интерфейс шаблонизатора: имя + render поверх IContext/plain-object. */
export interface TemplateEngine {
  readonly name: string
  render(template: string, context: IContext | object): string
}

// ---------- мост IContext → Nunjucks ----------

function isContextLike(v: unknown): v is IContext {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { get?: unknown }).get === 'function' &&
    typeof (v as { cast?: unknown }).cast === 'function'
  )
}

/**
 * Отрендерить тело шаблона поверх контекста.
 *
 * IContext оборачивается `wrapContext` (Proxy с честным `ownKeys` через
 * `cast('keys')`) — Nunjucks копирует ключи через `Object.keys`, вложенность
 * раскрывается лениво. Plain-object передаётся как есть — для chat2/custom путей,
 * где данные уже в JS-форме.
 */
export function render(
  env: nunjucks.Environment,
  template: string,
  ctx: IContext | object,
): string {
  const data = isContextLike(ctx) ? wrapContext(ctx) : ctx
  return env.renderString(template, data as object)
}

/**
 * Обёртка Nunjucks-движка под общий контракт `TemplateEngine`. `createEnv` и
 * `render` остаются экспортированными для обратной совместимости.
 */
export async function nunjucksEngine(opts?: CreateEnvOptions): Promise<TemplateEngine> {
  const env = await createEnv(opts)
  return {
    name: 'nunjucks',
    render(template, ctx) {
      return render(env, template, ctx)
    },
  }
}
