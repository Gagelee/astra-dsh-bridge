#!/usr/bin/env node
/**
 * MCP stdio server for Codex. Codex/Astra sees the `astra_*` and `dsh_*` tools
 * defined in tools.mjs; all state lives in the shared workspace.
 *
 * stdout is reserved for JSON-RPC. Every diagnostic goes to stderr.
 */

import { createInterface } from 'node:readline'
import { loadConfig } from './config.mjs'
import { Bridge, TOOL_DEFINITIONS, callTool } from './tools.mjs'
import { BridgeError } from './util.mjs'

const VERSION = '1.0.0'
const log = (...parts) => {
  try {
    process.stderr.write(`[astra-dsh ${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch {
    // stderr can be gone during shutdown.
  }
}

const bridge = new Bridge(loadConfig())
const inflight = new Map()

function send(message) {
  if (!process.stdout.writable) return
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

async function handleRequest(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      bridge.codexInitialize = {
        clientInfo: params?.clientInfo ?? null,
        meta: params?._meta ?? null,
      }
      const protocolVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18'
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'astra-dsh-bridge', version: VERSION },
        instructions:
          'Astra plans; DSH executes. Start with astra_inbox, dispatch complete packets with dsh_dispatch, and review with dsh_result/dsh_review. When a task settles the bridge wakes this same Codex thread via codex queue; dsh_wait is diagnostic only.',
      })
      return
    }
    case 'ping':
      sendResult(id, {})
      return
    case 'tools/list':
      sendResult(id, { tools: TOOL_DEFINITIONS })
      return
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      const meta = params?._meta ?? null
      const controller = new AbortController()
      inflight.set(id, controller)
      try {
        const result = await callTool(name, args, bridge, { signal: controller.signal, meta })
        const content = [{ type: 'text', text: String(result.text ?? '') }]
        const payload = { content, isError: Boolean(result.isError) }
        if (result.structured !== undefined) payload.structuredContent = result.structured
        sendResult(id, payload)
      } catch (error) {
        const bridgeError = error instanceof BridgeError ? error : undefined
        const text = bridgeError
          ? `Error [${bridgeError.code}]: ${bridgeError.message}`
          : `Error: ${error?.stack ?? error}`
        log(`tool ${name} failed:`, bridgeError?.message ?? error)
        sendResult(id, {
          content: [{ type: 'text', text: bridgeError?.details ? `${text}\n\n${JSON.stringify(bridgeError.details, undefined, 2)}` : text }],
          isError: true,
        })
      } finally {
        inflight.delete(id)
      }
      return
    }
    case 'logging/setLevel':
      sendResult(id, {})
      return
    default:
      sendError(id, -32601, `Method not found: ${method}`)
  }
}

function handleNotification(message) {
  const { method, params } = message
  if (method === 'notifications/cancelled') {
    const requestId = params?.requestId
    const controller = inflight.get(requestId)
    if (controller) {
      controller.abort()
      inflight.delete(requestId)
    }
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/progress') return
  // Unknown notifications are ignored by MCP convention.
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch (error) {
    log('dropping unparseable JSON-RPC line:', error.message)
    return
  }
  if (message.jsonrpc !== '2.0') return
  const isRequest = message.id !== undefined && message.method !== undefined
  if (isRequest) {
    handleRequest(message).catch((error) => {
      sendError(message.id, -32603, error?.message ?? 'internal error')
    })
    return
  }
  if (message.method !== undefined) handleNotification(message)
})

reader.on('close', async () => {
  log('stdin closed; shutting down')
  await shutdown(0)
})

let shuttingDown = false
async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const controller of inflight.values()) controller.abort()
  inflight.clear()
  try {
    await bridge.close()
  } catch (error) {
    log('shutdown error:', error?.message ?? error)
  }
  process.exit(code)
}

process.on('SIGTERM', () => { void shutdown(0) })
process.on('SIGINT', () => { void shutdown(0) })
process.stdout.on('error', (error) => {
  // Codex closed its control pipe. A turn in flight must be reported by the
  // watchdog sidecar rather than leaving an orphaned MCP process behind.
  log('stdout error:', error?.message ?? error)
  void shutdown(1)
})
process.on('uncaughtException', (error) => {
  log('uncaught exception:', error?.stack ?? error)
  void shutdown(1)
})
process.on('unhandledRejection', (error) => {
  log('unhandled rejection:', error?.stack ?? error)
})

log(`started pid=${process.pid} dsh=${bridge.config.dshBin} home=${bridge.config.dshHome ?? 'per-workspace'} model=${bridge.config.model}`)
