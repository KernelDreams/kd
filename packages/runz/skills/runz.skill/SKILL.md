---
name: runz
description: >
  Писать скрипты и appz на runz и @kerneldreams/nrd — форматы mdz/mdd/mds, IContext и резолв плейсхолдеров, сборка контекста и исполнение блоков, ступени nrd/web и nrd/node, шаблоны nrd/template, контракт runz-скрипта, конвенции. Используй ВСЕГДА при работе с runz или nrd: почти всё уже есть, свой парсер/шаблонизатор/HTTP — велосипед.
---

# use-nr — писать скрипты и appz на runz + nrd

**Файлы этого скилла лежат рядом с этим документом.**

**runz** запускает `.ts` и NRD-документы (`.md`/`.mdz`) без package.json, без
node_modules и без билда: Node гоняет TypeScript нативно, окружение и конфиги даёт
runz. **nrd** (`@kerneldreams/nrd`) — формат mdd/mdz, резолвер `${}`, сборка
контекста, исполнение блоков, шаблоны, платформенные ступени.

**Главное правило: перед тем как писать механизм — проверь таблицу ниже. Почти всё
уже есть.** Свой парсер конфигов, шаблонизатор, HTTP с ретраями — велосипед, он
будет отклонён на ревью.

## Маршрутизация по задаче

| Мне нужно… | Читай | Ключевое |
|---|---|---|
| Написать скрипт или appz: каркас, аргументы, `meta`, тесты | `runz.md` | `(ctx, meta) => ScriptResult`; данные — в `meta.dataDir` |
| Писать или читать mdz/mdd/mds: синтаксис, коэрсия, `%role` | `formats.md` | mdz `$` = исполнение (last-wins), mdd `@` = данные |
| Распарсить документ, ходить по данным, резолвить `${}` | `nrd.md` | всё — IContext: `get`/`func`/`cast`; свой парсер запрещён |
| Собрать контекст из `## $source`, исполнить блок | `nrd.md` | `buildContext`, `execBlock`; корневые атрибуты в результат не входят |
| HTTP, стриминг, LLM, эмбеды, storage, fs, spawn, discovery | `platform.md` | `nrd/web` — WinterCG, `nrd/node` — только Node; эмбеды — через CAS-кеш |
| Состояние документа одной JSON-строкой | `formats.md` | `toJson(doc.doc)` / `fromJson`, не свой обход дерева |
| Батч по документу: оси-списки, оси-таблицы, группы `## $batch`, CLI-схлопывание | `batch.md` | `planBatches` из `nrd/batch`; свой парсер списков и BFS по `${}` не пиши |
| Отрендерить шаблон | `template.md` | делимитеры `<{ }>` / `<< >>`; движки async, optional peers |
| Запустить шаблон/документ runz из хоста (плагин, сайдкар, мост): значения → `outputs`, отмена, строки вывода | `internal/runz-run.md` | `runTemplate`/`runFile`, не свой `spawn` + парсинг stdout |
| Долгий прогон вне окна: очередь, лимиты по ключам (`$jobs`, `$job_keys`), лог после смерти хоста, пачка, `runz job` | `internal/runz-run.md` § Задачи, `runz.md` § Задачи | `@kerneldreams/runz-run/jobs`, не `spawn` с `detached` руками |
| Сгенерить картинку, видео или музыку: BFL (+flux-3-video), nano-gpt, Google (Gemini image, Veo, Lyria — AI Studio и Vertex), comfy; из скрипта, батча, хоста | `platform.md` § медиа, `runz.md` § `helpers.image`/`video`/`audio` | один контракт `ImageProvider` (вид — `kind` модели); в runz — `helpers.*` и `resolveImageProvider`, свой клиент Gemini/Veo не пиши |
| ComfyUI: поставить workflow, прогресс и превью, отмена, загрузка картинок, роли входов, пустые рефы | `internal/comfy-client.md` | свои `/prompt`-запросы и ws-парсер не пиши |
| Нодовый редактор / граф шагов в UI: реестр прототипов, связи, группы, авто-раскладка, undo | `nr-nodes.md` | `@kerneldreams/nodes`: `/core` без React, `/ui` — `Canvas` + `useGraph`; свой канвас и dagre не тащи |
| Как здесь принято: пути, коммиты, README, тесты | `conventions.md` | коммитить каждое осмысленное состояние |

Все справочники — в `references/`.

## Жёсткие правила (нарушение = переделка)

- **Ядро stateless и IO-free.** Платформа инъектируется через capabilities и
  loaders; кеш — забота загрузчика, не либы.
- **Fail loud.** `Result` где принято, иначе явный throw; никаких молчаливых
  `undefined`. Ошибка пользователю — в stderr и ненулевой exit, не в `output`.
- **Данные скрипта — в `meta.dataDir`**, пути не хардкодить.
- **Тесты — часть определения «готово»:** чистая логика без теста не сделана.
- **`asText` ≠ `toText`.** `asText` — сужающий аксессор (не текст → `undefined`),
  `toText` — полная коэрсия с json5-дампом; подмена утекает содержимым контейнера.
- **Точка в ключе NRD — литерал:** `$a.b: 1` — ключ `"a.b"`, а не путь `a→b`.
- **Массивы из `ctx.get()` — `IArray`:** `Array.isArray` не сработает, нужны
  `isArray(v)`, `iterate()`/`at()`/`length()`.
- **`ScriptMeta`/`ScriptResult` — из `@kerneldreams/runz-runtime`**, не из `nrd`;
  `Result`/`isOk`/`isErr` — из корня `nrd`, не из `nrd/web`.
- **Любой `decode` TOON — строго с `{strict: false}`**: голый `decode(txt)` ломается
  на markdown-ссылках в значениях.
- **Разбираешь чужой документ — `trusted: false`**: тогда `exec`/`script`/`file`/`env`
  и fs-функции не подключаются.

Расширения студии — `references/internal/`, вне OSS (в bundle `runz` не входят):
`runz-run.md`, `comfy-client.md` (выше), `nr-web.md` (доставка
HTTP/CDP, `fetchTransport(opts)` с таймаутом и лимитом тела), `nr-cards.md`
(Character Card: `readCard` любой формы, `cardToPng`).
