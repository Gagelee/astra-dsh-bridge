/**
 * Minimal ACP (Agent Client Protocol) client over newline-delimited JSON-RPC.
 *
 * DSH ships an ACP server specifically for automation clients: persistent
 * sessions, committed semantic updates, cancellation, and one-shot permission
 * decisions. This client deliberately implements only that surface, with no
 * dependency on the SDK used inside the DSH checkout.
 *
 * Transport failures are terminal and idempotent. A closed stdout, a broken
 * stdin (EPIPE), a process exit, or an unrecoverable protocol stream rejects
 * every pending request exactly once, records the exit facts and a redacted
 * stderr tail, and marks the client unusable. A slow tool is *not* a transport
 * failure: no watchdog timer runs while a prompt is legitimately silent.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { BridgeError, ensureDir, nowIso, summarizeStderr } from './util.mjs'
import { dirname } from 'node:path'

const PROTOCOL_VERSION = 1
const STDERR_TAIL_BYTES = 16_000
const MAX_UNPARSEABLE_LINES = 50

/** Start a child process and speak ACP to it. */
export class AcpClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.command
   * @param {string[]} [options.args]
   * @param {string} options.cwd
   * @param {Record<string,string>} [options.env]
   * @param {string} [options.logPath]
   * @param {'allow'|'reject'} [options.permissionPolicy]
   */
  constructor({ command, args = [], cwd, env, logPath, permissionPolicy = 'allow' }) {
    super()
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env ?? process.env
    this.logPath = logPath
    this.permissionPolicy = permissionPolicy
    this.child = null
    this.alive = false
    this.pending = new Map()
    this.nextId = 1
    this.lineReader = null
    this.logStream = null
    this.initialized = false
    this.initResult = null
    this.turnHandlers = new Map()
    this.activeSessions = new Set()
    this.cancelledSessions = new Set()
    this.stderrTail = ''
    this.termination = null
    this.terminating = false
    this.disposing = false
    this.disposed = false
    this.disposePromise = null
    this.lineClosed = false
    this.unparseableLines = 0
    this.timers = new Set()
    this.handlers = null
  }

  /** Spawn the agent if it is not already running. */
  async start() {
    if (this.alive) return
    if (this.disposed || this.terminating || this.termination) {
      throw new BridgeError('ACP client is already terminated; create a new client', { code: 'ACP_DISPOSED' })
    }
    if (this.logPath) {
      ensureDir(dirname(this.logPath))
      this.logStream = createWriteStream(this.logPath, { flags: 'a' })
      this.logStream.write(`\n=== ACP client ${new Date().toISOString()} cwd=${this.cwd} ===\n`)
      this.logStream.on('error', () => { /* diagnostics must never crash a turn */ })
    }
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.alive = true
    this.lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lineReader.on('line', (line) => this.onLine(line))
    this.lineReader.on('close', () => this.onStdoutClosed())

    const onStdoutError = (error) => {
      this.terminate(new BridgeError(`ACP stdout failed: ${error?.message ?? error}`, { code: 'ACP_STREAM_ERROR' }))
    }
    const onStderr = (chunk) => {
      const text = String(chunk)
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES)
      this.logStream?.write(text)
    }
    const onStdinError = (error) => {
      this.terminate(new BridgeError(`ACP stdin failed (${error?.code ?? 'error'}): ${error?.message ?? error}`, {
        code: 'ACP_STDIN_ERROR',
      }))
    }
    const onError = (error) => {
      this.terminate(new BridgeError(`ACP process failed to start: ${error.message}`, { code: 'ACP_SPAWN_FAILED' }))
    }
    const onExit = (code, signal) => this.onExit(code, signal)
    this.handlers = { onStdoutError, onStderr, onStdinError, onError, onExit }
    child.stdout.on('error', onStdoutError)
    child.stderr.on('data', onStderr)
    child.stderr.on('error', () => { /* stderr is diagnostic only */ })
    child.stdin.on('error', onStdinError)
    child.on('error', onError)
    child.on('exit', onExit)
  }

  /** Handshake once per process. */
  async initialize() {
    if (this.initialized) return this.initResult
    await this.start()
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'astra-dsh-bridge', version: '1.0.0' },
    }, { timeoutMs: 60_000 })
    this.initialized = true
    this.initResult = result
    return result
  }

  /** Create a session rooted at an absolute working directory. */
  async newSession({ cwd }) {
    await this.initialize()
    const result = await this.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 180_000 })
    if (!result?.sessionId) {
      throw new BridgeError('ACP session/new returned no sessionId', { code: 'ACP_PROTOCOL' })
    }
    this.activeSessions.add(result.sessionId)
    return result
  }

  /** Resume a persisted session in the same working directory. */
  async resumeSession({ sessionId, cwd }) {
    await this.initialize()
    const result = await this.request('session/resume', { sessionId, cwd, mcpServers: [] }, { timeoutMs: 120_000 })
    this.activeSessions.add(sessionId)
    return result
  }

  /** Set a session configuration option such as model or reasoning_effort. */
  async setConfig({ sessionId, configId, value }) {
    return this.request('session/set_config_option', { sessionId, configId, value }, { timeoutMs: 60_000 })
  }

  /**
   * Send one prompt and resolve when the turn settles. The prompt itself has no
   * timer: only a transport failure ends it early.
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.text
   * @param {(update:object)=>void} [options.onUpdate]
   * @param {(request:object)=>void} [options.onPermission]
   */
  async prompt({ sessionId, text, onUpdate, onPermission }) {
    this.cancelledSessions.delete(sessionId)
    this.turnHandlers.set(sessionId, { onUpdate, onPermission })
    try {
      return await this.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      }, { timeoutMs: 0 })
    } finally {
      this.turnHandlers.delete(sessionId)
    }
  }

  /** Ask the agent to cancel the in-flight turn. This is a notification, not a request. */
  cancel(sessionId) {
    this.cancelledSessions.add(sessionId)
    if (!this.alive) return false
    try {
      this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
      return true
    } catch {
      return false
    }
  }

  /** Close a session on the agent while keeping its persisted log. */
  async closeSession(sessionId) {
    if (!this.alive) return
    try {
      await this.request('session/close', { sessionId }, { timeoutMs: 60_000 })
    } finally {
      this.activeSessions.delete(sessionId)
    }
  }

  /**
   * Stop the child process and reject anything still in flight. If the child has
   * already exited this completes immediately; every timer and listener this
   * client owns is removed so a disposed client cannot keep the loop alive.
   */
  async dispose() {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = (async () => {
      this.disposing = true
      this.lineClosed = true
      const child = this.child
      if (!child) {
        this.cleanup()
        this.markExpectedDispose()
        return
      }
      const alreadyExited = child.exitCode !== null || child.signalCode !== null
      if (alreadyExited) {
        this.markExpectedDispose()
        this.cleanup()
        return
      }
      try {
        child.stdin.end()
      } catch {
        // Already closed.
      }
      await this.waitForExit(child)
      this.markExpectedDispose()
      this.cleanup()
    })()
    return this.disposePromise
  }

  /** Wait for an exiting child, with bounded SIGTERM/SIGKILL escalation. */
  waitForExit(child) {
    return new Promise((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolvePromise()
        return
      }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        for (const timer of [termTimer, killTimer, hardTimer]) clearTimeout(timer)
        this.timers.delete(termTimer)
        this.timers.delete(killTimer)
        this.timers.delete(hardTimer)
        resolvePromise()
      }
      child.once('exit', finish)
      const termTimer = this.setTimer(() => {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
      }, 800)
      const killTimer = this.setTimer(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, 2300)
      const hardTimer = this.setTimer(finish, 4000)
    })
  }

  // ------------------------------------------------------------- internals

  setTimer(fn, ms) {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    this.timers.add(timer)
    return timer
  }

  /** Remove every listener/timer/file handle owned by this client. */
  cleanup() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    try { this.lineReader?.close() } catch { /* already closed */ }
    this.lineReader = null
    const child = this.child
    if (child && this.handlers) {
      child.stderr.removeListener('data', this.handlers.onStderr)
      child.stdout.removeListener('error', this.handlers.onStdoutError)
      child.stdin.removeListener('error', this.handlers.onStdinError)
      child.removeListener('error', this.handlers.onError)
      child.removeListener('exit', this.handlers.onExit)
    }
    this.handlers = null
    try { this.logStream?.end() } catch { /* best effort */ }
    this.logStream = null
    this.alive = false
    this.disposed = true
  }

  markExpectedDispose() {
    if (this.termination) return
    this.terminate(new BridgeError('ACP client disposed', { code: 'ACP_DISPOSED' }), { expected: true })
  }

  /**
   * Terminal, idempotent transport failure. Only the first call settles pending
   * requests; later faults just enrich the recorded exit facts.
   */
  terminate(error, { expected = false, kill = false } = {}) {
    if (this.termination) return this.termination
    if (this.terminating) return this.termination
    this.terminating = true
    this.alive = false
    const child = this.child
    const termination = {
      code: error?.code ?? 'ACP_ERROR',
      message: error?.message ?? String(error),
      exitCode: Number.isInteger(child?.exitCode) ? child.exitCode : null,
      signal: child?.signalCode ?? null,
      stderrSummary: summarizeStderr(this.stderrTail),
      at: nowIso(),
      expected,
      cancelledSessions: [...this.cancelledSessions],
    }
    this.termination = termination
    const failure = new BridgeError(termination.message, {
      code: termination.code,
      details: { ...(error?.details ?? {}), ...termination },
    })
    const pending = [...this.pending.values()]
    this.pending.clear()
    this.turnHandlers.clear()
    this.activeSessions.clear()
    for (const entry of pending) entry.reject(failure)
    if (!expected) {
      this.emit('failure', termination)
      this.emit('terminated', termination)
    }
    if (kill && child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      this.setTimer(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, 1000)
    }
    this.terminating = false
    return termination
  }

  onExit(code, signal) {
    const expected = this.disposing || this.disposed
    const error = expected
      ? new BridgeError('ACP client disposed', { code: 'ACP_DISPOSED' })
      : new BridgeError(`ACP process exited (code=${code}, signal=${signal})`, {
        code: 'ACP_EXITED',
        details: { exitCode: code, signal },
      })
    const termination = {
      code: error.code,
      message: error.message,
      exitCode: code,
      signal,
      stderrSummary: summarizeStderr(this.stderrTail),
      at: nowIso(),
      expected,
      cancelledSessions: [...this.cancelledSessions],
    }
    if (!this.termination) {
      this.terminate(error, { expected })
    }
    // A later exit may carry the real code/signal; keep the first settlement but
    // enrich the recorded facts.
    if (this.termination) {
      this.termination.exitCode = code
      this.termination.signal = signal
      this.termination.stderrSummary = summarizeStderr(this.stderrTail)
    }
    this.logStream?.write(`=== ACP exit code=${code} signal=${signal} ${new Date().toISOString()} ===\n`)
    this.emit('exit', { code, signal, ...termination })
  }

  stdoutClosedError() {
    return new BridgeError('ACP stdout closed before the process exited', { code: 'ACP_STREAM_CLOSED' })
  }

  onStdoutClosed() {
    if (this.lineClosed || this.disposing || this.disposed) return
    this.lineClosed = true
    // Give a concurrent process exit one tick to win: an exit carries the real
    // exitCode/signal, while a genuinely hung child still fails promptly.
    this.setTimer(() => {
      if (!this.termination) this.terminate(this.stdoutClosedError())
    }, 25)
  }

  stdinError(error) {
    this.terminate(new BridgeError(`ACP stdin failed (${error?.code ?? 'error'}): ${error?.message ?? error}`, {
      code: 'ACP_STDIN_ERROR',
    }))
  }

  send(message) {
    if (!this.alive || this.termination || !this.child?.stdin?.writable) {
      throw new BridgeError('ACP process is not running', {
        code: 'ACP_NOT_RUNNING',
        details: this.termination ? { termination: this.termination } : undefined,
      })
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.stdinError(error)
      })
    } catch (error) {
      this.stdinError(error)
      throw new BridgeError(`ACP write failed: ${error.message}`, { code: 'ACP_STDIN_ERROR' })
    }
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    if (this.termination) {
      return Promise.reject(this.terminationError(`ACP request rejected after ${this.termination.code}: ${method}`))
    }
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = timeoutMs > 0
        ? this.setTimer(() => {
          this.pending.delete(id)
          rejectPromise(new BridgeError(`ACP request timed out: ${method}`, { code: 'ACP_TIMEOUT' }))
        }, timeoutMs)
        : undefined
      this.pending.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolvePromise(value)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          rejectPromise(error)
        },
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        rejectPromise(error)
      }
    })
  }

  terminationError(message) {
    return new BridgeError(message, {
      code: this.termination.code,
      details: { ...this.termination },
    })
  }

  onLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.unparseableLines += 1
      this.logStream?.write(`=== unparseable ACP line: ${line.slice(0, 400)} ===\n`)
      if (this.unparseableLines >= MAX_UNPARSEABLE_LINES) {
        this.terminate(new BridgeError(
          `ACP protocol stream is not JSON-RPC (${this.unparseableLines} unparseable lines)`,
          { code: 'ACP_PROTOCOL_CORRUPT' },
        ))
      }
      return
    }
    this.unparseableLines = 0
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new BridgeError(
          `ACP ${pending.method} failed: ${message.error.message ?? 'unknown error'}`,
          { code: 'ACP_ERROR', details: message.error },
        ))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.id !== undefined && message.method) {
      this.onAgentRequest(message)
      return
    }
    if (message.method === 'session/update') {
      const { sessionId, update } = message.params ?? {}
      const handler = this.turnHandlers.get(sessionId)
      handler?.onUpdate?.(update)
      this.emit('update', { sessionId, update })
    }
  }

  onAgentRequest(message) {
    if (message.method !== 'session/request_permission') {
      try {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `unsupported client method: ${message.method}` },
        })
      } catch { /* transport already gone */ }
      return
    }
    const params = message.params ?? {}
    const handler = this.turnHandlers.get(params.sessionId)
    let decision = this.permissionPolicy === 'allow' ? 'allow' : 'reject'
    // A caller may make a per-turn decision (for example rejecting outside the
    // declared write scopes); it still cannot make the agent invent a new option.
    try {
      const override = handler?.onPermission?.(params)
      if (override === 'allow' || override === 'reject') decision = override
    } catch {
      decision = 'reject'
    }
    const options = Array.isArray(params.options) ? params.options : []
    const wanted = decision === 'allow'
      ? options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always')
      : options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always')
    const result = wanted
      ? { outcome: { outcome: 'selected', optionId: wanted.optionId } }
      : { outcome: { outcome: 'cancelled' } }
    try {
      this.send({ jsonrpc: '2.0', id: message.id, result })
    } catch { /* the runner will observe the transport failure */ }
    this.emit('permission', { sessionId: params.sessionId, decision, toolCall: params.toolCall, options })
  }

  /** Backwards-compatible explicit failure entry point. */
  failAll(error) {
    return this.terminate(error ?? new BridgeError('ACP transport failed', { code: 'ACP_ERROR' }))
  }
}
