// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

interface ExtensionManifest {
  version: string
  permissions: string[]
  background: Record<string, unknown>
  content_security_policy: { extension_pages: string }
  action?: { default_popup?: string }
  side_panel?: { default_path?: string }
  sidebar_action?: { default_panel?: string }
  browser_specific_settings?: {
    gecko?: {
      strict_min_version?: string
      data_collection_permissions?: { required?: string[] }
    }
  }
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as T
}

describe('Firefox build contract', () => {
  it('keeps release metadata and shared capabilities aligned with Chrome', async () => {
    const [chromeManifest, firefoxManifest, packageManifest] = await Promise.all([
      readJson<ExtensionManifest>('../manifest.json'),
      readJson<ExtensionManifest>('../manifest.firefox.json'),
      readJson<{ version: string }>('../package.json'),
    ])

    expect(firefoxManifest.version).toBe(packageManifest.version)
    expect(firefoxManifest.version).toBe(chromeManifest.version)
    // The three above must agree — that is the invariant this test exists for.
    // The literal value is not asserted, because pinning it here means editing a
    // test on every release, and a release that forgets teaches people to update
    // the expectation rather than look for the reason. What must hold is that the
    // version is a shape the stores accept.
    expect(chromeManifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    // The panel API is the one legitimate difference: Chrome declares the
    // `sidePanel` permission, Firefox has no such permission to request.
    expect(firefoxManifest.permissions).toEqual(chromeManifest.permissions.filter((name) => name !== 'sidePanel'))
    expect(chromeManifest.permissions).toContain('sidePanel')
    expect(firefoxManifest.permissions).not.toContain('sidePanel')
    expect(firefoxManifest.permissions).toContain('notifications')
    // The panel talks to the local bridge and nothing else. `connect-src` used
    // to also allow raw.githubusercontent.com, which no code ever used — it was
    // a permission granted to nobody in particular, so it was removed from both
    // manifests. A published extension should not carry network access it does
    // not exercise.
    expect(firefoxManifest.content_security_policy.extension_pages).toContain('ws://127.0.0.1:*')
    expect(firefoxManifest.content_security_policy.extension_pages).toContain('http://127.0.0.1:*')
    expect(firefoxManifest.content_security_policy.extension_pages).not.toContain('githubusercontent')
    expect(chromeManifest.content_security_policy.extension_pages).not.toContain('githubusercontent')
  })

  it('opens the same panel from the toolbar, through each browser own API', async () => {
    const [chromeManifest, firefoxManifest] = await Promise.all([
      readJson<ExtensionManifest>('../manifest.json'),
      readJson<ExtensionManifest>('../manifest.firefox.json'),
    ])

    // Chrome: a side panel, no popup (it would shadow the panel and cannot hold
    // the layout). Firefox: the sidebar, which the browser's own sidebar button
    // toggles, so no popup either.
    expect(chromeManifest.action?.default_popup).toBeUndefined()
    expect(firefoxManifest.action?.default_popup).toBeUndefined()
    expect(chromeManifest.side_panel?.default_path).toBe('control/index.html')
    expect(firefoxManifest.sidebar_action?.default_panel).toBe('control/index.html')
    expect(firefoxManifest.side_panel).toBeUndefined()
    expect(chromeManifest.sidebar_action).toBeUndefined()
  })

  it('never ships the removed chat client', async () => {
    const [chromeManifest, firefoxManifest] = await Promise.all([
      readJson<ExtensionManifest>('../manifest.json'),
      readJson<ExtensionManifest>('../manifest.firefox.json'),
    ])

    // The chat panel used to own these entry points; the control page is the
    // only UI now, and it is reached through the panel APIs above.
    for (const manifest of [chromeManifest, firefoxManifest]) {
      expect(manifest.action?.default_popup).toBeUndefined()
      expect(JSON.stringify(manifest)).not.toContain('panel/index.html')
      expect(JSON.stringify(manifest)).not.toContain('sidebar_action":{"default_title":"__MSG_actionTitle__","default_panel":"panel')
    }
  })

  it('uses a Firefox event page and AMO data-transmission declaration', async () => {
    const manifest = await readJson<ExtensionManifest>('../manifest.firefox.json')

    expect(manifest.background).toEqual({ scripts: ['background.js'] })
    expect(Number(manifest.browser_specific_settings?.gecko?.strict_min_version?.split('.')[0])).toBeGreaterThanOrEqual(140)
    expect(manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required?.sort()).toEqual([
      'browsingActivity',
      'personalCommunications',
      'websiteActivity',
      'websiteContent',
    ])
  })
})
