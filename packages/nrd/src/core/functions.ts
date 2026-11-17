// Stdlib чистых функций резолвера (core-hardening §C5) — фасад.
//
// Ступень 3 Total Refactor: coreFunctions переехали в
// `@kerneldreams/nrd/contracts/eval`. Реэкспорт 1:1 держит поверхность nrd-core.

export { coreFunctions } from '../contracts/eval/index.js'
