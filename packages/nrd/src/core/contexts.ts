// Standard IContext / IArray implementations (§8) — фасад.
//
// Ступень 3 Total Refactor: реализации контекстов переехали в
// `@kerneldreams/nrd/contracts/eval`. Реэкспорт 1:1 держит поверхность nrd-core.

export {
  objectContext,
  chainContext,
  ChainContext,
  emptyContext,
  funcContext,
  arrayValue,
  wrapValue,
  contextToString,
} from '../contracts/eval/index.js'
export type { FuncFn } from '../contracts/eval/index.js'
