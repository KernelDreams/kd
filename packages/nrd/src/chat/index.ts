// nr-chat: формат mds-ленты; потребители (nrchat и др.) берут dist/ — после правки npm run build.
export { parse, stringify, replaceSpan, escapeBody, fenceFor } from './format.js'
export type { ChatMessage, ChatMessageWithSpan, ParseOptions, Span, ChatSyntaxError } from './format.js'

// The JSON5 microcodec lives in @kerneldreams/nrd/json5; re-exported
// here under its original names — nr-chat's surface is unchanged.
export { parseJson5, stringifyJson5 } from '../json5/index.js'
export type { Json5SyntaxError } from '../json5/index.js'
