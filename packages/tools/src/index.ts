/**
 * `@kerneldreams/tools` — тулы агента: файлы (`read`, `ls`,
 * `find`, `grep`, `write`, `edit`, `apply_patch`), процессы (`exec`,
 * `process`) и их контракт. Ядро — без Node: пути и диск идут через `Fs`
 * (`@kerneldreams/chat-store/fs`), процессы — через {@link ProcessRegistry}.
 * Node-реализации (реестр процессов, `rg`/`fd`, тулы `runz`) — `./node`.
 *
 * Потребители: backend-nr (реэкспортирует прежние имена), стенд nr и
 * Claude Code через ACP (`nr-tools`), MCP-сервер.
 */

export type { BeforeToolDecision, ToolCallInfo, ToolContext, ToolDef, ToolExecutor, ToolFile, ToolHooks, ToolImage, ToolPolicy, ToolPreview, ToolResult, ToolSource } from './types.js'
export type { ExecHost, ProcInfo, ProcessRegistry, ProcStartOptions, ProcStatus } from './host.js'
export {
  applyHunks,
  capResultText,
  createFsTools,
  displayPath,
  expandPath,
  globMatcher,
  globToRegExp,
  parseUnifiedDiff,
  PathOutsideError,
  planPatch,
  resolveIn,
  resolveReadableIn,
  truncateHead,
  truncateTail,
  type FilePatch,
  type FsRoot,
  type FsScope,
  type FsToolsOptions,
  type PatchHunk,
  type SkillSource,
} from './fs/index.js'
export { applyPatchTool } from './fs/apply-patch.js'
export { imageMimeOf, lsTool, readTool } from './fs/read.js'
export { findTool, grepTool, type SearchOptions } from './fs/search.js'
export { editTool, writeTool } from './fs/write.js'
export { checkGraph, comfyTools, graphOf, nodeSummary, pngGraph, type ApiGraph, type ComfyFetch, type ComfyToolsOptions, type NodeInfo, type ObjectInfo } from './comfy.js'
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateLine, type Truncation, type TruncateOptions } from './fs/truncate.js'
export { compileExecDeny, createExecTools, DEFAULT_YIELD_MS, execDenied, execTool, processTool, type ExecDenyRule, type ExecToolsOptions } from './exec/exec.js'
export { fromBase64, toBase64, utf8Bytes, utf8Length, utf8Text } from './bytes.js'
