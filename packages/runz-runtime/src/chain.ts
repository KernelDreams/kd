/**
 * @kerneldreams/runz-runtime — chain composition
 *
 * Builds the IContext chain handed to scripts. Priority (first wins):
 *   CLI args > document > explicit config > script config >
 *   project config > global config > environment
 *
 * Окружение — НЕ источник голых ключей. Оно входит в цепочки только
 * неймспейсом `env.`: `${env.OPENROUTER_API_KEY}`, `ctx.get(['env', 'HOME'])`.
 * Причина: env — слабейшее звено, и любой служебный ключ в нём (`_`, `PWD`,
 * `HOME`, `SHELL`) молча подменял отсутствующее значение. `ctx.get(['_'])` без
 * позиционала отдавал путь бинаря runz, и скрипт уходил работать с мусором
 * вместо честного `undefined`.
 */

import * as fs from 'node:fs'
import {
  chainContext,
  objectContext,
  emptyContext,
  parseDocument,
  isContext,
  isArray,
} from '@kerneldreams/nrd'
import type { IContext, IArray, NRDocument, Value } from '@kerneldreams/nrd'

export interface ChainLayers {
  /** CLI `--key=value` arguments. */
  cliArgs: Record<string, Value>
  /** The NRD document being run (if `.md`). */
  doc: NRDocument | null
  /** Explicit config from `--runz-config`. */
  explicitConfig: NRDocument | null
  /** `<script>.config.md` next to the script. */
  scriptConfig: NRDocument | null
  /** Project `.runz/config.md`. */
  projectConfig: NRDocument | null
  /** Global `~/.runz/config.md`. */
  globalConfig: NRDocument | null
  /** Environment variables (lowest priority, только под неймспейсом `env.`). */
  env?: Record<string, string>
}

/**
 * Parse a config file into an NRDocument, or null if it doesn't exist.
 * Отсутствующий файл — норма (тихо). Битый/нечитаемый — warn в stderr:
 * молчаливое «конфига нет» при синтаксической ошибке стоило часов отладки.
 */
export function loadConfigFile(file: string): NRDocument | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[runz] config unreadable: ${file} — ${(e as Error).message}\n`)
    }
    return null
  }
  try {
    return parseDocument(text)
  } catch (e) {
    process.stderr.write(`[runz] config parse error: ${file} — ${(e as Error).message}\n`)
    return null
  }
}

/**
 * Три типовых скоупа. Каждый — своя chainContext-цепочка.
 *   sys      = argv → explicit/script/project config → global(~/.runz) config → env
 *   settings = project config → global config
 *   document = argv → doc  (+ маунт-слой sys/settings; ctx для тулзы)
 */
export interface Scopes {
  /** Провайдер-блоки, root-config, env. Маунтится в document как `${sys.…}`. */
  sys: IContext
  /** Пользовательские настройки. Маунтится как `${settings.…}`. */
  settings: IContext
  /** То, что тулза получает как `ctx`. */
  document: IContext
  /**
   * Слой СИЛЬНЕЕ атрибутов документа — CLI-аргументы (`HostChain.strong`).
   *
   * Хендлеру, который сам читает документ (rz → nrd-context), одного `document`
   * мало: там CLI, конфиги и env уже слиты в одну цепочку, и хендлер не может
   * поставить документ между ними. Без разделения посторонняя env-переменная
   * молча перебивает `$slug:` документа (resolve-fix §1.1).
   */
  strong: IContext
  /** Слой СЛАБЕЕ атрибутов документа — конфиги и env (`HostChain.weak`). */
  weak: IContext
}

export interface BuildScopesOptions {
  /**
   * Доверенный документ (default `true`). При `false` (untrusted) document-цепочка
   * собирается без маунтов, без sys-хвоста и без env — только doc-слои + argv.
   */
  trusted?: boolean
}

function compact(parts: (IContext | null | undefined)[]): IContext[] {
  return parts.filter((p): p is IContext => p != null)
}

/**
 * Собрать три скоупа. document получает маунт-слой `objectContext({ sys, settings })`:
 * `${sys.gitea.token}` / `${settings.editor}` работают, голые ключи в sys/settings
 * из document НЕ проваливаются.
 *
 * Переходный слой (обратная совместимость): document ВРЕМЕННО включает sys-хвостом
 * после маунтов, чтобы appz, читающие `ctx.get(['provider', …])` напрямую, не
 * ломались. Снятие хвоста — отдельным коммитом после миграции потребителей.
 */
export function buildScopes(layers: ChainLayers, opts: BuildScopesOptions = {}): Scopes {
  const trusted = opts.trusted !== false
  const argv = objectContext(layers.cliArgs)
  // Неймспейс, а не плоский слой: голый `${VAR}` окружением больше не резолвится.
  const envCtx = layers.env ? objectContext({ env: layers.env as unknown as Value }) : null

  // sys — провайдеры/root-config/env; приоритет слева направо.
  const sys = chainContext(...compact([
    argv,
    layers.explicitConfig,
    layers.scriptConfig,
    layers.projectConfig,
    layers.globalConfig,
    envCtx,
  ]))

  // settings — user/default settings. У runz нет отдельных settings-файлов, поэтому
  // маппим на конфиг-слои (project → global) без env и без sys-секретов.
  const settings = chainContext(...compact([
    layers.projectConfig,
    layers.globalConfig,
  ]))

  // document — argv → doc (user-doc/default-doc в runz пока нет).
  const docLayers = compact([argv, layers.doc])

  // Слои по силе относительно атрибутов документа: сильный — только argv,
  // слабый — конфиги и env (порядок внутри тот же, что в sys).
  const strong = argv
  const weak = chainContext(...compact([
    layers.explicitConfig,
    layers.scriptConfig,
    layers.projectConfig,
    layers.globalConfig,
    envCtx,
  ]))

  if (!trusted) {
    // Untrusted: только doc-слои + argv. Без маунтов, без sys-хвоста, без env.
    // Слабого слоя у недоверенного документа нет по той же причине.
    return {
      sys,
      settings,
      document: chainContext(...docLayers),
      strong,
      weak: emptyContext,
    }
  }

  const mounts = objectContext({ sys, settings })
  const document = chainContext(
    ...docLayers,
    mounts,
    // TODO migration: убрать sys-хвост.
    sys,
  )
  return { sys, settings, document, strong, weak }
}

/**
 * Compose the live IContext chain (document-скоуп). Тонкая обёртка над
 * {@link buildScopes} — сохранена для обратной совместимости вызовов.
 */
export function buildChain(layers: ChainLayers): IContext {
  return buildScopes(layers).document
}

function arrayToPlain(v: Value): Value {
  if (isArray(v)) {
    const out: Value[] = []
    for (const item of (v as IArray).iterate()) out.push(item)
    return out
  }
  return v
}

/** Top-level `$attr` keys of a document as a plain object. */
function docTopLevel(doc: NRDocument): Record<string, Value> {
  const out: Record<string, Value> = {}
  const attrs = doc.cast('attrs') as IArray | undefined
  if (!attrs) return out
  for (const item of attrs.iterate()) {
    if (!isContext(item)) continue
    // nrd-core 1.0: the `attrs` cast yields contexts keyed by `key` (was `name`).
    const key = item.get(['key'])
    if (typeof key !== 'string') continue
    out[key] = arrayToPlain(item.get(['value']))
  }
  return out
}

/**
 * Flatten the chain into a plain object for serialization (`--runz-chain`,
 * `--runz-debug` dumps, `--runz-dry`). Functions and environment are excluded.
 */
export function flattenChain(layers: ChainLayers): Record<string, Value> {
  const merge = (...sources: (Record<string, Value> | null)[]): Record<string, Value> => {
    const out: Record<string, Value> = {}
    for (const s of sources) {
      if (s) Object.assign(out, s)
    }
    return out
  }
  // Low priority first, high priority last (later overwrites earlier).
  return merge(
    layers.globalConfig ? docTopLevel(layers.globalConfig) : null,
    layers.projectConfig ? docTopLevel(layers.projectConfig) : null,
    layers.scriptConfig ? docTopLevel(layers.scriptConfig) : null,
    layers.explicitConfig ? docTopLevel(layers.explicitConfig) : null,
    layers.doc ? docTopLevel(layers.doc) : null,
    layers.cliArgs,
  )
}
