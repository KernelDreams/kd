/**
 * Файловые тулы (tools-spec §2): `read`, `ls`, `find`, `grep` — порт pi;
 * `write`, `edit` (vendoring OpenClaw edit-diff), `apply_patch`.
 * Все пути — относительно `cwd` сессии, выход за него — `scope: 'any'`.
 */

import type { ToolDef } from '../types.js'
import { applyPatchTool } from './apply-patch.js'
import type { FsRoot } from './paths.js'
import { lsTool, readTool } from './read.js'
import { findTool, grepTool, type SearchOptions } from './search.js'
import { editTool, writeTool } from './write.js'

export interface FsToolsOptions extends FsRoot, SearchOptions {}

export function createFsTools(opts: FsToolsOptions): ToolDef[] {
  return [readTool(opts), lsTool(opts), findTool(opts, opts), grepTool(opts, opts), writeTool(opts), editTool(opts), applyPatchTool(opts)]
}

export { applyHunks, parseUnifiedDiff, planPatch, type FilePatch, type PatchHunk } from './apply-patch.js'
export { displayPath, expandPath, PathOutsideError, resolveIn, resolveReadableIn, type FsRoot, type FsScope, type SkillSource } from './paths.js'
export { capResultText, truncateHead, truncateTail } from './truncate.js'
export { globMatcher, globToRegExp } from './search.js'
