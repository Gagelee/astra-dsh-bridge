import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, it } from 'node:test'
import { HostControlClient, probeHostControl } from '../src/host-client.mjs'

function startServer(dir) {
  const socketPath = join(dir, 'host.sock')
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      while (true) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const request = JSON.parse(line)
        if (request.method === 'follow') {
          socket.write(`${JSON.stringify({ id: request.id, event: 'start' })}\n`)
          socket.write(`${JSON.stringify({ id: request.id, event: 'frame', frame: { type: 'snapshot', cursor: 0 } })}\n`)
          socket.write(`${JSON.stringify({ id: request.id, event: 'end' })}\n`)
          continue
        }
        if (request.method === 'health') {
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { ok: true, version: '0.1.0', protocol: 1 } })}\n`)
          continue
        }
        if (request.method === 'create') {
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { sessionId: 'sess-host-1' } })}\n`)
          continue
        }
        socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'UNKNOWN_METHOD', message: 'nope' } })}\n`)
      }
    })
  })
  server.listen(socketPath)
  return { server, socketPath }
}

describe('host control client', () => {
  let dir
  let server
  afterEach(() => {
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    server = undefined
  })

  async function start() {
    dir = mkdtempSync(join(tmpdir(), 'astra-dsh-host-client-'))
    const started = startServer(dir)
    server = started.server
    if (!server.listening) await once(server, 'listening')
    return started.socketPath
  }

  it('probes a live host and reports capabilities', async () => {
    const socketPath = await start()
    const health = await probeHostControl(socketPath)
    assert.equal(health.available, true)
    assert.equal(health.version, '0.1.0')
  })

  it('returns unavailable for a missing socket', async () => {
    const health = await probeHostControl('/tmp/astra-dsh-missing.sock', { timeoutMs: 200 })
    assert.equal(health.available, false)
    assert.match(health.error, /connect|ENOENT|failed/)
  })

  it('sends a create request and receives the session id', async () => {
    const socketPath = await start()
    const client = new HostControlClient(socketPath)
    const result = await client.request('create', { cwd: '/tmp/project' })
    assert.equal(result.sessionId, 'sess-host-1')
  })

  it('streams follow frames and terminates on end', async () => {
    const socketPath = await start()
    const client = new HostControlClient(socketPath)
    const frames = []
    for await (const frame of client.follow('sess-host-1')) frames.push(frame)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].type, 'snapshot')
  })

  it('surfaces a bounded host error', async () => {
    const socketPath = await start()
    const client = new HostControlClient(socketPath)
    await assert.rejects(() => client.request('nope'), (error) => error.code === 'UNKNOWN_METHOD')
  })
})
