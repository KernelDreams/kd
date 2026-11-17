/**
 * `kd app` — регистрации сборок в общем слое (kd-cli-spec §10): список, зарегистрировать, снять.
 * Сборка при установке пишет регистрацию сама (тот же формат); руками — по явному действию.
 */

import { resolve } from 'node:path'
import { listApps, registerApp, unregisterApp } from '../node/apps.js'
import { hostOf } from '../node/host.js'

export const tool = {
  description: 'сборки, зарегистрированные в общем слое: список, зарегистрировать, снять',
  fields: {
    id: 'string? $pos=1 $for=register,unregister // Id сборки',
    path: 'string? $kind=file $for=register // Корень сборки',
    tools: 'string[]? $for=register // Каталоги тулов от корня сборки',
    links: 'string[]? $for=register // Файлы правил объектов от корня сборки',
    name: 'string? $for=register // Имя для людей',
  },
  actions: { list: { title: 'регистрации и живы ли сборки', default: true }, register: { title: 'зарегистрировать сборку' }, unregister: { title: 'снять регистрацию' } },
  examples: ['kd app register pix --path=/Applications/KD\\ Pix.app/Contents/Resources/kit --links=kd-links.mdz', 'kd app'],
}

type Ctx = { get(p: string[]): unknown }
const s = (ctx: Ctx, k: string): string => (typeof ctx.get([k]) === 'string' ? (ctx.get([k]) as string) : '')
const list = (ctx: Ctx, k: string): string[] => {
  const v = ctx.get([k])
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : []
}

export default function app(ctx: Ctx): { output: string; exitCode?: number } {
  const h = hostOf()
  if (!h) return { output: 'kd app: только из kd', exitCode: 1 }
  const home = h.layers.copy.sharedHome
  const action = s(ctx, 'action') || 'list'
  if (action === 'list') {
    const apps = listApps(home)
    return { output: apps.length ? apps.map((a) => `${a.ok ? ' ' : '!'} ${a.id.padEnd(12)} ${a.path}${a.ok ? '' : '  (сборки нет — пропускается)'}`).join('\n') : `регистраций нет (${home}/apps)` }
  }
  const id = s(ctx, 'id')
  if (!id) return { output: `kd app: нужен id сборки\nkd app ${action} <id>`, exitCode: 2 }
  if (action === 'unregister') return unregisterApp(home, id) ? { output: `снята: ${id}` } : { output: `kd app: «${id}» не зарегистрирована`, exitCode: 2 }
  const path = s(ctx, 'path')
  if (!path) return { output: `kd app: нужен --path корня сборки\nkd app register ${id} --path=<папка>`, exitCode: 2 }
  const file = registerApp(home, { id, path: resolve(h.io.cwd, path), tools: list(ctx, 'tools'), links: list(ctx, 'links'), ...(s(ctx, 'name') ? { name: s(ctx, 'name') } : {}) })
  return { output: `зарегистрирована: ${file}` }
}
