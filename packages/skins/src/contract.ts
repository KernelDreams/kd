/**
 * Контракт скина (skin-spec §2–§4): какие переменные скин задаёт, какие
 * элементы ленты он вправе трогать и какими свойствами. Это же — «контракт для
 * агента»: редактор тем и профиль модели читают описания отсюда.
 *
 * Контракт — карта гарантий, не запрет (skin-spec §2 v1.1, DECISIONS 05.11): токены, звенья и
 * свойства отсюда переживут перекройку разметки ядра; всё прочее скин вправе писать, линтер
 * предупреждает «не гарантируем». По контракту конвертеры считают покрытие.
 */

export type TokenKind = 'color' | 'font' | 'length' | 'number' | 'shadow' | 'duration' | 'background' | 'keyword'

export type TokenGroup = 'bg' | 'text' | 'accent' | 'fonts' | 'type' | 'radius' | 'space' | 'avatar' | 'code' | 'icons'

export interface TokenSpec {
  name: `--nr-${string}`
  group: TokenGroup
  kind: TokenKind
  /** Что красит/меняет переменная — для человека и модели. */
  description: string
  /** Уровень контракта (ui-kit-spec §3): A — палитра, обязательна; B — облик; C — декор. */
  level: 'A' | 'B' | 'C'
}

/**
 * Правила читаемости — для агента и редактора тем, словами. Числа и
 * проверки — `./readability.ts`: кегль ругает валидатор, контраст —
 * `compileSkin` (предупреждение) и тест скинов (строго).
 */
export const READABILITY_RULES: readonly string[] = [
  'кегль при 100%: --nr-text-sm и --nr-text-body не мельче 15px (0.9375rem), остальные ступени --nr-text-* не мельче 13px (0.8125rem); мельче хочет пользователь — «размер текста», не скин',
  'моноширинный (--nr-font-mono) — только код, пути, id и время; подписи, статусы, кнопки — шрифтом интерфейса',
  'контраст --nr-fg, --nr-muted, --nr-accent, --nr-ok, --nr-error к --nr-bg и к --nr-surface — не ниже 4.5:1 в каждом заявленном режиме; не проходит — тот же оттенок темнее (светлый режим) или светлее (тёмный)',
  'статус не только цветом: слово или иконка рядом остаются, цвет — дополнительно',
  'тулбар (--nr-chrome) отличим от панелей тоном самого скина (подмешать акцент, не серый), разница мягкая; --nr-fg и --nr-accent на нём — не ниже 4.5:1; активный пункт — акцентом и чертой, не светлой плашкой',
  'иконки режимов (тулбар, полоса телефона, список типов) различаются цветом, не только формой: оттенок — от типа или хэша id (как цвет записи), светлота и насыщенность — от --nr-record-accent; цветная иконка или плашка к --nr-chrome и белая иконка на плашке — не ниже 3:1 (графика, WCAG 1.4.11); линия не тоньше 2px на экране, серый лайнарт 1.5px — не читается',
  'иконки (icons-spec §2): картинку выбирает автор скина — пакет --nr-icon-pack (lucide, office, office2000 — картинки-предметы растром, или свой из envs/icon-packs: SVG, PNG или WebP; растр мельче 2× показа — предупреждение) и способ --nr-icon-style для одноцветных (outline | plate | duotone); эмодзи и символы можно; одноцветный пакет контуром (outline) с линией --nr-icon-stroke тоньше 2.33 в сетке 24 (≈1.75px при иконке 18px) — предупреждение; outline при сером --nr-record-accent — соседние иконки одного цвета, различаются только формой — предупреждение',
]

/** Встроенные пакеты иконок (icons-spec §2): `lucide` — одноцветный, `office` — многоцветный (Flat Color Icons). */
export const ICON_PACKS: readonly string[] = ['lucide', 'office']
/** Способы одноцветного пакета (A / B / C из); по умолчанию у базы — `plate`. */
export const ICON_STYLES: readonly string[] = ['outline', 'plate', 'duotone']

/** Группы редактора тем — в этом порядке. */
export const TOKEN_GROUPS: ReadonlyArray<{ id: TokenGroup; title: string }> = [
  { id: 'bg', title: 'Фон и линии' },
  { id: 'text', title: 'Текст' },
  { id: 'accent', title: 'Акцент и статусы' },
  { id: 'fonts', title: 'Шрифты' },
  { id: 'type', title: 'Кегль и интерлиньяж' },
  { id: 'radius', title: 'Радиусы и тени' },
  { id: 'space', title: 'Отступы и мера' },
  { id: 'avatar', title: 'Аватар и отбивка' },
  { id: 'code', title: 'Подсветка кода' },
  { id: 'icons', title: 'Иконки' },
]

const t = (name: `--nr-${string}`, group: TokenGroup, kind: TokenKind, level: TokenSpec['level'], description: string): TokenSpec => ({
  name,
  group,
  kind,
  level,
  description,
})

/** Все токены, которые скин вправе задавать. */
export const TOKENS: readonly TokenSpec[] = [
  // ── палитра (уровень A): обязательна для каждого заявленного режима ──
  t('--nr-bg', 'bg', 'color', 'A', 'фон окна и ленты'),
  t('--nr-surface', 'bg', 'color', 'A', 'подложка панелей, сайдбара, шапок карточек (тул, thinking)'),
  t('--nr-raised', 'bg', 'color', 'A', 'приподнятые поверхности: композер, поповеры, поля ввода'),
  t('--nr-line', 'bg', 'color', 'A', 'рамки и разделители'),
  t('--nr-fg', 'text', 'color', 'A', 'основной текст'),
  t('--nr-muted', 'text', 'color', 'A', 'вторичный текст: мета, подписи, имя игрока, thinking (контраст к фону ≥ 4.5:1)'),
  t('--nr-accent', 'accent', 'color', 'A', 'акцент: имя ассистента, ссылки, активные кнопки, фокус (контраст к фону ≥ 4.5:1)'),
  t('--nr-ok', 'accent', 'color', 'A', 'успех: готово, зелёные статусы (контраст к фону ≥ 4.5:1)'),
  t('--nr-error', 'accent', 'color', 'A', 'ошибка: красные статусы, расхождение модели (контраст к фону ≥ 4.5:1)'),
  t('--nr-accent-fg', 'accent', 'color', 'A', 'текст поверх заливки акцентом (кнопка «отправить»)'),
  t('--nr-line-soft', 'bg', 'color', 'A', 'тонкие разделители внутри панелей'),
  t('--nr-shadow-pop', 'radius', 'shadow', 'A', 'тень поповеров и меню'),
  // ── облик (уровень B) ──
  t('--nr-focus', 'accent', 'color', 'B', 'кольцо фокуса (по умолчанию = акцент)'),
  t('--nr-chrome', 'bg', 'color', 'C', 'фон тулбара оболочки (toolbar-spec): свой тон скина, не инверсия; по умолчанию — поверхность с 10% акцента (12% роняли акцент встроенного far ниже 4.5:1)'),
  t('--nr-toolbar-bg', 'bg', 'color', 'C', 'фон верхнего тулбара и шапки телефона (`[data-toolbar]`): тёмный верх над светлым окном; по умолчанию = --nr-chrome'),
  t('--nr-toolbar-fg', 'text', 'color', 'C', 'текст и иконки-знаки на тулбаре (`[data-toolbar]`): к --nr-toolbar-bg не ниже 4.5:1; по умолчанию = --nr-fg'),
  t('--nr-toolbar-muted', 'text', 'color', 'C', 'вторичный текст на тулбаре: подписи кнопок, «⋯»; по умолчанию = --nr-muted'),
  t('--nr-record-base', 'accent', 'color', 'C', 'эталон цвета записи для фона/полосы строки и рамки эскиза (objects-spec §19.1): запись меняет только оттенок — oklch(from эталон l c <оттенок>); по умолчанию — акцент 35% на фоне'),
  t('--nr-record-accent', 'accent', 'color', 'C', 'эталон цвета записи для плашки/иконки, насыщеннее --nr-record-base (§19.1); по умолчанию = акцент'),
  t('--nr-font-ui', 'fonts', 'font', 'B', 'шрифт интерфейса: панели, кнопки, сайдбар'),
  t('--nr-font-body', 'fonts', 'font', 'B', 'шрифт текста реплик (тело сообщения, thinking)'),
  t('--nr-font-mono', 'fonts', 'font', 'B', 'моноширинный — только код, пути, id и время; подписи, статусы и кнопки — шрифтом интерфейса'),
  t('--nr-text-xs', 'type', 'length', 'B', 'кегль меты, чипов, счётчиков (rem; дефолт 13px, не мельче 13px)'),
  t('--nr-text-sm', 'type', 'length', 'B', 'базовый текст интерфейса: списки, поля, сайдбар (rem; дефолт 15px, не мельче 15px)'),
  t('--nr-text-md', 'type', 'length', 'B', 'кегль заголовков панелей, редактора сообщения (rem; дефолт 16px, не мельче 13px)'),
  t('--nr-text-lg', 'type', 'length', 'B', 'кегль крупного: пустое состояние (rem; дефолт 18px, не мельче 13px)'),
  t('--nr-text-body', 'type', 'length', 'B', 'кегль текста реплики (rem; дефолт 16px, не мельче 15px)'),
  t('--nr-leading-tight', 'type', 'number', 'B', 'интерлиньяж заголовков'),
  t('--nr-leading-ui', 'type', 'number', 'B', 'интерлиньяж интерфейса'),
  t('--nr-leading-body', 'type', 'number', 'B', 'интерлиньяж текста реплик'),
  t('--nr-radius', 'radius', 'length', 'B', 'радиус кнопок, чипов, карточек'),
  t('--nr-radius-lg', 'radius', 'length', 'B', 'радиус композера и крупных блоков'),
  t('--nr-space-1', 'space', 'length', 'B', 'шаг отступа 1 (2px)'),
  t('--nr-space-2', 'space', 'length', 'B', 'шаг отступа 2 (4px)'),
  t('--nr-space-3', 'space', 'length', 'B', 'шаг отступа 3 (6px)'),
  t('--nr-space-4', 'space', 'length', 'B', 'шаг отступа 4 (10px)'),
  t('--nr-space-5', 'space', 'length', 'B', 'шаг отступа 5 (16px)'),
  t('--nr-space-6', 'space', 'length', 'B', 'шаг отступа 6 (24px)'),
  t('--nr-density', 'space', 'number', 'B', 'множитель шкалы отступов: 0.85 плотно, 1.2 просторно'),
  t('--nr-code-comment', 'code', 'color', 'B', 'подсветка кода: комментарий'),
  t('--nr-code-keyword', 'code', 'color', 'B', 'подсветка кода: ключевое слово'),
  t('--nr-code-string', 'code', 'color', 'B', 'подсветка кода: строка'),
  t('--nr-code-number', 'code', 'color', 'B', 'подсветка кода: число'),
  t('--nr-code-title', 'code', 'color', 'B', 'подсветка кода: имя функции/класса'),
  t('--nr-code-type', 'code', 'color', 'B', 'подсветка кода: тип'),
  t('--nr-code-attr', 'code', 'color', 'B', 'подсветка кода: атрибут'),
  // ── декор ленты (уровень C) ──
  t('--nr-measure', 'space', 'length', 'C', 'мера строки: ширина колонки текста реплики (ch)'),
  t('--nr-rule', 'avatar', 'color', 'C', 'отбивка между сообщениями'),
  t('--nr-avatar-size', 'avatar', 'length', 'C', 'размер аватара персоны в ленте'),
  t('--nr-avatar-radius', 'avatar', 'length', 'C', 'скругление аватара (9999px — круг)'),
  t('--nr-message-gap', 'space', 'length', 'C', 'отступ под сообщением (по умолчанию 18px)'),
  t('--nr-gutter-w', 'avatar', 'length', 'C', 'ширина колонки автора слева (аватар, имя; по умолчанию 76px)'),
  t('--nr-author-user', 'text', 'color', 'C', 'цвет имени игрока/пользователя (по умолчанию --nr-muted)'),
  t('--nr-author-assistant', 'text', 'color', 'C', 'цвет имени ассистента/персонажа (по умолчанию --nr-accent)'),
  t('--nr-em', 'text', 'color', 'C', 'цвет курсива в реплике — РП-действия *…* (по умолчанию наследует)'),
  t('--nr-bg-app', 'bg', 'background', 'C', 'фон окна целиком (любое background: градиент, текстура)'),
  t('--nr-bg-chat', 'bg', 'background', 'C', 'фон колонки ленты (любое background)'),
  // ── форма контролов по ролям: рамка, тень, радиус, заливка, зазор ──
  t('--nr-ctl-border-w', 'radius', 'length', 'C', 'толщина рамки кнопки и чипа (по умолчанию 1px)'),
  t('--nr-ctl-line', 'bg', 'color', 'C', 'цвет рамки контролов, вкладок, строк и панелей (по умолчанию --nr-line)'),
  t('--nr-ctl-radius', 'radius', 'length', 'C', 'радиус кнопок, чипов, полей и строк (по умолчанию --nr-radius)'),
  t('--nr-ctl-shadow', 'radius', 'shadow', 'C', 'тень кнопки и чипа; жёсткая ступенька — «3px 3px 0 цвет» (пустая — 0 0 #0000)'),
  t('--nr-ctl-bg', 'bg', 'color', 'C', 'заливка кнопки и чипа (по умолчанию прозрачная)'),
  t('--nr-field-border-w', 'radius', 'length', 'C', 'толщина рамки поля ввода и выпадающего списка (по умолчанию 1px)'),
  t('--nr-field-line', 'bg', 'color', 'C', 'цвет рамки поля (по умолчанию --nr-line-soft)'),
  t('--nr-field-bg', 'bg', 'color', 'C', 'заливка поля (по умолчанию --nr-raised)'),
  t('--nr-field-shadow', 'radius', 'shadow', 'C', 'тень поля'),
  t('--nr-iconbtn-border-w', 'radius', 'length', 'C', 'толщина рамки кнопки-иконки (по умолчанию 0 — без рамки)'),
  t('--nr-iconbtn-shadow', 'radius', 'shadow', 'C', 'тень кнопки-иконки'),
  t('--nr-iconbtn-bg', 'bg', 'color', 'C', 'заливка кнопки-иконки (по умолчанию прозрачная)'),
  t('--nr-tab-border-w', 'radius', 'length', 'C', 'толщина рамки ярлыка вкладки (по умолчанию 0)'),
  t('--nr-tab-radius', 'radius', 'length', 'C', 'радиус ярлыка вкладки'),
  t('--nr-tab-shadow', 'radius', 'shadow', 'C', 'тень ярлыка вкладки'),
  t('--nr-tab-gap', 'space', 'length', 'C', 'зазор вокруг ярлыка вкладки: вкладки отдельными коробочками'),
  t('--nr-row-border-w', 'radius', 'length', 'C', 'толщина рамки строки списка (по умолчанию 0): пункты плашками'),
  t('--nr-row-bg', 'bg', 'color', 'C', 'заливка строки списка'),
  t('--nr-panel-border-w', 'radius', 'length', 'C', 'толщина рамки зоны оболочки (левая, центр, правая): панели карточками'),
  t('--nr-panel-radius', 'radius', 'length', 'C', 'радиус зоны оболочки'),
  t('--nr-panel-shadow', 'radius', 'shadow', 'C', 'тень зоны оболочки'),
  t('--nr-panel-gap', 'space', 'length', 'C', 'зазор между зонами и от края окна'),
  t('--nr-panel-divider', 'radius', 'length', 'C', 'линия между зонами, когда у панелей нет своей рамки (по умолчанию 1px; у карточек — 0)'),
  t('--nr-hover', 'bg', 'color', 'C', 'подсветка под курсором: строки, кнопки тулбара, пункты меню (по умолчанию текст 8%)'),
  t('--nr-ctl-bg-on', 'bg', 'color', 'C', 'заливка включённого переключателя: чип набора, кнопка тулбара, выбранная строка'),
  t('--nr-toolbtn-border-w', 'radius', 'length', 'C', 'толщина рамки кнопки тулбара (по умолчанию 0)'),
  t('--nr-toolbtn-bg', 'bg', 'color', 'C', 'заливка кнопки тулбара'),
  t('--nr-toolbtn-shadow', 'radius', 'shadow', 'C', 'тень кнопки тулбара'),
  t('--nr-tab-bg', 'bg', 'color', 'C', 'заливка вкладки панели'),
  t('--nr-tab-bg-on', 'bg', 'color', 'C', 'заливка выбранной вкладки панели'),
  t('--nr-tile-border-w', 'radius', 'length', 'C', 'толщина рамки плитки (эскиз, шаг ленты)'),
  t('--nr-tile-line', 'bg', 'color', 'C', 'цвет рамки плитки'),
  t('--nr-tile-radius', 'radius', 'length', 'C', 'радиус плитки'),
  t('--nr-tile-shadow', 'radius', 'shadow', 'C', 'тень плитки'),
  t('--nr-tile-bg', 'bg', 'color', 'C', 'заливка плитки'),
  t('--nr-panel-head-bg', 'bg', 'color', 'C', 'заливка шапки панели'),
  t('--nr-panel-head-font', 'fonts', 'font', 'C', 'шрифт заголовка панели (по умолчанию шрифт интерфейса)'),
  t('--nr-slider-thumb-radius', 'radius', 'length', 'C', 'скругление бегунка ползунка (9999px — круг)'),
  t('--nr-menu-border-w', 'radius', 'length', 'C', 'толщина рамки меню и выезжающей полки'),
  t('--nr-menu-radius', 'radius', 'length', 'C', 'радиус меню'),
  t('--nr-menu-shadow', 'radius', 'shadow', 'C', 'тень меню и полки (по умолчанию --nr-shadow-pop)'),
  t('--nr-statusbar-bg', 'bg', 'color', 'C', 'заливка строки состояния'),
  t('--nr-slot-border-w', 'radius', 'length', 'C', 'толщина рамки слота-приёмника (ячейка рефа)'),
  // ── полотно схемы: нода, пин, провод, плашка на связи, фон — необязательные, дефолты у ядра ──
  t('--nr-canvas-bg', 'bg', 'color', 'C', 'фон полотна схемы (по умолчанию фон с 3% текста)'),
  t('--nr-canvas-grid', 'bg', 'color', 'C', 'цвет точек сетки полотна'),
  t('--nr-canvas-grid-size', 'space', 'length', 'C', 'шаг сетки полотна (по умолчанию 20px)'),
  t('--nr-node-border-w', 'radius', 'length', 'C', 'толщина рамки ноды схемы (по умолчанию 1px)'),
  t('--nr-node-line', 'bg', 'color', 'C', 'цвет рамки ноды'),
  t('--nr-node-radius', 'radius', 'length', 'C', 'радиус ноды'),
  t('--nr-node-shadow', 'radius', 'shadow', 'C', 'тень ноды (ступенька, мягкая, нет)'),
  t('--nr-node-bg', 'bg', 'color', 'C', 'заливка ноды (по умолчанию --nr-raised)'),
  t('--nr-node-head-bg', 'bg', 'color', 'C', 'заливка шапки ноды'),
  t('--nr-node-head-font', 'fonts', 'font', 'C', 'шрифт шапки ноды (по умолчанию шрифт интерфейса)'),
  t('--nr-node-player-line', 'accent', 'color', 'C', 'рамка ноды-места игрока (пунктир; по умолчанию акцент)'),
  t('--nr-node-fill', 'bg', 'background', 'C', 'градиент поверх заливки ноды (пергамент; по умолчанию none)'),
  t('--nr-node-fg', 'bg', 'color', 'C', 'текст на ноде (светлая нода на тёмном полотне; по умолчанию --nr-fg)'),
  t('--nr-node-muted', 'bg', 'color', 'C', 'приглушённый текст на ноде (по умолчанию --nr-muted)'),
  t('--nr-node-accent', 'accent', 'color', 'C', 'акцент на ноде: подписи, выделение (по умолчанию акцент)'),
  t('--nr-node-text-min', 'space', 'length', 'C', 'нижняя граница текста на ноде (правило полотна — 13px)'),
  t('--nr-node-icon-min', 'space', 'length', 'C', 'нижняя граница значка на ноде (правило полотна — 32px)'),
  t('--nr-canvas-fill', 'bg', 'background', 'C', 'градиент под сеткой полотна (по умолчанию none)'),
  t('--nr-pin-size', 'radius', 'length', 'C', 'диаметр пина (по умолчанию 12px)'),
  t('--nr-pin-border-w', 'radius', 'length', 'C', 'толщина обводки пина'),
  t('--nr-pin-line', 'bg', 'color', 'C', 'обводка пина без типа'),
  t('--nr-pin-radius', 'radius', 'length', 'C', 'скругление пина (9999px — круг, 2px — квадрат)'),
  t('--nr-pin-bg', 'bg', 'color', 'C', 'заливка пустого пина'),
  t('--nr-type-1', 'accent', 'color', 'C', 'цвет типа 1 пинов и проводов (по умолчанию акцент)'),
  t('--nr-type-2', 'accent', 'color', 'C', 'цвет типа 2 (по умолчанию акцент, оттенок +70°)'),
  t('--nr-type-3', 'accent', 'color', 'C', 'цвет типа 3 (по умолчанию акцент, оттенок +150°)'),
  t('--nr-type-4', 'accent', 'color', 'C', 'цвет типа 4 (по умолчанию акцент, оттенок +230°)'),
  t('--nr-wire-w', 'radius', 'length', 'C', 'толщина провода'),
  t('--nr-wire-color', 'bg', 'color', 'C', 'цвет провода без типа'),
  t('--nr-wire-on-w', 'radius', 'length', 'C', 'толщина выделенного провода'),
  t('--nr-wire-dash', 'radius', 'keyword', 'C', 'пунктир привязки и тянущегося провода (stroke-dasharray, «5 4»)'),
  t('--nr-edge-label-border-w', 'radius', 'length', 'C', 'толщина рамки плашки на связи'),
  t('--nr-edge-label-bg', 'bg', 'color', 'C', 'заливка плашки на связи'),
  t('--nr-edge-label-radius', 'radius', 'length', 'C', 'радиус плашки на связи (9999px — пилюля)'),
  // ── иконки (icons-spec §2): картинку выбирает автор скина ──
  t('--nr-icon-pack', 'icons', 'keyword', 'C', 'пакет иконок: lucide (одноцветный, по умолчанию), office (многоцветный SVG в духе Office 97–2000), office2000 (картинки-предметы Office 2000 растром) или id папки envs/icon-packs; имени нет в пакете — lucide'),
  t('--nr-icon-style', 'icons', 'keyword', 'C', 'способ одноцветного пакета: outline — цветной контур, plate — белая иконка на цветной плашке (по умолчанию), duotone — контур и заливка оттенком; многоцветный пакет не перекрашивается'),
  t('--nr-icon-bar', 'icons', 'length', 'C', 'иконка тулбара и полосы разделов (по умолчанию 32px; картинка-предмет мельче 32 не читается —)'),
  t('--nr-icon-row', 'icons', 'length', 'C', 'иконка ряда действий под сообщением, шапки чата и композера (по умолчанию 20px)'),
  t('--nr-hit-row', 'icons', 'length', 'C', 'область нажатия кнопки-иконки ряда, отдельно от картинки (по умолчанию 32px, на сенсорном экране 44px)'),
  t('--nr-icon-stroke', 'icons', 'number', 'C', 'толщина линии одноцветного пакета в сетке 24 (по умолчанию по способу: outline 2.4, plate 2.25, duotone 2); тоньше 2.33 у outline — предупреждение'),
  t('--nr-emoji-font', 'icons', 'keyword', 'C', 'эмодзи: system (по умолчанию) или noto — встроенный Noto Color Emoji (OFL), ровный вид на всех платформах; woff2 кусками по unicode-range рядом с бандлом, грузится лениво'),
]

export const TOKEN_BY_NAME: ReadonlyMap<string, TokenSpec> = new Map(TOKENS.map((x) => [x.name, x]))

/** Палитра, без которой режим скина не рисуется (уровень A). */
export const REQUIRED_TOKENS: readonly string[] = TOKENS.filter((x) => x.level === 'A').map((x) => x.name)

/**
 * Пространства имён плагинов: `--nr-<ns>-*` задаёт скин для экрана плагина
 * (`--nr-tv-*` — экран NR Tavern, `--nr-sheet-*` — лист универсального редактора: фон, рамка
 * секции, акцент, шрифт). Ядро их не читает, валидатор пропускает.
 */
export const PLUGIN_TOKEN_PREFIXES: readonly string[] = ['--nr-tv-', '--nr-sheet-']

/** Служебные переменные ядра — скин их не трогает (числа слоёв, размеры колонок, рантайм). */
export const FORBIDDEN_TOKEN_PREFIXES: ReadonlyArray<{ prefix: string; why: string }> = [
  { prefix: '--nr-z-', why: 'слои (z-index) — не облик, скин их не двигает' },
  { prefix: '--nr-dock-', why: 'размер дока задаёт приложение' },
  { prefix: '--nr-root-size', why: 'размер текста — настройка пользователя (⌘=), не скин' },
]

/** Токены, в значении которых допустим `url(…)` (фон-картинка). */
export const URL_TOKENS: readonly string[] = ['--nr-bg-app', '--nr-bg-chat']

// ────────────────────────────────────────────────────────────────────────────
// Элементы ленты
// ────────────────────────────────────────────────────────────────────────────

export interface SelectorSpec {
  /** Каноническая запись звена селектора (без кавычек в атрибутах). */
  selector: string
  description: string
}

const ROLES = ['user', 'assistant', 'system'] as const

/**
 * Звенья селектора после корня `[data-skin="<имя>"]` (+ `[data-mode=…]`).
 * Цепочка — до трёх звеньев через пробел (потомок): `.nr-message[data-role=user] .nr-author`.
 */
export const ELEMENT_SELECTORS: readonly SelectorSpec[] = [
  { selector: '.nr-feed', description: 'лента: прокручиваемая колонка сообщений' },
  { selector: '.nr-message', description: 'сообщение: строка ленты (колонка автора + тело)' },
  ...ROLES.map((r) => ({ selector: `.nr-message[data-role=${r}]`, description: `сообщение роли ${r}` })),
  ...ROLES.map((r) => ({ selector: `[data-role=${r}]`, description: `то же, что .nr-message[data-role=${r}] (короткая запись)` })),
  { selector: '.nr-gutter', description: 'колонка автора слева: аватар, имя, модель' },
  { selector: '.nr-avatar', description: 'аватар персоны (размер — токен --nr-avatar-size)' },
  { selector: '.nr-author', description: 'имя автора реплики' },
  { selector: '.nr-body', description: 'тело сообщения: части и тулбар' },
  { selector: '.nr-text', description: 'текстовая часть реплики (markdown)' },
  { selector: '.nr-thinking', description: 'блок рассуждений модели (thinking)' },
  { selector: '.nr-tool', description: 'карточка вызова тула' },
  { selector: '.nr-composer', description: 'поле ввода реплики (высоту держит фронт: минимум COMPOSER_MIN_ROWS строк, рост до COMPOSER_MAX_SHARE высоты чата)' },
  // ── панель файлов и полоса клавиш (skin-spec §4.1): классы ставит плагин files-panel ──
  { selector: '.nr-panel', description: 'панель файлов: колонка списка (фон панели)' },
  { selector: '.nr-panel-active', description: 'панель в фокусе (её курсор — курсор Far; у соседней — без заливки)' },
  { selector: '.nr-panel-header', description: 'шапка панели: путь, заголовки колонок' },
  { selector: '.nr-panel-row', description: 'строка файла в панели' },
  { selector: '.nr-panel-cursor', description: 'строка под курсором панели' },
  { selector: '.nr-panel-selected', description: 'помеченная строка (Ins, пробел, +)' },
  { selector: '.nr-panel-cursor.nr-panel-selected', description: 'помеченная строка под курсором' },
  { selector: '.nr-panel-status', description: 'строка состояния под списком: файл под курсором, итог пометок' },
  { selector: '.nr-keybar', description: 'полоса клавиш F1–F10 внизу окна' },
  { selector: '.nr-keybar-key', description: 'клавиша полосы: номер и подпись' },
  { selector: '.nr-keybar-num', description: 'номер клавиши (1…10) в полосе' },
]

/**
 * Элементы, которые скин вправе скрыть — `display: none` и только это значение
 *: скрыть — не перевёрстка, место отдаёт вёрстка ядра. Скин `far` прячет
 * аватар — в строке Far нет картинок.
 */
export const ELEMENT_HIDEABLE: readonly string[] = ['.nr-avatar']

/**
 * Высота композера — гарантия фронта, не скина: поле не ниже
 * `COMPOSER_MIN_ROWS` строк своего кегля и интерлиньяжа и растёт по тексту до
 * `COMPOSER_MAX_SHARE` высоты чата, дальше — скролл внутри. Скин размеров не
 * задаёт (их нет в `ELEMENT_PROPERTIES`); `font-size`/`line-height`/`padding`
 * у `.nr-composer` меняют строку, но не число строк. Зеркало — `nrchat/src/chat/composerFit.ts`.
 */
export const COMPOSER_MIN_ROWS = 3
export const COMPOSER_MAX_SHARE = 0.4

/** Теги, допустимые только внутри `.nr-text` — разметка реплики. */
export const TEXT_TAGS: readonly string[] = ['p', 'em', 'strong', 'a', 'blockquote', 'code', 'li', 'h1', 'h2', 'h3', 'hr']

export const ELEMENT_SELECTOR_SET: ReadonlySet<string> = new Set(ELEMENT_SELECTORS.map((s) => s.selector))

/** Максимум звеньев после корня. */
export const MAX_ELEMENT_DEPTH = 3

/**
 * Свойства в элементных правилах (кроме `--nr-*`): цвет, рамка, шрифт,
 * прозрачность, внутренний отступ. Вёрстку (`display`, `position`, `margin`,
 * размеры, `transform`, `content`, `visibility`, `z-index`) скин не трогает.
 */
export const ELEMENT_PROPERTIES: readonly string[] = [
  'color',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-color',
  'border-width',
  'border-style',
  'border-left',
  'border-left-color',
  'border-left-width',
  'border-left-style',
  'border-right',
  'border-top',
  'border-bottom',
  'border-inline-start',
  'border-radius',
  'box-shadow',
  'outline-color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-variant',
  'font-feature-settings',
  'letter-spacing',
  'line-height',
  'text-transform',
  'text-decoration',
  'text-decoration-color',
  'text-shadow',
  'opacity',
  'padding',
  'padding-left',
  'padding-right',
  'padding-top',
  'padding-bottom',
  'padding-inline-start',
  'padding-block',
]

/**
 * Откуда веб-шрифты предпочтительны (`@import`, `@font-face src`): быстрые и без следов. Не
 * запрет (DECISIONS 05.11 «скин ничего не запрещает»): линтер пропускает любой https-хост,
 * список — совет агенту в выжимке.
 */
export const FONT_HOSTS: readonly string[] = ['fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.bunny.net']

/**
 * Палитра уровня A по умолчанию — встроенный `parchment` nrchat (`src/core/theme/skins/parchment.css`).
 * Ей `compileSkin` добивает дыры скина без `base` и без дефолтного скина в наборе (skin-spec §2 v1.1).
 */
export const DEFAULT_PALETTE: Readonly<Record<'light' | 'dark', Readonly<Record<string, string>>>> = {
  light: {
    '--nr-bg': '#f6efe3',
    '--nr-surface': '#efe6d8',
    '--nr-raised': '#fffaf0',
    '--nr-line': '#ddd0bb',
    '--nr-fg': '#1f1a14',
    '--nr-muted': 'rgb(31 26 20 / 0.7)',
    '--nr-accent': '#985518',
    '--nr-ok': '#5f6c33',
    '--nr-error': '#a8452c',
    '--nr-accent-fg': '#fffaf0',
    '--nr-line-soft': '#e3d7c4',
    '--nr-shadow-pop': '0 8px 26px rgb(31 26 20 / 0.1)',
  },
  dark: {
    '--nr-bg': '#171310',
    '--nr-surface': '#1a1613',
    '--nr-raised': '#1c1713',
    '--nr-line': '#2a231d',
    '--nr-fg': '#efe6da',
    '--nr-muted': 'rgb(239 230 218 / 0.72)',
    '--nr-accent': '#e0a458',
    '--nr-ok': '#8fa055',
    '--nr-error': '#c56849',
    '--nr-accent-fg': '#171310',
    '--nr-line-soft': '#241e19',
    '--nr-shadow-pop': '0 8px 26px rgb(0 0 0 / 0.5)',
  },
}

/** Дефолтный скин дистрибутива — источник дыр палитры, если он есть в наборе. */
export const DEFAULT_SKIN = 'parchment'

export type SkinMode = 'light' | 'dark' | 'both'
export const SKIN_MODES: readonly SkinMode[] = ['light', 'dark', 'both']

/** Имя скина: латиница/цифры/дефис, с буквы — оно же id в `data-skin` и имя файла. */
export const SKIN_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/
