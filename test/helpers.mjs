/** Test helpers: spawn the real MCP server and speak JSON-RPC to it. */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

export const MOCK_ACP = fileURLToPath(new URL('./fixtures/mock-acp-agent.mjs', import.meta.url))
export const SERVER = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))

export async function makeWorkspace(prefix = 'astra-dsh-test-') {
  return mkdtemp(join(tmpdir(), prefix))
}

export function startMcp({ cwd, env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: {
      ...process.env,
      PATH: `${join(process.execPath, '..')}:${process.env.PATH}`,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const stderr = []
  let nextId = 1
  const notifications = []
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  reader.on('line', (line) => {
    if (!line.trim()) return
    const message = JSON.parse(line)
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
      return
    }
    notifications.push(message)
  })
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))

  function request(method, params, timeoutMs = 60_000) {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP timeout: ${method}\n${stderr.join('')}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
    })
  }

  async function call(name, args, timeoutMs = 60_000) {
    const result = await request('tools/call', { name, arguments: args }, timeoutMs)
    return {
      text: result.content?.[0]?.text ?? '',
      structured: result.structuredContent,
      isError: Boolean(result.isError),
    }
  }

  async function close() {
    child.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return { child, request, call, close, stderr, notifications }
}
