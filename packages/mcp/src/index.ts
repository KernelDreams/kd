/**
 * `@kerneldreams/mcp` — руки агента на машине (nrchat.dev/specs/board-edge-spec.md §3):
 * установленный `nr-host-agent` (панель файлов хаба по HTTP) и тулы `nr-tools` по MCP Streamable HTTP.
 * Запуск — бинарь `nr-mcp` (bun --compile) или `node dist/cli.js`.
 */

export { configPath, configTemplate, DEFAULT_PORT, expandHome, parseConfig, parseConfigText, type McpConfig } from './config.js'
export { handleRpc, PROTOCOL_VERSION, SERVER_NAME, type McpHost } from './mcp.js'
export { createRootsGuard, guardFs, OutsideRootsError, type RootsGuard } from './roots.js'
export { startServer, type McpServer, type StartOptions } from './server.js'
export { createMachineTools, denyRule, type MachineTools, type MachineToolsOptions } from './tools.js'
export { attachHubTools, loadHubTools, type HubOptions } from './hub.js'
export { VERSION } from './version.js'
export { createWatchThread, type WatchThread } from './watch.js'
