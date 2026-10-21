/**
 * Manual end-to-end check against a real DSH ACP server. Not part of `npm test`
 * because it needs working DeepSeek credentials and spends tokens.
 *
 *   ASTRA_DSH_DSH_HOME=~/.dsh node scripts/real-e2e.mjs /path/to/workspace
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const workspace = process.argv[2] ?? process.cwd()
const server = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))
const child = spawn(process.execPath, [server], {
  cwd: workspace,
  env: {
    ...process.env,
    ASTRA_DSH_DSH_BIN: process.env.ASTRA_DSH_DSH_BIN ?? 'dsh',
    ASTRA_DSH_MODEL: process.env.ASTRA_DSH_MODEL ?? 'deepseek-v4-pro',
    ASTRA_DSH_EFFORT: process.env.ASTRA_DSH_EFFORT ?? 'high',
    ASTRA_DSH_PERMISSION_POLICY: process.env.ASTRA_DSH_PERMISSION_POLICY ?? 'allow',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`))
const pending = new Map()
let nextId = 1
const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
reader.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.id !== undefined) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
})
function request(method, params, timeout = 300_000) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeout)
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
  })
}
async function call(name, args) {
  const result = await request('tools/call', { name, arguments: args })
  if (result.isError) throw new Error(result.content?.[0]?.text)
  return result.structuredContent ?? { text: result.content?.[0]?.text }
}

try {
  await request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
  const dispatched = await call('dsh_dispatch', {
    workspace,
    title: 'Real ACP end-to-end',
    goal: 'Create a file named real-e2e.txt in the workspace containing exactly "hello from real DSH". Then reply with REAL_E2E_OK and a one-line summary.',
    context: 'This is the first real end-to-end validation of the Astra-DSH bridge. The workspace is shared; Astra will inspect the file afterwards.',
    acceptance: ['real-e2e.txt exists with the exact requested content', 'Final reply contains REAL_E2E_OK'],
    constraints: ['Only create real-e2e.txt; do not touch other files'],
    writeScopes: ['real-e2e.txt'],
    reviewMode: process.env.REAL_E2E_REVIEW_MODE ?? 'full',
    verifyCommands: process.env.REAL_E2E_VERIFY ? [process.env.REAL_E2E_VERIFY] : [],
  })
  console.log('dispatched', dispatched)
  const waited = await call('dsh_wait', { workspace, taskId: dispatched.taskId, timeoutSec: 240 })
  console.log('state:', waited.state, 'stop:', waited.stopReason)
  console.log('text:', waited.lastAssistantText)
  console.log('changed:', waited.changedFiles)
  const result = await call('dsh_result', { workspace, taskId: dispatched.taskId })
  console.log('result markdown:\n', result.resultMarkdown)
  if (waited.state === 'idle') {
    await call('dsh_review', { workspace, taskId: dispatched.taskId, decision: 'accepted', notes: 'real e2e inspection' })
  } else {
    console.log('auto review outcome:', waited.autoReview)
  }
} finally {
  child.stdin.end()
  setTimeout(() => process.exit(0), 1500)
}
