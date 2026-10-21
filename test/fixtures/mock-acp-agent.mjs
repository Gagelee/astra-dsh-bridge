#!/usr/bin/env node
/**
 * Mock ACP agent used by the bridge integration tests. It implements just
 * enough of the DSH ACP surface to exercise dispatch, streaming updates,
 * permission prompts, cancellation, and multi-turn sessions without an LLM.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const sessions = new Map()
const cancelled = new Set()
const pendingClient = new Map()
let nextId = 1
let nextPermissionId = 9000
let sessionCounter = 0

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function requestClient(method, params) {
  const id = nextPermissionId++
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolvePromise) => pendingClient.set(id, resolvePromise))
}

async function promptHandler(id, params) {
  const session = sessions.get(params.sessionId)
  if (!session) {
    respondError(id, -32000, 'unknown session')
    return
  }
  const text = (params.prompt ?? []).map((block) => block.text ?? '').join('\n')
  const marker = /Task: `([^`]+)`/.exec(text)?.[1] ?? 'MOCK'
  session.turns += 1

  notify('session/update', {
    sessionId: params.sessionId,
    update: { sessionUpdate: 'agent_thought_chunk', messageId: `t${session.turns}`, content: { type: 'text', text: 'mock is considering the task' } },
  })
  await delay(20)

  if (text.includes('SLOW')) {
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `call-slow-${session.turns}`,
        title: 'bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'sleep 300' },
      },
    })
    for (let i = 0; i < 600; i += 1) {
      if (cancelled.has(params.sessionId)) {
        cancelled.delete(params.sessionId)
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `call-slow-${session.turns}`,
            status: 'failed',
            content: [],
          },
        })
        respond(id, { stopReason: 'cancelled' })
        return
      }
      await delay(50)
    }
    respond(id, { stopReason: 'end_turn' })
    return
  }

  if (text.includes('FAIL')) {
    respondError(id, -32000, 'mock failure requested')
    return
  }

  let permission = 'not-requested'
  if (text.includes('NEED_PERMISSION')) {
    const response = await requestClient('session/request_permission', {
      sessionId: params.sessionId,
      toolCall: { toolCallId: `perm-${session.turns}` },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const outcome = response?.outcome
    permission = outcome?.outcome === 'selected' ? outcome.optionId : outcome?.outcome ?? 'none'
  }

  const toolCallId = `call-${session.turns}`
  notify('session/update', {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'write_file',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { path: 'dsh-output.txt' },
    },
  })
  await delay(20)
  mkdirSync(session.cwd, { recursive: true })
  appendFileSync(join(session.cwd, 'dsh-output.txt'), `MOCK_DONE ${marker} turn=${session.turns} permission=${permission}\n`)
  if (session.turns === 1) writeFileSync(join(session.cwd, 'dsh-second-file.txt'), `created by ${marker}\n`)
  notify('session/update', {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file written' } }],
    },
  })

  let final = `MOCK_DONE ${marker} turn=${session.turns} permission=${permission}`
  if (text.includes('ASK_QUESTION')) {
    final += '\nQUESTION: Should the mock use option A or option B?'
  }
  notify('session/update', {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: `m${session.turns}`,
      content: { type: 'text', text: final },
    },
  })
  notify('session/update', {
    sessionId: params.sessionId,
    update: { sessionUpdate: 'usage_update', used: 100, size: 1000 },
  })
  respond(id, { stopReason: 'end_turn' })
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', async (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.id !== undefined && message.method === undefined) {
    pendingClient.get(message.id)?.(message.result)
    pendingClient.delete(message.id)
    return
  }
  if (message.id === undefined && message.method === 'session/cancel') {
    cancelled.add(message.params.sessionId)
    return
  }
  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: 'mock-acp', version: '1.0.0' },
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      })
      return
    case 'session/new': {
      sessionCounter += 1
      const sessionId = `mock-session-${sessionCounter}`
      sessions.set(sessionId, { cwd: message.params.cwd, turns: 0 })
      respond(message.id, {
        sessionId,
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: '["mock","mock-model"]', options: [] },
          { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [] },
        ],
      })
      return
    }
    case 'session/resume': {
      const session = sessions.get(message.params.sessionId)
      if (!session) {
        respondError(message.id, -32000, 'session not resumable')
        return
      }
      respond(message.id, { configOptions: [] })
      return
    }
    case 'session/set_config_option':
      respond(message.id, { configOptions: [] })
      return
    case 'session/close':
      sessions.delete(message.params.sessionId)
      respond(message.id, {})
      return
    case 'session/prompt':
      await promptHandler(message.id, message.params)
      return
    default:
      respondError(message.id, -32601, `method not found: ${message.method}`)
  }
})

reader.on('close', () => process.exit(0))
