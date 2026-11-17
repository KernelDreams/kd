/** gcloud для Vertex — этой машины (PATH, Homebrew, Cloud SDK Windows), не путь машины сборки комплекта. */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findGcloud, gcloudDirs } from '../src/provider.ts'

const disk = (...files: string[]) => (p: string): boolean => files.includes(p)

describe('findGcloud', () => {
  it('$gcloud машины сборки, которого здесь нет, — поиском: Homebrew на macOS без gcloud в PATH', () => {
    const at = '/opt/homebrew/share/google-cloud-sdk/bin/gcloud'
    expect(findGcloud('/home/user/google-cloud-sdk/bin/gcloud', { PATH: '/usr/bin:/bin' }, 'darwin', disk(at))).toBe(at)
  })
  it('явный путь, который есть, — он; PATH — раньше стандартных мест', () => {
    expect(findGcloud('/srv/sdk/gcloud', { PATH: '/usr/bin' }, 'linux', disk('/srv/sdk/gcloud', '/opt/homebrew/bin/gcloud'))).toBe('/srv/sdk/gcloud')
    expect(findGcloud(undefined, { PATH: '/x/bin:/usr/bin' }, 'darwin', disk('/x/bin/gcloud', '/opt/homebrew/bin/gcloud'))).toBe('/x/bin/gcloud')
  })
  it('Windows: gcloud.cmd в Cloud SDK у LocalAppData', () => {
    const env = { Path: 'C:\\Windows', LOCALAPPDATA: 'C:/Users/u/AppData/Local' }
    const at = join('C:/Users/u/AppData/Local', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd')
    expect(gcloudDirs(env, 'win32')[0]).toBe(join('C:/Users/u/AppData/Local', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin'))
    expect(findGcloud(undefined, env, 'win32', disk(at))).toBe(at)
  })
  it('нигде нет — null (провайдер выключен с причиной)', () => {
    expect(findGcloud('/home/user/google-cloud-sdk/bin/gcloud', { PATH: '/usr/bin' }, 'darwin', disk())).toBeNull()
  })
})
