/**
 * Durable per-event notification outbox.
 *
 * Every notification is a separate JSON record under `.astra-dsh/notifications`
 * so a bridge restart, an old `saveTask` snapshot, or a watchdog sidecar cannot
 * lose it. Senders claim a record with an atomic `mkdir` lease before invoking
 * the external `codex queue` CLI; success is recorded as a receipt.
 *
 * Delivery boundary: the external CLI has no idempotency key. We guarantee at
 * most one send per record while the claim/lease is healthy, but a crash after
 * the CLI accepted the message and before the receipt was written can cause one
 * duplicate after the lease expires. This is at-least-once, not exactly-once.
 */

import { mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureDir,
  nowIso,
  oneLine,
  readJson,
  removePath,
  runCommand,
  shortId,
  statOrUndefined,
  truncate,
  writeJson,
} from './util.mjs'

const PENDING_STATUSES = new Set(['pending', 'retrying', 'sending'])
const TERMINAL_STATUSES = new Set(['sent', 'suppressed', 'degraded'])

/** Deterministic id: one event per task/turn/kind, so duplicate settles dedupe. */
export function notificationId(taskId, turn, kind, idSuffix = null) {
  const safeKind = String(kind ?? 'event').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48)
  const suffix = idSuffix == null || idSuffix === ''
    ? ''
    : `~${String(idSuffix).replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 64)}`
  return `${taskId}~t${Number(turn) || 0}~${safeKind}${suffix}`
}

export class NotificationOutbox {
  constructor({ store, config, owner = `bridge-${process.pid}-${shortId(2)}`, log = null, autoFlush = true }) {
    this.store = store
    this.config = config
    this.owner = owner
    this.log = log
    this.dir = join(store.root, 'notifications')
    this.claimsDir = join(this.dir, 'claims')
    ensureDir(this.dir)
    ensureDir(this.claimsDir)
    this.timer = null
    this.timerAt = 0
    this.flushing = false
    this.closed = false
    this.autoFlush = autoFlush
    this.heldClaims = new Map()
  }

  recordPath(id) {
    return join(this.dir, `${id}.json`)
  }

  claimPath(id) {
    return join(this.claimsDir, id)
  }

  load(id) {
    return readJson(this.recordPath(id), null)
  }

  save(record) {
    writeJson(this.recordPath(record.id), record)
    return record
  }

  listRecords() {
    let names
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const records = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = readJson(join(this.dir, name), null)
      if (record?.id) records.push(record)
    }
    records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    return records
  }

  /**
   * Persist one notification event. Re-enqueueing the same task/turn/kind is
   * idempotent unless the previous record was explicitly suppressed.
   */
  enqueue({
    taskId,
    turn,
    kind,
    threadId,
    message,
    stateAtEnqueue = null,
    detail = null,
    episodeAt = null,
    idSuffix = null,
  }) {
    const id = notificationId(taskId, turn, kind, idSuffix)
    const existing = this.load(id)
    if (existing) {
      // Event payloads are immutable once written. Senders mutate only the
      // delivery state (status/attempts/receipt) under a fenced claim; a late
      // enqueue replay must never roll a sent receipt back to pending.
      return existing
    }
    const record = {
      schema: 1,
      id,
      taskId,
      turn: Number(turn) || 0,
      kind,
      threadId: threadId ?? null,
      message: message ?? null,
      detail: detail == null ? null : truncate(String(detail), 1200),
      episodeAt: episodeAt ?? null,
      stateAtEnqueue,
      status: 'pending',
      attempts: 0,
      createdAt: nowIso(),
      lastAttemptAt: null,
      nextAttemptAt: nowIso(),
      lastError: null,
      claimedBy: null,
      claimExpiresAt: null,
      receipt: null,
      suppressedReason: null,
    }
    this.save(record)
    this.schedule(0)
    return record
  }

  /** Record a visible degradation instead of silently dropping a wake-up. */
  markDegraded({ taskId, turn = 0, kind = 'degraded', threadId = null, reason, idSuffix = null }) {
    const record = this.enqueue({
      taskId,
      turn,
      kind,
      threadId,
      message: null,
      stateAtEnqueue: null,
      detail: reason,
      idSuffix,
    })
    const existing = this.load(record.id) ?? record
    if (TERMINAL_STATUSES.has(existing.status)) return existing
    // Only the claim owner may turn a pending event into degraded.
    if (this.claimHealthy(existing.id)) return this.load(existing.id) ?? existing
    const fresh = this.claim(existing.id)
    if (!fresh) return this.load(existing.id) ?? existing
    fresh.status = 'degraded'
    fresh.lastError = truncate(String(reason), 1000)
    fresh.suppressedReason = truncate(String(reason), 1000)
    fresh.nextAttemptAt = null
    fresh.claimedBy = null
    fresh.claimExpiresAt = null
    this.save(fresh)
    this.releaseClaim(fresh.id)
    return fresh
  }

  summarize(taskId = null) {
    const records = this.listRecords().filter((record) => !taskId || record.taskId === taskId)
    const counts = { pending: 0, retrying: 0, sending: 0, sent: 0, suppressed: 0, degraded: 0 }
    for (const record of records) {
      if (counts[record.status] === undefined) counts[record.status] = 0
      counts[record.status] += 1
    }
    const active = records.filter((record) => PENDING_STATUSES.has(record.status))
    const nextAttemptAt = active
      .map((record) => record.nextAttemptAt)
      .filter(Boolean)
      .sort()[0] ?? null
    const lastError = [...records].reverse().find((record) => record.lastError)?.lastError ?? null
    const health = counts.degraded > 0
      ? 'degraded'
      : active.length > 0
        ? (counts.retrying > 0 || counts.sending > 0 ? 'retrying' : 'pending')
        : 'ok'
    return {
      health,
      counts,
      pending: counts.pending + counts.retrying + counts.sending,
      nextAttemptAt,
      lastError,
      recent: records.slice(-5).map((record) => ({
        id: record.id,
        taskId: record.taskId,
        turn: record.turn,
        kind: record.kind,
        status: record.status,
        attempts: record.attempts,
        threadId: record.threadId,
        lastError: record.lastError,
        nextAttemptAt: record.nextAttemptAt,
        receipt: record.receipt,
      })),
    }
  }

  schedule(delayMs = 0) {
    if (this.closed || !this.autoFlush) return
    const when = Date.now() + Math.max(0, Number(delayMs) || 0)
    if (this.timer && this.timerAt <= when) return
    if (this.timer) clearTimeout(this.timer)
    this.timerAt = when
    this.timer = setTimeout(() => {
      this.timer = null
      this.timerAt = 0
      void this.flush().catch(() => { /* flush records its own errors */ })
    }, Math.max(0, when - Date.now()))
    this.timer.unref?.()
  }

  nextDueDelay(records) {
    let next = null
    for (const record of records) {
      if (!PENDING_STATUSES.has(record.status)) continue
      let due = Date.parse(record.nextAttemptAt ?? record.createdAt ?? 0) || 0
      const claim = readJson(join(this.claimPath(record.id), 'claim.json'), null)
      if (claim) {
        // Another sender owns a healthy claim: wake when that lease expires,
        // not immediately (which would spin on a past nextAttemptAt).
        due = Math.max(due, Date.parse(claim.expiresAt ?? 0) || due)
      }
      if (next === null || due < next) next = due
    }
    if (next === null) return null
    return Math.max(0, next - Date.now())
  }

  /**
   * Send every due record, coalescing records that share one Codex thread into
   * a single `codex queue` call. Never creates a session and never uses a thread
   * other than the one captured at dispatch time.
   */
  async flush({ onlyIds = null } = {}) {
    if (this.closed) return { sent: 0, suppressed: 0, retried: 0, skipped: true }
    if (this.flushing) return { sent: 0, suppressed: 0, retried: 0, skipped: true }
    this.flushing = true
    // Normalize once: callers pass arrays (watchdog) or Sets, and the finally
    // block must use the same normalized value or it throws TypeError after a
    // successful send/failure.
    const only = onlyIds ? new Set(onlyIds) : null
    const result = { sent: 0, suppressed: 0, retried: 0, degraded: 0 }
    try {
      const now = Date.now()
      const due = this.listRecords().filter((record) => {
        if (only && !only.has(record.id)) return false
        if (!PENDING_STATUSES.has(record.status)) return false
        if (this.claimHealthy(record.id)) return false
        return (Date.parse(record.nextAttemptAt ?? record.createdAt ?? 0) || 0) <= now
      })
      const byThread = new Map()
      for (const record of due) {
        const key = record.threadId ?? ''
        if (!byThread.has(key)) byThread.set(key, [])
        byThread.get(key).push(record)
      }
      for (const [threadKey, records] of byThread) {
        const claimed = []
        for (const record of records) {
          const fresh = this.claim(record.id)
          if (!fresh) continue
          const evaluation = this.evaluate(fresh)
          if (!evaluation.ok) {
            if (evaluation.status === 'degraded') {
              this.degrade(fresh, evaluation.reason)
              result.degraded += 1
            } else {
              this.settle(fresh, evaluation)
              result.suppressed += 1
            }
            continue
          }
          claimed.push({ ...fresh, ...evaluation })
        }
        if (claimed.length === 0) continue
        const effectiveThread = threadKey || claimed[0]?.threadId || ''
        if (!effectiveThread) {
          for (const record of claimed) {
            this.degrade(record, 'no Codex thread id was captured at dispatch time')
            result.degraded += 1
          }
          continue
        }
        if (this.config.notifyCodex === false) {
          for (const record of claimed) {
            this.settle(record, { ok: false, status: 'suppressed', reason: 'ASTRA_DSH_NOTIFY_CODEX=0' })
            result.suppressed += 1
          }
          continue
        }
        if (!this.config.codexBin) {
          for (const record of claimed) {
            this.degrade(record, 'codex binary could not be found; notification cannot be delivered')
            result.degraded += 1
          }
          continue
        }

        const message = this.composeMessage(effectiveThread, claimed)
        const attemptAt = nowIso()
        for (const record of claimed) {
          const fresh = this.load(record.id) ?? record
          fresh.status = 'sending'
          fresh.attempts = Number(fresh.attempts ?? 0) + 1
          fresh.lastAttemptAt = attemptAt
          fresh.claimedBy = this.owner
          fresh.claimExpiresAt = new Date(Date.now() + this.config.notifyLeaseMs).toISOString()
          this.save(fresh)
        }
        let cliResult = null
        let failure = null
        const renewalMs = Math.max(25, Math.floor(this.config.notifyLeaseMs / 3))
        const renewal = setInterval(() => {
          for (const record of claimed) this.renewClaim(record.id)
        }, renewalMs)
        renewal.unref?.()
        try {
          cliResult = await runCommand(this.config.codexBin, ['queue', '--thread', effectiveThread, '--message', message], {
            timeoutMs: this.config.notifyCliTimeoutMs,
            maxBytes: 100_000,
          })
        } catch (error) {
          failure = error
        } finally {
          clearInterval(renewal)
        }
        const ok = !failure && cliResult && cliResult.code === 0 && !cliResult.timedOut
        for (const record of claimed) {
          const fresh = this.load(record.id) ?? record
          if (ok) {
            fresh.status = 'sent'
            fresh.receipt = {
              at: nowIso(),
              threadId: effectiveThread,
              code: cliResult.code,
              messageChars: message.length,
              attempts: fresh.attempts,
            }
            fresh.nextAttemptAt = null
            fresh.lastError = null
            fresh.claimedBy = null
            fresh.claimExpiresAt = null
            this.save(fresh)
            result.sent += 1
          } else {
            fresh.status = 'retrying'
            fresh.lastError = truncate(
              failure?.message
                ?? (cliResult?.timedOut ? 'codex queue timed out' : (cliResult?.stderr || cliResult?.stdout || `codex queue exited ${cliResult?.code}`)),
              1000,
            )
            fresh.nextAttemptAt = new Date(Date.now() + this.backoffMs(fresh.attempts)).toISOString()
            fresh.claimedBy = null
            fresh.claimExpiresAt = null
            this.save(fresh)
            result.retried += 1
          }
          this.releaseClaim(record.id)
        }
      }
      return result
    } finally {
      this.flushing = false
      const delay = this.nextDueDelay(this.listRecords().filter((record) => !only || only.has(record.id)))
      if (delay !== null) this.schedule(delay)
    }
  }

  composeMessage(threadId, records) {
    const tasks = [...new Set(records.map((record) => record.taskId))]
    const lines = records.map((record) => {
      const detail = record.detail ? ` — ${oneLine(record.detail, 220)}` : ''
      return `- ${record.taskId} turn ${record.turn} ${record.kind}${detail}`
    })
    return [
      `DSH bridge event${records.length > 1 ? 's' : ''} in ${this.store.workspace}:`,
      ...lines,
      '',
      `Call dsh_status and dsh_result for ${tasks.length > 1 ? 'each task' : tasks[0]} before deciding next steps. (thread ${threadId})`,
    ].join('\n')
  }

  /** Reload the task and decide whether this event is still worth waking Astra. */
  evaluate(record) {
    let task
    try {
      task = this.store.loadTask(record.taskId)
    } catch {
      return { ok: false, status: 'suppressed', reason: 'task no longer exists' }
    }
    if (!task.codexThreadId) {
      return { ok: false, status: 'degraded', reason: 'no Codex thread id was captured at dispatch time' }
    }
    if (record.threadId && record.threadId !== task.codexThreadId) {
      return { ok: false, status: 'suppressed', reason: 'dispatch thread changed; refusing to wake a different thread' }
    }
    record.threadId = task.codexThreadId
    record.task = task
    if (Number(task.turnIndex ?? 0) !== Number(record.turn ?? 0)) {
      return { ok: false, status: 'suppressed', reason: `event belongs to turn ${record.turn}, task is on turn ${task.turnIndex}` }
    }
    if (task.review || ['accepted', 'rejected', 'changes_requested'].includes(task.state)) {
      return { ok: false, status: 'suppressed', reason: 'task was already reviewed' }
    }
    if (task.state === 'cancelled') {
      return { ok: false, status: 'suppressed', reason: 'task was cancelled by the user' }
    }
    if (record.kind === 'suspected-stall') {
      const stall = task.stall ?? null
      if (!stall || stall.recoveredAt || stall.suspectedAt !== record.episodeAt) {
        return { ok: false, status: 'suppressed', reason: 'stall episode recovered before notification was sent' }
      }
      if (task.state !== 'running') {
        return { ok: false, status: 'suppressed', reason: 'task is no longer running' }
      }
    }
    if (record.kind === 'control-lost') {
      if (!['running', 'interrupted', 'failed'].includes(task.state)) {
        return { ok: false, status: 'suppressed', reason: `task is ${task.state}; control-loss alert is stale` }
      }
      const interrupted = this.load(notificationId(record.taskId, record.turn, 'interrupted'))
      if (interrupted?.status === 'sent') {
        return { ok: false, status: 'suppressed', reason: 'an interruption alert already covers this turn' }
      }
    }
    if (record.kind === 'interrupted') {
      const lost = this.load(notificationId(record.taskId, record.turn, 'control-lost'))
      if (lost && ['pending', 'sending', 'retrying', 'sent'].includes(lost.status)) {
        return { ok: false, status: 'suppressed', reason: 'a control-loss alert already covers this turn' }
      }
    }
    if (record.kind === 'settled' && task.state === 'running') {
      return { ok: false, status: 'suppressed', reason: 'task is still running (stale completion event)' }
    }
    return { ok: true, threadId: task.codexThreadId }
  }

  backoffMs(attempts) {
    const exponent = Math.max(0, Number(attempts ?? 1) - 1)
    const base = this.config.notifyRetryBaseMs * (2 ** Math.min(exponent, 20))
    const jitter = Math.floor(Math.random() * Math.max(1, base * 0.15))
    return Math.min(this.config.notifyRetryMaxMs, base + jitter)
  }

  claimHealthy(id) {
    const claimFile = join(this.claimPath(id), 'claim.json')
    const claim = readJson(claimFile, null)
    if (!claim) return false
    return Date.parse(claim.expiresAt ?? 0) > Date.now()
  }

  /**
   * Atomically claim one record. `mkdir` is the cross-process lock: exactly one
   * sender wins. A live claim is respected; an expired claim is moved aside.
   */
  claim(id) {
    const dir = this.claimPath(id)
    let acquired = false
    try {
      mkdirSync(dir)
      acquired = true
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const claim = readJson(join(dir, 'claim.json'), null)
      const claimExpires = Date.parse(claim?.expiresAt ?? 0)
      const stat = statOrUndefined(dir)
      const tooYoung = !claim && stat && Date.now() - stat.mtimeMs < 5000
      if (claimExpires > Date.now() || tooYoung) return null
      const stale = `${dir}.stale-${process.pid}-${shortId(2)}`
      try {
        renameSync(dir, stale)
      } catch {
        return null
      }
      removePath(stale)
      try {
        mkdirSync(dir)
        acquired = true
      } catch {
        return null
      }
    }
    if (!acquired) return null
    const fresh = this.load(id)
    if (!fresh || TERMINAL_STATUSES.has(fresh.status)) {
      this.releaseClaim(id)
      return null
    }
    const token = shortId(8)
    writeJson(join(dir, 'claim.json'), {
      owner: this.owner,
      pid: process.pid,
      token,
      recordId: id,
      claimedAt: nowIso(),
      expiresAt: new Date(Date.now() + this.config.notifyLeaseMs).toISOString(),
    })
    this.heldClaims.set(id, token)
    return fresh
  }

  /** Fenced release: never delete a claim another sender has taken over. */
  releaseClaim(id) {
    const token = this.heldClaims.get(id)
    this.heldClaims.delete(id)
    if (!token) return
    const claim = readJson(join(this.claimPath(id), 'claim.json'), null)
    if (claim?.owner === this.owner && claim?.token === token) {
      removePath(this.claimPath(id))
    }
  }

  /** Extend our lease while the external CLI is still running. */
  renewClaim(id) {
    const token = this.heldClaims.get(id)
    if (!token) return false
    const file = join(this.claimPath(id), 'claim.json')
    const claim = readJson(file, null)
    if (!claim || claim.owner !== this.owner || claim.token !== token) return false
    claim.expiresAt = new Date(Date.now() + this.config.notifyLeaseMs).toISOString()
    writeJson(file, claim)
    return true
  }

  settle(record, { status = 'suppressed', reason = null } = {}) {
    const fresh = this.load(record.id)
    if (!fresh) {
      this.releaseClaim(record.id)
      return
    }
    fresh.status = status
    fresh.suppressedReason = truncate(reason ?? 'notification invalidated', 1000)
    fresh.nextAttemptAt = null
    fresh.claimedBy = null
    fresh.claimExpiresAt = null
    this.save(fresh)
    this.releaseClaim(record.id)
  }

  degrade(record, reason) {
    const fresh = this.load(record.id) ?? record
    if (fresh.status === 'sent') return fresh
    fresh.status = 'degraded'
    fresh.lastError = truncate(reason, 1000)
    fresh.suppressedReason = truncate(reason, 1000)
    fresh.nextAttemptAt = null
    fresh.claimedBy = null
    fresh.claimExpiresAt = null
    this.save(fresh)
    this.releaseClaim(record.id)
  }

  /**
   * Recover after a bridge restart: stale `sending` claims become retryable and
   * pending/retrying records are rescheduled. Records that are already terminal
   * are left alone.
   */
  recover() {
    let recovered = 0
    for (const record of this.listRecords()) {
      if (!PENDING_STATUSES.has(record.status)) continue
      // A healthy claim belongs to another (possibly live) sender. Never edit
      // its record or remove its lease from the recovery path.
      if (this.claimHealthy(record.id)) continue
      const fresh = this.claim(record.id)
      if (!fresh) continue
      if (fresh.status === 'sending') {
        fresh.status = 'retrying'
        fresh.lastError = fresh.lastError ?? 'sender stopped before writing a receipt'
      }
      // A restart should resume a pending/retrying record promptly rather than
      // waiting out a backoff scheduled by the dead sender.
      fresh.nextAttemptAt = nowIso()
      fresh.claimedBy = null
      fresh.claimExpiresAt = null
      this.save(fresh)
      this.releaseClaim(fresh.id)
      recovered += 1
    }
    this.schedule(0)
    return { recovered }
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.timerAt = 0
  }
}

/** Build a human summary for status tools without failing on a bad record. */
export function renderNotificationSummary(summary) {
  if (!summary) return 'unknown'
  const parts = []
  for (const key of ['pending', 'retrying', 'sending', 'sent', 'suppressed', 'degraded']) {
    if (summary.counts?.[key]) parts.push(`${key} ${summary.counts[key]}`)
  }
  if (summary.nextAttemptAt) parts.push(`next ${summary.nextAttemptAt}`)
  return parts.length ? parts.join(' · ') : 'none'
}

export { PENDING_STATUSES, TERMINAL_STATUSES }
