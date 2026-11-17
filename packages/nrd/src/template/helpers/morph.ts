// Морфология для шаблонов (bot-graph-spec §1). Portable.
//
// Перенос archive/donors/ngen-core/morphology (прилагательные) + своя таблица
// местоимений. Род: h (муж.) | s (жен.) | o (сред.) | m (мн.). Падеж: i r d v t p.
// Значение-актёр — объект с полем `sex` (`m|f|n|pl` или `h|s|o|m`) либо `rod`.
//
//   << actor | rod >>              → 'h' | 's' | 'o' | 'm'
//   << 'красивый' | adj(actor, 'v') >>  → «красивую» (если actor женского рода)
//   << actor | pron('t') >>        → «ним» / «ней» / «ними»
//   << actor | pron('v', 'en') >>  → him / her / them
//   << actor | name('r') >>        → форма имени из actor.forms.r или name

import type nunjucks from 'nunjucks'

export type Rod = 'h' | 's' | 'o' | 'm'
export type Padej = 'i' | 'r' | 'd' | 'v' | 't' | 'p'

const PADEJ: Record<Padej, number> = { i: 0, r: 1, d: 2, v: 3, t: 4, p: 5 }

const ENDINGS: Record<'y' | 'niy' | 'kiy' | 'o', Record<Rod, string[]>> = {
  y: {
    h: ['ый', 'ого', 'ому', 'ый', 'ым', 'ом'],
    s: ['ая', 'ой', 'ой', 'ую', 'ой', 'ой'],
    o: ['ое', 'ого', 'ому', 'ое', 'ым', 'ом'],
    m: ['ые', 'ых', 'ым', 'ых', 'ыми', 'ых'],
  },
  niy: {
    h: ['ий', 'его', 'ему', 'ий', 'им', 'ем'],
    s: ['яя', 'ей', 'ей', 'юю', 'ей', 'ей'],
    o: ['ее', 'его', 'ему', 'ее', 'им', 'ем'],
    m: ['ие', 'их', 'им', 'их', 'ими', 'их'],
  },
  kiy: {
    h: ['ий', 'ого', 'ому', 'ий', 'им', 'ом'],
    s: ['ая', 'ой', 'ой', 'ую', 'ой', 'ой'],
    o: ['ое', 'ого', 'ому', 'ое', 'им', 'ом'],
    m: ['ие', 'их', 'им', 'их', 'ими', 'их'],
  },
  o: {
    h: ['ой', 'ого', 'ому', 'ой', 'ым', 'ом'],
    s: ['ая', 'ой', 'ой', 'ую', 'ой', 'ой'],
    o: ['ое', 'ого', 'ому', 'ое', 'ым', 'ом'],
    m: ['ые', 'ых', 'ым', 'ых', 'ыми', 'ых'],
  },
}

/** Местоимение 3-го лица по роду и падежу (после предлога — формы с «н»: «над ним»). */
const PRON_RU: Record<Rod, string[]> = {
  h: ['он', 'него', 'нему', 'него', 'ним', 'нём'],
  s: ['она', 'неё', 'ней', 'неё', 'ней', 'ней'],
  o: ['оно', 'него', 'нему', 'него', 'ним', 'нём'],
  m: ['они', 'них', 'ним', 'них', 'ними', 'них'],
}
/** Без предлога: «его», «ей», «им». */
const PRON_RU_BARE: Record<Rod, string[]> = {
  h: ['он', 'его', 'ему', 'его', 'им', 'нём'],
  s: ['она', 'её', 'ей', 'её', 'ей', 'ней'],
  o: ['оно', 'его', 'ему', 'его', 'им', 'нём'],
  m: ['они', 'их', 'им', 'их', 'ими', 'них'],
}
/** Английский: i — subject, v/r/d/t/p — object, `poss` — possessive. */
const PRON_EN: Record<Rod, { subj: string; obj: string; poss: string }> = {
  h: { subj: 'he', obj: 'him', poss: 'his' },
  s: { subj: 'she', obj: 'her', poss: 'her' },
  o: { subj: 'it', obj: 'it', poss: 'its' },
  m: { subj: 'they', obj: 'them', poss: 'their' },
}

const SEX_TO_ROD: Record<string, Rod> = {
  h: 'h', s: 's', o: 'o', m: 'h', f: 's', n: 'o', pl: 'm',
  male: 'h', female: 's', neuter: 'o', plural: 'm', м: 'h', ж: 's',
}

/** Род значения: строка-код, объект с `rod` / `sex` / `gender`. Неизвестно — мужской (как у донора). */
export function rodOf(value: unknown): Rod {
  if (typeof value === 'string') {
    if (value in SEX_TO_ROD) return SEX_TO_ROD[value]!
    return 'h'
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.rod === 'string' && v.rod in SEX_TO_ROD) return SEX_TO_ROD[v.rod]!
    for (const k of ['sex', 'gender'] as const) {
      const s = v[k]
      if (typeof s === 'string' && s.toLowerCase() in SEX_TO_ROD) return SEX_TO_ROD[s.toLowerCase()]!
    }
  }
  return 'h'
}

function padejOf(p: unknown): Padej {
  return typeof p === 'string' && p in PADEJ ? (p as Padej) : 'i'
}

function preserveCase(original: string, result: string): string {
  if (!original) return result
  return original[0] === original[0]!.toUpperCase() ? result.charAt(0).toUpperCase() + result.slice(1) : result
}

/** Склонить прилагательное (форма — муж. ед. им.: «красный», «синий», «великий», «голубой»). */
export function declineAdjective(word: string, rod: Rod = 'h', padej: Padej = 'i'): string {
  const lower = word.toLowerCase()
  let kind: keyof typeof ENDINGS | null = null
  if (lower.endsWith('ый')) kind = 'y'
  else if (lower.endsWith('ой')) kind = 'o'
  else if (lower.endsWith('ий')) kind = lower.length >= 3 && 'кгх'.includes(lower[lower.length - 3]!) ? 'kiy' : 'niy'
  if (!kind) return word
  return preserveCase(word, word.slice(0, -2) + ENDINGS[kind][rod][PADEJ[padej]])
}

/** Склонить каждое слово-прилагательное фразы (`«молодой красивый»`). Слова без окончания прилагательного — как есть. */
export function adj(phrase: unknown, who: unknown, padej: unknown = 'i'): string {
  if (typeof phrase !== 'string') return ''
  const rod = rodOf(who)
  const p = padejOf(padej)
  return phrase.replace(/[А-Яа-яЁё]+/g, (w) => declineAdjective(w, rod, p))
}

/**
 * Местоимение по актёру. `pron(actor, padej, mode)`: mode `prep` (по умолчанию для косвенных — «над ним»),
 * `bare` («его», «ей»), `en` (he/him/his — padej `i` subject, `poss` possessive, прочее object).
 */
export function pron(who: unknown, padej: unknown = 'i', mode: unknown = 'prep'): string {
  const rod = rodOf(who)
  if (mode === 'en') {
    const t = PRON_EN[rod]
    return padej === 'i' ? t.subj : padej === 'poss' ? t.poss : t.obj
  }
  const table = mode === 'bare' ? PRON_RU_BARE : PRON_RU
  return table[rod][PADEJ[padejOf(padej)]]!
}

/** Имя актёра в падеже: `forms.<padej>` если есть, иначе `name` (формы собственных имён — вручную, спека §7). */
export function nameOf(who: unknown, padej: unknown = 'i'): string {
  if (typeof who === 'string') return who
  if (!who || typeof who !== 'object') return ''
  const v = who as Record<string, unknown>
  const forms = v.forms as Record<string, unknown> | undefined
  const p = padejOf(padej)
  if (forms && typeof forms[p] === 'string') return forms[p] as string
  return typeof v.name === 'string' ? v.name : ''
}

/** Глагол прошедшего времени по роду: `past(actor, 'сделал', 'сделала', 'сделало', 'сделали')`. */
export function byRod(who: unknown, h: unknown, s: unknown, o?: unknown, m?: unknown): string {
  const rod = rodOf(who)
  const pick = rod === 's' ? s : rod === 'o' ? (o ?? h) : rod === 'm' ? (m ?? h) : h
  return typeof pick === 'string' ? pick : ''
}

// ---------- отчество и согласование фамилии (node-canvas-spec §7) ----------

/** Отчества-исключения: имя → [мужское, женское]. */
const PATRONYMIC_EXCEPTIONS: Record<string, [string, string]> = {
  лев: ['Львович', 'Львовна'],
  пётр: ['Петрович', 'Петровна'],
  петр: ['Петрович', 'Петровна'],
  павел: ['Павлович', 'Павловна'],
  михаил: ['Михайлович', 'Михайловна'],
  яков: ['Яковлевич', 'Яковлевна'],
  илья: ['Ильич', 'Ильинична'],
  фома: ['Фомич', 'Фоминична'],
  кузьма: ['Кузьмич', 'Кузьминична'],
  лука: ['Лукич', 'Лукинична'],
  никита: ['Никитич', 'Никитична'],
  савва: ['Саввич', 'Саввична'],
  любим: ['Любимович', 'Любимовна'],
}

/**
 * Отчество от имени отца: «Иван» → «Иванович» / «Ивановна», «Николай» → «Николаевич», «Игорь» → «Игоревич»,
 * «Никита» → «Никитич» / «Никитична». Род — код (`h|s`, `м|ж`) или актёр; не мужской и не женский — мужской.
 */
export function patronymic(father: unknown, who: unknown = 'h'): string {
  const name = typeof father === 'string' ? father.trim() : nameOf(father)
  if (!name) return ''
  const fem = rodArg(who, undefined) === 's'
  const low = name.toLowerCase()
  const ex = PATRONYMIC_EXCEPTIONS[low]
  if (ex) return preserveCase(name, fem ? ex[1] : ex[0])
  const last = low[low.length - 1]!
  const stem = name.slice(0, -1)
  let out: string
  if (last === 'й' || last === 'ь') out = stem + (fem ? 'евна' : 'евич')
  else if (last === 'а' || last === 'я') out = stem + (fem ? 'ична' : 'ич')
  else if ('жшчщц'.includes(last)) out = name + (fem ? 'евна' : 'евич')
  else out = name + (fem ? 'овна' : 'ович')
  return out
}

/**
 * Согласовать фамилию (или прилагательное) с родом: «Перов» → «Перова», «Пушкин» → «Пушкина»,
 * «Достоевский» → «Достоевская», «Толстой» → «Толстая»; несклоняемые («Черных», «Гюго», «Шевченко») — как есть.
 * Множественное: «Перовы», «Достоевские».
 */
export function agreeSurname(surname: unknown, who: unknown = 'h'): string {
  if (typeof surname !== 'string' || !surname) return typeof surname === 'string' ? surname : ''
  const rod = rodArg(who, undefined)
  if (rod === 'h' || rod === 'o') return surname
  const low = surname.toLowerCase()
  if (/(ский|цкий|ской|цкой|ый|ой|ий)$/.test(low)) return declineAdjective(surname, rod, 'i')
  if (/(ов|ев|ёв|ин|ын)$/.test(low)) return surname + (rod === 's' ? 'а' : 'ы')
  return surname
}

/** Род из буквы меты пилюли: м ж с мн → h s o m (прочее — как `rodOf`). */
const RU_ROD: Record<string, Rod> = { м: 'h', ж: 's', с: 'o', мн: 'm' }
function rodArg(v: unknown, ctx: unknown): Rod {
  if (typeof v === 'string' && v in RU_ROD) return RU_ROD[v]!
  if (v !== undefined && v !== null && v !== '') return rodOf(v)
  const c = ctx as { __rod?: unknown } | undefined
  if (c && typeof c.__rod === 'string') return rodArg(c.__rod, undefined)
  return 'h'
}
const RU_PADEJ: Record<string, Padej> = { и: 'i', р: 'r', д: 'd', в: 'v', т: 't', п: 'p' }

/** Регистр значения: «заглавная» — первая буква. */
export function titleCase(v: unknown): string {
  const s = typeof v === 'string' ? v : String(v ?? '')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Русские фильтры меты пилюли композита. Род без аргумента — род строки (`__rod` в контексте рендера).
 *   << отец | отчество >>   << отец | отчество('ж') >>   << фамилия | род('ж') >>   << прил | падеж('р') >>
 */
export function registerMorphRu(env: nunjucks.Environment): void {
  env.addFilter('отчество', function (this: { ctx?: unknown }, v: unknown, rod?: unknown) {
    return patronymic(v, rodArg(rod, this?.ctx))
  })
  env.addFilter('род', function (this: { ctx?: unknown }, v: unknown, rod?: unknown) {
    return agreeSurname(v, rodArg(rod, this?.ctx))
  })
  env.addFilter('падеж', function (this: { ctx?: unknown }, v: unknown, p?: unknown) {
    const pad = typeof p === 'string' ? (RU_PADEJ[p] ?? padejOf(p)) : 'i'
    return adj(typeof v === 'string' ? v : String(v ?? ''), rodArg(undefined, this?.ctx), pad)
  })
  env.addFilter('заглавная', (v: unknown) => titleCase(v))
  env.addFilter('прописные', (v: unknown) => String(v ?? '').toUpperCase())
  env.addFilter('строчные', (v: unknown) => String(v ?? '').toLowerCase())
}

export function registerMorph(env: nunjucks.Environment): void {
  env.addFilter('rod', (v: unknown) => rodOf(v))
  env.addFilter('adj', (phrase: unknown, who: unknown, padej?: unknown) => adj(phrase, who, padej))
  env.addFilter('pron', (who: unknown, padej?: unknown, mode?: unknown) => pron(who, padej, mode))
  env.addFilter('name', (who: unknown, padej?: unknown) => nameOf(who, padej))
  env.addFilter('byRod', (who: unknown, h: unknown, s: unknown, o?: unknown, m?: unknown) => byRod(who, h, s, o, m))
  env.addFilter('patronymic', (v: unknown, who?: unknown) => patronymic(v, who))
  env.addFilter('agree', (v: unknown, who?: unknown) => agreeSurname(v, who))
  registerMorphRu(env)
}
