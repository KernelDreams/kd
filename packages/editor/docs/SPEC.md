# nr-editor — спека v1

Редактор текстовых файлов kd. Один движок — CodeMirror 6, режимы по типу файла.
Потребители (позже, не в этой задаче): nrchat (плагин-вьюер), exz (Tauri), Trempel (Pixi, без React), сайты/CMS.

Решение принято (nrchat.dev/DECISIONS.md, 10.10.2026) — спека закрыта, не переобсуждать.

## Главные правила

1. **Сырой текст — источник правды.** Декорации никогда не меняют документ. `setText(x)` → `getText()` === `x` байт в байт (BOM, `\r\n`, хвостовые пробелы — всё сохраняется).
2. **Ядро без фреймворка.** Ванильный API поверх CM6; React — тонкая обёртка отдельным subpath.
3. **Всё тяжёлое — лениво.** Грамматики языков и TS-сервис грузятся `import()` при первом использовании режима. Базовый бандл (ядро + md) не тянет `typescript`.
4. **Не велосипед.** Live preview markdown — `@atomic-editor/editor` (MIT, экспортирует `inlinePreview` как CM6-расширение без React). Языки — `@codemirror/lang-*`. TS-сервис — `@valtown/codemirror-ts` (ISC) + `@typescript/vfs` в Web Worker. Своё — только синтаксис mdz.

## Пакет

- Имя: `@kerneldreams/editor`. TypeScript strict, ESM, Vite library mode, vitest. npm.
- Exports: `.` — ванильное ядро; `./react` — компонент `<NrEditor>`; `./worker` — точка входа TS-воркера.
- Публикацию НЕ делать (реестр — Gitea в локальной сети, опубликуем сами).

## API ядра

```ts
createEditor(opts: {
  parent: HTMLElement
  text?: string
  mode?: Mode            // явный режим, побеждает filename
  filename?: string      // режим по расширению
  readOnly?: boolean
  theme?: 'light' | 'dark' | 'auto'   // auto = prefers-color-scheme
  typescript?: boolean | { worker: Worker }  // TS-сервис для ts/tsx/js/jsx, по умолчанию false
  extensions?: Extension[]            // доп. CM6-расширения потребителя
  onChange?: (text: string) => void
  onSave?: (text: string) => void     // Mod-s
  onLinkClick?: (target: string) => void  // вики-ссылки [[x]] и инклуды $[[x]]
}): EditorHandle

interface EditorHandle {
  view: EditorView
  getText(): string
  setText(text: string): void         // без потери undo-истории не требуется
  setMode(mode: Mode): Promise<void>
  setTheme(theme: 'light' | 'dark' | 'auto'): void
  setReadOnly(v: boolean): void
  focus(): void
  destroy(): void
}

type Mode = 'md' | 'mdz' | 'mdd' | 'mds' | 'js' | 'ts' | 'jsx' | 'tsx'
          | 'json' | 'yaml' | 'css' | 'html' | 'text'
modeFromFilename(name: string): Mode   // экспортируется
```

Расширения → режим: `.md .markdown`→md, `.mdz`→mdz, `.mdd`→mdd, `.mds`→mds, `.js .mjs .cjs`→js, `.ts .mts .cts`→ts, `.jsx`, `.tsx`, `.json .json5`→json, `.yaml .yml`→yaml, `.css`, `.html .htm`→html, прочее → text. Составные: `x.slides.md`→md, `x.widget.mdz`→mdz (берётся последнее расширение).

React: `<NrEditor value onChange mode filename theme readOnly typescript extensions onSave ref>` — ref отдаёт `EditorHandle`. `value` контролируемый: внешняя смена `value` ≠ текущему тексту → `setText`.

## Режимы

### md
Live preview Atomic Editor (заголовки, жирный/курсив, ссылки, картинки, таблицы, task-листы, fenced code с ленивой подсветкой). Вики-ссылки `[[x]]` — включить, клик → `onLinkClick(target)`. Плюс слой mdd (сигил `@`) — см. ниже, `.md` может нести mdd-данные.

### mdz / mds (сигил `$`), mdd (сигил `@`)
То же, что md, плюс расширение синтаксиса nrd. Грамматика — `docs/mdz-syntax.md`. Реализовать как CM6-расширение (ViewPlugin с декорациями по строкам — грамматика построчная, Lezer не нужен):

- Заголовок блока `#{1,6} $name [id]` — имя блока и id разными классами; `## $@` / `## $` — закрытие блока (приглушённо).
- Атрибут `$key: value` (строка начинается с сигила + ключа + `:`) — ключ, двоеточие, значение разными классами. Значение-подтипы: `$[...]` flow-список, `{...}` JSON5-объект, `true/false/null/число` — свои классы.
- Ключи `nr-*` (`$nr-type` и т.д.) — отдельный класс «директива».
- Инклуд `$[[path]]` / `$[[path#Section]]` — как ссылка, клик → `onLinkClick(path)`.
- Плейсхолдер `${...}` (с вложенностью `${a.${b}}`) — подсветка в любом месте строки. `\${` — не плейсхолдер.
- Эскейпы `\$ \@ \[ \{ \,` — не триггерят разметку.
- `%role` в начале строки (`%user`, `%assistant`, `%system`, …) — конверт сообщения, заметный разделитель.
- Фенс из ЧЕТЫРЁХ бэктиков с `%type` — тело opaque (внутри разметку не искать), приглушённый блок, сворачивается.
- `$//` в начале строки — комментарий.
- Live preview НЕ прячет `$`/`@`-разметку — строки атрибутов и заголовки блоков остаются видимыми, только стилизуются. Обычный markdown в телах блоков рендерится live preview как в md.
- Сворачивание (fold) по заголовкам блоков: от `## $name` до следующего заголовка того же/старшего уровня.
- Сигил другого режима — обычный текст (в mdd строка `$key: v` — не атрибут, и наоборот).

### js / ts / jsx / tsx
`@codemirror/lang-javascript` с `typescript`/`jsx` флагами. При `typescript: true` — `@valtown/codemirror-ts`: диагностика, автокомплит, hover с типами. Сервис в Web Worker (`./worker`), ленивый. Работает и для js (checkJs off, только комплит/hover). Один виртуальный файл на редактор; модули/импорты между файлами — не в этой задаче.

### json / yaml / css / html
Соответствующие `@codemirror/lang-*` (yaml — `@codemirror/lang-yaml`). Ленивая загрузка.

### text
Без языка.

## Общее

- Тема: CSS-переменные на корне редактора (`--nre-bg`, `--nre-fg`, `--nre-accent`, классы токенов mdz тоже через переменные), светлая и тёмная. Шрифт — переменная, по умолчанию system monospace для кода и system sans для md-режимов.
- Keymap: стандартный CM6 + history + search (Mod-f) + Mod-s → onSave. Перенос строк включён в md-режимах, выключен в коде.
- Мобилка: нормально работает на ширине телефона (live preview Atomic Editor это уже держит — не сломать).

## Демо (`demo/`, Vite-приложение, `npm run demo`)

Слева список файлов-образцов, справа редактор, сверху: переключатель темы, тумблер TS-сервиса, кнопка «Dump» (показывает `getText()` и сверку с исходником: «identical: true/false»).
Образцы (`demo/samples/`): `readme.md` (все md-конструкции + вики-ссылки + `@`-атрибуты), `recipe.mdz` (блоки с id, атрибуты всех типов значений, `nr-*`, инклуды, `${}`, эскейпы, `$//`, вложенные блоки), `session.mds` (`%role`-конверты, четырёхбэктиковый фенс), `data.mdd`, `game.ts` (с намеренной ошибкой типов — видно диагностику), `component.tsx`, `config.json`, `ci.yaml`, `styles.css`, `page.html`.

## Тесты (vitest)

- `modeFromFilename` — все расширения из таблицы, составные, регистр.
- Round-trip: для каждого образца `createEditor({text}).getText() === text` (jsdom), включая текст с BOM и `\r\n`.
- Токенизатор mdz (чистая функция, отдельно от CM6): заголовки блоков (уровни, id, закрытие), атрибуты и подтипы значений, `nr-*`, инклуды, `${}` с вложенностью, эскейпы, `%role`, четыре бэктика, `$//`, чужой сигил.
- `tsc --noEmit` чистый, `npm run build` собирается, базовый бандл без `typescript` (проверка в тесте/скрипте по выходу сборки).

## Вне задачи

Файловая система, сохранение, коллаб/Yjs, плагин nrchat, интеграция в exz/Trempel, публикация пакета, межфайловые импорты TS, GitHub Pages.

## Сдача

PR в `main`. Описание PR кончается разделом **«Приёмка глазами»**: как поднять демо (`npm i && npm run demo`), шаги-клики по образцам, что должно быть видно; скриншоты демо (playwright) — `docs/screens/*.png` в PR: md-live-preview, mdz в светлой и тёмной теме, ts с диагностикой и hover, мобильная ширина.
