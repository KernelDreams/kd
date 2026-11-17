# nr-forms — конвенции

Пакет nrlib: форма по JSON Schema + `x-ui` (`./react`), разбор `## $form` (`.`, без DOM и зависимостей) и ядро
универсального редактора без DOM (`./editor`: описание, `check`, каталог, выражения ntpl; пиры nr-md, nrd, nunjucks).
Спека — `~/Studio/Projects/nrchat.dev/specs/universal-editor-spec.md` (§1 границы, §10 этапы). Потребитель — nrchat
(`src/core/forms/FormView.tsx` — адаптер ctx → `labels` + `ModelChooser`).

- Пакет не знает nrchat, `PluginContext`, бэкенд, файловую систему. Строки — `labels`, тема — токены `--nr-*`.
- Поменял `<ObjectEditor>` или виджеты — `npm run e2e` (тестовая страница `demo/editor.html`, §11 шаги 1–6; в worktree — `E2E_PORT_BASE`).
- `./react` не импортирует ядро выражений (`expr`, `catalog`, `check`): страж `tests/react-boundary.test.ts`.
- Поменял вид формы — `npm run screens` и e2e форм nrchat (forms2, pult, widget, palette, graph) до и после.
- После правки — `npm run build` (nrchat берёт `dist`, Tailwind nrchat сканирует `dist`).
- `.` не тянет зависимостей: его импортирует nrchat (адаптер FormView). Ядро редактора — только `./editor`.
- Фикстуры пробы — `tests/fixtures/probe`, пересобрать: `node scripts/probe-fixtures.mjs <каталог пробы>`.
