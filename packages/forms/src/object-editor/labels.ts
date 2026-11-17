// Строки <ObjectEditor> — английские по умолчанию, хозяин отдаёт свои (`labels`). `{name}` — подстановка.

export interface EditorLabels {
  search: string
  /** «Ничего не найдено по «{query}»». */
  noMatches: string
  add: string
  remove: string
  moveUp: string
  moveDown: string
  drag: string
  /** Заголовок строки без значения: «#{n}». */
  item: string
  emptyList: string
  revert: string
  /** «⋯» поля: прочитать, скопировать, продиктовать (хозяин — `fieldMenu`). */
  fieldMenu: string
  /** Кандидат генератора (§10): принять / отказаться / ошибка «{error}». */
  candidateAccept: string
  candidateReject: string
  candidateError: string
  computed: string
  issues: string
  jsonInvalid: string
  preview: string
  edit: string
  imageUrl: string
  upload: string
  addTag: string
  ladder: string[]
  aspectKinds: Record<string, string>
  severities: Record<string, string>
  refresh: string
  boxes: string
}

export const EDITOR_LABELS: EditorLabels = {
  search: 'Search fields',
  noMatches: 'Nothing matches “{query}”',
  add: 'Add',
  remove: 'Remove',
  moveUp: 'Move up',
  moveDown: 'Move down',
  drag: 'Drag to reorder',
  item: '#{n}',
  emptyList: 'Empty',
  revert: 'Revert',
  fieldMenu: 'Field actions',
  candidateAccept: 'Accept',
  candidateReject: 'Discard',
  candidateError: 'Generator failed: {error}',
  computed: 'computed',
  issues: 'Editor description has problems',
  jsonInvalid: 'Not valid JSON: {error}',
  preview: 'Preview',
  edit: 'Edit',
  imageUrl: 'Image URL',
  upload: 'Upload',
  addTag: 'Add…',
  // Лестница Fate −2…+8.
  ladder: ['Terrible', 'Poor', 'Mediocre', 'Average', 'Fair', 'Good', 'Great', 'Superb', 'Fantastic', 'Epic', 'Legendary'],
  aspectKinds: { 'high-concept': 'High concept', trouble: 'Trouble', other: 'Aspect' },
  severities: { mild: 'Mild', moderate: 'Moderate', severe: 'Severe' },
  refresh: 'refresh {n}',
  boxes: '{n} boxes',
}

export const EDITOR_LABELS_RU: EditorLabels = {
  search: 'Поиск по полям',
  noMatches: 'Ничего не найдено по «{query}»',
  add: 'Добавить',
  remove: 'Удалить',
  moveUp: 'Выше',
  moveDown: 'Ниже',
  drag: 'Перетащить',
  item: '№{n}',
  emptyList: 'Пусто',
  revert: 'Вернуть',
  fieldMenu: 'Действия поля',
  candidateAccept: 'Принять',
  candidateReject: 'Нет',
  candidateError: 'Генератор не справился: {error}',
  computed: 'вычисляется',
  issues: 'В описании редактора ошибки',
  jsonInvalid: 'Не JSON: {error}',
  preview: 'Превью',
  edit: 'Правка',
  imageUrl: 'Адрес картинки',
  upload: 'Загрузить',
  addTag: 'Добавить…',
  ladder: ['Ужасно', 'Плохо', 'Посредственно', 'Средне', 'Неплохо', 'Хорошо', 'Отлично', 'Превосходно', 'Фантастично', 'Эпично', 'Легендарно'],
  aspectKinds: { 'high-concept': 'Концепция', trouble: 'Проблема', other: 'Аспект' },
  severities: { mild: 'Лёгкое', moderate: 'Среднее', severe: 'Тяжёлое' },
  refresh: 'восстановление {n}',
  boxes: '{n} ячеек',
}

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
