import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_ID, canProjects, isProjectId, pluginsForWorkspace, projectIdOf, sessionProjectOf } from '../src/index.js'

describe('проекты (v1.26)', () => {
  it('canProjects — по capability workspace.projects', () => {
    expect(canProjects({})).toBe(false)
    expect(canProjects({ workspace: { switch: true } })).toBe(false)
    expect(canProjects({ workspace: { projects: true } })).toBe(true)
  })

  it('sessionProjectOf: нет пометки — default', () => {
    expect(sessionProjectOf(undefined)).toBe(DEFAULT_PROJECT_ID)
    expect(sessionProjectOf({ workspace: { cwd: '/x' } })).toBe('default')
    expect(sessionProjectOf({ workspace: { project: '' } })).toBe('default')
    expect(sessionProjectOf({ workspace: { project: 'slots' } })).toBe('slots')
  })

  it('projectIdOf: имя → имя файла', () => {
    expect(projectIdOf('nrchat')).toBe('nrchat')
    expect(projectIdOf('  Meadow Fortune!  ')).toBe('meadow-fortune')
    expect(projectIdOf('Слоты')).toBe('project')
    expect(isProjectId('meadow-fortune')).toBe(true)
    expect(isProjectId('../x')).toBe(false)
    expect(isProjectId('.hidden')).toBe(false)
  })

  it('pluginsForWorkspace: стенда всегда, проекта — только при нём', () => {
    const all = [{ id: 'hello' }, { id: 'cc', workspace: 'nrchat' }, { id: 'reels', workspace: 'slots' }]
    expect(pluginsForWorkspace(all, 'nrchat').map((p) => p.id)).toEqual(['hello', 'cc'])
    expect(pluginsForWorkspace(all, 'default').map((p) => p.id)).toEqual(['hello'])
    expect(pluginsForWorkspace(all, undefined).map((p) => p.id)).toEqual(['hello'])
  })
})
