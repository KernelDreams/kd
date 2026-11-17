/**
 * Библиотека правил ссылок без ввода-вывода (kd-cli-spec §4): те же случаи каскада, что у
 * сервиса `links` backend-http, но на текстах в памяти; плюс поиск в тексте и целое слово.
 */

import { describe, expect, it } from 'vitest'
import * as nrdModule from '@kerneldreams/nrd'
import { actionsFor, findLinkHits, matchWord, mergeLinkRules, parseLinksText, patternFrom, type LayeredLinksFile, type LinksNrd } from '../src/links-rules.js'

const nrd = nrdModule as unknown as LinksNrd

const STAND = [
  '## $link dev',
  "$pattern: 'TASK-\\d+'",
  '$kind: task',
  '',
  '## $action reveal-stand',
  '$for: file',
  '$run: host.reveal',
  '',
  '## $action torrent',
  '$for: magnet',
  '$run: exec',
  "$cmd: 'echo add'",
  '',
  '## $action zed',
  '$for: file',
  '$run: host.open',
].join('\n')
const AGENT = ['## $link dev', "$pattern: 'TASK-\\d+'", '$kind: url', "$label: 'задача ${text}'", '$icons: $[menu, expand]', '', '## $action zed', '$off: true'].join('\n')
const USER = ['## $action notify', '$for: file', '$run: exec', '$cmd: echo ${basename(path)}'].join('\n')
const SPACE = ['$links: $[extra.mdz]', '## $link nas', "$pattern: 'nas:/\\S+'", '$kind: file'].join('\n')

const layered = (trusted: boolean): LayeredLinksFile[] => [
  { layer: 'agent', trusted, file: parseLinksText(nrd, '/a.mdz', AGENT, 'agent') },
  { layer: 'space', trusted, file: parseLinksText(nrd, '/s.mdz', SPACE, 'space') },
  { layer: 'user', trusted, file: parseLinksText(nrd, '/u.mdz', USER, 'user') },
  { layer: 'stand', trusted: true, file: parseLinksText(nrd, '/st.mdz', STAND, 'stand') },
]

describe('links-rules: разбор и каскад', () => {
  it('сильный слой вытесняет одноимённое правило; $off снимает нижнее', () => {
    const r = mergeLinkRules(layered(true))
    const dev = r.links.find((l) => l.id === 'dev')!
    expect(dev).toMatchObject({ layer: 'agent', kind: 'url', pattern: 'TASK-\\d+', label: 'задача ${text}', icons: ['menu', 'expand'] })
    expect(r.links.filter((l) => l.id === 'dev')).toHaveLength(1)
    expect(r.off).toContain('zed')
    expect(r.actions.map((a) => a.id).sort()).toEqual(['notify', 'reveal-stand', 'torrent'])
    expect(r.layers.map((l) => l.layer)).toEqual(['agent', 'space', 'user', 'stand'])
  })
  it('включения $links отдаются как написаны — раскрывает вызывающий', () => {
    expect(parseLinksText(nrd, '/s.mdz', SPACE, 'space').includes).toEqual(['extra.mdz'])
  })
  it('без доверия exec/script пропадают, кроме слоя стенда', () => {
    const r = mergeLinkRules(layered(false), false)
    expect(r.actions.map((a) => a.id).sort()).toEqual(['reveal-stand', 'torrent'])
    expect(r.trusted).toBe(false)
  })
  it('действие без $for или $run — не действие', () => {
    const f = parseLinksText(nrd, '/x.mdz', ['## $action a', '$for: file', '', '## $action b', '$run: copy'].join('\n'), 'stand')
    expect(f.actions).toEqual([])
  })
})

describe('links-rules: совпадения', () => {
  it('в тексте — длиннее побеждает, хвостовая пунктуация снимается', () => {
    const pats = [
      { resolver: 'task', rule: 'dev', re: patternFrom('TASK-\\d+', 'dev')!, order: 1 },
      { resolver: 'url', rule: 'url', re: patternFrom('https?://\\S+', 'url')!, order: 2 },
    ]
    const hits = findLinkHits('см. TASK-10. и https://x/TASK-11)', pats, { trimTrailing: () => true })
    expect(hits.map((h) => h.text)).toEqual(['TASK-10', 'https://x/TASK-11'])
  })
  it('битый шаблон — null и причина в onError', () => {
    const errs: string[] = []
    expect(patternFrom('(', 'bad', (id) => errs.push(id))).toBeNull()
    expect(errs).toEqual(['bad'])
  })
  it('целое слово: только полное совпадение, длиннее и сильнее первым; группы — в named', () => {
    const r = mergeLinkRules([
      { layer: 'user', trusted: true, file: parseLinksText(nrd, '/u', ["## $link bot", "$pattern: 'https://bots\\.example/characters/(?<author>[^/]+)/(?<slug>[^/?#]+)'", '$kind: bot', '', '## $action play', '$for: bot', '$run: exec', '$cmd: x'].join('\n'), 'user') },
      { layer: 'stand', trusted: true, file: parseLinksText(nrd, '/s', ["## $link url", "$pattern: 'https?://\\S+'", '$kind: url', '', "## $link task", "$pattern: '[A-Z]+-\\d+'", '$kind: task'].join('\n'), 'stand') },
    ])
    const m = matchWord('https://bots.example/characters/ann/cat', r.links)
    expect(m.map((x) => x.rule.id)).toEqual(['bot', 'url'])
    expect(m[0]!.named).toEqual({ author: 'ann', slug: 'cat' })
    expect(matchWord('see TASK-42', r.links)).toEqual([])
    expect(matchWord('TASK-42', r.links).map((x) => x.rule.kind)).toEqual(['task'])
    expect(actionsFor(r, m[0]!.rule).map((a) => a.id)).toEqual(['play'])
  })
})
