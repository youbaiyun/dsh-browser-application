import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../src/host-api.ts'
import { withSessionWorkspace } from '../src/session-workspace.ts'

const WORKSPACE_ID = 'workspace-browser'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempWorkspacePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-'))
  dirs.push(root)
  return join(root, 'browser-sessions')
}

function request(payload: Record<string, unknown> = {}, rpcId = 'session-rpc'): HostRpcCall {
  return {
    rpcId,
    method: 'session.create',
    payload,
    signal: new AbortController().signal,
  }
}

function apiHarness(
  workspaceCreate?: (call: HostRpcCall) => Promise<HostRpcResult>,
  workspaceRename?: (call: HostRpcCall) => Promise<HostRpcResult>,
) {
  const sessionCreate = vi.fn(async (): Promise<HostRpcResult> => ({
    ok: true, value: { sessionId: 'session-browser' },
  }))
  const rename = vi.fn(async (input: HostRpcCall): Promise<HostRpcResult> => {
    if (workspaceRename !== undefined) return workspaceRename(input)
    return { ok: true, value: { workspace: { workspaceId: WORKSPACE_ID } } }
  })
  const call = vi.fn(async (input: HostRpcCall): Promise<HostRpcResult> => {
    if (input.method === 'session.create') return sessionCreate(input)
    if (input.method === 'workspace.create' && workspaceCreate !== undefined) return workspaceCreate(input)
    if (input.method === 'workspace.rename') return rename(input)
    return { ok: false, error: { code: 'not-found', message: 'workspace API is unavailable', details: {} } }
  })
  const api: BrowserHostApi = {
    call,
    async *events() {},
    respond: async () => ({ accepted: false }),
  }
  return { api, call, rename, sessionCreate }
}

function workspaceSuccess(inspect?: (path: string) => Promise<void>) {
  return vi.fn(async (call: HostRpcCall): Promise<HostRpcResult> => {
    const path = (call.payload as { path: string }).path
    await inspect?.(path)
    return {
      ok: true,
      value: {
        created: true,
        workspace: { workspaceId: WORKSPACE_ID, path, title: 'browser-sessions', sessionIds: [] },
      },
    }
  })
}

describe('withSessionWorkspace', () => {
  it('creates one cached workspace and injects its id into implicit Session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceCreate = workspaceSuccess(async (path) => {
      expect((await stat(path)).isDirectory()).toBe(true)
    })
    const { api, sessionCreate } = apiHarness(workspaceCreate)
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, '', warn)

    await Promise.all([
      wrapped.call(request({ cwd: '/ignored', sessionId: 'session-chosen' }, 'first')),
      wrapped.call(request({}, 'second')),
    ])

    expect(workspaceCreate).toHaveBeenCalledOnce()
    expect(workspaceCreate).toHaveBeenCalledWith(expect.objectContaining({
      method: 'workspace.create', payload: { path: workspacePath },
    }))
    expect(sessionCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      rpcId: 'first', payload: { sessionId: 'session-chosen', workspaceId: WORKSPACE_ID },
    }))
    expect(sessionCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      rpcId: 'second', payload: { workspaceId: WORKSPACE_ID },
    }))
    expect(warn).not.toHaveBeenCalled()
  })

  it('passes an explicit workspace id through without preparing the configured workspace', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceCreate = workspaceSuccess()
    const { api, sessionCreate } = apiHarness(workspaceCreate)
    const wrapped = withSessionWorkspace(api, workspacePath, '', vi.fn())
    const original = request({ workspaceId: 'workspace-explicit' })

    await wrapped.call(original)

    expect(sessionCreate).toHaveBeenCalledWith(original)
    expect(workspaceCreate).not.toHaveBeenCalled()
    await expect(stat(workspacePath)).rejects.toThrow()
  })

  it('returns the original API when grouping is opted out', () => {
    const { api } = apiHarness(workspaceSuccess())
    expect(withSessionWorkspace(api, '', '', vi.fn())).toBe(api)
  })

  it('caches a workspace failure and preserves ungrouped Session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceCreate = vi.fn(async (): Promise<HostRpcResult> => ({
      ok: false,
      error: { code: 'internal', message: 'workspace service missing', details: {} },
    }))
    const { api, sessionCreate } = apiHarness(workspaceCreate)
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, '', warn)
    const original = request({ cwd: '/original' })

    await wrapped.call(original)
    await wrapped.call(original)

    expect(workspaceCreate).toHaveBeenCalledOnce()
    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionCreate).toHaveBeenNthCalledWith(1, original)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace.create failed'))
  })

  it('catches a thrown workspace failure and preserves Session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceCreate = vi.fn(async (): Promise<HostRpcResult> => { throw new Error('domain unavailable') })
    const { api, sessionCreate } = apiHarness(workspaceCreate)
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, '', warn)
    const original = request({ cwd: '/original' })

    await wrapped.call(original)

    expect(sessionCreate).toHaveBeenCalledWith(original)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('domain unavailable'))
  })

  it('names the workspace, so the group is not left called "browser-sessions"', async () => {
    // The desktop derives a new workspace's title from its directory, and the
    // registered directory is named `browser-sessions`. Nothing in the interface
    // renames a workspace, so without this the user's browser conversations sit
    // in a group that reads like an internal detail.
    const workspacePath = await tempWorkspacePath()
    const { api, rename } = apiHarness(workspaceSuccess())
    const wrapped = withSessionWorkspace(api, workspacePath, '浏览器对话', vi.fn())

    await wrapped.call(request())

    expect(rename).toHaveBeenCalledWith(expect.objectContaining({
      method: 'workspace.rename',
      payload: { workspaceId: WORKSPACE_ID, title: '浏览器对话' },
    }))
  })

  it('does not rename a workspace that already carries the wanted name', async () => {
    const workspacePath = await tempWorkspacePath()
    const { api, rename } = apiHarness(vi.fn(async (call: HostRpcCall): Promise<HostRpcResult> => ({
      ok: true,
      value: {
        created: false,
        workspace: { workspaceId: WORKSPACE_ID, path: (call.payload as { path: string }).path, title: '浏览器对话', sessionIds: [] },
      },
    })))
    const wrapped = withSessionWorkspace(api, workspacePath, '浏览器对话', vi.fn())

    await wrapped.call(request())

    expect(rename).not.toHaveBeenCalled()
  })

  it('keeps grouping when naming fails, because the name is only a label', async () => {
    // The name is already taken by a workspace the user made, which the desktop
    // rejects. Grouping still works; the group simply keeps its directory name.
    const workspacePath = await tempWorkspacePath()
    const { api, sessionCreate } = apiHarness(workspaceSuccess(), async () => ({
      ok: false,
      error: { code: 'workspace/name-conflict', message: "Workspace name '浏览器对话' is already in use", details: {} },
    }))
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, '浏览器对话', warn)

    await wrapped.call(request({}, 'first'))

    expect(sessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      payload: { workspaceId: WORKSPACE_ID },
    }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not name the session workspace'))
  })
})
