/**
 * Типы ComfyUI API. `Prompt` — API-формат (то, что уходит в `/prompt`):
 * `{ [nodeId]: { class_type, inputs, _meta? } }`, вход — литерал виджета или
 * ссылка `[nodeId, outputIndex]`. `Workflow` UI-графа — непрозрачный JSON.
 */

export interface PromptNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string; [k: string]: unknown }
}

export type Prompt = Record<string, PromptNode>

/** UI-граф фронта ComfyUI (`workflow` в PNG) — пакет его не разбирает. */
export type UiWorkflow = Record<string, unknown>

/** Картинка на сервере ComfyUI — адрес для `/view`. */
export interface ImageRef {
  filename: string
  subfolder: string
  type: string
}

export interface NodeOutput {
  images?: ImageRef[]
  [k: string]: unknown
}

export interface HistoryEntry {
  prompt?: unknown[]
  status?: {
    status_str: string
    completed: boolean
    messages?: Array<[string, Record<string, unknown>]>
  }
  outputs: Record<string, NodeOutput>
}

/** Спека входа из `/object_info`: `[TYPE | options[], {default, min, max, …}]`. */
export type InputSpec = [unknown, Record<string, unknown>?]

export interface NodeInfo {
  name?: string
  display_name?: string
  category?: string
  input: {
    required?: Record<string, InputSpec>
    optional?: Record<string, InputSpec>
    hidden?: Record<string, unknown>
  }
  input_order?: { required?: string[]; optional?: string[]; hidden?: string[] }
  output?: string[]
  output_node?: boolean
  [k: string]: unknown
}

export type ObjectInfo = Record<string, NodeInfo>

/** Адрес сервера: `host:port` или `http(s)://host:port[/база]`. */
export type ComfyServer = string
