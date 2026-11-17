// NRDocument — parser output (Document) as an IContext (§6 of engine-spec.md).
//
// NRDocument — биндинг кодека к протоколу: живёт со стороны движка ( §2).
// Его вклад в CastMap подмешивается отсюда через module augmentation (§3.2),
// чтобы `icontext.ts` (протокол) не импортировал `document.ts` (биндинг).

import { parse } from '../md/index.js'
import type {
  Attribute,
  AttributeValue,
  Block,
  BodyValue,
  Document,
  Json5Object,
  ParseOptions,
} from '../md/index.js'
import type { IArray, IContext, Segment, Value } from './icontext.js'
import { asText, isInterpolated } from './icontext.js'
import type { ExtendsLoader, SelfOptions } from '../contracts/index.js'
export type { ExtendsLoader, SelfOptions } from '../contracts/index.js'
import { isJson5Object, isJson5Shaped, parseJson5Object } from '../md/index.js'
import {
  arrayValue,
  objectContext,
  chainContext,
  funcContext,
  contextToString,
} from '../contracts/eval/index.js'
import { walk } from '../contracts/eval/index.js'
import { parse as parseChat } from '../chat/index.js'
import { resolve } from '../contracts/eval/index.js'
import { coreFunctions } from '../contracts/eval/index.js'

const LENIENT = { mode: 'lenient' } as const

// ---------- Body text helpers ----------

function bodyText(b: BodyValue | undefined): string {
  if (b === undefined) return ''
  if (typeof b === 'string') return b
  return b.raw // as-is; escapes not unfolded (resolver finishes that)
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n')
}

/** A line is decoration if (after leading ws) it starts with #, *, ` or //. */
function isDecorationLine(line: string): boolean {
  let i = 0
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  const c = line[i]
  if (c === '#' || c === '*' || c === '`') return true
  if (c === '/' && line[i + 1] === '/') return true
  return false
}

function promptLines(text: string): string[] {
  return splitLines(text).filter((l) => l.trim().length > 0 && !isDecorationLine(l))
}

/** Split into paragraphs by blank lines; blank lines inside ``` fences don't split. */
function splitParagraphs(text: string): string[] {
  if (text.length === 0) return []
  const out: string[] = []
  let cur: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('```')) {
      inFence = !inFence
      cur.push(line)
      continue
    }
    if (!inFence && t === '') {
      if (cur.length) {
        out.push(cur.join('\n'))
        cur = []
      }
      continue
    }
    cur.push(line)
  }
  if (cur.length) out.push(cur.join('\n'))
  return out
}

// ---------- Messages (`%role` лента) ----------

/**
 * Тело как `%role`-лента → сообщения nr-chat (`ChatMessage`).
 *
 * Разбор — `parse` из `@kerneldreams/nrd/chat`: он и есть дом формата `%role`
 * (собственный сплиттер nrd-core умер в 4.0.0). Форма элемента — ChatMessage:
 * `role`, `body`, опциональные `name` / `meta` / `rawMeta`. Прежние `content` и
 * `blocks` не отдаются: тело сообщения — `body`, а ` ```` `-зоны непрозрачны и
 * остаются в теле как есть.
 *
 * Лента без маркеров даёт пустой массив — текст до первого `%role` игнорируется
 * (так же, как игнорировал прежний сплиттер).
 *
 * @throws {SyntaxError} `parse` падает на невалидном JSON5-мета маркера — каст
 *   не глушит это: битый маркер лучше увидеть, чем молча потерять сообщение.
 */
function chatMessages(body: string): IContext[] {
  return parseChat(body).map((m) => objectContext(m as unknown as Record<string, Value>))
}

// ---------- Attributes ----------

function wrapAttrValue(v: AttributeValue): Value {
  // Plain arrays (flow-literals) → IArray; scalars/InterpolatedValue as-is.
  if (Array.isArray(v)) return arrayValue(v as Value[])
  return v
}

function getAttr(attrs: Attribute[], name: string): Value | undefined {
  // Last-wins (§2.4): repeated key = reassignment, last value wins.
  let result: Value | undefined = undefined
  for (const a of attrs) {
    if (a.key.join('.') === name) result = wrapAttrValue(a.value)
  }
  return result
}

function attrContext(a: Attribute): IContext {
  return objectContext({ key: a.key.join('.'), value: wrapAttrValue(a.value) })
}

// ---------- Block as IContext ----------

/**
 * Стек путей `$nr-extends`, пройденных при построении контекста — цикл-гард
 * (`a → b → a` ловится до бесконечной рекурсии).
 */
type ExtendsChain = readonly string[]

/**
 * Блок как IContext. Если у блока есть `$nr-extends` И передан загрузчик —
 * возвращается КОМПОЗИТ own + база (nr-extends-transparent-spec §1): штатный
 * лукап `${block.key}` / `doc.get([block, key])` прозрачно видит базу (own-wins,
 * база = дефолты). Логика ПУТИ при этом не меняется — меняется только то, ЧТО
 * возвращается для extends-блока.
 */
function blockContext(
  block: Block,
  source: string,
  load?: ExtendsLoader,
  chain: ExtendsChain = [],
): IContext {
  const path = extendsPath(block)
  if (path === undefined) return ownBlockContext(block, source, load, chain)
  return extendsBlockContext(block, source, path, load, chain)
}

/** Голый контекст блока — без базы `$nr-extends` (own-слой композита). */
function ownBlockContext(
  block: Block,
  source: string,
  load?: ExtendsLoader,
  chain: ExtendsChain = [],
): IContext {
  return {
    get(path: Segment[]): Value | undefined {
      if (path.length === 0) return undefined
      const first = resolveBlockName(block, source, path[0], load, chain)
      if (path.length === 1) return first
      return walk(first, path.slice(1), LENIENT)
    },
    func: () => undefined,
    cast(name: string): any {
      return blockCast(block, source, name, load, chain)
    },
    toString(): string {
      return contextToString(this)
    },
  }
}

/** Касты, отдающие тело блока — наследуются от базы, если своего тела нет. */
const BODY_CASTS = new Set(['text', 'lines', 'prompts', 'paragraphs', 'messages'])
/** Касты про сам блок (диагностика/структура) — только own, база не подмешивается. */
const OWN_ONLY_CASTS = new Set(['raw', 'name', 'id', 'attrs'])

/**
 * Композит `own + $nr-extends база` (§1 спеки). База грузится ЛЕНИВО — только
 * при обращении к ключу, которого нет в own: вход в блок сам по себе IO не
 * делает (иначе `cast('records')`/итерация читали бы базы всех блоков подряд).
 *
 * Загрузчик не передан (untrusted) → обращение к унаследованному ключу кидает
 * ошибку из `loadExtends` — fail loud, не молчаливый undefined (§4/§5 спеки).
 */
function extendsBlockContext(
  block: Block,
  source: string,
  path: string,
  load: ExtendsLoader | undefined,
  chain: ExtendsChain,
): IContext {
  const own = ownBlockContext(block, source, load, chain)
  let base: IContext | undefined
  const getBase = (): IContext => {
    if (base === undefined) {
      if (chain.includes(path)) {
        throw new Error(
          `$nr-extends "${path}": цикл наследования (${[...chain, path].join(' → ')})`,
        )
      }
      const doc = loadExtends(path, load)
      // База = её root как блок: атрибуты + дочерние блоки. Тот же load —
      // база сама может наследовать (цепочка), цикл ловит chain.
      base = blockContext(doc.doc.root, doc.source, load, [...chain, path])
    }
    return base
  }
  const self: IContext = {
    get(p: Segment[]): Value | undefined {
      if (p.length === 0) return undefined
      const v = own.get(p) // own-wins: база = дефолты
      return v !== undefined ? v : getBase().get(p)
    },
    func: () => undefined,
    cast(name: string): any {
      if (name === 'IContext') return self // композит, а не голый own
      if (OWN_ONLY_CASTS.has(name)) return own.cast(name)
      if (name === 'keys') return unionKeys(own.cast('keys'), getBase().cast('keys'))
      if (BODY_CASTS.has(name) && block.body === undefined) return getBase().cast(name)
      const v = own.cast(name)
      return v !== undefined ? v : getBase().cast(name)
    },
    toString(): string {
      return contextToString(self)
    },
  }
  return self
}

function resolveBlockName(
  block: Block,
  source: string,
  name: Segment,
  load?: ExtendsLoader,
  chain: ExtendsChain = [],
): Value | undefined {
  if (typeof name !== 'string') return undefined
  // §8 cascade: scalar id-lookup takes the LAST matching record (last-wins).
  let byId: Block | undefined
  for (const ch of block.children) if (ch.id === name) byId = ch
  if (byId) return blockContext(byId, source, load, chain)
  const coll = block.children.filter((ch) => ch.name === name)
  if (coll.length > 0) return collectionArray(coll, source, load, chain)
  return getAttr(block.attrs, name)
}

/** Best-effort source fragment for a block (parser exposes no offsets). */
function blockRaw(block: Block): string {
  const lines: string[] = []
  const hashes = '#'.repeat(Math.max(1, block.level))
  lines.push(`${hashes} $${block.name}${block.id ? ' ' + block.id : ''}`)
  for (const a of block.attrs) lines.push(`$${a.key.join('.')}: ${attrRaw(a.value)}`)
  const body = bodyText(block.body)
  if (body.length > 0) lines.push(body)
  return lines.join('\n')
}

function attrRaw(v: AttributeValue): string {
  if (Array.isArray(v)) return '$[' + v.map((e) => attrRaw(e as AttributeValue)).join(', ') + ']'
  if (v !== null && typeof v === 'object' && 'raw' in v) return (v as { raw: string }).raw
  return String(v)
}

/**
 * Ключи блока: собственные атрибуты + id/name дочерних блоков, дедуп, порядок
 * документа. Тот же набор, что видит `get([key])`.
 *
 * Нужен приведению к тексту (text-cast-spec §2.1): json5-дамп звена собирается
 * протоколом — `cast('keys')` + `get`, без доступа к дереву. Без этого каста
 * блок без тела дампился бы пустым.
 */
function blockKeys(block: Block): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (k: string | undefined) => {
    if (k && !seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  for (const a of block.attrs) push(a.key.join('.'))
  for (const ch of block.children) push(ch.id ?? ch.name)
  return out
}

/** Объединение наборов ключей own + база: own впереди, дедуп. */
function unionKeys(own: unknown, base: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const src of [own, base]) {
    if (!Array.isArray(src)) continue
    for (const k of src as string[]) {
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  return out
}

function blockCast(
  block: Block,
  source: string,
  name: string,
  load?: ExtendsLoader,
  chain: ExtendsChain = [],
): any {
  const body = bodyText(block.body)
  switch (name) {
    case 'text':
      return body
    case 'raw':
      return blockRaw(block)
    case 'lines':
      return arrayValue(splitLines(body))
    case 'prompts':
      return arrayValue(promptLines(body))
    case 'paragraphs':
      return arrayValue(splitParagraphs(body))
    case 'records':
      return collectionArray(block.children, source, load, chain)
    case 'name':
      return block.name ?? undefined
    case 'id':
      return block.id ?? undefined
    case 'attrs':
      return arrayValue(block.attrs.map(attrContext))
    case 'keys':
      return blockKeys(block)
    case 'IContext':
      return blockContext(block, source, load, chain)
    case 'messages':
      return arrayValue(chatMessages(body) as unknown as Value[])
    default:
      return undefined // tbl / mdd — separate tasks
  }
}

// ---------- Collection (IArray of blocks) ----------

function collectionArray(
  blocks: Block[],
  source: string,
  load?: ExtendsLoader,
  chain: ExtendsChain = [],
): IArray {
  return {
    length: () => blocks.length,
    at: (i: number) => (blocks[i] ? blockContext(blocks[i], source, load, chain) : undefined),
    iterate: () => blocks.map((b) => blockContext(b, source, load, chain)),
    cast(name: string): any {
      if (name === 'IContext') {
        // name segment on a collection → look records up by id (§4 cross-cast).
        return {
          get(path: Segment[]): Value | undefined {
            if (path.length === 0) return undefined
            const head = path[0]
            let target: Block | undefined
            if (typeof head === 'number') target = blocks[head]
            else for (const b of blocks) if (b.id === head) target = b // §8: last id match wins
            if (!target && typeof head !== 'number') {
              // §8 cascade: scalar path into a collection with no id match →
              // delegate to the LAST element (covers repeated id-less blocks and
              // the former singleton auto-unwrap; ${cfg.x} reaches attrs without .at()).
              return blockContext(blocks[blocks.length - 1], source, load, chain).get(path)
            }
            if (!target) return undefined
            const ctx = blockContext(target, source, load, chain)
            return path.length === 1 ? ctx : walk(ctx, path.slice(1), LENIENT)
          },
          func: () => undefined,
          cast: (n: string): any => (n === 'keys' ? recordKeys(blocks) : undefined),
          toString(): string {
            return contextToString(this)
          },
        } as IContext
      }
      return undefined
    },
    toString(): string {
      return contextToString(this)
    },
  }
}

/** Имена записей коллекции (id, иначе имя блока) — для дампа и `wrapContext`. */
function recordKeys(blocks: Block[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const b of blocks) {
    const k = b.id ?? b.name
    if (k && !seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  return out
}

// ---------- NRDocument ----------

export class NRDocument implements IContext {
  /**
   * @param load Загрузчик `$nr-extends` (nr-extends-transparent-spec §2). Единственная
   *   точка привязки: дальше `load` живёт локально внутри document.ts. Без него блоки с
   *   `$nr-extends` не наследуют — обращение к унаследованному ключу = ошибка (fail loud).
   */
  constructor(
    public readonly doc: Document,
    public readonly source: string = '',
    public readonly load?: ExtendsLoader,
  ) {}

  get(path: Segment[]): Value | undefined {
    if (path.length === 0) return undefined
    const first = this.resolveName(path[0])
    if (path.length === 1) return first
    return walk(first, path.slice(1), LENIENT)
  }

  func(): Value | undefined {
    return undefined // functions arrive via ChainContext (§6)
  }

  cast(name: string): any {
    const root = this.doc.root
    switch (name) {
      case 'NRDocument':
      case 'IContext':
        return this
      case 'text':
        return bodyText(root.body)
      case 'raw':
        return this.source
      case 'lines':
        return arrayValue(splitLines(bodyText(root.body)))
      case 'prompts':
        return arrayValue(promptLines(bodyText(root.body)))
      case 'paragraphs':
        return arrayValue(splitParagraphs(bodyText(root.body)))
      case 'records':
        return collectionArray(root.children, this.source, this.load)
      case 'attrs':
        return arrayValue(root.attrs.map(attrContext))
      case 'keys':
        // root-атрибуты + id/name дочерних блоков, дедуп, порядок документа
        return blockKeys(root)
      case 'messages':
        return arrayValue(chatMessages(bodyText(this.doc.root.body)) as unknown as Value[])
      default:
        return undefined // tbl / mdd — separate tasks
    }
  }

  /**
   * Тело по маркерам `%role` (engine-spec §9) — тот же разбор, что
   * `cast('messages')`, но без обёртки в IArray.
   */
  split(): IContext[] {
    return chatMessages(bodyText(this.doc.root.body))
  }

  /** Текст документа по §2.1: тело root, иначе json5-дамп его ключей. */
  toString(): string {
    return contextToString(this)
  }

  private resolveName(name: Segment): Value | undefined {
    const root = this.doc.root
    if (typeof name !== 'string') return undefined
    // 1. record by id — §8 cascade: LAST matching record wins
    let byId: Block | undefined
    for (const ch of root.children) if (ch.id === name) byId = ch
    if (byId) return blockContext(byId, this.source, this.load)
    // 2. type collection
    const coll = root.children.filter((ch) => ch.name === name)
    if (coll.length > 0) return collectionArray(coll, this.source, this.load)
    // 3. root attribute
    return getAttr(root.attrs, name)
  }
}

// CastMap.NRDocument — вклад биндинга в открытый набор кастов ( §3.2).
// CastMap переехал в @kerneldreams/nrd/contracts (ступень 1) — augmentation
// целится в модуль-объявитель, иначе слияние не срабатывает.
declare module '../contracts/index.js' {
  interface CastMap {
    NRDocument: NRDocument
  }
}

/**
 * Parse text and wrap it as an NRDocument (keeps the source for `raw`).
 *
 * `load` — загрузчик `$nr-extends` (см. NRDocument). Без него поведение прежнее:
 * блоки с `$nr-extends` не наследуют, чтение унаследованного ключа — ошибка.
 */
export function parseDocument(text: string, opts?: ParseOptions, load?: ExtendsLoader): NRDocument {
  return new NRDocument(parse(text, opts), text, load)
}

// ---------- Слоистые контексты: self + $nr-extends (core-hardening-spec §C) ----------

// ExtendsLoader/SelfOptions — типы переехали в @kerneldreams/nrd/contracts
// (ступень 1); document.ts остаётся домом реализаций (blockSelf/selfScope/
// resolveBlockValue) и реэкспортирует типы обратно.

function extendsPath(block: Block): string | undefined {
  const v = getAttr(block.attrs, 'nr-extends')
  return typeof v === 'string' ? v : undefined
}

/**
 * Загрузить и распарсить базу `$nr-extends` (C3). Битый/отсутствующий файл —
 * fail loud. Кэша здесь нет: ядро stateless и IO-free (манифест в functions.ts),
 * а ключом мог бы быть только сырой путь — который резолвит загрузчик
 * относительно СВОЕЙ директории, так что `base.mdz` из разных документов
 * коллизирует. Мемоизация — зона ответственности ExtendsLoader.
 */
function loadExtends(path: string, load?: ExtendsLoader): NRDocument {
  if (!load) {
    throw new Error(`$nr-extends "${path}": загрузчик не передан (opts.load)`)
  }
  let text: string
  try {
    text = load(path)
  } catch (e) {
    throw new Error(`$nr-extends "${path}": ошибка загрузки: ${(e as Error).message}`)
  }
  if (typeof text !== 'string') {
    throw new Error(`$nr-extends "${path}": загрузчик не вернул содержимое`)
  }
  return parseDocument(text)
}

/**
 * Композит own + уже загруженная база (общее тело blockSelf/resolveBlockValue).
 * own-слой — ГОЛЫЙ (`ownBlockContext`): базу подмешивает эта функция, повторно
 * (через extends-ветку blockContext) её подмешивать нельзя.
 */
function composeSelf(
  block: Block,
  source: string,
  base: NRDocument | undefined,
  load?: ExtendsLoader,
): IContext {
  const own = ownBlockContext(block, source, load)
  return base === undefined ? own : chainContext(own, base)
}

/**
 * Композитный `self` блока (C2): `chainContext(own-атрибуты, $nr-extends база)`.
 * own-wins (база = дефолты). Virtual dispatch: ссылки базы на `${self.x}` видят
 * переопределения наследника, потому что own стоит первым в цепочке.
 */
export function blockSelf(block: Block, source = '', load?: ExtendsLoader): IContext {
  const path = extendsPath(block)
  return composeSelf(block, source, path === undefined ? undefined : loadExtends(path, load), load)
}

/**
 * Контекст резолва с привязанным `self` (C2). Голый `${x}` проваливается в
 * reader (свободная переменная-параметр, C1); `${self.x}` — связан к композиту.
 * Функции — из opts.functions или stdlib.
 *
 * Reader по умолчанию — САМ композит. Раньше без явного `reader`
 * свободных переменных не видел никто, и `${upper(name)}` рядом с `$name:` в
 * том же блоке молча превращался в `''`: путь не резолвился, `undefined`
 * уезжал аргументом в функцию, функция коэрсила его в пустую строку — ни
 * ошибки, ни оставшегося литерала. Дефолт «блок видит себя» убирает ловушку
 * целиком; явный `reader` по-прежнему сильнее (он встаёт первым звеном).
 */
export function selfScope(self: IContext, opts: SelfOptions = {}): IContext {
  const layers: IContext[] = [objectContext({ self })]
  layers.push(opts.reader ?? self)
  layers.push(opts.functions ?? funcContext(coreFunctions))
  return chainContext(...layers)
}

/** Сырой текст тела блока (или базы, если тело унаследовано) для резолва. */
function bodyRawForSelf(block: Block, base: NRDocument | undefined): string | undefined {
  if (block.body !== undefined) return bodyText(block.body)
  return base === undefined ? undefined : (base.cast('text') as string | undefined)
}

/**
 * Резолв значения атрибута (или тела) блока с привязанным `self` (C2/C3).
 *
 * `name === 'body'`/`'text'` — тело блока (или унаследованное от базы); иначе —
 * атрибут (own или из `$nr-extends` базы). Сырое значение берётся ИЗ self, а
 * резолвится об `selfScope`, поэтому virtual dispatch работает: json из базы с
 * `${self.model}` видит model наследника.
 */
export function resolveBlockValue(
  block: Block,
  name: string,
  opts: SelfOptions = {},
): string | Json5Object {
  // База грузится максимум один раз на вызов — локальная переменная, не кэш.
  const path = extendsPath(block)
  const base = path === undefined ? undefined : loadExtends(path, opts.load)
  const self = composeSelf(block, '', base, opts.load)
  const scope = selfScope(self, opts)
  const isBody = name === 'body' || name === 'text'

  if (isBody) {
    const raw = bodyRawForSelf(block, base)
    if (raw === undefined) return ''
    return resolve(raw, scope, { mode: opts.mode === 'strict' ? 'strict' : 'lenient' })
  }

  const value = self.get([name])
  // Уже объект — коэрсия случилась на parse-time, значит ${} в нём не было
  // и резолвить нечего (§7.2, точка 1).
  if (isJson5Object(value)) return value

  // Право на пост-резолвную детекцию — по СЫРОЙ форме, ДО резолва (§7.2):
  // значение пропустило точку 1 (InterpolatedValue) И его raw сам по себе —
  // форма `{...}`. Два следствия, ради которых eligibility считается здесь:
  //  - `$lit: \{not json}` / `$k: "{a: 1}"` — коэрснуты в точке 1, их эскейп и
  //    кавычки уже съедены; повторная детекция вернула бы их в форму;
  //  - `$n: ${x}` при x=`{a: 1}` — raw `${x}` не форма, поэтому НИКОГДА не
  //    детектится, чем бы резолв ни обернулся. Это и есть принятая асимметрия:
  //    подстановка не делает из строки объект (коэрсия скаляров —).
  const eligible = isInterpolated(value) && isJson5Shaped(value.raw)

  const raw = asText(value)
  if (raw === undefined) return ''
  const out = resolve(raw, scope, { mode: opts.mode === 'strict' ? 'strict' : 'lenient' })

  // Форма raw гарантирует форму out (ведущая `{` и хвостовая `}` — литералы,
  // плейсхолдеры строго внутри), поэтому повторная проверка формы не нужна:
  // eligible-значение ОБЯЗАНО быть валидным JSON5, битое → ошибка.
  // Строки документа здесь уже нет (Attribute её не несёт) — ошибка назовёт ключ.
  if (eligible) return parseJson5Object(out, undefined, name)
  return out
}
