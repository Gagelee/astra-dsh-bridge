#!/usr/bin/env node
/**
 * Watchdog sidecar for exactly one DSH task turn.
 *
 * It owns no task state: it reads the durable task record, and on an unexpected
 * bridge disconnect writes one incident + one outbox notification. It never
 * edits task.json, resumes a model, releases a lock, or touches an ACP session.
 *
 * Lifecycle: started by WatchdogSupervisor at turn start; exits on `shutdown`
 * (normal settle/cancel/bridge shutdown), or after recording one control-loss
 * event. Parent death is detected through the IPC channel disconnect, which is
 * strong evidence that the bridge process is gone.
 */

import { appendJsonLine, ensureDir, isPidAlive, nowIso, readJson, truncate, writeJson } from './util.mjs'
import { loadConfig } from './config.mjs'
import { WorkspaceStore } from './store.mjs'
import { NotificationOutbox, notificationId } from './notifications.mjs'

const [workspace, taskId] = process.argv.slice(2)
let finished = false
let expected = null
let interval = null

function finish(code = 0) {
  if (finished) return
  finished = true
  if (interval) clearInterval(interval)
  setTimeout(() => process.exit(code), 5).unref?.()
}

function log(event, extra = {}) {
  try {
    const stamp = new Date()
    const day = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`
    const file = `${workspace}/.astra-dsh/logs/watchdog-${day}.log`
    ensureDir(`${workspace}/.astra-dsh/logs`)
    appendJsonLine(file, { t: nowIso(), pid: process.pid, taskId, event, ...extra })
  } catch {
    // A sidecar must never fail because its log is unavailable.
  }
}

if (!workspace || !taskId) {
  process.stderr.write('watchdog: workspace and taskId are required\n')
  process.exit(2)
}
if (!process.channel) {
  process.stderr.write('watchdog: refusing to run without a parent IPC channel\n')
  process.exit(2)
}

const config = loadConfig()
const store = new WorkspaceStore(workspace, { controlOnly: true })
const outbox = new NotificationOutbox({
  store,
  config,
  owner: `watchdog-${process.pid}`,
  log,
  autoFlush: false,
})

function sendParent(message) {
  try {
    if (process.connected && process.channel) process.send(message)
  } catch {
    // Parent already gone; the disconnect path handles the incident.
  }
}

function loadTask() {
  try {
    return readJson(`${workspace}/.astra-dsh/tasks/${taskId}/task.json`, null)
  } catch {
    return null
  }
}

function stillOwnsTurn(task) {
  if (!task) return { ok: false, reason: 'task disappeared' }
  if (expected && Number(task.turnIndex ?? 0) !== expected.turn) {
    return { ok: false, reason: `task moved to turn ${task.turnIndex}` }
  }
  if (task.state !== 'running') return { ok: false, reason: `task is ${task.state}` }
  if (expected?.runnerInstance && task.runner?.instance && task.runner.instance !== expected.runnerInstance) {
    return { ok: false, reason: 'a different runner instance now owns the task' }
  }
  return { ok: true }
}

let handling = false

async function recordControlLoss() {
  if (handling) return
  handling = true
  const task = loadTask()
  const owns = stillOwnsTurn(task)
  if (!owns.ok) {
    log('exit-without-incident', { reason: owns.reason })
    return finish(0)
  }
  const turn = Number(task.turnIndex ?? expected?.turn ?? 0)
  const acpPid = task.runner?.acpPid ?? null
  // If the ACP child is verifiably gone we can say the turn is no longer
  // executing. Anything else is "may still be active" and must not claim stop.
  const acpAlive = Number.isInteger(acpPid) ? isPidAlive(acpPid) : true
  const lastTool = task.lastTool ?? task.stall?.tool ?? null
  const message = acpAlive
    ? 'Bridge control connection was lost while DSH may still be executing. Execution may still be active; do not assume the task stopped and do not start a second writer.'
    : 'Bridge control connection was lost; the ACP process is no longer alive, but the turn was never settled by the bridge.'
  const incident = {
    schema: 1,
    id: `INC-${taskId}-t${turn}-control-lost`,
    kind: 'control-lost',
    severity: acpAlive ? 'critical' : 'warning',
    taskId,
    turn,
    sessionId: task.sessionId ?? null,
    at: nowIso(),
    phase: task.phase ?? null,
    lastTool,
    lastAcpUpdateAt: task.lastAcpUpdateAt ?? null,
    lastBridgeHeartbeatAt: task.lastBridgeHeartbeatAt ?? null,
    runner: task.runner ?? null,
    acpPid,
    executionMayBeActive: acpAlive,
    message,
  }
  try {
    ensureDir(`${workspace}/.astra-dsh/tasks/${taskId}`)
    writeJson(`${workspace}/.astra-dsh/tasks/${taskId}/incident-control-lost.json`, incident)
  } catch (error) {
    log('incident-write-failed', { error: truncate(error.message, 500) })
  }
  if (!task.codexThreadId) {
    outbox.markDegraded({
      taskId,
      turn,
      kind: 'control-lost',
      reason: 'no Codex thread id was captured at dispatch; control-loss alert cannot wake Astra',
    })
    log('notify-degraded', { reason: 'no-thread' })
    return finish(0)
  }
  const id = notificationId(taskId, turn, 'control-lost')
  outbox.enqueue({
    taskId,
    turn,
    kind: 'control-lost',
    threadId: task.codexThreadId,
    message,
    stateAtEnqueue: task.state,
    detail: message,
  })
  const receipt = await retryOwnNotification(id)
  log('control-loss-recorded', {
    turn,
    executionMayBeActive: incident.executionMayBeActive,
    incidentAt: incident.at,
    notificationStatus: receipt?.status ?? null,
    attempts: receipt?.attempts ?? null,
    exhausted: receipt && ['pending', 'retrying', 'sending'].includes(receipt.status),
  })
  finish(0)
}

/**
 * Retry only this sidecar's control-loss event. The parent is gone, so nobody
 * else will drive the outbox; stay alive within a bounded budget. On budget
 * exhaustion the record stays pending/retrying for a future bridge recovery.
 */
async function retryOwnNotification(id) {
  const deadline = Date.now() + config.watchdogNotifyBudgetMs
  let attempts = 0
  let record = null
  while (!finished) {
    attempts += 1
    try {
      await outbox.flush({ onlyIds: [id] })
    } catch (error) {
      log('notify-flush-failed', { error: truncate(error?.message ?? error, 500) })
    }
    record = outbox.load(id)
    if (!record) return null
    if (['sent', 'suppressed', 'degraded'].includes(record.status)) return record
    if (attempts >= config.watchdogNotifyMaxAttempts || Date.now() >= deadline) break
    const nextAt = Date.parse(record.nextAttemptAt ?? 0) || 0
    const remaining = deadline - Date.now()
    const waitMs = Math.max(50, Math.min(remaining, nextAt > Date.now() ? nextAt - Date.now() : 50))
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  record = outbox.load(id)
  if (record && ['pending', 'retrying', 'sending'].includes(record.status)) {
    record.lastError = truncate(
      `${record.lastError ? `${record.lastError} | ` : ''}watchdog retry budget exhausted after ${attempts} attempt(s); a future bridge start will resume this outbox record`,
      1000,
    )
    outbox.save(record)
    log('notify-budget-exhausted', { id, attempts, status: record.status, lastError: record.lastError })
  }
  return record
}

async function onParentLost() {
  if (finished) return
  // Give a shutdown/turn-end message a moment to win the race on clean exits.
  await new Promise((resolve) => setTimeout(resolve, 200))
  if (finished) return
  await recordControlLoss()
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'turn-start') {
    expected = { turn: Number(message.turn ?? 0), runnerInstance: message.runnerInstance ?? null }
    log('turn-start', expected)
    const task = loadTask()
    if (!task) {
      sendParent({ type: 'ready', ok: false, taskId, turn: expected.turn, reason: 'task disappeared before ready' })
      return finish(1)
    }
    if (Number(task.turnIndex ?? 0) !== expected.turn || task.state !== 'running') {
      sendParent({ type: 'ready', ok: false, taskId, turn: expected.turn, reason: `task is ${task.state} at turn ${task.turnIndex}` })
      return finish(1)
    }
    if (expected.runnerInstance && task.runner?.instance && task.runner.instance !== expected.runnerInstance) {
      sendParent({ type: 'ready', ok: false, taskId, turn: expected.turn, reason: 'runner instance changed before ready' })
      return finish(1)
    }
    sendParent({ type: 'ready', ok: true, taskId, turn: expected.turn, runnerInstance: expected.runnerInstance, pid: process.pid })
    return
  }
  if (message.type === 'shutdown' || message.type === 'turn-end') {
    log('shutdown', { reason: message.reason ?? message.type })
    if (message.type === 'shutdown' && message.reason === 'bridge-shutdown') {
      // A graceful bridge exit while the turn is still running is still a lost
      // control connection from DSH's point of view: record it before exiting.
      void recordControlLoss().catch((error) => {
        log('shutdown-record-failed', { error: truncate(error?.message ?? error, 500) })
        finish(1)
      })
      return
    }
    finish(0)
  }
})
process.on('disconnect', () => {
  void onParentLost().catch((error) => {
    log('parent-lost-failed', { error: truncate(error.message, 500) })
    finish(1)
  })
})
process.on('SIGTERM', () => finish(0))
process.on('SIGINT', () => finish(0))
process.on('uncaughtException', (error) => {
  log('uncaught-exception', { error: truncate(error?.stack ?? error, 1000) })
  finish(1)
})
process.on('unhandledRejection', (error) => {
  log('unhandled-rejection', { error: truncate(error?.stack ?? error, 1000) })
  finish(1)
})

// Safety net: if the parent itself forgot to settle this turn, exit once the
// durable task no longer belongs to this sidecar. This never edits the task.
interval = setInterval(() => {
  if (finished || handling) return
  const owns = stillOwnsTurn(loadTask())
  if (!owns.ok) {
    log('exit-after-turn-change', { reason: owns.reason })
    finish(0)
  }
}, 2000)

log('started')
