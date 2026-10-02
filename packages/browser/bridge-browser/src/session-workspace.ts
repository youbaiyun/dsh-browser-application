/**
 * Best-effort workspace grouping for sessions created through the browser
 * bridge. The wrapper changes only implicit `session.create` requests;
 * explicit workspace choices and every other gateway method pass through.
 * @module @yuxianglin/dsh-bridge-browser/src/session-workspace
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'

type Warn = (message: string) => void

/**
 * Add a dedicated Workspace to implicit session creation without making
 * grouping a session-creation dependency. The first implicit create mkdirs
 * and registers the configured path; that result, including failure, is
 * cached for the wrapper lifetime.
 *
 * @param api - Injected gateway API implementation.
 * @param workspacePath - Dedicated directory, or an empty string to opt out.
 * @param warn - Logger called once when grouping cannot be established.
 * @returns the original API for opt-out, otherwise an API with wrapped session creation.
 */
export function withSessionWorkspace(
  api: BrowserHostApi,
  workspacePath: string,
  warn: Warn,
): BrowserHostApi {
  if (workspacePath === '') return api

  let workspacePromise: Promise<string | undefined> | undefined
  const ensureWorkspace = (): Promise<string | undefined> => {
    if (workspacePromise !== undefined) return workspacePromise
    workspacePromise = (async () => {
      try {
        await mkdir(workspacePath, { recursive: true })
        const response = await api.call({
          rpcId: randomUUID(),
          method: 'workspace.create',
          payload: { path: workspacePath },
          signal: new AbortController().signal,
        })
        if (!response.ok) {
          warn(
            `browser bridge: workspace.create failed for "${workspacePath}" `
            + `(${response.error.code}: ${response.error.message}); sessions will remain ungrouped`,
          )
          return undefined
        }
        const value = response.value
        if (!isRecord(value) || !isRecord(value.workspace) || typeof value.workspace.workspaceId !== 'string') {
          warn(`browser bridge: workspace.create returned an invalid response; sessions will remain ungrouped`)
          return undefined
        }
        return value.workspace.workspaceId
      } catch (error: unknown) {
        warn(
          `browser bridge: could not prepare session workspace "${workspacePath}": `
          + `${String(error)}; sessions will remain ungrouped`,
        )
        return undefined
      }
    })()
    return workspacePromise
  }

  return {
    async call(call: HostRpcCall): Promise<HostRpcResult> {
      if (call.method !== 'session.create' || !isRecord(call.payload)) return api.call(call)
      if (call.payload.workspaceId !== undefined) return api.call(call)
      const workspaceId = await ensureWorkspace()
      if (workspaceId === undefined) return api.call(call)
      const payload: Record<string, unknown> = { ...call.payload, workspaceId }
      delete payload.cwd
      return api.call({ ...call, payload })
    },
    events: signal => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
  }
}
