/**
 * Per-turn watchdog supervisor.
 *
 * A small detached Node process is started for each DSH turn. It holds an IPC
 * channel to the bridge; if that channel disconnects because the bridge died
 * (including SIGKILL), the sidecar writes one control-loss incident and one
 * durable notification, then exits. It is not a daemon: normal turn end sends
 * `shutdown` so the sidecar exits immediately, and it never retries forever.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nowIso, isPidAlive, truncate } from './util.mjs'

const SIDECAR = fileURLToPath(new URL('./watchdog.mjs', import.meta.url))

export class WatchdogSupervisor {
  constructor({ store, config, env = process.env, scriptPath = null }) {
    this.store = store
    this.config = config
    this.env = env
    this.customScriptPath = scriptPath
    this.entries = new Map()
    this.degraded = new Map()
    this.closed = false
  }

  scriptPath() {
    return this.customScriptPath ?? SIDECAR
  }

  /** Start (or replace) the sidecar for one task turn. Never throws. */
  async start(task) {
    if (this.closed) return { active: false, degraded: 'bridge is shutting down' }
    if (!this.config.watchdog) {
      return {
        active: false,
        degraded: 'watchdog disabled by ASTRA_DSH_WATCHDOG=0; only in-process reconcile covers a bridge crash',
      }
    }
    await this.stop(task.id, 'replaced')
    const turn = Number(task.turnIndex ?? 0)
    const instance = task.runner?.instance ?? null
    let child
    try {
      child = spawn(process.execPath, [this.scriptPath(), this.store.workspace, task.id], {
        cwd: this.store.workspace,
        env: { ...this.env, ASTRA_DSH_WATCHDOG_SIDECAR: '1' },
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
    } catch (error) {
      const degraded = `could not spawn watchdog sidecar: ${error.message}`
      this.failStart(task, degraded)
      return { active: false, degraded }
    }
    const entry = { child, pid: child.pid ?? null, taskId: task.id, turn, startedAt: nowIso(), state: 'starting' }
    this.entries.set(task.id, entry)
    child.on('error', (error) => {
      if (this.entries.get(task.id)?.child !== child) return
      this.entries.delete(task.id)
      this.failStart(task, `watchdog sidecar failed: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      const current = this.entries.get(task.id)
      if (current?.child !== child) return
      this.entries.delete(task.id)
      // An exit while the turn is still running means the independent monitor
      // died early; surface that instead of pretending the task is watched.
      try {
        const fresh = this.store.loadTask(task.id)
        if (fresh.state === 'running' && Number(fresh.turnIndex ?? 0) === turn) {
          this.failStart(task, `watchdog sidecar exited early (code=${code}, signal=${signal}); a bridge crash has no independent alert`)
        }
      } catch {
        // Task already gone.
      }
    })
    child.unref()
    const spawned = await new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => done(false), 2000)
      child.once('spawn', () => done(true))
      child.once('error', () => done(false))
    })
    if (!spawned) {
      this.entries.delete(task.id)
      await this.killSidecar(child)
      const degraded = 'watchdog sidecar did not start in time'
      this.failStart(task, degraded)
      return { active: false, degraded }
    }

    const ready = await this.waitReady(child, { taskId: task.id, turn, instance })
    if (!ready.ok) {
      this.entries.delete(task.id)
      try { child.send({ type: 'shutdown', reason: 'ready-failed' }) } catch { /* already gone */ }
      await this.killSidecar(child)
      const degraded = `watchdog sidecar was not ready: ${ready.reason}`
      this.failStart(task, degraded)
      return { active: false, degraded }
    }

    const liveEntry = this.entries.get(task.id)
    if (!liveEntry || liveEntry.child !== child) {
      const degraded = this.degraded.get(task.id) ?? 'watchdog sidecar exited immediately after ready'
      return { active: false, degraded }
    }
    entry.state = 'active'
    this.degraded.delete(task.id)
    try {
      this.store.updateTask(task.id, (fresh) => {
        fresh.monitor = {
          watchdog: 'active',
          pid: entry.pid,
          instance,
          turn,
          readyAt: nowIso(),
          startedAt: entry.startedAt,
        }
        return fresh
      })
    } catch {
      // A monitor annotation must never fail the turn itself.
    }
    return { active: true, pid: entry.pid, turn }
  }

  /** Wait for a ready ACK carrying the same task/turn/runner instance. */
  waitReady(child, { taskId, turn, instance }) {
    return new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener('message', onMessage)
        child.removeListener('exit', onExit)
        resolve(value)
      }
      const timer = setTimeout(
        () => done({ ok: false, reason: `no ready ACK within ${this.config.watchdogReadyTimeoutMs}ms` }),
        this.config.watchdogReadyTimeoutMs,
      )
      const onMessage = (message) => {
        if (!message || message.type !== 'ready') return
        if (message.taskId !== taskId) return
        if (Number(message.turn ?? -1) !== Number(turn)) return
        if (instance && message.runnerInstance && message.runnerInstance !== instance) return
        if (message.ok === false) {
          done({ ok: false, reason: message.reason ?? 'sidecar reported initialization failure' })
          return
        }
        done({ ok: true, pid: message.pid ?? child.pid })
      }
      const onExit = (code, signal) => done({ ok: false, reason: `sidecar exited before ready (code=${code}, signal=${signal})` })
      child.on('message', onMessage)
      child.once('exit', onExit)
      try {
        child.send({ type: 'turn-start', taskId, turn, runnerInstance: instance })
      } catch (error) {
        done({ ok: false, reason: `could not handshake: ${error.message}` })
      }
    })
  }

  async killSidecar(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, 1500)
      child.once('exit', finish)
    })
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    const force = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, 500)
    force.unref?.()
    await exited
  }

  failStart(task, reason) {
    this.degraded.set(task.id, reason)
    this.recordDegraded(task, reason)
  }

  recordDegraded(task, reason) {
    try {
      this.store.appendEvent(task, { type: 'watchdog_degraded', error: truncate(reason, 500) })
      this.store.updateTask(task.id, (fresh) => {
        fresh.monitor = { watchdog: 'degraded', reason: truncate(reason, 500), at: nowIso() }
        return fresh
      })
    } catch {
      // Diagnostics only.
    }
  }

  /** Stop one sidecar. Normal turn end waits briefly for a clean, idempotent exit. */
  async stop(taskId, reason = 'turn-end') {
    const entry = this.entries.get(taskId)
    if (!entry) return
    this.entries.delete(taskId)
    const child = entry.child
    const waitMs = reason === 'bridge-shutdown' ? 5000 : 3000
    const exited = new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, waitMs)
      child.once('exit', finish)
      if (child.exitCode !== null || child.signalCode !== null) finish()
    })
    try {
      child.send({ type: 'shutdown', reason })
    } catch {
      // Already gone.
    }
    await exited
    if (child.exitCode === null && child.signalCode === null && reason !== 'bridge-shutdown') {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, 1000).unref?.()
    }
    if (child.exitCode === null && child.signalCode === null && reason === 'bridge-shutdown') {
      // The detached sidecar owns a durable control-loss event and may still be
      // within its bounded retry budget. Let it finish after this process exits
      // instead of truncating the last possible wake-up.
      return
    }
    try {
      this.store.updateTask(taskId, (fresh) => {
        if (fresh.monitor?.pid === entry.pid) {
          fresh.monitor = { watchdog: 'stopped', pid: entry.pid, turn: entry.turn, stoppedAt: nowIso() }
        }
        return fresh
      })
    } catch {
      // The task may already be gone.
    }
  }

  async stopAll(reason = 'bridge-shutdown') {
    this.closed = true
    const ids = [...this.entries.keys()]
    await Promise.allSettled(ids.map((id) => this.stop(id, reason)))
  }

  status(taskId) {
    const entry = this.entries.get(taskId)
    if (entry) return { watchdog: entry.state, pid: entry.pid, turn: entry.turn, startedAt: entry.startedAt }
    const degraded = this.degraded.get(taskId)
    if (degraded) return { watchdog: 'degraded', reason: degraded }
    return { watchdog: this.config.watchdog ? 'inactive' : 'disabled' }
  }

  sidecarAlive(taskId) {
    const entry = this.entries.get(taskId)
    return Boolean(entry?.pid && isPidAlive(entry.pid))
  }
}

export { SIDECAR }
