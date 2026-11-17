/**
 * Резолвер ссылок (v1.54, nrchat.dev/specs/link-resolver-spec.md): правила
 * распознавания и действия ссылок — данные mdz (`links.mdz`) на каскаде слоёв
 * агент → пространство → пользователь → стенд (первый сильнее); встроенные (файл, адрес,
 * задача) — у фронта, правила хаба их перекрывают и дополняют.
 *
 * Сервис ядра `links` хаба:
 *   • `rules {agent?, space?, cwd?, user?}` → {@link LinkRules}: правила с сырыми `${}`;
 *   • `resolve {templates, vars}` → строки: `${}` подписей и наведения об слой `params`;
 *   • `run {action, vars, …слои}` → действие `$run: exec` на машине `$where` (только при доверии);
 *   • стрим `watch {…слои}` → кадр `changed`, когда файл любого слоя изменился.
 *
 * Фронт не знает бэкендов: нет сервиса `links` — работают встроенные.
 */

/** Id сервиса ядра. */
export const LINKS_SERVICE = 'links'
/** Кадр стрима `watch`: слои правил изменились — перечитать `rules`. */
export const LINKS_CHANGED_EVENT = 'changed'

/** Слой каскада, от сильного к слабому. */
export type LinkLayer = 'agent' | 'space' | 'user' | 'stand'
export const LINK_LAYERS: readonly LinkLayer[] = ['agent', 'space', 'user', 'stand']

/** Встроенные действия (`$run`), которые выполняет фронт. */
export const LINK_BUILTIN_RUNS = ['open', 'host.open', 'host.reveal', 'copy', 'copy.link', 'download', 'tab', 'web'] as const
export type LinkBuiltinRun = (typeof LINK_BUILTIN_RUNS)[number]

/** Тон статуса ссылки (как у чипа задачи). */
export type LinkTone = 'ok' | 'warn' | 'bad' | 'muted' | 'accent'

/** Блок `## $link <id>`: распознавание. Строки с `${}` — сырые, их резолвит `resolve`. */
export interface LinkRuleDef {
  id: string
  layer: LinkLayer
  /** Regex совпадения (без флагов; `g` ставит фронт). Нет — правило только дополняет kind / id ниже по цепочке. */
  pattern?: string
  /** `file`, `url`, `task`, `magnet`, … — открытый список. */
  kind?: string
  target?: string
  label?: string
  status?: string
  tone?: LinkTone
  /** Наведение строкой. */
  title?: string
  /** Наведение markdown с `${}`, лениво. */
  hover?: string
  /** Вид разворота: id из `linkViews` / `codeFences` (`task`, `image`, `audio`, `file`). */
  expand?: string
  /** Иконки рядом: `menu` (`⋯`), `expand`, id действий. Нет — `[menu]`. */
  icons?: string[]
  /** Id действия по клику. */
  default?: string
  /** Файл слоя (для отладки и «где правило»). */
  source?: string
}

/** Блок `## $action <id>`: действие ссылки. */
export interface LinkActionDef {
  id: string
  layer: LinkLayer
  /** Чьё: kind ссылки или id правила. */
  for: string
  title?: string
  icon?: string
  /** ⌥-клик. */
  alt?: boolean
  /** Клик. */
  default?: boolean
  /** Машина исполнения (`${device.host}`): имя из `$hosts`. */
  where?: string
  /** Встроенное ({@link LinkBuiltinRun}), `exec` (`cmd` на машине `where`) или `script` (модуль `path`). */
  run: string
  cmd?: string
  path?: string
  /** Адрес, который открыть на устройстве после успешного `exec` (окно удалённого браузера). */
  after?: string
  source?: string
}

/** Ответ `links.rules`. */
export interface LinkRules {
  /** Правила, сильный слой первым; одноимённые нижние уже вытеснены. */
  links: LinkRuleDef[]
  /** Действия всех слоёв (одноимённые — сильнейшее). */
  actions: LinkActionDef[]
  /** Id правил и действий, снятые `$off: true` (в том числе встроенные фронта). */
  off: string[]
  /** Прочитанные файлы слоёв (что подключено). */
  layers: { layer: LinkLayer; path: string; trusted: boolean }[]
  /** Собрано без доверия (гость): `exec`/`script` выброшены. */
  trusted: boolean
}

/** Контекст сборки слоёв (`rules`, `run`, `watch`). */
export interface LinkLayersInput {
  /** Агент сессии (`envs/agents/<id>.links.mdz`). */
  agent?: string
  /** Пространство (`$links` реестра `envs/projects/<id>.mdz`). */
  space?: string
  /** Рабочий каталог сессии: `.nr/links.mdz` вверх от него. */
  cwd?: string
  /** Пользователь (`envs/users/<id>/links.mdz`). */
  user?: string
}

/** `links.run`: результат `exec`. */
export interface LinkRunResult {
  code: number
  stdout: string
  stderr: string
  /** Где выполнялось. */
  where?: string
  /** `dryRun`: команда без исполнения. */
  command?: string
}

/** Гейт сервиса `links`. */
export function canLinks(caps: { services?: Record<string, { methods?: string[] }> } | null | undefined): boolean {
  return !!caps?.services?.[LINKS_SERVICE]?.methods?.includes('rules')
}
