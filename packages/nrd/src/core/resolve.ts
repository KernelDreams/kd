// Resolver (§3) — фасад.
//
// Ступень 3 Total Refactor: resolve/get переехали в
// `@kerneldreams/nrd/contracts/eval`. Реэкспорт 1:1 держит поверхность nrd-core.

export { resolve, resolveValue, get, unescapeOptOut } from '../contracts/eval/index.js'
