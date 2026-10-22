/** Test helpers: spawn the real MCP server and speak JSON-RPC to it. */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

export const MOCK_ACP = fileURLToPath(new URL('./fixtures/mock-acp-agent.mjs', import.meta.url))
export const SERVER = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))
export const MOCK_CODEX = fileURLToPath(new URL('./fixtures/mock-codex.mjs', import.meta.url))
export const MOCK_CODEX_OUT = (workspace) => `${workspace}.mock-codex-calls.jsonl`
export const MOCK_ACP_FAULTS = fileURLToPath(new URL('./fixtures/mock-acp-faults.mjs', import.meta.url))

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

  async function call(name, args, timeoutMs = 60_000, meta) {
    const effective = name === 'dsh_dispatch'
      ? {
        implementationPlan: 'Implement the requested outcome.',
        writeScopes: ['dsh-output.txt'],
        ...args,
      }
      : args
    const result = await request('tools/call', {
      name,
      arguments: effective,
      ...(meta === undefined ? {} : { _meta: meta }),
    }, timeoutMs)
    return {
      text: result.content?.[0]?.text ?? '',
      structured: result.structuredContent,
      isError: Boolean(result.isError),
    }
  }

  async function kill(signal = 'SIGKILL') {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try { child.kill(signal) } catch { /* already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
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

  async function callWithMeta(name, args, meta, timeoutMs = 60_000) {
    return call(name, args, timeoutMs, meta)
  }

  return { child, request, call, callWithMeta, close, kill, stderr, notifications }
}

/** Poll until predicate returns truthy, then return its value. */
export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

/** Read successful mock codex calls (all calls unless onlyOk=false). */
export function readMockCodexCalls(workspace, { onlyOk = false } = {}) {
  const file = MOCK_CODEX_OUT(workspace)
  if (!existsSync(file)) return []
  const calls = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return onlyOk ? calls.filter((call) => !call.fail) : calls
}

export function readTaskRecord(workspace, taskId) {
  return JSON.parse(readFileSync(join(workspace, '.astra-dsh', 'tasks', taskId, 'task.json'), 'utf8'))
}

export function readTaskFile(workspace, taskId, name) {
  const file = join(workspace, '.astra-dsh', 'tasks', taskId, name)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

export function readNotifications(workspace) {
  const dir = join(workspace, '.astra-dsh', 'notifications')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}
