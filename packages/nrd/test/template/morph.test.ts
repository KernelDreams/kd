import { describe, expect, it } from 'vitest'
import { adj, declineAdjective, nameOf, pron, rodOf, byRod, patronymic, agreeSurname } from '../../src/template/helpers/morph.js'
import { createEnv, render } from '../../src/template/engine.js'

const bree = { name: 'Бри', sex: 'f' }
const robin = { name: 'Робин', sex: 'm', forms: { t: 'Робином' } }

describe('морфология шаблонов (ABC-793)', () => {
  it('род из актёра', () => {
    expect(rodOf(bree)).toBe('s')
    expect(rodOf(robin)).toBe('h')
    expect(rodOf({ sex: 'pl' })).toBe('m')
    expect(rodOf('s')).toBe('s')
    expect(rodOf(undefined)).toBe('h')
  })
  it('прилагательные: таблица донора', () => {
    expect(declineAdjective('красный', 's', 'v')).toBe('красную')
    expect(declineAdjective('синий', 'm', 't')).toBe('синими')
    expect(declineAdjective('великий', 'h', 'r')).toBe('великого')
    expect(declineAdjective('Голубой', 's', 'i')).toBe('Голубая')
    expect(adj('молодой красивый', bree, 'v')).toBe('молодую красивую')
    expect(adj('молодой красивый', robin, 'v')).toBe('молодой красивый')
  })
  it('местоимения ru / en', () => {
    expect(pron(bree, 't')).toBe('ней')
    expect(pron(robin, 't')).toBe('ним')
    expect(pron(bree, 'r', 'bare')).toBe('её')
    expect(pron(robin, 'v', 'en')).toBe('him')
    expect(pron(bree, 'poss', 'en')).toBe('her')
    expect(pron(bree, 'i', 'en')).toBe('she')
  })
  it('имя в падеже и глагол по роду', () => {
    expect(nameOf(robin, 't')).toBe('Робином')
    expect(nameOf(bree, 't')).toBe('Бри')
    expect(byRod(bree, 'сказал', 'сказала')).toBe('сказала')
  })
  it('фильтры в ntpl', async () => {
    const env = await createEnv()
    const t = 'любит доминировать над << p | pron("t") >>; << "послушный" | adj(p) >> << p | byRod("сказал", "сказала") >>'
    expect(render(env, t, { p: bree })).toBe('любит доминировать над ней; послушная сказала')
    expect(render(env, t, { p: robin })).toBe('любит доминировать над ним; послушный сказал')
  })
})

describe('отчество и согласование фамилии', () => {
  it('отчество по роду', () => {
    expect(patronymic('Иван')).toBe('Иванович')
    expect(patronymic('Иван', 'ж')).toBe('Ивановна')
    expect(patronymic('Николай')).toBe('Николаевич')
    expect(patronymic('Олег', 's')).toBe('Олеговна')
    expect(patronymic('Игорь', 'ж')).toBe('Игоревна')
    expect(patronymic('Никита', 'ж')).toBe('Никитична')
    expect(patronymic('Илья')).toBe('Ильич')
    expect(patronymic('Лев', 'ж')).toBe('Львовна')
    expect(patronymic('Михаил')).toBe('Михайлович')
  })
  it('фамилия по роду', () => {
    expect(agreeSurname('Перов', 'ж')).toBe('Перова')
    expect(agreeSurname('Пушкин', 's')).toBe('Пушкина')
    expect(agreeSurname('Достоевский', 'ж')).toBe('Достоевская')
    expect(agreeSurname('Толстой', 'ж')).toBe('Толстая')
    expect(agreeSurname('Черных', 'ж')).toBe('Черных')
    expect(agreeSurname('Перов', 'м')).toBe('Перов')
    expect(agreeSurname('Перов', 'мн')).toBe('Перовы')
  })
  it('русские фильтры: род строки из контекста', async () => {
    const env = await createEnv()
    expect(render(env, "<< отец | отчество >> << ф | род >>", { отец: 'Олег', ф: 'Сидоров', __rod: 'ж' })).toBe('Олеговна Сидорова')
    expect(render(env, "<< отец | отчество('ж') >> << ф | род('ж') | прописные >>", { отец: 'Иван', ф: 'Перов' })).toBe('Ивановна ПЕРОВА')
    expect(render(env, '<< отец | отчество >>', { отец: 'Иван' })).toBe('Иванович')
  })
})
