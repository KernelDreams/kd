// nrd/program — документ как программа (rz-merge §2.1).
//
// Слой между форматом и хостом: реестр деклараций (что объявил файл), мост
// mds→блоки, плагины `fn`/`template`, сборка контекста программы. Portable:
// ни `node:`, ни fetch. Чтение файла, детект по расширению и Node-адаптеры
// capability — ступень `@kerneldreams/nrd/node`.

export {
  ATTR_BODY,
  ATTR_NAME,
  attrToValue,
  bodyText,
  stripFence,
  readBlockAttrs,
  rootParams,
} from './blocks.js'

export {
  KINDS,
  BLOCK_NAMES,
  isKind,
  readDecl,
  readDecls,
  findDecl,
  autoSteps,
} from './registry.js'
export type { Kind, NameSpec, Decl } from './registry.js'

export { META_ROLE, lexValue, valueFromMeta, attrsFromMeta, mdsToRoot } from './bridge.js'

export {
  INPUT_KINDS,
  isInputKind,
  sigilOf,
  dirOf,
  programFromText,
  programFromDoc,
} from './program.js'
export type { InputKind, Program } from './program.js'

export { requireFs, requireCodeLoader } from './capability.js'
export type { SyncStorage, ProgramCapabilities } from './capability.js'

export { FN_TYPES, FN_LANGS, fnSource, loadFn } from './fn.js'
export type { LoadedFn } from './fn.js'

export {
  TEMPLATE_PARSE_MODES,
  TEMPLATE_TYPES,
  templateParse,
  chatMessages,
  templateBody,
  renderTemplate,
} from './template.js'
export type { TemplateParse, RenderedMessage, TemplateEnv } from './template.js'

export { buildProgramContext } from './context.js'
export type { ProgramContextOptions } from './context.js'
