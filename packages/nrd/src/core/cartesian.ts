// Fan-out: cartesian product (§7) — фасад.
//
// Ступень 3 Total Refactor: cartesian переехал в
// `@kerneldreams/nrd/contracts/eval`. Реэкспорт 1:1 держит поверхность nrd-core.

export { cartesian } from '../contracts/eval/index.js'
export type { CartesianOptions } from '../contracts/eval/index.js'
