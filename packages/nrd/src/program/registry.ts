/**
 * Реестр деклараций программы.
 *
 * Нода/блок объявляет вклад в контекст по трём осям:
 *   nr.kind  — ЧТО (source | transform | fn | template | data)
 *   nr.type  — ОТКУДА (имя плагина: inline | file | env | exec | ...)
 *   nr.parse — В КАКОМ ФОРМАТЕ (кодек)
 *
 * Тип — атрибут, НЕ имя блока. Имя остаётся именем; словарь имён ниже — тот же
 * хардкод хоста (`$action`/`$prompt`/`$tpl`), вынесенный в таблицу. Явная
 * `nr.kind` перебивает словарь; незнакомое имя без декларации — данные (роли
 * чата `%system`/`%user`, `## $card` — это данные, а не ошибка).
 */

import { nrKey } from '../context/index.js'
import type { IContext, Value } from '../core/index.js'
import type { Block } from '../md/index.js'
import { readBlockAttrs, ATTR_BODY, ATTR_NAME } from './blocks.js'

export type Kind = 'source' | 'transform' | 'fn' | 'template' | 'data'

export const KINDS: readonly Kind[] = ['source', 'transform', 'fn', 'template', 'data']

export interface NameSpec {
  kind: Kind
  /** Дефолтный `nr.parse` для имени (семантика словаря, не грамматики). */
  parse?: string
  /**
   * Имя объявляет шаг блокнота: `fn`, исполняемый автоматически, в порядке
   * документа (rz-merge §2.4). Явный `$nr-auto: true` даёт то же на любом имени.
   */
  auto?: boolean
}

/** Словарь имён блоков/ролей нод → категория вклада. */
export const BLOCK_NAMES: Record<string, NameSpec> = {
  // канон
  source: { kind: 'source' },
  transform: { kind: 'transform' },
  fn: { kind: 'fn' },
  template: { kind: 'template' },
  data: { kind: 'data' },
  // шаг блокнота — `fn`, который исполняется без явного `$run`
  step: { kind: 'fn', auto: true },
  // словарь легаси-имён (поведение сохранено)
  action: { kind: 'fn' },
  handler: { kind: 'fn' },
  prompt: { kind: 'template', parse: 'chat' },
  tpl: { kind: 'template' },
  card: { kind: 'data' },
}

export function isKind(v: unknown): v is Kind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v)
}

/** Разобранная декларация одного блока/ноды. */
export interface Decl {
  kind: Kind
  /** Имя блока / роль ноды — как написано в файле. */
  blockName: string
  /** id блока / name ноды; для безымянных — имя блока. */
  id: string
  /** Плагин (`nr.type`, легаси `$type`). undefined — плагин не объявлен. */
  type?: string
  /** Кодек (`nr.parse`); undefined — не объявлен (дефолт решает потребитель). */
  parse?: string
  /** Язык тела для `fn` (`nr.lang`), дефолт ts. */
  lang: string
  /** Внешнее тело (`nr.src`) — путь относительно baseDir. */
  src?: string
  /** Шаг блокнота: исполняется автоматически, в порядке документа. */
  auto: boolean
  body: string
  attrs: Record<string, Value>
}

function str(v: Value): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

function bool(v: Value): boolean | undefined {
  if (v === true || v === false) return v
  const s = str(v)?.toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  return undefined
}

/**
 * Прочитать декларацию блока. Атрибуты резолвятся об `ctx`, все записи
 * (`$nr: {…}` / `$nr.X` / `$nr-X`) уже сведены к плоской форме.
 *
 * @throws на явной `nr.kind` вне закрытого набора — громкая ошибка.
 */
export function readDecl(block: Block, ctx: IContext): Decl {
  const attrs = readBlockAttrs(block, ctx)
  const blockName = block.name
  const spec = BLOCK_NAMES[blockName]
  const declaredKind = str(nrKey(attrs, 'kind'))

  if (declaredKind !== undefined && !isKind(declaredKind)) {
    throw new Error(
      `nrd: неизвестный nr.kind "${declaredKind}" у "${blockName}" — известные: ${KINDS.join(' | ')}`,
    )
  }

  const kind: Kind = declaredKind ?? spec?.kind ?? 'data'
  return {
    kind,
    blockName,
    id: String(attrs[ATTR_NAME] ?? blockName),
    type: str(nrKey(attrs, 'type')),
    parse: str(nrKey(attrs, 'parse')) ?? spec?.parse,
    lang: str(nrKey(attrs, 'lang')) ?? 'ts',
    src: str(nrKey(attrs, 'src')),
    auto: bool(nrKey(attrs, 'auto')) ?? spec?.auto ?? false,
    body: String(attrs[ATTR_BODY] ?? ''),
    attrs,
  }
}

/** Все декларации верхнего уровня документа, в порядке файла. */
export function readDecls(root: Block, ctx: IContext): Decl[] {
  return root.children.map((b) => readDecl(b, ctx))
}

/**
 * Найти декларацию по категории и имени. Имя — id блока (`## $action all` →
 * `all`), для нод mds — `%fn all`. Без имени берётся первая своей категории.
 */
export function findDecl(decls: Decl[], kind: Kind, id?: string): Decl | undefined {
  if (id === undefined) return decls.find((d) => d.kind === kind)
  return decls.find((d) => d.kind === kind && d.id === id)
}

/** Шаги блокнота — `fn` с `auto: true`, в порядке документа (§2.4). */
export function autoSteps(decls: Decl[]): Decl[] {
  return decls.filter((d) => d.kind === 'fn' && d.auto)
}
