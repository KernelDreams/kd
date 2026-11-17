/**
 * Скины как данные (v1.21, skin-spec §5): бэкенд отдаёт список скинов и их
 * проверенный CSS, фронт регистрирует их у себя. Файлы, валидатор и
 * наследование — `@kerneldreams/skins`; здесь только шов.
 *
 * Провод (`serveBackend({skins})`):
 *   GET  /skins[?session=<id>]              → SkinInfo[]
 *   GET  /skins/<имя>.css[?session=<id>]    → text/css (собранный, с base)
 *   PUT  /skins/<имя>.css {css, sessionId?, description?, mode?, base?} → SkinSaveResult   (capability skins.save)
 *   PUT  /skins/current {name, mode}        → текущий выбор (выжимка агенту)               (capability skins.select)
 *   GET  /skins/user                        → text/css слоя пользователя (нет — 200, пусто)  (capability skins.user, v1.32)
 *   PUT  /skins/user {css}                  → записать user.css пользователя запроса         (capability skins.user, v1.32)
 *
 * user.css (v1.32, front-context-spec §6): свой CSS пользователя — слой БЕЗ
 * ограничений скина (любые селекторы, `@media`), фронт накладывает его
 * последним. Пользователь — тот, кто пришёл (гейт пользователей стенда);
 * без гейта — владелец стенда. Хранение — `<usersDir>/<id>/user.css` (nr-skins/node).
 */

import type { Capabilities } from './types.js'

export type SkinMode = 'light' | 'dark' | 'both'

export interface SkinInfo {
  /** Имя = `data-skin` = имя файла `<имя>.skin.css`. */
  name: string
  description?: string
  /** Какие режимы скин несёт; `light`/`dark` — фронт держит режим скина. */
  mode: SkinMode
  base?: string
  /** `shared` — `<root>/skins`, `workspace` — `.nr/skins` каталога сессии. */
  source: 'shared' | 'workspace'
  /** Шапка `source:` — откуда скин (репа темы, файл; конвертеры тем). */
  origin?: string
  /** Шапка `license:` — лицензия источника; список показывает рядом с именем. */
  license?: string
  /** Шапка `author:` — автор исходной темы. */
  author?: string
  /** Хэш собранного CSS: сменился — перезагрузить стиль. */
  hash: string
  /** Не собирается (CSS не разбирается, шапка, base): в списке есть, CSS не отдаётся. */
  error?: string
  errors?: string[]
  /** Замечания линтера (вне контракта, палитра добита, контраст): скин работает, список показывает счётчик. */
  warnings?: string[]
}

export interface SkinsListOpts {
  /** Сессия, чья рабочая область (`.nr/skins` каталога сессии) добавляется к общим. */
  sessionId?: string
}

export interface SkinSaveOpts extends SkinsListOpts {
  description?: string
  mode?: SkinMode
  base?: string
  /** Шапка `source:` / `license:` / `author:` (импорт темы). */
  origin?: string
  license?: string
  author?: string
}

export interface SkinSaveResult {
  ok: boolean
  skin?: SkinInfo
  path?: string
  errors?: string[]
  warnings?: string[]
}

export interface SkinSelection {
  name: string
  mode: 'light' | 'dark'
}

/** capability: skins */
export interface SkinsOps {
  list(opts?: SkinsListOpts): Promise<SkinInfo[]>
  /** Собранный CSS; сломанный — `bad_request`, нет — `not_found`. */
  css(name: string, opts?: SkinsListOpts): Promise<string>
  /** capability: skins.save — проверить и записать в рабочую область. Ошибки контракта — в результате, не throw. */
  save?(name: string, css: string, opts?: SkinSaveOpts): Promise<SkinSaveResult>
  /** capability: skins.select — фронт сообщает выбор пользователя. */
  select?(sel: SkinSelection): Promise<void>
  /**
   * capability: skins.user (v1.32) — user.css пользователя (пусто — `''`).
   * `userId` ставит транспорт (пользователь запроса); клиент его не передаёт.
   */
  userCss?(opts?: UserCssOpts): Promise<string>
  /** capability: skins.user (v1.32) — записать user.css (пустая строка — очистить). */
  saveUserCss?(css: string, opts?: UserCssOpts): Promise<void>
}

/** Чей user.css: id пользователя стенда; нет — владелец стенда. Ставит транспорт, не клиент. */
export interface UserCssOpts {
  userId?: string
}

export interface SkinsCapability {
  save?: boolean
  select?: boolean
  /** user.css пользователя: `userCss`/`saveUserCss` (v1.32). */
  user?: boolean
}

/** Есть ли у бэкенда скины (и операция `op`). */
export function canSkins(caps: Capabilities | null | undefined, op?: 'save' | 'select' | 'user'): boolean {
  const s = caps?.skins
  if (!s) return false
  return op ? s[op] === true : true
}
