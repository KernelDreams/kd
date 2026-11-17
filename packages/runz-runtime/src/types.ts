/**
 * @kerneldreams/runz-runtime — types
 *
 * Ступень 1 Total Refactor: протокол запуска (ScriptMeta/ScriptResult/
 * ServiceResult/ScriptOutput/ScriptFn/isServiceResult) переехал в
 * @kerneldreams/nrd/contracts. `ScriptMeta` там — дженерик по TDoc; runz-фасад
 * сужает его до `ScriptMeta<NRDocument>` под прежним именем. `LoadedScript`/
 * `Runner` — машинерия хоста, остаются здесь.
 */

import type { IContext, Value, NRDocument, Program } from '@kerneldreams/nrd'
import type { ProgramHelpers } from '@kerneldreams/nrd/node'
import type {
  ScriptMeta as ContractScriptMeta,
  ScriptResult,
  ServiceResult,
  ScriptOutput,
  ScriptArtifact,
  ScriptFn,
} from '@kerneldreams/nrd/contracts'
import { isServiceResult } from '@kerneldreams/nrd/contracts'

/**
 * runz-суженный ScriptMeta: `doc` — NRDocument, `program` — разобранная
 * программа документа (контракт держит дженерики TDoc/TProgram).
 */
export type ScriptMeta = ContractScriptMeta<NRDocument, Program>

export type { ScriptResult, ServiceResult, ScriptOutput, ScriptArtifact, ScriptFn }
export { isServiceResult }
export type { ProgramHelpers }

/**
 * appz-хендлер документа (`$type`): контракт скрипта плюс `helpers` хоста
 * третьим аргументом — те же, что у in-file `## $handler`. Есть,
 * когда runz запустил документ; виртуальный `--type` без документа — `undefined`.
 */
export type DocumentHandlerFn = (
  ctx: IContext,
  meta: ScriptMeta,
  helpers?: ProgramHelpers,
) => Promise<ScriptOutput>

/** A script resolved and loaded, ready to run. */
export interface LoadedScript {
  /** Script name. */
  name: string
  /** Resolved source file (`.ts` or `.md`), null if virtual. */
  file: string | null
  /** Parsed NRD document if the source is a document format. */
  doc: NRDocument | null
  /** Handler function. */
  fn: ScriptFn
  /** Execution environment: `node` | `electron`. */
  runtime: string
}

/** An execution environment for scripts. */
export interface Runner {
  name: string
  canRun(script: LoadedScript): boolean
  run(script: LoadedScript, ctx: IContext, meta: ScriptMeta): Promise<ScriptOutput>
}

export type { Value }
