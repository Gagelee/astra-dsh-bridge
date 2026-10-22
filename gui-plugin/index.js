/**
 * Attach bridge-created ACP DSH sessions to their DSH Workspace and publish
 * them into the client session catalog.
 *
 * The bridge (a separate process) creates sessions over ACP and drops one JSON
 * *request* per identity under `<DSH_HOME>/astra-dsh/attach/`. This host plugin
 * polls that queue and, inside the GUI process:
 *
 *   1. confirms the session exists via `ctx.sessionController.list()` — a
 *      read-only, cold-safe list that never resumes or creates an Agent;
 *   2. publishes it with `ctx.emit('api-session/added', summary)` so the client
 *      catalog shows it without a GUI restart (the same event the host emits
 *      for internally created sessions);
 *   3. groups it with `workspaceRegistry.resolveByPath/create` +
 *      `workspace.attachSession`, honouring the request's `policy`
 *      (existing | create | off);
 *   4. writes a durable ACK, then deletes the request.
 *
 * Requests are keyed by immutable per-identity filenames (task+session+
 * generation+workspace-hash), so an in-flight process can never delete or
 * overwrite a newer request/ACK the bridge wrote in the meantime. Legacy
 * `<taskId>.json` requests (no schema) are migrated to guiPolicy=existing and
 * never create a workspace. Transient conditions retry with backoff and survive
 * a plugin restart; terminal outcomes always leave a durable receipt.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ATTACH_SCHEMA,
  ATTACH_STATUS,
  FOLLOWUP_WINDOW_MS,
  legacyRequestPath,
  migrateLegacyRequest,
  renderAttachAck,
  validateAttachRequest,
  writeAttachAck,
  writeJsonAtomic,
} from './protocol.js'
import { processRepairs } from './repair.js'

export const name = 'astra-dsh-workspace-attach'
export const inject = ['workspaceRegistry', 'sessionController']
export const PLUGIN_VERSION = '2.1.0'

const POLL_MS = 2_000
const HEARTBEAT_MS = 30_000
/** Terminal failure after this many per-file attempts (with backoff). */
const MAX_ATTEMPTS = 60
/** Backoff ceiling (ms) between retries of one file. */
const MAX_BACKOFF_MS = 30_000

export function apply(ctx, options = {}) {
  const opts = {
    pollMs: options.pollMs ?? POLL_MS,
    heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
    maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
    followupWindowMs: options.followupWindowMs ?? FOLLOWUP_WINDOW_MS,
    autoStart: options.autoStart !== false,
    now: options.now ?? (() => Date.now()),
    backoff: options.backoff ?? ((attempts) => Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, attempts - 1))),
  }

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const queueDir = join(dshHome, 'astra-dsh', 'attach')
  const repairDir = join(dshHome, 'astra-dsh', 'repair')
  const heartbeatFile = join(dshHome, 'astra-dsh', 'heartbeat.json')
  let stopped = false
  let busy = false
  const abort = new AbortController()
  const followUps = new Map()

  const log = (message) => console.log(`[astra-dsh-attach] ${message}`)

  try {
    mkdirSync(queueDir, { recursive: true, mode: 0o700 })
    mkdirSync(repairDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    console.warn(`[astra-dsh-attach] cannot create queue dir ${queueDir}: ${error.message}`)
    return
  }

  /** Plugin-only heartbeat so `astra_status` can report plugin health/version. */
  function writeHeartbeat() {
    try {
      mkdirSync(join(dshHome, 'astra-dsh'), { recursive: true })
      writeJsonAtomic(heartbeatFile, { version: PLUGIN_VERSION, at: new Date().toISOString(), pid: process.pid })
    } catch {
      // Best effort; never block attach work on a heartbeat write.
    }
  }

  async function listSummaries() {
    if (typeof ctx.sessionController?.list !== 'function') {
      throw new Error('ctx.sessionController.list is unavailable; cannot read the session catalog')
    }
    const result = await ctx.sessionController.list({}, abort.signal)
    return Array.isArray(result?.items) ? result.items : []
  }

  function publish(summary) {
    ctx.emit('api-session/added', summary)
  }

  function fingerprintOf(summary) {
    const p = summary?.projections?.values ?? {}
    return JSON.stringify({
      updatedAt: summary?.updatedAt ?? 0,
      blank: Boolean(summary?.blank),
      title: typeof p.title === 'string' ? p.title : null,
      sessionListMetadata: p.sessionListMetadata ?? null,
    })
  }

  function quarantine(full, kind, reason = '') {
    const target = `${full}.${kind}-${Date.now()}`
    try {
      renameSync(full, target)
      log(`quarantined ${kind} queue entry: ${reason || target}`)
    } catch {
      rmSync(full, { force: true })
    }
  }

  function writeAck(ack) {
    writeAttachAck(queueDir, ack)
  }

  function terminalAck(entry, status, { workspaceId = null, workspaceTitle = null, attempts = 0, lastError = null, summary = null } = {}) {
    const followup = (status === ATTACH_STATUS.ATTACHED || status === ATTACH_STATUS.UNREGISTERED) && summary
      ? {
        followupUntil: new Date(opts.now() + opts.followupWindowMs).toISOString(),
        followupFingerprint: fingerprintOf(summary),
      }
      : {}
    return renderAttachAck({
      identity: entry.identity,
      workspace: entry.workspace,
      canonicalWorkspace: entry.canonicalWorkspace,
      sessionId: entry.identity.sessionId,
      workspaceId,
      workspaceTitle,
      status,
      phase: status,
      attempts,
      lastError,
      publishedAt: new Date(opts.now()).toISOString(),
      ...followup,
    })
  }

  async function onTransient(entry, full, attempts, message) {
    if (attempts >= opts.maxAttempts) {
      writeAck(terminalAck(entry, ATTACH_STATUS.FAILED, { attempts, lastError: message }))
      rmSync(full, { force: true })
      log(`gave up on ${entry.identity.taskId} after ${attempts} attempts: ${message}`)
      return
    }
    writeAck(renderAttachAck({
      identity: entry.identity,
      workspace: entry.workspace,
      canonicalWorkspace: entry.canonicalWorkspace,
      sessionId: entry.identity.sessionId,
      status: ATTACH_STATUS.WAITING_SESSION,
      phase: 'waiting-session',
      attempts,
      lastError: message,
    }))
    writeJsonAtomic(full, {
      ...entry,
      attempts,
      status: ATTACH_STATUS.WAITING_SESSION,
      lastError: message,
      nextRetryAt: new Date(opts.now() + opts.backoff(attempts)).toISOString(),
    })
  }

  async function processFile(file, sharedList) {
    const full = join(queueDir, file)
    let raw
    try {
      raw = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      quarantine(full, 'bad', 'malformed JSON')
      return
    }

    let entry
    if (raw && typeof raw === 'object' && raw.schema === ATTACH_SCHEMA) {
      const check = validateAttachRequest(raw)
      if (!check.ok) {
        quarantine(full, 'bad', check.error)
        return
      }
      entry = raw
    } else {
      const migrated = migrateLegacyRequest(raw)
      if (!migrated.ok) {
        quarantine(full, 'bad', migrated.error)
        return
      }
      entry = migrated.request
      // Legacy filename/identity consistency: the file must be `<taskId>.json`.
      if (full !== legacyRequestPath(queueDir, entry.identity.taskId)) {
        quarantine(full, 'bad', 'legacy request filename does not match its taskId')
        return
      }
    }

    const sessionId = entry.identity.sessionId
    const attempts = Number(entry.attempts ?? 0) + 1

    const nextRetryAt = typeof entry.nextRetryAt === 'string' ? Date.parse(entry.nextRetryAt) : 0
    if (Number.isFinite(nextRetryAt) && opts.now() < nextRetryAt) return

    // policy off: no publish, no grouping, no side effects.
    if (entry.policy === 'off') {
      writeAck(terminalAck(entry, ATTACH_STATUS.OFF, { attempts, lastError: 'guiPolicy=off' }))
      rmSync(full, { force: true })
      log(`off ${sessionId}: no GUI delivery`)
      return
    }

    let summary = null
    try {
      const items = await sharedList()
      summary = items.find((item) => item?.sessionId === sessionId) ?? null
    } catch (error) {
      await onTransient(entry, full, attempts, `session catalog unavailable: ${String(error?.message ?? error)}`)
      return
    }
    if (stopped) return

    if (!summary) {
      await onTransient(entry, full, attempts, 'session not yet visible in sessionController.list')
      return
    }

    // 1) Publish into the client catalog. This is the host's list-update
    //    receipt; it does not mean the client has rendered it.
    publish(summary)

    // 2) Group into a workspace per policy.
    let workspace
    try {
      workspace = await ctx.workspaceRegistry.resolveByPath(entry.canonicalWorkspace)
      if (workspace === undefined && entry.policy === 'create') {
        workspace = await ctx.workspaceRegistry.create(entry.canonicalWorkspace, entry.title ?? undefined)
      }
    } catch (error) {
      await onTransient(entry, full, attempts, `workspace resolve/create failed: ${String(error?.message ?? error)}`)
      return
    }
    if (stopped) return

    if (workspace === undefined) {
      // existing policy + unregistered workspace: terminal, skipped (published only).
      writeAck(terminalAck(entry, ATTACH_STATUS.UNREGISTERED, {
        attempts,
        lastError: 'workspace is not registered and guiPolicy=existing does not create it',
        summary,
      }))
      rmSync(full, { force: true })
      followUps.set(sessionId, { fingerprint: fingerprintOf(summary), until: opts.now() + opts.followupWindowMs })
      log(`unregistered ${sessionId}: workspace missing (policy=existing)`)
      return
    }

    let workspaceId = null
    let workspaceTitle = null
    try {
      await workspace.attachSession(sessionId)
      workspaceId = workspace.id
      workspaceTitle = workspace.title
    } catch (error) {
      await onTransient(entry, full, attempts, `attachSession failed: ${String(error?.message ?? error)}`)
      return
    }
    if (stopped) return

    writeAck(terminalAck(entry, ATTACH_STATUS.ATTACHED, { workspaceId, workspaceTitle, attempts, summary }))
    rmSync(full, { force: true })
    followUps.set(sessionId, { fingerprint: fingerprintOf(summary), until: opts.now() + opts.followupWindowMs })
    log(`attached ${sessionId}${workspaceTitle ? ` → ${workspaceTitle}` : ''}`)
  }

  function seedFollowupsFromAcks() {
    let files
    try {
      files = readdirSync(queueDir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.ack.json')) continue
      let ack
      try {
        ack = JSON.parse(readFileSync(join(queueDir, file), 'utf8'))
      } catch {
        continue
      }
      if (!ack || typeof ack !== 'object') continue
      if (ack.status !== ATTACH_STATUS.ATTACHED && ack.status !== ATTACH_STATUS.UNREGISTERED) continue
      const until = Date.parse(ack.followupUntil ?? 0)
      if (!Number.isFinite(until) || until < opts.now()) continue
      followUps.set(ack.sessionId, { fingerprint: ack.followupFingerprint ?? null, until })
    }
  }

  async function followUpTitles(sharedList) {
    for (const [sessionId, follow] of [...followUps.entries()]) {
      if (follow.until < opts.now()) followUps.delete(sessionId)
    }
    if (followUps.size === 0) return
    let items
    try {
      items = await sharedList()
    } catch {
      return
    }
    if (stopped) return
    for (const [sessionId, follow] of [...followUps.entries()]) {
      const summary = items.find((item) => item?.sessionId === sessionId)
      if (summary === undefined) continue
      const fingerprint = fingerprintOf(summary)
      if (fingerprint === follow.fingerprint) continue
      try {
        publish(summary)
      } catch (error) {
        log(`followup publish failed for ${sessionId}: ${error?.message ?? error}`)
        continue
      }
      follow.fingerprint = fingerprint
    }
  }

  async function pump() {
    if (busy || stopped) return
    busy = true
    try {
      let files
      try {
        files = readdirSync(queueDir).filter((file) => file.endsWith('.json') && !file.endsWith('.ack.json'))
      } catch (error) {
        if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true, mode: 0o700 })
        return
      }

      // One shared list call per pump, reused by every file and the followups.
      let items = null
      let listError = null
      const sharedList = async () => {
        if (listError) throw listError
        if (items === null) {
          try {
            items = await listSummaries()
          } catch (error) {
            listError = error
            throw error
          }
        }
        return items
      }

      for (const file of files) {
        if (stopped) return
        try {
          await processFile(file, sharedList)
        } catch (error) {
          // Per-file isolation: one broken entry must not crash the pump.
          log(`error processing ${file}: ${error?.message ?? error}`)
        }
      }
      try {
        await processRepairs(ctx, repairDir, { log })
      } catch (error) {
        log(`repair error: ${error?.message ?? error}`)
      }
      if (!stopped) {
        try {
          await followUpTitles(sharedList)
        } catch (error) {
          log(`followup error: ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      log(`pump error: ${error?.message ?? error}`)
    } finally {
      busy = false
    }
  }

  const timer = opts.autoStart ? setInterval(() => { void pump() }, opts.pollMs) : null
  timer?.unref?.()
  const heartbeatTimer = setInterval(writeHeartbeat, opts.heartbeatMs)
  heartbeatTimer.unref?.()
  writeHeartbeat()
  seedFollowupsFromAcks()
  if (opts.autoStart) void pump()

  ctx.effect(() => () => {
    stopped = true
    abort.abort()
    if (timer) clearInterval(timer)
    clearInterval(heartbeatTimer)
  })

  // Exposed for tests and diagnostics; ignored by the Cordis loader.
  return { pump, processFile: (file) => processFile(file, listSummaries), followUpTitles: () => followUpTitles(listSummaries), pumpRepairs: () => processRepairs(ctx, repairDir, { log }), queueDir, repairDir, dshHome, stop: () => { stopped = true; abort.abort(); if (timer) clearInterval(timer); clearInterval(heartbeatTimer) } }
}
