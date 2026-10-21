/**
 * Minimal ACP (Agent Client Protocol) client over newline-delimited JSON-RPC.
 *
 * DSH ships an ACP server specifically for automation clients: persistent
 * sessions, committed semantic updates, cancellation, and one-shot permission
 * decisions. This client deliberately implements only that surface, with no
 * dependency on the SDK used inside the DSH checkout.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { BridgeError, ensureDir } from './util.mjs'
import { dirname } from 'node:path'

const PROTOCOL_VERSION = 1

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
    this.turnHandlers = new Map()
    this.activeSessions = new Set()
  }

  /** Spawn the agent if it is not already running. */
  async start() {
    if (this.alive) return
    if (this.logPath) {
      ensureDir(dirname(this.logPath))
      this.logStream = createWriteStream(this.logPath, { flags: 'a' })
      this.logStream.write(`\n=== ACP client ${new Date().toISOString()} cwd=${this.cwd} ===\n`)
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
    child.stderr.on('data', (chunk) => {
      this.logStream?.write(String(chunk))
    })
    child.on('error', (error) => {
      this.failAll(new BridgeError(`ACP process failed to start: ${error.message}`, { code: 'ACP_SPAWN_FAILED' }))
    })
    child.on('exit', (code, signal) => {
      const wasAlive = this.alive
      this.alive = false
      this.logStream?.write(`=== ACP exit code=${code} signal=${signal} ${new Date().toISOString()} ===\n`)
      if (wasAlive) {
        this.failAll(new BridgeError(`ACP process exited (code=${code}, signal=${signal})`, { code: 'ACP_EXITED' }))
        this.emit('exit', { code, signal })
      }
    })
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
   * Send one prompt and resolve when the turn settles.
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.text
   * @param {(update:object)=>void} [options.onUpdate]
   * @param {(request:object)=>void} [options.onPermission]
   */
  async prompt({ sessionId, text, onUpdate, onPermission }) {
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
    if (!this.alive) return
    this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
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

  /** Stop the child process and reject anything still in flight. */
  async dispose() {
    const child = this.child
    if (!child) return
    this.alive = false
    this.lineReader?.close()
    try {
      child.stdin.end()
    } catch {
      // Already closed.
    }
    await new Promise((resolvePromise) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolvePromise()
      }
      child.once('exit', finish)
      setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          // Already gone.
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
          finish()
        }, 1500)
      }, 800)
      setTimeout(finish, 4000)
    })
    this.failAll(new BridgeError('ACP client disposed', { code: 'ACP_DISPOSED' }))
    this.logStream?.end()
    this.logStream = null
  }

  // ------------------------------------------------------------- internals

  send(message) {
    if (!this.alive || !this.child?.stdin?.writable) {
      throw new BridgeError('ACP process is not running', { code: 'ACP_NOT_RUNNING' })
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
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

  onLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.logStream?.write(`=== unparseable ACP line: ${line.slice(0, 400)} ===\n`)
      return
    }
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
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `unsupported client method: ${message.method}` },
      })
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
    this.send({ jsonrpc: '2.0', id: message.id, result })
    this.emit('permission', { sessionId: params.sessionId, decision, toolCall: params.toolCall, options })
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.turnHandlers.clear()
    this.activeSessions.clear()
  }
}
