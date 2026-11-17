/**
 * @kerneldreams/comfy-client — клиент ComfyUI: один на batch-appz
 * (`appz/comfy`) и на capability `comfy` моста артефактов.
 *
 *   HTTP     queuePrompt / history / waitForResult / view / upload / interrupt / queueState / objectInfo (кэш)
 *   ws       connect → события {kind}, превью {kind:'preview', mime, bytes}; conn.queue / queue → job (итератор своего prompt)
 *   PNG      parsePng → {prompt?, workflow?}; embedWorkflow
 *   входы    editableInputs(prompt, objectInfo) → виджеты для формы; setInputs
 *   роли     roles(prompt, objectInfo) → refs/mask/prompt/negative/size/seed/steps/denoise/ckpt
 *   prune    pruneEmptyLoaders(prompt, objectInfo?) — пустые LoadImage: отрезать / обойти насквозь
 *   UI→API   detect / uiToApi(workflow, objectInfo) — UI-граф (подграфы) в API-формат
 *   контракт comfyImageProvider({server, templatesDir}) — ImageProvider, модель = шаблон
 */

export type { ComfyServer, HistoryEntry, ImageRef, InputSpec, NodeInfo, NodeOutput, ObjectInfo, Prompt, PromptNode, UiWorkflow } from './types.js'
export {
  baseUrl,
  collectOutputFiles,
  formatPromptError,
  formatStatusError,
  history,
  imageInputValue,
  interrupt,
  objectInfo,
  queuePrompt,
  queueState,
  submitPrompt,
  upload,
  uploadImage,
  view,
  viewImage,
  waitForResult,
  wsUrl,
} from './http.js'
export type { QueueOpts, QueueState, Queued, UploadOpts } from './http.js'
export { connect, isTerminal, parseBinary, parseMessage, queue } from './ws.js'
export type { ComfyConnection, ComfyEvent, ComfyJob, ConnectOpts, JobResult, TerminalKind } from './ws.js'
export { asciiJson, embedWorkflow, isPng, parsePng, readChunks, readText } from './png.js'
export type { PngChunk, PngMeta } from './png.js'
export { editableInputs, isLink, setInputs, widgetOf } from './inputs.js'
export type { EditableInput, InputType } from './inputs.js'
export { roles } from './roles.js'
export type { RefSlot, RoleRef, Roles } from './roles.js'
export { PruneError, pruneEmptyLoaders } from './prune.js'
export { classesOf, detect, isApiPrompt, isUiWorkflow, mapWidgets, uiToApi, widgetSlots } from './ui2api.js'
export type { Bind, WidgetSlot } from './ui2api.js'
export { comfyImageProvider } from './provider.js'
export type { ComfyProviderOptions } from './provider.js'
export { comfyGraph } from './graph.js'
export type { ComfyGraph, ComfyGroup, ComfyLink, ComfyNode, ComfyPin } from './graph.js'
