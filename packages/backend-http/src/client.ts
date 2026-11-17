/**
 * createHttpBackend — клиентская сторона шва: HTTP + SSE → ProtocolBackend.
 *
 * Живёт в `@kerneldreams/chat-client` (клиент без зависимостей —
 * для браузера, виджета и артефактов); здесь — реэкспорт для прежних импортов
 * (`@kerneldreams/backend-http/client`), своей копии нет.
 */

export { BackendError, createHttpBackend, type HttpBackendOpts } from '@kerneldreams/chat-client'
