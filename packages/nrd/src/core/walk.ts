// Path traversal (§4) — фасад.
//
// Ступень 3 Total Refactor: walk переехал в
// `@kerneldreams/nrd/contracts/eval`. Реэкспорт 1:1 держит поверхность nrd-core.

export { walk } from '../contracts/eval/index.js'
