/**
 * Лента виджета — одна модель на оба транспорта: события рана nr-ui-protocol
 * и апдейты ACP сводятся к сообщениям из блоков (текст, рассуждение, тул с
 * результатом, вопрос). Рендер перерисовывает только «грязные» сообщения.
 */

export type Role = 'user' | 'assistant' | 'error'

export type AskKind = 'tool_approval' | 'select' | 'text' | 'permission' | 'acp_permission'

export interface ApprovalOption {
  /** Значение ответа: decision протокола или optionId ACP. */
  value: string
  label: string
  /** Вид кнопки: разрешить / разрешить до конца сессии / отказать. */
  tone: 'allow' | 'session' | 'deny'
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool'
      callId: string
      name: string
      title?: string
      args?: unknown
      result?: string
      status: 'running' | 'done' | 'error'
      /** Исполнитель — страница (тул, зарегистрированный `registerTool`). */
      page?: boolean
    }
  | {
      kind: 'ask'
      askId: string
      ask: AskKind
      question: string
      options?: ApprovalOption[] | string[]
      preview?: string
      answered?: string
    }

export interface FeedMessage {
  id: string
  role: Role
  blocks: Block[]
  /** Ответ ещё стримится. */
  live?: boolean
}

export class Feed {
  readonly messages: FeedMessage[] = []
  private readonly dirty = new Set<string>()
  private seq = 0
  /** Колбэк перерисовки: id изменённых сообщений (пусто — перестроить всё). */
  onChange: (ids: string[] | null) => void = () => {}

  private touch(id: string): void {
    this.dirty.add(id)
    queueMicrotask(() => this.flush())
  }

  private flush(): void {
    if (!this.dirty.size) return
    const ids = [...this.dirty]
    this.dirty.clear()
    this.onChange(ids)
  }

  /** Синхронно сбросить отложенные изменения (тесты, конец рана). */
  flushNow(): void {
    this.flush()
  }

  localId(prefix = 'local'): string {
    return `${prefix}-${++this.seq}`
  }

  get(id: string): FeedMessage | undefined {
    return this.messages.find((m) => m.id === id)
  }

  /** Сообщение по id; нет — новое в конец. */
  ensure(id: string, role: Role): FeedMessage {
    let m = this.get(id)
    if (!m) {
      m = { id, role, blocks: [] }
      this.messages.push(m)
    }
    this.touch(id)
    return m
  }

  add(role: Role, blocks: Block[], id = this.localId(role)): FeedMessage {
    const m: FeedMessage = { id, role, blocks }
    this.messages.push(m)
    this.touch(id)
    return m
  }

  /** Сменить id (оптимистичное сообщение пользователя получило id сервера). */
  rename(from: string, to: string): void {
    const m = this.get(from)
    if (!m || this.get(to)) return
    m.id = to
    this.onChange(null)
  }

  update(id: string, fn: (m: FeedMessage) => void): void {
    const m = this.get(id)
    if (!m) return
    fn(m)
    this.touch(id)
  }

  /** Блок тула по callId — в любом сообщении (результат приходит отдельным). */
  findTool(callId: string): { message: FeedMessage; block: Extract<Block, { kind: 'tool' }> } | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!
      for (const b of m.blocks) if (b.kind === 'tool' && b.callId === callId) return { message: m, block: b }
    }
    return undefined
  }

  findAsk(askId: string): { message: FeedMessage; block: Extract<Block, { kind: 'ask' }> } | undefined {
    for (const m of this.messages) for (const b of m.blocks) if (b.kind === 'ask' && b.askId === askId) return { message: m, block: b }
    return undefined
  }

  clear(): void {
    this.messages.length = 0
    this.dirty.clear()
    this.onChange(null)
  }

  /** Последнее сообщение ассистента (или новое) — куда класть вопрос без сообщения. */
  lastAssistant(): FeedMessage {
    const last = this.messages.at(-1)
    if (last && last.role === 'assistant') {
      this.touch(last.id)
      return last
    }
    return this.add('assistant', [])
  }

  /** Текст сообщения целиком (для события `message`). */
  static textOf(m: FeedMessage): string {
    return m.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n')
  }
}

/** Короткая строка аргументов тула для заголовка карточки. */
export function argsSummary(args: unknown): string {
  if (args === undefined || args === null) return ''
  if (typeof args !== 'object') return String(args)
  const rec = args as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'query', 'url', 'question']) {
    if (typeof rec[key] === 'string') return rec[key] as string
  }
  const json = JSON.stringify(args)
  return json.length > 80 ? `${json.slice(0, 77)}…` : json
}
