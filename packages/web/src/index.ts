// @kerneldreams/web — web transport layer. Carries raw bytes, understands nothing.
// Spec: docs/specs/nr-web-spec.md

// ---------- Types (§2, §4, §5) ----------
export type {
  Body,
  MultipartBody,
  WebRequest,
  WebResponse,
  Transport,
  Adapter,
  CdpTransportOptions,
  CdpCredentials,
  ChromeSpec,
  ChromeHandle,
  CdpCookie,
  CdpHandle,
  TabInfo,
  AuthResult,
  AuthHelpers,
  AuthScript,
  DevtoolsCaptured,
  Devtools,
} from './types.js'

// ---------- Decode helpers (§2.1) ----------
export { asText, asJson } from './decode.js'

// ---------- Transports (§1, §2.2) ----------
export { fetchTransport } from './transport/fetch.js'
export type { FetchTransportOptions } from './transport/fetch.js'
export { cdpTransport, buildFetchExpression } from './transport/cdp.js'

// ---------- Chrome supervisor + CDP client (§4) ----------
export { ensureChrome, killChrome, buildChromeCommand, ensureOriginTab } from './chrome/supervisor.js'
export {
  CDPClient,
  cdpConnect,
  connectTab,
  getTabs,
  tabInfos,
  newTab,
  browserWsUrl,
} from './chrome/cdp-client.js'

// ---------- Adapter (§2.3, §3) ----------
export { loadAdapter } from './adapter/load.js'
export { readProfileFields, extractAuthScript } from './adapter/profile.js'
export type { ProfileFields } from './adapter/profile.js'
export { compileAuthScript, stripFences } from './adapter/auth-script.js'

// ---------- Devtools (§5) ----------
export { devtools } from './devtools/devtools.js'
