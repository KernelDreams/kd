/** Строки виджета (ru/en). Язык — атрибут `lang`, иначе язык документа. */

const ru = {
  placeholder: 'Сообщение…',
  send: 'Отправить',
  stop: 'Стоп',
  thinking: 'Рассуждение',
  tool: 'Тул',
  pageTool: 'тул страницы',
  running: 'выполняется',
  done: 'готово',
  failed: 'ошибка',
  allow: 'Разрешить',
  allowSession: 'До конца сессии',
  deny: 'Отказать',
  approval: 'Разрешить действие?',
  answer: 'Ответить',
  answered: 'Ответ',
  connecting: 'Подключение…',
  connectFailed: 'Не удалось подключиться к бэкенду',
  disconnected: 'Соединение закрыто',
  runError: 'Ошибка рана',
  noPageTools: 'Бэкенд не принимает тулы страницы (нет capability tools.session)',
  acpNoPageTools: 'ACP: тулы страницы не поддерживаются — агенту их не объявить',
  empty: 'Напишите сообщение, чтобы начать.',
}

export type Strings = typeof ru

const en: Strings = {
  placeholder: 'Message…',
  send: 'Send',
  stop: 'Stop',
  thinking: 'Thinking',
  tool: 'Tool',
  pageTool: 'page tool',
  running: 'running',
  done: 'done',
  failed: 'failed',
  allow: 'Allow',
  allowSession: 'Allow for session',
  deny: 'Deny',
  approval: 'Allow this action?',
  answer: 'Answer',
  answered: 'Answer',
  connecting: 'Connecting…',
  connectFailed: 'Cannot connect to the backend',
  disconnected: 'Connection closed',
  runError: 'Run failed',
  noPageTools: 'Backend does not accept page tools (no tools.session capability)',
  acpNoPageTools: 'ACP: page tools are not supported — they cannot be declared to the agent',
  empty: 'Write a message to start.',
}

export function strings(lang: string | undefined): Strings {
  const l = (lang ?? (typeof document !== 'undefined' ? document.documentElement.lang : '') ?? '').toLowerCase()
  return l.startsWith('en') ? en : ru
}
