// LLM-словарь: типы переехали в @kerneldreams/nrd/contracts (ступень 1 Total
// Refactor). nr-infra реэкспортирует их без изменений поверхности; реализация
// парсера SSE (parseSSE) остаётся здесь.

export type {
  ContentBlock,
  LLMMessage,
  LLMTool,
  LLMToolCall,
  ThinkingConfig,
  LLMRequest,
  LLMUsage,
  LLMResponse,
  LLMChunk,
  LLMProvider,
  ProviderOptions,
  EmbedRequest,
  EmbedResponse,
  EmbedStore,
} from '../../contracts/index.js'

// ==================== SSE ====================

/** Разбить SSE-стрим ReadableStream на строки `data: ...`. */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) {
          yield line.slice(5).trim()
        }
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) yield tail.slice(5).trim()
  } finally {
    reader.releaseLock()
  }
}
