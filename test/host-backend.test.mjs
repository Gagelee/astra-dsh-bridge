import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'
import { makeWorkspace, startMcp } from './helpers.mjs'

function startHostMock(dir) {
  const socketPath = join(dir, 'host-control.sock')
  let followCount = 0
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
        if (request.method === 'health') {
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result: {
            ok: true, version: '0.1.0', protocol: 1, pid: 1, dshHome: dir,
            capabilities: ['session.create', 'session.prompt', 'session.cancel', 'session.status', 'session.follow', 'workspace.resolve'],
          } })}\n`)
        } else if (request.method === 'create') {
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result: {
            sessionId: 'host-session-1', agentPreset: 'standard',
            selected: { provider: 'deepseek-official', model: request.params.model ?? 'deepseek-flash' },
          } })}\n`)
        } else if (request.method === 'follow') {
          followCount += 1
          const turn = followCount
          const text = turn === 1 ? 'HOST_DONE' : 'HOST_DONE_2'
          socket.write(`${JSON.stringify({ id: request.id, event: 'start' })}\n`)
          socket.write(`${JSON.stringify({ id: request.id, event: 'frame', frame: { type: 'snapshot', cursor: 0, records: [] } })}\n`)
          socket.write(`${JSON.stringify({ id: request.id, event: 'frame', frame: {
            type: 'assistant/message', seq: turn * 2, time: turn,
            data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } },
          } })}\n`)
          socket.write(`${JSON.stringify({ id: request.id, event: 'frame', frame: {
            type: 'turn/end', seq: turn * 2 + 1, time: turn + 1, data: { turn, reason: { kind: 'completed' } },
          } })}\n`)
          socket.write(`${JSON.stringify({ id: request.id, event: 'end' })}\n`)
        } else if (request.method === 'prompt') {
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { accepted: true } })}\n`)
        } else {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'UNKNOWN_METHOD', message: 'nope' } })}\n`)
        }
      }
    })
  })
  server.listen(socketPath)
  return { server, socketPath }
}

async function init(mcp) {
  await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    clientCapabilities: {},
    clientInfo: { name: 'test', version: '0' },
  })
}

describe('host backend dispatch', () => {
  let workspace
  let host
  let mcp
  afterEach(async () => {
    await mcp?.close()
    host?.server.close()
    mcp = undefined
    host = undefined
    workspace = undefined
  })

  it('runs a task on the host control plane and marks it live', async () => {
    workspace = await makeWorkspace('astra-dsh-host-backend-')
    host = startHostMock(workspace)
    if (!host.server.listening) await once(host.server, 'listening')
    mcp = startMcp({
      cwd: workspace,
      env: {
        ASTRA_DSH_DSH_HOME: workspace,
        ASTRA_DSH_EXECUTION_BACKEND: 'auto',
        ASTRA_DSH_HOST_SOCKET: host.socketPath,
        ASTRA_DSH_HOST_PROBE_TIMEOUT_MS: '500',
        ASTRA_DSH_CODEX_BIN: '/nonexistent/codex',
        ASTRA_DSH_NOTIFY_CODEX: '0',
      },
    })
    await init(mcp)
    const dispatched = await mcp.call('dsh_dispatch', {
      workspace,
      title: 'Host live task',
      goal: 'Prove the host backend settles a task.',
      implementationPlan: 'Use the host session and return HOST_DONE.',
      acceptance: ['result.md contains HOST_DONE'],
      writeScopes: ['host-output.txt'],
      reviewMode: 'light',
    })
    assert.equal(dispatched.isError, false, dispatched.text)
    const taskId = dispatched.structured.taskId
    assert.equal(dispatched.structured.executionBackend, 'host')
    assert.equal(dispatched.structured.live, true)
    assert.equal(dispatched.structured.sessionId, 'host-session-1')

    const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
    assert.equal(waited.structured.state, 'idle')
    assert.equal(waited.structured.executionBackend, 'host')
    assert.equal(waited.structured.live, true)
    const result = await mcp.call('dsh_result', { workspace, taskId })
    assert.match(result.text, /HOST_DONE/)
    const task = JSON.parse(readFileSync(join(workspace, '.astra-dsh', 'tasks', taskId, 'task.json'), 'utf8'))
    assert.equal(task.executionBackend, 'host')
    assert.equal(task.live, true)
    assert.equal(task.sessionId, 'host-session-1')
  })

  it('continues the same host session for a follow-up message', async () => {
    workspace = await makeWorkspace('astra-dsh-host-follow-up-')
    host = startHostMock(workspace)
    if (!host.server.listening) await once(host.server, 'listening')
    mcp = startMcp({
      cwd: workspace,
      env: {
        ASTRA_DSH_DSH_HOME: workspace,
        ASTRA_DSH_EXECUTION_BACKEND: 'auto',
        ASTRA_DSH_HOST_SOCKET: host.socketPath,
        ASTRA_DSH_HOST_PROBE_TIMEOUT_MS: '500',
        ASTRA_DSH_CODEX_BIN: '/nonexistent/codex',
        ASTRA_DSH_NOTIFY_CODEX: '0',
      },
    })
    await init(mcp)
    const dispatched = await mcp.call('dsh_dispatch', {
      workspace,
      title: 'Host follow-up',
      goal: 'Run two host turns.',
      implementationPlan: 'Use the same host session for both turns.',
      acceptance: ['second result contains HOST_DONE_2'],
      writeScopes: ['host-output.txt'],
      reviewMode: 'light',
    })
    assert.equal(dispatched.isError, false, dispatched.text)
    const taskId = dispatched.structured.taskId
    await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
    const messaged = await mcp.call('dsh_message', { workspace, taskId, message: 'Do the next turn.' })
    assert.equal(messaged.isError, false, messaged.text)
    const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
    assert.equal(waited.structured.state, 'idle')
    assert.equal(waited.structured.executionBackend, 'host')
    assert.equal(waited.structured.live, true)
    const result = await mcp.call('dsh_result', { workspace, taskId })
    assert.match(result.text, /HOST_DONE_2/)
    assert.equal(waited.structured.turn, 2)
    assert.equal(waited.structured.sessionId, 'host-session-1')
  })
})
