import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { apply, assertPositiveInteger, buildVisionClient, BROWSER_PROMPT_MARKER_RULE, BROWSER_PROMPT_PREAMBLE, BROWSER_TASK_LIST_RULE, Config, DEFAULT_EXTENSION_ID, resolveConfig, resolveVisionClient } from '../src/index.ts'
import { VISION_MODEL } from '@dsh-browser/protocol'

/** Minimal context stub: apply only needs the services at registration time. */
function stubContext(): Context {
  const gateway = {
    wireStream: {
      open: async (): Promise<AsyncIterable<unknown>> => ({
        async *[Symbol.asyncIterator]() { yield { type: 'ready', clientId: 'test', host: { home: '/tmp' } } },
      }),
      failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }),
    },
    invoke: async () => undefined,
  }
  const connection = {
    createSharedFetchHandler: () => ({ fetch: async () => new Response('not found', { status: 404 }) }),
  }
  return {
    webServer: { port: 0, registerUpgrade: () => () => {}, register: () => () => {} },
    tools: { register: () => () => {} },
    agents: { get: () => undefined },
    get: (key: string) => key === 'typertGateway' ? gateway : key === 'connection' ? connection : undefined,
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown, label?: string) => {
      void label
      return fn() as () => void
    },
  } as unknown as Context
}

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('system prompt text', () => {
  it('keeps the assembled section ASCII-only, so a page has no homoglyph to smuggle', () => {
    // The extension marks user panel input with an origin marker; that marker is
    // deliberately not quoted in the prompt, so the prompt must stay plain ASCII.
    for (const [label, text] of [['preamble', BROWSER_PROMPT_PREAMBLE], ['marker rule', BROWSER_PROMPT_MARKER_RULE], ['task list rule', BROWSER_TASK_LIST_RULE]] as const) {
      const offenders = [...text].filter((character) => character.charCodeAt(0) > 0x7f)
      expect(offenders, `${label} must stay ASCII-only: found ${offenders.join('')}`).toEqual([])
    }
  })

  it('describes the marker by origin instead of quoting it', () => {
    expect(BROWSER_PROMPT_MARKER_RULE).toContain('origin marker')
    // A quoted literal marker would hand a page the exact string to impersonate.
    expect(BROWSER_PROMPT_MARKER_RULE).not.toContain('[用户')
    expect(BROWSER_PROMPT_PREAMBLE).not.toContain('[用户')
  })
})

describe('assertPositiveInteger', () => {
  it('accepts positive integers and rejects everything else', () => {
    expect(() => assertPositiveInteger('x', 1)).not.toThrow()
    expect(() => assertPositiveInteger('x', 0)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', -1)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', 1.5)).toThrow(/must be a positive integer/)
  })
})

/** Valid budgets (the Loader applies schema defaults; hand-built tests pass them explicitly). */
const VALID = { toolTimeoutMs: 90_000, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

/** Vision is off until a key is configured, so its defaults are inert. */
const VISION_DEFAULTS = {
  visionApiKey: '',
  visionBaseUrl: 'https://api.deepseek.com/v1',
  visionModel: VISION_MODEL,
  visionThinking: 'off',
  visionTimeoutMs: 20_000,
}

/** Launching is off until a browser is configured; detection happens at launch time. */
const LAUNCH_DEFAULTS = {
  browserExecutablePath: '',
  extensionPath: '',
  browserUserDataDir: '',
  browserLaunchArgs: [],
  browserHeadless: false,
  browserLaunchTimeoutMs: 25_000,
}

describe('vision source', () => {
  it('prefers a configured key and never asks the credential service', async () => {
    const client = await resolveVisionClient(
      { get: () => { throw new Error('the credential service must not be consulted when a key is configured') } },
      resolveConfig({ ...VALID, visionApiKey: 'configured' }),
    )
    expect(client).toBeDefined()
  })

  it('falls back to the credential the desktop already holds', async () => {
    // `DEEPSEEK_API_KEY` by name: a CredentialRef is an environment-variable name
    // layered over the environment, the managed store and `.env` files.
    const asked: string[] = []
    const client = await resolveVisionClient({
      get: (name) => name === 'credentials'
        ? { resolve: async (ref: string) => { asked.push(ref); return { value: 'from-store', source: 'store' } } }
        : undefined,
    }, resolveConfig({ ...VALID }))
    expect(client).toBeDefined()
    expect(asked).toEqual(['DEEPSEEK_API_KEY'])
  })

  it('never borrows the account token, which the public API rejects', async () => {
    // The first fallback asked `deepseekAccount` and got a platform token; the API
    // answered 401 about a key nobody wrote. That service must not be consulted.
    const client = await resolveVisionClient({
      get: (name) => {
        if (name === 'deepseekAccount') throw new Error('the account service must not be used')
        return undefined
      },
    }, resolveConfig({ ...VALID }))
    expect(client).toBeUndefined()
  })

  it('stays unavailable when the credential resolves to nothing', async () => {
    const config = resolveConfig({ ...VALID })
    expect(await resolveVisionClient({ get: () => undefined }, config)).toBeUndefined()
    expect(await resolveVisionClient({ get: () => ({ resolve: async () => undefined }) }, config)).toBeUndefined()
    expect(await resolveVisionClient({
      get: () => ({ resolve: async () => ({ value: '   ', source: 'x' }) }),
    }, config)).toBeUndefined()
    expect(await resolveVisionClient({
      get: () => ({ resolve: async () => { throw new Error('no store') } }),
    }, config)).toBeUndefined()
  })

  it('names one image-capable model, by its API id, as the default that can be overridden', () => {
    // `deepseek-v4.1-flash` is the display name and answers 400; the API lists
    // `deepseek-flash` and `deepseek-v4-pro`, and only the first accepts an image.
    expect(VISION_MODEL).toBe('deepseek-flash')
    // Unset or cleared resolves to that id, so an install nobody configured — and a
    // config whose field was emptied — are both correct rather than broken.
    expect(resolveConfig({ ...VALID }).visionModel).toBe('deepseek-flash')
    expect(resolveConfig({ ...VALID, visionModel: '' }).visionModel).toBe('deepseek-flash')
    // But the field is configuration, because `visionBaseUrl` is: pointing this at
    // another provider while the id stayed fixed would send a name that provider has
    // never heard of. A wrong id is not silent — the provider's own 400 lists the
    // names it accepts, which is how this one was found.
    expect(resolveConfig({ ...VALID, visionModel: 'custom-vision' }).visionModel).toBe('custom-vision')
  })

  it('falls back rather than throwing when a direct caller passes a non-string model', () => {
    // The Loader always runs the schema first, but a hand-built config never does,
    // and `.trim()` on a number used to throw a TypeError where the field's old
    // `??` form simply took the fallback.
    const handBuilt = { ...VALID, visionModel: 42 } as unknown as Config
    expect(resolveConfig(handBuilt).visionModel).toBe('deepseek-flash')
  })

  it('asks for thinking off by default', () => {
    // On a perception task the reasoning tokens cost more than the image does.
    expect(resolveConfig({ ...VALID }).visionThinking).toBe('off')
  })
})

describe('config', () => {
  it('resolves defaults, including an enabled workspace under the dsh home', () => {
    expect(resolveConfig({})).toEqual({
      ...VALID,
      sessionWorkspacePath: dshHomePath('browser-sessions'),
      // Named, or the group would appear under its directory name.
      sessionWorkspaceTitle: '浏览器对话',
      deferSessionCreate: true,
      // The model opens pages for the user unless the user turns it off.
      openPagesForUser: true,
      // One named extension may skip the token on loopback; nothing else may.
      extensionId: DEFAULT_EXTENSION_ID,
      ...VISION_DEFAULTS,
      ...LAUNCH_DEFAULTS,
    })
    expect(new Config().sessionWorkspacePath).toBe(dshHomePath('browser-sessions'))
    expect(new Config().sessionWorkspaceTitle).toBe('浏览器对话')
  })

  it('preserves explicit values and the empty-string workspace opt-out', () => {
    expect(resolveConfig({
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      sessionWorkspaceTitle: '',
      deferSessionCreate: false,
      openPagesForUser: false,
      visionApiKey: 'secret',
      visionBaseUrl: '',
      visionModel: 'custom-vision',
      visionThinking: 'low',
      visionTimeoutMs: 1_000,
      extensionId: '',
      browserExecutablePath: '/opt/custom/chrome',
      extensionPath: '/opt/ext/dist',
      browserUserDataDir: '/home/user/.dsh/browser-profile',
      browserLaunchArgs: ['--no-first-run'],
      browserHeadless: true,
      browserLaunchTimeoutMs: 5_000,
    })).toEqual({
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      sessionWorkspaceTitle: '',
      deferSessionCreate: false,
      openPagesForUser: false,
      visionApiKey: 'secret',
      visionBaseUrl: '',
      visionModel: 'custom-vision',
      visionThinking: 'low',
      visionTimeoutMs: 1_000,
      // The empty-string opt-out must survive: it makes the token mandatory.
      extensionId: '',
      browserExecutablePath: '/opt/custom/chrome',
      extensionPath: '/opt/ext/dist',
      browserUserDataDir: '/home/user/.dsh/browser-profile',
      browserLaunchArgs: ['--no-first-run'],
      browserHeadless: true,
      browserLaunchTimeoutMs: 5_000,
    })
    expect(new Config({ sessionWorkspacePath: '' }).sessionWorkspacePath).toBe('')
  })

  it('rejects a thinking setting the caller would silently misread', () => {
    expect(() => resolveConfig({ visionThinking: 'medium' })).toThrow(/visionThinking/)
  })

  it('rejects a launch timeout that cannot be waited on', () => {
    expect(() => resolveConfig({ browserLaunchTimeoutMs: 0 })).toThrow(/browserLaunchTimeoutMs/)
    expect(() => resolveConfig({ browserLaunchTimeoutMs: 1.5 })).toThrow(/browserLaunchTimeoutMs/)
  })

  it('builds no vision client without a key, and one when a key is present', () => {
    expect(buildVisionClient(resolveConfig({}))).toBeUndefined()
    expect(buildVisionClient(resolveConfig({ visionApiKey: 'secret' }))).toBeDefined()
  })
})

describe('apply', () => {
  it('registers the bridge with a fixed token (no generation)', async () => {
    await apply(stubContext(), { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })
  })

  it.each([undefined, {}, { wireStream: {} }])('rejects unsupported Gateway capabilities: %j', async (gateway) => {
    const ctx = stubContext()
    const get = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation((key) => key === 'typertGateway' ? gateway : get(key))
    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await expect(apply(ctx, { token: 'fixed-token', ...VALID })).rejects.toThrow(/dsh 0\.2\.0-rc\.1.*wireStream unavailable/)
    expect(register).not.toHaveBeenCalled()
  })

  it('leaves Remote event source ownership to the host composition', async () => {
    const ctx = stubContext()
    const gateway = ctx.get('typertGateway')
    const open = vi.spyOn(gateway.wireStream, 'open')

    await apply(ctx, { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })

    expect(open).not.toHaveBeenCalled()
  })

  it('generates and persists a token when none is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
    dirs.push(home)
    vi.stubEnv('DSH_HOME', home)
    await apply(stubContext(), VALID)
  })

  it('rejects invalid budgets loudly', async () => {
    await expect(apply(stubContext(), { ...VALID, toolTimeoutMs: 0 })).rejects.toThrow(/toolTimeoutMs/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: -1 })).rejects.toThrow(/snapshotMaxChars/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: 499 })).rejects.toThrow(/at least 500/)
  })
})
