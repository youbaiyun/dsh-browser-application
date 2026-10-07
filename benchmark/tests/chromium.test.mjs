import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { playwrightCacheRoot, systemBrowserCandidates } from '../lib/chromium.mjs'

test('Playwright cache root follows each platform convention', () => {
  assert.equal(
    playwrightCacheRoot({ platform: 'darwin', env: {}, home: '/Users/tester' }),
    join('/Users/tester', 'Library', 'Caches', 'ms-playwright'),
  )
  assert.equal(
    playwrightCacheRoot({ platform: 'linux', env: {}, home: '/home/tester' }),
    join('/home/tester', '.cache', 'ms-playwright'),
  )
  assert.equal(
    playwrightCacheRoot({ platform: 'linux', env: { XDG_CACHE_HOME: '/cache' }, home: '/home/tester' }),
    join('/cache', 'ms-playwright'),
  )
  assert.equal(
    playwrightCacheRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, home: 'C:\\Users\\tester' }),
    join('C:\\Users\\tester\\AppData\\Local', 'ms-playwright'),
  )
})

test('Playwright cache root honors an explicit browser cache path', () => {
  assert.equal(
    playwrightCacheRoot({ env: { PLAYWRIGHT_BROWSERS_PATH: './browser-cache' }, cwd: '/workspace', home: '/ignored' }),
    resolve('/workspace', 'browser-cache'),
  )
})

test('extension browser fallback excludes branded Chrome Stable', () => {
  const extensionCandidates = systemBrowserCandidates({ platform: 'darwin', requireExtensions: true })
  const baselineCandidates = systemBrowserCandidates({ platform: 'darwin' })

  assert.deepEqual(extensionCandidates, ['/Applications/Chromium.app/Contents/MacOS/Chromium'])
  assert.ok(baselineCandidates.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
  assert.ok(!extensionCandidates.some((candidate) => candidate.includes('Google Chrome.app')))
})
