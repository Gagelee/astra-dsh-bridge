/**
 * Attach bridge-created ACP DSH sessions to their DSH Workspace.
 *
 * The ACP server creates sessions with a cwd but does not register them in the
 * GUI workspace registry, so the GUI shows them under Ungrouped. The bridge
 * drops one JSON request per session under `<DSH_HOME>/astra-dsh/attach/`; this
 * plugin polls that queue and calls `workspaceRegistry.create/attachSession`
 * inside the GUI process, which updates the live feed and persists membership.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const name = 'astra-dsh-workspace-attach'
export const inject = ['workspaceRegistry']

const POLL_MS = 2_000
const MAX_ATTEMPTS = 10

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const queueDir = join(dshHome, 'astra-dsh', 'attach')
  let stopped = false
  let busy = false

  try {
    mkdirSync(queueDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    console.warn(`[astra-dsh-attach] cannot create queue dir ${queueDir}: ${error.message}`)
    return
  }

  const log = (message) => console.log(`[astra-dsh-attach] ${message}`)

  async function processFile(file) {
    const full = join(queueDir, file)
    let entry
    try {
      entry = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      renameSync(full, `${full}.bad-${Date.now()}`)
      log(`moved malformed queue entry ${file}`)
      return
    }
    if (!entry || typeof entry.workspace !== 'string' || typeof entry.sessionId !== 'string' || !isAbsolute(entry.workspace)) {
      renameSync(full, `${full}.bad-${Date.now()}`)
      log(`moved invalid queue entry ${file}`)
      return
    }

    const attempts = Number(entry.attempts ?? 0) + 1
    try {
      let workspace = await ctx.workspaceRegistry.resolveByPath(entry.workspace)
      if (workspace === undefined) {
        workspace = await ctx.workspaceRegistry.create(entry.workspace)
        log(`created workspace ${workspace.title} for ${entry.workspace}`)
      }
      await workspace.attachSession(entry.sessionId)
      rmSync(full, { force: true })
      log(`attached ${entry.sessionId} to ${workspace.title}`)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (attempts >= MAX_ATTEMPTS) {
        renameSync(full, `${full}.failed-${Date.now()}`)
        log(`gave up on ${file} after ${attempts} attempts: ${message}`)
        return
      }
      writeFileSync(full, `${JSON.stringify({ ...entry, attempts, lastError: message }, undefined, 2)}\n`, 'utf8')
    }
  }

  async function pump() {
    if (busy || stopped) return
    busy = true
    try {
      let files
      try {
        files = readdirSync(queueDir).filter((file) => file.endsWith('.json'))
      } catch (error) {
        if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true, mode: 0o700 })
        return
      }
      for (const file of files) {
        if (stopped) return
        await processFile(file)
      }
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => { void pump() }, POLL_MS)
  timer.unref?.()
  void pump()

  ctx.effect(() => () => {
    stopped = true
    clearInterval(timer)
  })
}
