// Протокол запуска — сигнатура запуска любого сервиса, один контракт для всех
// хостов исполнения (runz CLI, exz service-супервизор, будущие HTTP/cron/MCP).
//
// `ScriptMeta` — дженерик по `TDoc` (NRDocument не протаскивается: zero-deps
// свят). runz-фасад реэкспортирует `ScriptMeta<NRDocument>` под прежним именем.
// `LoadedScript`/`Runner` — машинерия хоста, сюда НЕ едут.

import type { IContext } from './context.js'

/**
 * Слои цепочки хоста, разделённые по силе ОТНОСИТЕЛЬНО АТРИБУТОВ ДОКУМЕНТА
 * (resolve-fix §1.1).
 *
 * Хост отдаёт цепочку одним `ctx` — и в нём уже неразличимы CLI-аргумент
 * (сильнее документа) и переменная окружения (слабее). Хендлеру, который сам
 * читает атрибуты документа (rz → nrd-context), этого мало: без разделения
 * посторонняя env-переменная молча перебивает собственный `$slug:` документа.
 *
 * Канонический каскад: `CLI > документ > app-конфиг > глобальный конфиг > env`.
 */
export interface HostChain {
  /** Сильнее документа: CLI-аргументы, явные параметры вызова. */
  strong: IContext
  /** Слабее документа: конфиги, окружение. */
  weak: IContext
}

/** Metadata about a single script run — what isn't in the chain. */
export interface ScriptMeta<TDoc = unknown, TProgram = unknown> {
  /** Path to the source file (null if virtual run). */
  file: string | null
  /** NRD document (null if a `.ts` script was run directly). */
  doc: TDoc | null
  /**
   * Документ, приведённый к программе: корневой блок + декларации (rz-merge
   * §2.4). Есть, когда хост запустил документ (`.mdz`/`.md`/`.mdd`/`.mds`), —
   * хендлер, которому нужно дерево, берёт его отсюда, а не парсит файл заново.
   * `doc` при этом — `program.doc`.
   */
  program?: TProgram | null
  /** Project root — the directory containing `.runz/` (null if global). */
  projectDir: string | null
  /** Directory for persistent script data. */
  dataDir: string
  /** --runz-debug */
  debug: boolean
  /** --runz-dry */
  dry: boolean
  /**
   * Слои цепочки, разделённые по силе (см. {@link HostChain}). Поле опционально:
   * хост, который разделения не даёт, его не кладёт — потребитель тогда трактует
   * весь `ctx` как один слой (прежнее поведение).
   */
  chain?: HostChain
}

/**
 * One thing a script produced, declared for machine consumers (`--runz-json`, services).
 * `name` — имя выхода (mdz-приложение, `$outputs`: `lyrics`, `style`, `image`).
 */
export type ScriptArtifact =
  | { type: 'text'; text: string; name?: string }
  | { type: 'image'; path: string; meta?: Record<string, unknown>; name?: string }
  | { type: 'file'; path: string; name?: string }

/** Result of a normal (non-service) script. */
export interface ScriptResult {
  /** Text to print to stdout. */
  output?: string
  /** Text to append to the source file (chat append-mode). */
  append?: string
  /** Exit code (default 0). */
  exitCode?: number
  /**
   * What the script produced, for machine consumers. The CLI does not print it
   * (only `--runz-json` exposes it); `output` stays the human summary.
   */
  outputs?: ScriptArtifact[]
}

/** Result of a long-running service script. */
export interface ServiceResult {
  /** PID of the running service. */
  pid: number
  /** URL for health-check. */
  url?: string
  /** Log file. */
  log?: string
}

export type ScriptOutput = ScriptResult | ServiceResult

/** A script — `(ctx, meta) => Promise<ScriptResult | ServiceResult>`. */
export type ScriptFn = (ctx: IContext, meta: ScriptMeta) => Promise<ScriptOutput>

/** Discriminate ServiceResult from ScriptResult. */
export function isServiceResult(r: ScriptOutput): r is ServiceResult {
  return typeof (r as ServiceResult).pid === 'number'
}
