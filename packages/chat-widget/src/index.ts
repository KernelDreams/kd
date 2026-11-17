/**
 * @kerneldreams/chat-widget — `<nr-chat>`: чат nrchat в любую страницу.
 * Импорт бандла регистрирует элемент.
 *
 * ```html
 * <script type="module" src="nr-chat.js"></script>
 * <nr-chat backend="http://127.0.0.1:7800" profile="agent"></nr-chat>
 * ```
 */

import { defineNrChat } from './element.js'

export { NrChatElement, defineNrChat, mount } from './element.js'
export { Feed, type Block, type FeedMessage } from './feed.js'
export { renderMarkdown } from './markdown.js'
export type { PageToolDef, PageToolHandler, PageToolResult, WidgetOptions } from './transport.js'

defineNrChat()
