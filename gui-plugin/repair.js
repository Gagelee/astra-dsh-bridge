/**
 * Explicit, host-side maintenance queue for workspace cleanup.
 *
 * This is intentionally not an API the bridge or an Agent can call freely:
 * requests live in a private queue directory, are validated against the exact
 * workspace id + path + session-id set, and only support one action
 * (`archive-and-delete`). A mismatch aborts the target instead of guessing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const REPAIR_SCHEMA = 1
export const REPAIR_ACTION = 'archive-and-delete'

export function validateRepairRequest(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'request must be an object' }
  if (raw.schema !== REPAIR_SCHEMA) return { ok: false, error: `unsupported schema ${raw.schema}` }
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(raw.id)) {
    return { ok: false, error: 'id must be a safe file name' }
  }
  if (raw.action !== REPAIR_ACTION) return { ok: false, error: `unsupported action ${raw.action}` }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    return { ok: false, error: 'targets must be a non-empty array' }
  }
  const targets = []
  for (const [index, target] of raw.targets.entries()) {
    if (!target || typeof target !== 'object') return { ok: false, error: `targets[${index}] must be an object` }
    if (typeof target.workspacePath !== 'string' || !target.workspacePath.startsWith('/')) {
      return { ok: false, error: `targets[${index}].workspacePath must be absolute` }
    }
    if (typeof target.workspaceId !== 'string' || target.workspaceId.length === 0) {
      return { ok: false, error: `targets[${index}].workspaceId is required` }
    }
    if (!Array.isArray(target.sessionIds) || target.sessionIds.length === 0
      || target.sessionIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      return { ok: false, error: `targets[${index}].sessionIds must be a non-empty string array` }
    }
    if (new Set(target.sessionIds).size !== target.sessionIds.length) {
      return { ok: false, error: `targets[${index}].sessionIds contains duplicates` }
    }
    targets.push({
      workspacePath: target.workspacePath,
      workspaceId: target.workspaceId,
      sessionIds: [...target.sessionIds],
      reason: typeof target.reason === 'string' ? target.reason.slice(0, 500) : '',
    })
  }
  return { ok: true, request: { schema: REPAIR_SCHEMA, id: raw.id, action: REPAIR_ACTION, targets } }
}

export async function executeRepair(ctx, request) {
  const results = []
  for (const target of request.targets) {
    const result = {
      workspacePath: target.workspacePath,
      workspaceId: target.workspaceId,
      ok: false,
      archived: [],
      deleted: false,
      error: null,
    }
    try {
      const workspace = await ctx.workspaceRegistry.resolveByPath(target.workspacePath)
      if (!workspace) throw new Error('workspace is not registered')
      if (workspace.id !== target.workspaceId) {
        throw new Error(`workspace id mismatch: expected ${target.workspaceId}, found ${workspace.id}`)
      }
      if (workspace.path !== target.workspacePath) {
        throw new Error(`workspace path mismatch: expected ${target.workspacePath}, found ${workspace.path}`)
      }
      const actual = [...(workspace.sessionIds ?? [])].sort()
      const expected = [...target.sessionIds].sort()
      if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
        throw new Error(`session set mismatch: expected ${expected.join(',')}, found ${actual.join(',')}`)
      }

      const summaries = await ctx.sessionController.list({}, new AbortController().signal)
      const running = new Set((summaries?.items ?? []).filter((item) => item?.running).map((item) => item.sessionId))
      const active = target.sessionIds.filter((sessionId) => running.has(sessionId))
      if (active.length > 0) throw new Error(`session still running: ${active.join(',')}`)

      for (const sessionId of target.sessionIds) {
        // Never stop activity here: archiveSession itself refuses active work.
        await ctx.workspaceRegistry.archiveSession(sessionId)
        result.archived.push(sessionId)
      }
      result.deleted = await ctx.workspaceRegistry.delete(target.workspaceId)
      if (!result.deleted) throw new Error('workspace delete returned false')
      result.ok = true
    } catch (error) {
      result.error = error?.message ?? String(error)
    }
    results.push(result)
  }
  return {
    schema: REPAIR_SCHEMA,
    id: request.id,
    action: request.action,
    ok: results.every((result) => result.ok),
    at: new Date().toISOString(),
    results,
  }
}

/** Process every `*.json` repair request once. Returns per-file outcomes. */
export async function processRepairs(ctx, repairDir, { now = () => new Date(), log = () => {} } = {}) {
  if (!existsSync(repairDir)) return []
  const outcomes = []
  for (const file of readdirSync(repairDir).filter((name) => name.endsWith('.json') && !name.endsWith('.ack.json'))) {
    const full = join(repairDir, file)
    let raw
    try {
      raw = JSON.parse(readFileSync(full, 'utf8'))
    } catch (error) {
      const bad = `${full}.bad-${now().getTime()}`
      try { renameSync(full, bad) } catch { rmSync(full, { force: true }) }
      outcomes.push({ file, ok: false, error: `malformed JSON: ${error?.message ?? error}` })
      continue
    }
    const checked = validateRepairRequest(raw)
    if (!checked.ok) {
      const bad = `${full}.bad-${now().getTime()}`
      try { renameSync(full, bad) } catch { rmSync(full, { force: true }) }
      outcomes.push({ file, ok: false, error: checked.error })
      continue
    }
    try {
      const ack = await executeRepair(ctx, checked.request)
      const ackPath = join(repairDir, `${checked.request.id}.ack.json`)
      const temp = `${ackPath}.tmp-${process.pid}`
      mkdirSync(repairDir, { recursive: true })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(temp, `${JSON.stringify(ack, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, ackPath)
      rmSync(full, { force: true })
      log(`repair ${checked.request.id}: ${ack.ok ? 'ok' : 'failed'}`)
      outcomes.push({ file, ok: ack.ok, ack })
    } catch (error) {
      outcomes.push({ file, ok: false, error: error?.message ?? String(error) })
    }
  }
  return outcomes
}
