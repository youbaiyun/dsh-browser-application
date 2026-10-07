/**
 * Best-effort workspace grouping for sessions created through the browser
 * bridge.
 *
 * The wrapper touches exactly one request: an implicit `session.create`, which
 * it gives the browser group's workspace id. Explicit workspace choices and
 * every other gateway method pass through untouched — including the
 * `workspace.create` and `workspace.rename` calls this module makes on its own
 * behalf, which are issued through the same API and must not be intercepted.
 *
 * Grouping is best-effort by design. A failure returns the original call
 * ungrouped rather than failing the prompt, because a conversation the user can
 * still have is worth more than a tidy list.
 *
 * @module dsh-browser-crossplatform/src/session-workspace
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'

type Warn = (message: string) => void

/**
 * Give the browser-conversation group a name a user will recognise.
 *
 * The desktop derives a new workspace's title from its directory, and the bridge
 * registers a directory called `browser-sessions` — so the group appears under
 * that name. Nothing in the interface renames a workspace, and nothing tells the
 * user the group exists, so conversations look lost: they are saved, in a group
 * whose name reads like an internal detail.
 *
 * A title is a presentation concern, so a failure here is reported and otherwise
 * ignored. The grouping still works; only the label stays as the directory name.
 *
 * @param api - Injected gateway API implementation.
 * @param workspaceId - the workspace to name.
 * @param currentTitle - its title as the desktop reported it.
 * @param desiredTitle - the name to apply, or an empty string to leave it alone.
 * @param warn - Logger for a failure that does not stop grouping.
 */
async function nameWorkspace(
  api: BrowserHostApi,
  workspaceId: string,
  currentTitle: unknown,
  desiredTitle: string,
  warn: Warn,
): Promise<void> {
  if (desiredTitle === '') return
  if (typeof currentTitle === 'string' && currentTitle === desiredTitle) return
  try {
    const response = await api.call({
      rpcId: randomUUID(),
      method: 'workspace.rename',
      payload: { workspaceId, title: desiredTitle },
      signal: new AbortController().signal,
    })
    if (response.ok) return
    // A conflict is the expected case when the user already made a workspace with
    // this name. Renaming is a convenience, so losing the race is not an error
    // worth failing over — the conversations are grouped either way.
    warn(
      `browser bridge: could not name the session workspace "${desiredTitle}" `
      + `(${response.error.code}: ${response.error.message}); it keeps its directory name`,
    )
  } catch (error: unknown) {
    warn(`browser bridge: naming the session workspace failed: ${String(error)}`)
  }
}

/**
 * Add a dedicated Workspace to implicit session creation without making
 * grouping a session-creation dependency. The first implicit create mkdirs
 * and registers the configured path; that result, including failure, is
 * cached for the wrapper lifetime.
 *
 * @param api - Injected gateway API implementation.
 * @param workspacePath - Dedicated directory, or an empty string to opt out.
 * @param workspaceTitle - Display name for the group, or an empty string to keep
 *   the name the desktop derives from the directory. A title is needed because
 *   that derived name is the directory's, so a fresh install shows
 *   "browser-sessions" — an internal-sounding label the user has no reason to
 *   open, and no way to rename from the interface.
 * @param warn - Logger called once when grouping cannot be established.
 * @returns the original API for opt-out, otherwise an API with wrapped session creation.
 */
export function withSessionWorkspace(
  api: BrowserHostApi,
  workspacePath: string,
  workspaceTitle: string,
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
        const workspaceId = value.workspace.workspaceId
        await nameWorkspace(api, workspaceId, value.workspace.title, workspaceTitle, warn)
        return workspaceId
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
