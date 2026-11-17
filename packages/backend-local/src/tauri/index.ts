/**
 * @kerneldreams/backend-local/tauri — транспорт nr-ui-protocol через Tauri `invoke`, обе стороны.
 *
 * createProtocolHost(backend) в sidecar ⇄ `protocol_call` / `protocol_event` ⇄
 * createTauriBackend() в webview → ProtocolBackend. Третий транспорт после
 * HTTP и in-process (exz-v2-spec §2). Стороны в одном пакете намеренно —
 * эволюционируют синхронно и тестируются друг об друга. Норматив —
 * docs/TRANSPORT.md.
 *
 * Зависимости: только @kerneldreams/ui-protocol; ни node, ни Tauri.
 */

export { createTauriBackend, BackendError } from './client.js'
export type { InvokeFn, ListenFn, TauriBackendOpts } from './client.js'

export { createProtocolHost } from './host.js'
export type { ProtocolHost, ProtocolHostOpts } from './host.js'

export { createMemoryBridge } from './bridge.js'
export type { MemoryBridge, MemoryBridgeOpts } from './bridge.js'

export {
  CODE_BAD_REQUEST,
  CODE_BUSY,
  CODE_CONNECTION_LOST,
  CODE_NOT_FOUND,
  CODE_NOT_SUPPORTED,
  PROTOCOL_CALL_COMMAND,
  PROTOCOL_EVENT,
  STREAM_CLOSE_METHOD,
  base64ToBytes,
  bytesToBase64,
} from './wire.js'
export type { ProtocolCall, ProtocolEventPayload, WireEnvelope } from './wire.js'
