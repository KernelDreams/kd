// разбор вывода git и сводка по папкам — на выводе настоящего git во временной репе и на строках.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  STASH_FORMAT,
  classifyGitError,
  collectDecorations,
  gitCodes,
  gitDecorationProvider,
  gitLookup,
  parseBlame,
  parseBranches,
  parseLog,
  parseNameStatus,
  parseStashList,
  parseStatus,
  repoRel,
} from '../src/index.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'nrf-git-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', LC_ALL: 'C' }
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' })

git('init', '-q', '-b', 'master')
mkdirSync(join(root, 'src', 'deep'), { recursive: true })
mkdirSync(join(root, 'tmp', 'x'), { recursive: true })
mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'a.txt'), 'a\n')
writeFileSync(join(root, 'b.txt'), 'b\n')
writeFileSync(join(root, 'old name.txt'), 'old\n')
writeFileSync(join(root, 'src', 'deep', 'm.ts'), 'one\ntwo\n')
writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n')
git('add', '-A')
git('commit', '-q', '-m', 'first')
writeFileSync(join(root, 'a.txt'), 'a2\n')
writeFileSync(join(root, 'src', 'deep', 'm.ts'), 'one\nTWO\n')
writeFileSync(join(root, 'new.txt'), 'n\n')
writeFileSync(join(root, 'tmp', 'x', 'y.txt'), 'y\n')
writeFileSync(join(root, 'build', 'out.js'), 'o\n')
writeFileSync(join(root, 'debug.log'), 'l\n')
git('rm', '-q', 'b.txt')
git('mv', 'old name.txt', 'new name.txt')
git('add', 'a.txt')
writeFileSync(join(root, 'a.txt'), 'a3\n')

describe('status porcelain v2', () => {
  const st = parseStatus(git('status', '--porcelain=v2', '-z', '--branch'))

  it('ветка и файлы с буквами', () => {
    expect(st.branch.head).toBe('master')
    expect(st.branch.oid).toMatch(/^[0-9a-f]{40}$/)
    const by = Object.fromEntries(st.files.map((f) => [f.path, f]))
    expect(by['a.txt']).toMatchObject({ code: 'M', index: 'M', work: 'M' })
    expect(by['b.txt']).toMatchObject({ code: 'D' })
    expect(by['new name.txt']).toMatchObject({ code: 'R', orig: 'old name.txt' })
    expect(by['src/deep/m.ts']).toMatchObject({ code: 'M', index: '.', work: 'M' })
    expect(by['new.txt']).toMatchObject({ code: '?' })
    expect(by['tmp/']).toMatchObject({ code: '?' })
  })

  it('сводка: корень, папка — худший статус внутри, каталог не под git целиком; игнор по check-ignore', () => {
    const names = ['a.txt', 'new.txt', 'src', 'tmp', 'build', 'debug.log', 'new name.txt', '.gitignore']
    const codes = gitCodes(root, root, st.files, names, ['build', 'debug.log'])
    expect(Object.fromEntries(codes)).toEqual({ 'a.txt': 'M', 'b.txt': 'D', 'new name.txt': 'R', src: 'M', 'new.txt': '?', tmp: '?', build: '!', 'debug.log': '!' })
    expect(Object.fromEntries(gitCodes(root, join(root, 'src'), st.files, ['deep']))).toEqual({ deep: 'M' })
    expect(Object.fromEntries(gitCodes(root, join(root, 'tmp', 'x'), st.files, ['y.txt']))).toEqual({ 'y.txt': '?' })
    expect(gitCodes(root, '/elsewhere', st.files, ['a']).size).toBe(0)
  })

  it('конфликт — U, ↑/↓ против upstream', () => {
    const u = parseStatus('# branch.oid abc\0# branch.head topic\0# branch.upstream origin/topic\0# branch.ab +2 -3\0u UU N... 100644 100644 100644 100644 a b c x/conf.txt\0')
    expect(u.branch).toEqual({ head: 'topic', oid: 'abc', upstream: 'origin/topic', ahead: 2, behind: 3 })
    expect(u.files).toEqual([{ path: 'x/conf.txt', code: 'U', index: 'U', work: 'U' }])
    expect(Object.fromEntries(gitCodes('/r', '/r', [...u.files, { path: 'x/m', code: 'M', index: '.', work: 'M' }], ['x']))).toEqual({ x: 'U' })
    expect(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').branch).toEqual({ head: null, oid: null, ahead: 0, behind: 0 })
  })

  it('gitLookup — по абсолютным путям (дерево)', () => {
    const at = gitLookup(root, st.files)
    expect(at(join(root, 'a.txt'))).toBe('M')
    expect(at(join(root, 'src'))).toBe('M')
    expect(at(join(root, 'src', 'deep'))).toBe('M')
    expect(at(join(root, 'tmp'))).toBe('?')
    expect(at(join(root, 'tmp', 'x', 'y.txt'))).toBe('?')
    expect(at(join(root, '.gitignore'))).toBeUndefined()
    expect(at('/elsewhere/a')).toBeUndefined()
  })

  it('repoRel', () => {
    expect(repoRel('/r', '/r')).toBe('')
    expect(repoRel('/r/', '/r/a/b/')).toBe('a/b')
    expect(repoRel('/r', '/rr/a')).toBeNull()
  })

  it('поставщик пометок git', async () => {
    const p = gitDecorationProvider({ status: async (dir) => (dir.startsWith(root) ? { root, files: st.files } : null), ignored: async () => ['build'] })
    const m = await collectDecorations([p], root, [join(root, 'a.txt'), join(root, 'build'), join(root, '.gitignore')])
    expect(m.get(join(root, 'a.txt'))).toEqual([{ source: 'git', badge: 'M', tone: 'modified', title: 'изменён' }])
    expect(m.get(join(root, 'build'))?.[0]?.badge).toBe('!')
    expect(m.has(join(root, '.gitignore'))).toBe(false)
    expect((await collectDecorations([p], '/nope', ['/nope/a'])).size).toBe(0)
  })
})

describe('log, blame, файлы коммита, ветки, stash', () => {
  it('log с ветками, родителями и юникодом', () => {
    git('add', '-A')
    git('commit', '-q', '-m', 'второй: привет')
    const log = parseLog(git('log', `--format=${LOG_FORMAT}`, '--decorate=full', '-n', '5'))
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ author: 'T', email: 't@x', subject: 'второй: привет' })
    expect(log[0]!.refs.join(',')).toMatch(/HEAD -> /)
    expect(log[0]!.parents).toEqual([log[1]!.hash])
    expect(log[1]!.parents).toEqual([])
  })

  it('blame porcelain', () => {
    const b = parseBlame(git('blame', '--porcelain', '--', 'src/deep/m.ts'))
    expect(b.map((l) => [l.line, l.text])).toEqual([
      [1, 'one'],
      [2, 'TWO'],
    ])
    expect(b[0]!.summary).toBe('first')
    expect(b[1]!.summary).toBe('второй: привет')
    expect(b[0]!.author).toBe('T')
    expect(b[1]!.time).toBeGreaterThan(0)
  })

  it('name-status -z: изменения коммита с переименованием', () => {
    const ch = parseNameStatus(git('show', '--name-status', '-z', '-M', '--format=', 'HEAD'))
    const by = Object.fromEntries(ch.map((c) => [c.path, c]))
    expect(by['a.txt']?.status).toBe('M')
    expect(by['b.txt']?.status).toBe('D')
    expect(by['new name.txt']).toMatchObject({ status: 'R', orig: 'old name.txt' })
    expect(by['tmp/x/y.txt']?.status).toBe('A')
  })

  it('ветки: текущая первой, локальные до удалённых', () => {
    git('branch', 'zeta')
    const br = parseBranches(git('for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'))
    expect(br.map((b) => [b.name, b.current, b.remote])).toEqual([
      ['master', true, false],
      ['zeta', false, false],
    ])
    const r = parseBranches(`*\x1frefs/heads/m\x1fm\x1fabc\x1forigin/m\x1f[ahead 1, behind 2]\x1f1\x1fs\n \x1frefs/remotes/origin/HEAD\x1forigin\x1fabc\x1f\x1f\x1f1\x1fs\n \x1frefs/remotes/origin/m\x1forigin/m\x1fdef\x1f\x1f\x1f1\x1fs\n`)
    expect(r.map((b) => b.name)).toEqual(['m', 'origin/m'])
    expect(r[0]).toMatchObject({ upstream: 'origin/m', ahead: 1, behind: 2 })
  })

  it('stash list', () => {
    writeFileSync(join(root, 'a.txt'), 'stash me\n')
    git('stash', 'push', '-q', '-m', 'моя заначка')
    const s = parseStashList(git('stash', 'list', `--format=${STASH_FORMAT}`))
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ ref: 'stash@{0}', message: 'On master: моя заначка' })
  })
})

describe('ошибки git', () => {
  it('доступ, non-ff, конфликт, грязная копия', () => {
    expect(classifyGitError('fatal: could not read Username for https://x: terminal prompts disabled', 'origin')).toEqual({ kind: 'access', text: 'нужен доступ к origin' })
    expect(classifyGitError('git@x: Permission denied (publickey).\nfatal: Could not read from remote repository.').kind).toBe('access')
    expect(classifyGitError(' ! [rejected]        master -> master (fetch first)\nerror: failed to push some refs').kind).toBe('non-ff')
    expect(classifyGitError('CONFLICT (content): Merge conflict in a.txt').kind).toBe('conflict')
    expect(classifyGitError('error: Your local changes to the following files would be overwritten by checkout:').kind).toBe('dirty')
    expect(classifyGitError('boom').text).toBe('boom')
  })
})

describe('источник «ветка против базы» в состоянии вкладки', async () => {
  const { decodeState, encodeState, goTo } = await import('../src/index.js')
  it('vs ↔ against; переход в каталог — обычный каталог', () => {
    const s = decodeState({ path: '/w', vs: 'master' })
    expect(s.against).toBe('master')
    expect(encodeState(s).vs).toBe('master')
    expect(goTo(s, '/w/x').against).toBeUndefined()
  })
})
