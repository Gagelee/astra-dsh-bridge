import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, it } from 'node:test'
import { apply, PROTOCOL, VERSION } from '../host-plugin/index.js'

function makeCtx() {
  const calls = []
  const ctx = {
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'sess-1', running: false, updatedAt: 1 }] }),
      create: async (request) => { calls.push(['create', request]); return { sessionId: 'sess-1', agentPreset: request.agentPreset } },
      selectModel: async (request) => { calls.push(['selectModel', request]); return { selected: { provider: request.provider, model: request.model } } },
      prompt: async (request) => { calls.push(['prompt', request]); return { accepted: true } },
      cancel: (request) => { calls.push(['cancel', request]); return { accepted: true } },
      follow: async function* () {
        yield { type: 'snapshot', cursor: 0, records: [] }
        yield { type: 'assistant/message', seq: 1, time: 1, data: { text: 'hello' } }
      },
    },
    workspaceRegistry: {
      resolveByPath: async (path) => (path === '/tmp/project' ? { id: 'ws-1', path, title: 'project', sessionIds: [] } : undefined),
      create: async (path) => ({ id: 'ws-created', path, title: 'created', sessionIds: [] }),
    },
    effect: () => {},
  }
  return { ctx, calls }
}

function connectSocket(path) {
  const socket = connect(path)
  let buffer = ''
  const lines = []
  const waiters = []
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    while (true) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const value = JSON.parse(line)
      const waiter = waiters.shift()
      if (waiter) waiter(value)
      else lines.push(value)
    }
  })
  return {
    socket,
    next: () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiters.push(resolve)),
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    close: () => socket.destroy(),
  }
}

describe('host control plugin', () => {
  let dir
  let controller
  let client

  afterEach(() => {
    client?.close()
    controller?.server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    controller = undefined
    client = undefined
  })

  async function start() {
    dir = mkdtempSync(join(tmpdir(), 'astra-dsh-host-control-'))
    process.env.DSH_HOME = dir
    const { ctx } = makeCtx()
    controller = apply(ctx, {
      socketPath: join(dir, 'host.sock'),
      statusFile: join(dir, 'host.json'),
    })
    if (!controller.server.listening) await once(controller.server, 'listening')
    client = connectSocket(join(dir, 'host.sock'))
    return controller
  }

  it('reports health and protocol without creating anything', async () => {
    await start()
    client.send({ id: 1, method: 'health' })
    const response = await client.next()
    assert.equal(response.id, 1)
    assert.equal(response.ok, true)
    assert.equal(response.result.version, VERSION)
    assert.equal(response.result.protocol, PROTOCOL)
    assert.ok(response.result.capabilities.includes('session.follow'))
  })

  it('creates a host session, selects the model, and prompts it', async () => {
    const { ctx } = makeCtx()
    dir = mkdtempSync(join(tmpdir(), 'astra-dsh-host-control-'))
    process.env.DSH_HOME = dir
    controller = apply(ctx, { socketPath: join(dir, 'host.sock'), statusFile: join(dir, 'host.json') })
    if (!controller.server.listening) await once(controller.server, 'listening')
    client = connectSocket(join(dir, 'host.sock'))
    client.send({ id: 'c', method: 'create', params: { cwd: '/tmp/project', agentPreset: 'standard', model: 'deepseek-flash', reasoningEffort: 'high', prompt: 'do it' } })
    const response = await client.next()
    assert.equal(response.ok, true)
    assert.equal(response.result.sessionId, 'sess-1')
    assert.equal(response.result.selected.model, 'deepseek-flash')
    assert.equal(response.result.selected.provider, 'deepseek-official')
  })

  it('prompts, cancels, reports status, and resolves workspaces', async () => {
    await start()
    for (const request of [
      { id: 'p', method: 'prompt', params: { sessionId: 'sess-1', text: 'again' } },
      { id: 'c', method: 'cancel', params: { sessionId: 'sess-1' } },
      { id: 's', method: 'status', params: { sessionId: 'sess-1' } },
      { id: 'w', method: 'workspaces', params: { path: '/tmp/project' } },
    ]) {
      client.send(request)
      const response = await client.next()
      assert.equal(response.ok, true, JSON.stringify(response))
    }
    client.send({ id: 'w2', method: 'workspaces', params: { path: '/tmp/project', policy: 'create' } })
    const created = await client.next()
    assert.equal(created.result.workspaceId, 'ws-1')
  })

  it('streams follow frames and ends cleanly', async () => {
    await start()
    client.send({ id: 'f', method: 'follow', params: { sessionId: 'sess-1' } })
    const startFrame = await client.next()
    assert.equal(startFrame.event, 'start')
    const frame = await client.next()
    assert.equal(frame.event, 'frame')
    assert.equal(frame.frame.type, 'snapshot')
    const next = await client.next()
    assert.equal(next.event, 'frame')
    const end = await client.next()
    assert.equal(end.event, 'end')
  })

  it('returns a bounded error for an unknown method', async () => {
    await start()
    client.send({ id: 'x', method: 'nope' })
    const response = await client.next()
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'UNKNOWN_METHOD')
  })
})
