/**
 * Сборка контекста программы: звенья файла поверх цепочки хоста.
 *
 * Источники и трансформы резолвит слой сборки контекста (`buildContextFromRoot`
 * — тот же пайплайн, что у mdz-конфигов; мост mds отдаёт ему псевдо-дерево).
 * Программный слой лишь решает порядок звеньев.
 *
 * Каскад (first-wins) — `CLI > документ > конфиги > env` (resolve-fix §1.1):
 *   1. источники/трансформы файла (namespaced + верхний уровень) + функции;
 *   2. сильный слой хоста — CLI-аргументы;
 *   3. корневые атрибуты целевого файла;
 *   4. остальная цепочка хоста — маунты `${sys.…}`/`${settings.…}`, конфиги, env.
 *
 * Раньше корневые атрибуты стояли ПОСЛЕ всей цепочки хоста — чтобы `runz
 * conv.mdz --in=x` видел CLI-значение, а не пустой `$in:` из шапки. Ценой было
 * то, что и env, и любой конфиг тоже перебивали документ: посторонняя
 * переменная окружения молча уводила источник на другой файл. Разделение слоёв
 * (`ScriptMeta.chain`) снимает размен: CLI по-прежнему впереди, документ —
 * сильнее конфигов и окружения.
 *
 * Без разделения (хост не дал `chain`, программный вызов) поведение прежнее:
 * вся цепочка трактуется как сильный слой.
 */

import { chainContext, objectContext } from '../core/index.js'
import type { IContext, Value } from '../core/index.js'
import type { HostChain } from '../contracts/index.js'
import { buildContextFromRoot } from '../context/index.js'
import type { ProgramCapabilities } from './capability.js'
import { rootParams } from './blocks.js'
import type { Program } from './program.js'

export interface ProgramContextOptions {
  program: Program
  /** Цепочка, которую принёс хост. */
  hostCtx: IContext
  /** Слои цепочки по силе относительно атрибутов документа (`ScriptMeta.chain`). */
  chain?: HostChain
  caps: ProgramCapabilities
  /** Подмешать корневые атрибуты файла (file-режим). */
  withRootAttrs: boolean
  /** Явные параметры поверх корневых атрибутов при резолве деклараций. */
  params?: Record<string, Value>
  /** Ронять на заблокированном недоверенном звене вместо warn+skip. */
  strictUntrusted?: boolean
}

export async function buildProgramContext(o: ProgramContextOptions): Promise<IContext> {
  // Хост не разделил слои → весь ctx считается сильным (прежнее поведение).
  const strong = o.chain?.strong ?? o.hostCtx
  const weak = o.chain?.weak

  const sourcesCtx = await buildContextFromRoot(o.program.root, {
    baseDir: o.caps.baseDir,
    storage: o.caps.storage,
    executor: o.caps.executor,
    trusted: o.caps.trusted,
    strictUntrusted: o.strictUntrusted,
    params: o.params,
    functions: o.caps.functions,
    // `${loadJSON}`/`${loadMDD}` в декларациях документа. Гейт — внутри
    // buildContext: недоверенному звену привилегированные не подключаются.
    privilegedFunctions: o.caps.privilegedFunctions,
    // `${}` в декларациях видит то же, что код — и в том же каскаде.
    strongChain: strong,
    weakChain: weak,
  })

  const links: IContext[] = [sourcesCtx, strong]
  if (o.withRootAttrs) {
    links.push(objectContext(rootParams(o.program.root, chainContext(strong, o.hostCtx))))
  }
  // hostCtx целиком — хвостом: маунты `${sys.…}` и слабые слои. CLI в нём
  // повторяется, но он уже отработал первым звеном, так что порядок не меняет.
  links.push(o.hostCtx)

  return chainContext(...links)
}
