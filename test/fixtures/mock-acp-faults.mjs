#!/usr/bin/env node
/**
 * Mock ACP agent for transport-fault tests. Behaviour is selected by
 * MOCK_FAULT so a test can close stdout, break stdin with EPIPE, exit in the
 * middle of a prompt, go quiet for a long tool, or fail model configuration.
 * Everything is a short-lived child process; no real model or DSH session is
 * involved.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const MODE = process.env.MOCK_FAULT ?? 'ok'
const sessions = new Map()
let counter = 0
let nextId = 1000
let keepAlive = ['close-stdout', 'epipe', 'silent'].includes(MODE)

function send(message) {
  try {
    if (process.stdout.writable) process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch {
    // The parent may already be gone.
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function promptCount(cwd) {
  try {
    mkdirSync(cwd, { recursive: true })
    appendFileSync(join(cwd, 'fault-prompts.jsonl'), `${JSON.stringify({ at: Date.now(), mode: MODE })}\n`)
  } catch {
    // Diagnostics only.
  }
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
  promptCount(session.cwd)

  notify('session/update', {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: `fault-${session.turns}`,
      title: 'bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'long-running mock tool' },
    },
  })

  if (MODE === 'close-stdout') {
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: `m${session.turns}`,
        content: { type: 'text', text: 'PARTIAL_OUTPUT before stdout closed' },
      },
    })
    await delay(50)
    try { closeSync(1) } catch { /* already gone */ }
    // Deliberately stay alive with a closed stdout; the client must detect the
    // broken stream, reject pending, and kill this child.
    return
  }

  if (MODE === 'epipe') {
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: `m${session.turns}`,
        content: { type: 'text', text: 'PARTIAL_OUTPUT before stdin broke' },
      },
    })
    await delay(50)
    try { closeSync(0) } catch { /* already gone */ }
    // Ask the client to write back. Its response hits a closed pipe (EPIPE).
    send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'session/request_permission',
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: `perm-${session.turns}` },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
    return
  }

  if (MODE === 'exit-during-prompt') {
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: `m${session.turns}`,
        content: { type: 'text', text: `PARTIAL_OUTPUT ${marker} turn=${session.turns}` },
      },
    })
    await delay(700)
    try { process.stderr.write('fault-exit: simulated transport crash token=sk-abcdefghijklmnop\n') } catch { /* gone */ }
    process.exit(7)
  }

  if (MODE === 'silent' || MODE === 'stall-twice') {
    const recoverMs = Number(process.env.MOCK_SILENT_RECOVER_MS ?? 0)
    const limitMs = Number(process.env.MOCK_SILENT_MS ?? 60_000)
    const startedFile = process.env.MOCK_SILENT_STARTED_FILE
    const recoverFile = process.env.MOCK_SILENT_RECOVER_FILE
    const recoverFile2 = process.env.MOCK_SILENT_RECOVER_FILE_2
    if (startedFile) {
      try { writeFileSync(startedFile, `${JSON.stringify({ at: Date.now(), turn: session.turns })}\n`) } catch { /* test diagnostic */ }
    }
    const started = Date.now()
    let recoveredOnce = false
    while (Date.now() - started < limitMs) {
      if (session.cancelled && process.env.MOCK_IGNORE_CANCEL !== '1') {
        const ignoreMs = Number(process.env.MOCK_IGNORE_CANCEL_MS ?? 0)
        if (ignoreMs > 0 && Date.now() - (session.cancelAt ?? 0) < ignoreMs) {
          await delay(50)
          continue
        }
        session.cancelled = false
        notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: `fault-${session.turns}`, status: 'failed', content: [] },
        })
        respond(id, { stopReason: 'cancelled' })
        return
      }
      const firstReady = MODE === 'stall-twice'
        ? Boolean(recoverFile && existsSync(recoverFile))
        : (recoverFile ? existsSync(recoverFile) : (recoverMs > 0 && Date.now() - started >= recoverMs))
      if (firstReady && MODE === 'stall-twice' && !recoveredOnce) {
        recoveredOnce = true
        // A visible tool update clears the first stall episode; then go quiet
        // again so a second episode can be detected in the same turn.
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `fault-${session.turns}`,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'first stall recovered' } }],
          },
        })
        await delay(20)
        continue
      }
      const secondReady = MODE === 'stall-twice'
        ? Boolean(recoverFile2 && existsSync(recoverFile2))
        : firstReady
      if (secondReady && (MODE !== 'stall-twice' || recoveredOnce)) {
        notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: `fault-${session.turns}`, status: 'completed', content: [] },
        })
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: `m${session.turns}`,
            content: { type: 'text', text: `RECOVERED ${marker} turn=${session.turns}` },
          },
        })
        respond(id, { stopReason: 'end_turn' })
        return
      }
      await delay(50)
    }
    respond(id, { stopReason: 'end_turn' })
    return
  }

  if (MODE === 'slow-tool') {
    await delay(Number(process.env.MOCK_SLOW_MS ?? 400))
    notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: `fault-${session.turns}`, status: 'completed', content: [] },
    })
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: `m${session.turns}`,
        content: { type: 'text', text: `MOCK_DONE ${marker} turn=${session.turns}` },
      },
    })
    respond(id, { stopReason: 'end_turn' })
    return
  }

  notify('session/update', {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: `m${session.turns}`,
      content: { type: 'text', text: `MOCK_DONE ${marker} turn=${session.turns}` },
    },
  })
  respond(id, { stopReason: 'end_turn' })
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', async (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id !== undefined && message.method === undefined) return
  if (message.id === undefined && message.method === 'session/cancel') {
    const session = sessions.get(message.params.sessionId)
    if (session) {
      session.cancelled = true
      session.cancelAt = Date.now()
    }
    return
  }
  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: 'mock-acp-faults', version: '1.0.0' },
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      })
      return
    case 'session/new': {
      counter += 1
      const sessionId = `fault-session-${counter}`
      sessions.set(sessionId, { cwd: message.params.cwd, turns: 0, cancelled: false })
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
      if (MODE === 'set-config-fails') {
        respondError(message.id, -32000, 'model selection rejected: flash unavailable')
        return
      }
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

reader.on('close', () => {
  if (!keepAlive) process.exit(0)
})
process.stdin.on('error', () => { /* expected when the parent dies mid-write */ })
function noteSignal(signal) {
  const file = process.env.MOCK_SIGNAL_FILE
  if (!file) return
  try { appendFileSync(file, `${signal}\n`) } catch { /* test diagnostic only */ }
}
process.on('SIGTERM', () => {
  noteSignal('SIGTERM')
  process.exit(0)
})
process.on('SIGINT', () => {
  noteSignal('SIGINT')
  process.exit(0)
})
if (keepAlive) setInterval(() => {}, 1000)
