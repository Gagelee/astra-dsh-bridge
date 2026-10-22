/**
 * Host control plane for Astra-DSH.
 *
 * The bridge runs outside the GUI process. This plugin opens a private Unix
 * socket inside the host and exposes only the operations needed to create and
 * drive a host-owned Session, so the GUI gets a native live transcript instead
 * of a cold-read of an external ACP log.
 *
 * Protocol: one JSON object per line. Request { id, method, params }.
 * Response { id, ok, result } or { id, ok: false, error }.
 * `follow` is a stream: { id, event: 'frame', frame } ... { id, event: 'end' }.
 */

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'astra-dsh-host-control'
export const inject = ['sessionController', 'workspaceRegistry']
export const VERSION = '0.1.0'
export const PROTOCOL = 1

const MAX_LINE = 16 * 1024 * 1024

async function safeWriteJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

export function apply(ctx, options = {}) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(dshHome, 'astra-dsh')
  const socketPath = options.socketPath ?? join(stateDir, 'host-control.sock')
  const statusFile = options.statusFile ?? join(stateDir, 'host-control.json')
  const server = createServer()
  let stopped = false
  const controllers = new Set()

  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (existsSync(socketPath)) {
    try { rmSync(socketPath, { force: true }) } catch { /* listen will report */ }
  }

  const health = () => ({
    ok: true,
    version: VERSION,
    protocol: PROTOCOL,
    pid: process.pid,
    dshHome,
    socketPath,
    capabilities: ['session.create', 'session.prompt', 'session.cancel', 'session.status', 'session.follow', 'workspace.resolve'],
  })

  async function listSummary(sessionId) {
    const result = await ctx.sessionController.list({}, new AbortController().signal)
    const items = Array.isArray(result?.items) ? result.items : []
    return items.find((item) => item?.sessionId === sessionId) ?? null
  }

  async function resolveWorkspace(params) {
    const path = typeof params?.path === 'string' ? params.path : ''
    if (!path.startsWith('/')) throw Object.assign(new Error('path must be absolute'), { code: 'BAD_REQUEST' })
    let workspace = await ctx.workspaceRegistry.resolveByPath(path)
    if (!workspace && params?.policy === 'create') {
      workspace = await ctx.workspaceRegistry.create(path, typeof params.title === 'string' ? params.title : undefined)
    }
    if (!workspace) throw Object.assign(new Error('workspace is not registered'), { code: 'WORKSPACE_NOT_FOUND' })
    return { workspaceId: workspace.id, path: workspace.path, title: workspace.title ?? null, sessionIds: workspace.sessionIds ?? [] }
  }

  async function createSession(params) {
    const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
    if (!cwd.startsWith('/')) throw Object.assign(new Error('cwd must be absolute'), { code: 'BAD_REQUEST' })
    const created = await ctx.sessionController.create({
      cwd,
      ...(typeof params?.workspaceId === 'string' && params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(typeof params?.agentPreset === 'string' && params.agentPreset ? { agentPreset: params.agentPreset } : {}),
    })
    const sessionId = created?.sessionId
    if (!sessionId) throw Object.assign(new Error('host did not return a sessionId'), { code: 'HOST_ERROR' })
    let attached = false
    try {
      const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
      if (workspace) {
        await workspace.attachSession(sessionId)
        attached = true
      }
    } catch (error) {
      // Grouping is best effort; the host-owned Session is still live without it.
      console.warn(`[astra-dsh-host-control] workspace attach failed: ${error?.message ?? error}`)
    }
    let selected = null
    if (typeof params?.model === 'string' && params.model) {
      const provider = typeof params?.provider === 'string' && params.provider ? params.provider : 'deepseek-official'
      const selection = await ctx.sessionController.selectModel({
        sessionId,
        provider,
        model: params.model,
        ...(typeof params?.reasoningEffort === 'string' && params.reasoningEffort
          ? { reasoningEffort: params.reasoningEffort }
          : {}),
      })
      selected = selection?.selected ?? null
    }
    if (typeof params?.prompt === 'string' && params.prompt.trim()) {
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: params.prompt }],
        clientTimeZone: typeof params?.clientTimeZone === 'string' ? params.clientTimeZone : undefined,
      }, new AbortController().signal)
    }
    return { sessionId, agentPreset: created.agentPreset ?? null, selected, attached, protocol: PROTOCOL }
  }

  async function prompt(params) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    const text = typeof params?.text === 'string' ? params.text : ''
    if (!sessionId || !text.trim()) throw Object.assign(new Error('sessionId and text are required'), { code: 'BAD_REQUEST' })
    await ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: params?.mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: typeof params?.clientTimeZone === 'string' ? params.clientTimeZone : undefined,
    }, new AbortController().signal)
    return { accepted: true }
  }

  function cancel(params) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'BAD_REQUEST' })
    return ctx.sessionController.cancel({ sessionId })
  }

  async function status(params) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'BAD_REQUEST' })
    return { summary: await listSummary(sessionId) }
  }

  async function* follow(params, signal) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'BAD_REQUEST' })
    const stream = ctx.sessionController.follow({
      address: { kind: 'session', sessionId },
      assistantStream: true,
      ...(params?.maxMessages ? { maxMessages: Number(params.maxMessages) } : {}),
    }, signal)
    for await (const frame of stream) {
      if (stopped || signal.aborted) return
      yield frame
    }
  }

  async function dispatch(method, params, signal) {
    switch (method) {
      case 'health': return health()
      case 'create': return createSession(params)
      case 'prompt': return prompt(params)
      case 'cancel': return cancel(params)
      case 'status': return status(params)
      case 'workspaces': return resolveWorkspace(params)
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: 'UNKNOWN_METHOD' })
    }
  }

  function writeLine(socket, value) {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(value)}\n`)
  }

  async function handleLine(socket, line) {
    let request
    try { request = JSON.parse(line) } catch { writeLine(socket, { id: null, ok: false, error: { code: 'BAD_JSON', message: 'invalid JSON' } }); return }
    const id = request?.id ?? null
    const method = typeof request?.method === 'string' ? request.method : ''
    const params = request?.params ?? {}
    if (method === 'follow') {
      const controller = new AbortController()
      controllers.add(controller)
      socket.on('close', () => controller.abort())
      try {
        writeLine(socket, { id, event: 'start' })
        for await (const frame of follow(params, controller.signal)) {
          writeLine(socket, { id, event: 'frame', frame })
        }
        writeLine(socket, { id, event: 'end' })
      } catch (error) {
        if (!controller.signal.aborted) {
          writeLine(socket, { id, event: 'error', error: { code: error?.code ?? 'HOST_ERROR', message: error?.message ?? String(error) } })
        }
      } finally {
        controllers.delete(controller)
      }
      return
    }
    try {
      const result = await dispatch(method, params, new AbortController().signal)
      writeLine(socket, { id, ok: true, result })
    } catch (error) {
      writeLine(socket, { id, ok: false, error: { code: error?.code ?? 'HOST_ERROR', message: error?.message ?? String(error) } })
    }
  }

  server.on('connection', (socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      while (true) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        if (line.length > MAX_LINE) {
          writeLine(socket, { id: null, ok: false, error: { code: 'LINE_TOO_LARGE', message: 'request line too large' } })
          socket.destroy()
          return
        }
        void handleLine(socket, line)
      }
    })
    socket.on('error', () => {})
  })

  server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600) } catch { /* best effort */ }
    safeWriteJson(statusFile, { ...health(), at: new Date().toISOString() }).catch(() => {})
    console.log(`[astra-dsh-host-control] listening on ${socketPath}`)
  })

  ctx.effect(() => () => {
    stopped = true
    for (const controller of controllers) controller.abort()
    server.close()
    try { rmSync(socketPath, { force: true }) } catch {}
    try { rmSync(statusFile, { force: true }) } catch {}
  })

  return { socketPath, statusFile, server, health }
}
