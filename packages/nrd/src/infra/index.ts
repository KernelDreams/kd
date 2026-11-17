// nrd/infra — portable-инфраструктура (бывший nr-infra, ступень «ноль
// environment API»). Здесь остаётся только то, что живёт в GAS: Result,
// генератор id, резолвер инклудов поверх инжектируемого IStorage.
//
// http/llm/memoryStorage уехали в `nrd/web` (WinterCG), fsStorage/execShell/
// runFile — в `nrd/node` (nrd-merge §2.1–§2.3).

export {
  type Result,
  type AsyncResult,
  ok,
  err,
  isOk,
  isErr,
} from './result.js'

export { generateId } from './id.js'

export {
  type IncludeResolver,
  fileIncludeResolver,
} from './include.js'
