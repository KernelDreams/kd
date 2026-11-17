// @kerneldreams/nrd/template — NRD Template Engine (portable ядро).
//
// Рендер Nunjucks-шаблонов поверх IContext с кастомными делимитерами
// (`<{ }>` теги, `<< >>` переменные). Handlebars в данных (`{{user}}`) проходит
// сквозь нетронутым. Node-слой (loader, findTemplate, capabilities) — отдельный
// ступень `@kerneldreams/nrd/node`. Spec: docs/specs/ntpl-spec.md
//
//   import { extractNrd, createEnv, render, resolveRoute } from './index.js'
//   import { nodeLoader, findTemplate, nodeCapabilities } from '../node/index.js'

export { extractNrd } from './extract.js'
export type { ExtractResult } from './extract.js'

export { createEnv, createEnvWith, render, nunjucksEngine } from './engine.js'
export type { CreateEnvOptions, HelperRegistrar, TemplateEngine } from './engine.js'

export { createInterpreter, installNoEvalNunjucks, noEvalTemplate } from './noeval.js'
export type { Nunjucks } from './noeval.js'

export { handlebarsEngine } from './handlebars.js'

export { resolveRoute } from './route.js'
export type { SitePlugin, ParsedUrl, RouteResult } from './route.js'

export * from './helpers/index.js'

export { registerSite, registeredSites } from './sites.js'
